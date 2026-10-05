// [2026-10-05] Jev QA Router — 결정 정책 로더 (지시서 §13~14, §21).
// 임계값은 tts_policy.json과 별개 파일(eval/decision_policy.json)로 관리하며, mtime 캐시로
// 프로세스 재시작 없이 옵티마이저의 변경을 즉시 반영한다.
// applyThresholds()는 라우트+신뢰도 게이트(§14)를 순수 함수로 구현 — 단위 테스트 대상.
const fs = require('fs');
const path = require('path');

const POLICY_PATH = process.env.PT_DECISION_DIR
  ? path.join(process.env.PT_DECISION_DIR, 'decision_policy.json')
  : path.join(__dirname, '..', 'eval', 'decision_policy.json');

// 지시서 §13 기본 임계값 — 파일이 없거나 깨지면 이 값으로 동작(결측 키만 보강, 운영 값 보존).
const DEFAULTS = {
  version: 1,
  mode: 'shadow',            // shadow | canary | active | off — 초기 배포는 Shadow만(§35)
  provider: 'rule',          // rule | jev | llm_judge — §30 Provider 추상화
  canary_pct: 0,             // canary 모드에서 라우팅을 적용할 QA 비율(0~100)
  jev: { url: null, timeout_ms: 300 },  // §34 Jev 예산 300ms, 미설정 시 Rule로 폴백
  llm_judge_shadow: false,   // 섀도 비교용 LLMJudge 병행(클라우드 비용 — 기본 끔)
  answer_high: 0.85,
  answer_mid: 0.65,
  no_answer_high: 0.90,
  llm_required_high: 0.75,
  direct_answer_high: 0.92,
  interrupt_high: 0.80,
};

// §17 옵티마이저 안전 클램프 — 자동 조정이 임계값을 비현실적 영역으로 밀지 못하게 한다.
const CLAMPS = {
  direct_answer_high: [0.85, 0.98],
  no_answer_high: [0.85, 0.99],
  llm_required_high: [0.60, 0.90],
};

let _cache = { mtime: 0, policy: null };
function getPolicy() {
  let mtime = 0;
  try { mtime = fs.statSync(POLICY_PATH).mtimeMs; } catch { /* 파일 없음 → 기본값 */ }
  if (_cache.policy && mtime === _cache.mtime) return _cache.policy;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8')); } catch { /* */ }
  const policy = { ...DEFAULTS, ...raw, jev: { ...DEFAULTS.jev, ...(raw.jev || {}) } };
  _cache = { mtime, policy };
  return policy;
}

function clamp(key, v) {
  const [lo, hi] = CLAMPS[key] || [-Infinity, Infinity];
  return Math.min(hi, Math.max(lo, v));
}

// §14 라우트+신뢰도 게이트. 라우터의 원판정(confidence)을 정책 임계값과 비교해 최종 경로를
// 정한다 — 미달 시 "기존 QA 경로"로 후퇴하는 게 기본(발표 중단 방지, §33).
// 반환 exec: 'direct'(검증 지식 직답) | 'no_answer'(거절 멘트) | 'existing'(기존 QA 체인).
function applyThresholds(d, policy) {
  policy = policy || getPolicy();
  const conf = typeof d.confidence === 'number' ? d.confidence : 0;
  let route = d.route, exec = 'existing', reason = d.reason_code || '';
  if (route === 'DIRECT') {
    if (conf >= policy.direct_answer_high) exec = 'direct';
    else { route = 'RAG_LLM'; reason = 'below_direct_answer_high'; }
  } else if (route === 'NO_ANSWER') {
    if (conf >= policy.no_answer_high) exec = 'no_answer';
    else { route = 'RAG_LLM'; reason = 'below_no_answer_high'; } // 미달 → 기존 LLM 판단(§14)
  } else if (route === 'RAG_SHORT') {
    // RAG_SHORT는 LLM 없는 결정형 포맷터 — 신뢰도 낮으면 일반 RAG_LLM으로.
    if (conf < policy.answer_mid) { route = 'RAG_LLM'; reason = 'below_answer_mid'; }
  } else if (route === 'LLM_REASON' && conf < policy.llm_required_high) {
    route = 'RAG_LLM'; reason = 'below_llm_required_high';
  }
  return { route, exec, confidence: conf, reason_code: reason };
}

module.exports = { POLICY_PATH, DEFAULTS, CLAMPS, getPolicy, clamp, applyThresholds };
