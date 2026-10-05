#!/usr/bin/env python3
"""pt-agent 무결 감시 루프 (v9.3, 2026-10-04)

발표 로그(pt-agent.log [클라이언트 진단] + mlx-tts-proxy.log)를 주기 스캔해 이슈를 분류하고:

  1. 매개변수형 이슈 → tts_policy.json을 클램프 범위 내 자동 조정 (즉시 다음 실행에 반영,
     프록시는 mtime 감지, 클라이언트는 /api/tts-policy 수신) — 사람 없는 자동 패치.
  2. 코드형 이슈 → integrity/issues.jsonl에 증거와 함께 적립 → 다음 Claude 세션이 읽고
     코드 패치. 이렇게 "로그 → 감지 → 자동 매개변수 패치 + 코드 패치 대기열 → 재검증"의
     폐루프가 형성되고 에이전트는 점점 무결한 상태로 수렴한다.

설계 원칙:
  - 자동 조정은 반드시 클램프 내 (무한 증폭 방지), 같은 이슈 코드 조정은 30분 쿨다운.
  - 모든 판단·조정은 status.json과 issues.jsonl에 기록 (감사 가능).
  - 로그 회전/부재에도 죽지 않는다.
"""
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone

BASE = os.path.dirname(os.path.abspath(__file__))
INTEG = os.path.join(BASE, "integrity")
PT_LOG = os.path.join(BASE, "pt-agent.log")
PROXY_LOG = "/Users/wizbase/works/bc-ai/mlx-tts-proxy.log"
POLICY = "/Users/wizbase/works/bc-ai/tts_policy.json"
CKPT = os.path.join(INTEG, "checkpoints.json")
ISSUES = os.path.join(INTEG, "issues.jsonl")
STATUS = os.path.join(INTEG, "status.json")
KST = timezone(timedelta(hours=9))
COOLDOWN_MIN = 30

# 이슈 코드별 정의: (출처, 정규식, 등급, 자동조정)
# 등급: info=통계만, auto=매개변수 자동조정, code=코드 패치 대기열
SIGS = [
    ("TTS_FINAL_FAIL",    "proxy",  r"FAIL-FINAL",            "code",
     "TTS 조각이 재시도+분할 모두 실패 → 클라이언트 폴백(이질적 목소리) 위험"),
    ("TTS_TRUNCATED",     "proxy",  r"reason=truncated",      "auto",
     "조기 EOS 잘린 생성 — 분할 폴백이 구출하는지 추적"),
    ("TTS_RUNAWAY",       "proxy",  r"reason=runaway",        "auto",
     "과장 생성(runaway) — cap 배율 완화가 필요할 수 있음"),
    ("TTS_UPSTREAM_ERR",  "proxy",  r"reason=upstream",       "code",
     "업스트림 mlx 오류/타임아웃 — 인프라 점검 필요"),
    ("PLAY_STALL_DECODE", "client", r"8초 무반응",             "code",
     "디코딩 정체 8초 감시 발동 — 오디오 로드 경로 점검"),
    ("PLAY_STALL_HARD",   "client", r"120s상한",               "code",
     "재생 120초 상한 발동 — 재생 체인 정체"),
    ("PLAY_BLOCKED",      "client", r"재생 차단",              "code",
     "자동재생 정책 차단 — unlockAudio 경로 점검"),
    ("BROWSER_FALLBACK",  "client", r"폴백\(브라우저 음성\)",   "auto",
     "브라우저 폴백 전환 — 사용자가 '오류'로 인지하는 최악 UX"),
    ("CLIENT_JS_ERROR",   "client", r"스크립트 오류|미처리 거부", "code",
     "클라이언트 JS 예외 — 스택 분석 필요"),
    ("SYNC_MISMATCH",     "client", r"화면-음성 불일치",        "code",
     "화면/음성 슬라이드 불일치 — 세대 체크 점검"),
]


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def read_new(path, offset):
    """(새 데이터, 새 오프셋). 회전(파일이 작아짐) 감지 시 처음부터."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return "", 0
    off = offset if offset <= size else 0
    with open(path, "rb") as f:
        f.seek(off)
        data = f.read().decode("utf-8", "replace")
    return data, off + len(data.encode("utf-8", "replace"))


def classify(logs):
    counts = {}
    evidence = {}
    for code, src, pat, _, _ in SIGS:
        n = len(re.findall(pat, logs[src]))
        if n:
            counts[code] = n
            m = re.search(pat, logs[src])
            evidence[code] = m.group(0)[:60] if m else pat
    # TTS 처리량 통계 (info)
    stats = {
        "tts_ok": len(re.findall(r"\] OK piece", logs["proxy"])),
        "tts_split_rescue": len(re.findall(r"SPLIT-OK", logs["proxy"])),
    }
    return counts, evidence, stats


def apply_auto_patches(counts, policy):
    """클램프+쿨다운 안에서 매개변수 자동조정. 적용 목록 반환."""
    now = datetime.now(KST)
    applied = []
    cl = policy.get("clamps", {})
    last = policy.get("_auto_last", {})

    def cooled(code):
        t = last.get(code)
        return not t or (now - datetime.fromisoformat(t)) >= timedelta(minutes=COOLDOWN_MIN)

    def bump(code, key, fn):
        if counts.get(code, 0) < 1 or not cooled(code):
            return
        lo, hi = (cl.get(key) or [None, None])[0:2]
        cur = policy.get(key, {"attempts": 2, "floor_mult": 1.0, "cap_mult": 1.0,
                               "client_tts_timeout_ms": 60000}[key])
        new = fn(cur)
        if lo is not None:
            new = min(hi, max(lo, new))
        if new != cur:
            policy[key] = new
            last[code] = now.isoformat()
            applied.append({"code": code, "key": key, "from": cur, "to": new})

    # 최종 실패/폴백 → 재시도 1회 추가 (최대 3)
    if (counts.get("TTS_FINAL_FAIL", 0) + counts.get("BROWSER_FALLBACK", 0)) >= 1:
        bump("TTS_FINAL_FAIL" if counts.get("TTS_FINAL_FAIL") else "BROWSER_FALLBACK",
             "attempts", lambda v: int(v) + 1)
    # runaway 다발 → cap 완화 (생성이 못 끝나는 상태 — 상한을 조금 늘려준다)
    if counts.get("TTS_RUNAWAY", 0) >= 3:
        bump("TTS_RUNAWAY", "cap_mult", lambda v: round(float(v) * 1.08, 3))
    # [2026-10-04, PT 후속] 브라우저 폴백 다발(클라이언트 타임아웃 중단 포함) → 클라이언트
    # TTS 타임아웃 완화 — 폴백 전 대기 한도를 25%씩 늘린다(클램프 20~90s). GPU 경합으로
    # 정상 생성이 60s를 넘던 실측(발표 전 테스트 창 AbortError 다수) 클래스의 자동 흡수.
    if counts.get("BROWSER_FALLBACK", 0) >= 2:
        bump("TTS_CLIENT_TIMEOUT", "client_tts_timeout_ms", lambda v: int(v * 1.25) // 1000 * 1000)
    policy["_auto_last"] = last
    return applied


def main():
    os.makedirs(INTEG, exist_ok=True)
    ck = load_json(CKPT, {"pt": 0, "proxy": 0})
    pt_new, ck["pt"] = read_new(PT_LOG, ck.get("pt", 0))
    px_new, ck["proxy"] = read_new(PROXY_LOG, ck.get("proxy", 0))
    logs = {"client": pt_new, "proxy": px_new}
    if not pt_new and not px_new:
        # [2026-10-04] 조기 반환 시에도 이전 통계 유지 — 통째로 덮어쓰면 누적(totals)이 유실됨
        prev = load_json(STATUS, {})
        prev["last_scan"] = datetime.now(KST).isoformat()
        prev["note"] = "변동 없음"
        save_json(STATUS, prev)
        return

    counts, evidence, stats = classify(logs)
    policy = load_json(POLICY, {})
    applied = apply_auto_patches(counts, policy)
    if applied:
        policy["version"] = int(policy.get("version", 0)) + 1
        policy["updated"] = datetime.now(KST).isoformat()
        policy["updated_by"] = "integrity_watch"
        save_json(POLICY, policy)

    issues = [(code, n) for code, n in counts.items() if n]
    if issues:
        with open(ISSUES, "a", encoding="utf-8") as f:
            for code, n in issues:
                grade = next(s[3] for s in SIGS if s[0] == code)
                desc = next(s[4] for s in SIGS if s[0] == code)
                f.write(json.dumps({
                    "ts": datetime.now(KST).isoformat(), "code": code, "count": n,
                    "grade": grade, "evidence": evidence.get(code, ""), "desc": desc,
                    "auto_patch": [a for a in applied if a["code"] == code],
                }, ensure_ascii=False) + "\n")

    save_json(CKPT, ck)
    prev = load_json(STATUS, {})
    tot = prev.get("totals", {"tts_ok": 0, "tts_split_rescue": 0})
    tot["tts_ok"] += stats["tts_ok"]
    tot["tts_split_rescue"] += stats["tts_split_rescue"]
    save_json(STATUS, {
        "last_scan": datetime.now(KST).isoformat(),
        "counts": counts, "stats": stats, "totals": tot,
        "auto_patches": applied,
        "policy_version": policy.get("version", 0),
    })
    # 감시자 자신의 동작도 서버 로그에 남긴다 — 사람이 한눈에 볼 수 있게
    if issues or applied:
        print(f"[무결감시] 이슈 {counts} 자동조정 {applied}", flush=True)


if __name__ == "__main__":
    main()
