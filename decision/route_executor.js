// [2026-10-05] Jev QA Router — 라우트 실행 계획 (지시서 §28 Route Executor).
// 섀도 모드에서는 실행이 없다(관찰만). canary/active에서 클라이언트가 수행할 "실행 계획"을
// 순수 함수로 산출한다 — 서버가 직답 본문을 만들지 않고, 클라이언트의 기존 자원(검색 결과·
// RAG_MISS_MSG·프리캐시 멘트)을 재지시하는 방식이라 LLM 없는 라우트는 정말 LLM 없이 돈다.
// 항상 null을 돌려도 안전(null = 기존 경로).

// g: applyThresholds 결과 {route, exec, confidence}, d: 판단체 원판정
function planFor(g, d) {
  if (!g || g.exec === 'existing') return null; // 기존 QA 체인 그대로(§14 미달 후퇴)
  if (g.exec === 'no_answer') {
    return { type: 'no_answer', say: 'rag_miss', acquire: !!(d && d.should_acquire_knowledge) };
    // say:'rag_miss' — 클라이언트의 RAG_MISS_MSG(센티널 원칙: 거절 문구는 LLM이 만들지 않음)
  }
  if (g.exec === 'direct') {
    return { type: 'direct', use: 'top_reference', lead: true };
    // 클라이언트가 이미 받은 검색 1위 참조(자동 지식)를 포맷터로 감싸 바로 발화 — LLM 0회.
  }
  return null;
}

module.exports = { planFor };
