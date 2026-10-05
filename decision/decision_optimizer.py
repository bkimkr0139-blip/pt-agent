#!/usr/bin/env python3
# [2026-10-05] Jev QA Router — 임계값 옵티마이저 (지시서 §16~18).
# eval/decision_log.jsonl(섀도 관찰)을 읽어 오거절/오수용률을 계산하고, 안전 장치 안에서
# eval/decision_policy.json의 임계값을 조정한다. 기존 QA에는 어떤 영향도 없다(섀도 지표만 봄).
#
# 안전 장치(§17): 표본 최소 50건 / 키별 30분 쿨다운 / 1회 실행당 키별 최대 ±0.03 /
# 클램프(direct .85~.98, no_answer .85~.99, llm_required .60~.90) / 직전 정책 .prev 보관(1스텝 롤백).
import json, os, shutil, sys, time
from collections import Counter

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVAL_DIR = os.environ.get('PT_DECISION_DIR') or os.path.join(BASE, 'eval')
LOG = os.path.join(EVAL_DIR, 'decision_log.jsonl')
POLICY = os.path.join(EVAL_DIR, 'decision_policy.json')
STATUS = os.path.join(EVAL_DIR, 'decision_status.json')

MIN_SAMPLES = 50
COOLDOWN_SEC = 30 * 60
MAX_STEP = 0.03
CLAMPS = {'direct_answer_high': (0.85, 0.98), 'no_answer_high': (0.85, 0.99), 'llm_required_high': (0.60, 0.90)}
# 어떤 오류율이 어떤 키를 어느 방향으로 움직이는가 (§18 규칙표)
RULES = [
    # 오거절(거절 판단했는데 실제 답변됨)↑ → 거절 문턱을 올려 더 조심하게
    ('false_reject', 5.0, 'no_answer_high', +0.02),
    # 오수용(직답 판단했는데 실제 거절됨)↑ → 직답 문턱을 올려 직답을 덜 내주게
    ('false_accept', 3.0, 'direct_answer_high', +0.02),
]

def load_jsonl(path, tail=2000):
    try:
        with open(path, encoding='utf-8') as f:
            lines = f.read().strip().split('\n')[-tail:]
    except FileNotFoundError:
        return []
    out = []
    for l in lines:
        try:
            out.append(json.loads(l))
        except json.JSONDecodeError:
            pass
    return out

def compute(recs):
    routes = Counter(); avoid = 0; f_reject = 0; f_accept = 0; actual = 0
    bd_answered = 0; bn_declined = 0
    for r in recs:
        thr = r.get('threshold') or {}
        dec = r.get('decision') or {}
        route = thr.get('route') or dec.get('route') or '?'
        routes[route] += 1
        if dec.get('requires_llm') is False:
            avoid += 1
        act = r.get('actual') or {}
        if act.get('engine'):
            actual += 1
            if route in ('NO_ANSWER', 'ASK_CLARIFY') and act['engine'] != 'rag-miss':
                f_reject += 1
            if thr.get('exec') == 'direct' and act['engine'] == 'rag-miss':
                f_accept += 1
            # 게이트 미달로 잃은 절감 기회(§18 완화 근거): 판단은 DIRECT/NO_ANSWER였으나
            # 신뢰도 부족으로 기존 경로로 후퇴한 샘플 중, 실제 결과가 "그 판단대로였어도 맞았다"인 것
            if thr.get('reason_code') == 'below_direct_answer_high' and act['engine'] != 'rag-miss':
                bd_answered += 1
            if thr.get('reason_code') == 'below_no_answer_high' and act['engine'] == 'rag-miss':
                bn_declined += 1
    n = len(recs)
    return {
        'total': n, 'routes': dict(routes), 'answered_n': actual,
        'llm_avoidance': round(100 * avoid / n, 1) if n else None,
        'false_reject': round(100 * f_reject / actual, 1) if actual else None,
        'false_accept': round(100 * f_accept / actual, 1) if actual else None,
        'blocked_direct_answered': bd_answered, 'blocked_no_answer_declined': bn_declined,
    }

def main():
    recs = load_jsonl(LOG)
    m = compute(recs)
    with open(POLICY, encoding='utf-8') as f:
        policy = json.load(f)
    status = {}
    try:
        with open(STATUS, encoding='utf-8') as f:
            status = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    now = time.time()
    key_state = status.get('key_state', {})
    adjustments = []
    notes = []

    def try_adjust(key, step, reason):
        """쿨다운·클램프·1회 한도를 공유하는 단일 조정 경로. 조정됐으면 True."""
        ks = key_state.get(key, {})
        if now - ks.get('last_change', 0) < COOLDOWN_SEC:
            notes.append(f"{key}: 쿨다운 중(30분) — 조정 보류 ({reason})")
            return False
        old = float(policy.get(key, 0))
        new = round(min(CLAMPS[key][1], max(CLAMPS[key][0], old + step)), 3) if key in CLAMPS else round(old + step, 3)
        if abs(new - old) < 1e-9:
            notes.append(f"{key}: 클램프 경계({old}) — 더 이상 조정 불가")
            return False
        if abs(new - old) > MAX_STEP:
            notes.append(f"{key}: 1회 최대 {MAX_STEP} 초과 방지 — 보류")
            return False
        policy[key] = new
        key_state[key] = {'last_change': now, 'samples': m['total'], 'reason': reason}
        adjustments.append({'key': key, 'from': old, 'to': new, 'reason': reason})
        return True

    if m['total'] < MIN_SAMPLES:
        notes.append(f"표본 {m['total']}건 < 최소 {MIN_SAMPLES}건 — 관찰만 하고 조정 없음")
    else:
        # 경질 방향(§18): 오류율 KPI 초과 → 문턱 상향
        for metric, kpi, key, step in RULES:
            v = m.get(metric)
            if v is not None and v > kpi:
                try_adjust(key, step, f'{metric}={v}% > KPI {kpi}%')
        # 완화 방향(§18): 정확도 유지 + 게이트 미달로 잃은 절감 기회가 축적되면 문턱 하향.
        # 근거 부족은 의도적 — 섀도 샘플 10건+에서만, 오류율이 KPI 절반 이하일 때만 0.01씩.
        fa, fr = m.get('false_accept'), m.get('false_reject')
        if fa is not None and fa <= 1.5 and m.get('blocked_direct_answered', 0) >= 10:
            try_adjust('direct_answer_high', -0.01, f"정확도 유지(오수용 {fa}%) + 게이트 미달 절감 {m['blocked_direct_answered']}건")
        if fr is not None and fr <= 2.5 and m.get('blocked_no_answer_declined', 0) >= 10:
            try_adjust('no_answer_high', -0.01, f"정확도 유지(오거절 {fr}%) + 게이트 미달 절감 {m['blocked_no_answer_declined']}건")
    if adjustments:
        # 1스텝 롤백용 직전 정책 보관 + 버전/서명 갱신 (tts_policy와 별개 파일, §21)
        shutil.copyfile(POLICY, POLICY + '.prev')
        policy['version'] = int(policy.get('version', 1)) + 1
        policy['updated_by'] = 'decision_optimizer'
        policy['updated_at'] = time.strftime('%Y-%m-%dT%H:%M:%S')
        with open(POLICY, 'w', encoding='utf-8') as f:
            json.dump(policy, f, ensure_ascii=False, indent=1)
    status_out = {
        'generated_at': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'metrics': m, 'adjustments': adjustments, 'notes': notes,
        'policy_version': policy.get('version'), 'key_state': key_state,
    }
    with open(STATUS, 'w', encoding='utf-8') as f:
        json.dump(status_out, f, ensure_ascii=False, indent=1)
    print(f"표본 {m['total']}건 | LLM회피 {m['llm_avoidance']}% | 오거절 {m['false_reject']}% | 오수용 {m['false_accept']}%")
    for a in adjustments:
        print(f"조정: {a['key']} {a['from']} → {a['to']} ({a['reason']})")
    for n_ in notes:
        print(f"메모: {n_}")
    if not adjustments and not notes:
        print("오류율이 KPI 이내 — 조정 없음 (정책 유지)")

if __name__ == '__main__':
    main()
