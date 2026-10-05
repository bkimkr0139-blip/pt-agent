// [2026-10-05] Jev QA Router — DecisionProvider 추상화 (지시서 §30~32).
// "Jev 자체 도입이 목적이 아니라 결정 레이어가 목적"(§44)이므로 코드는 어느 판단체에도
// 종속되지 않는다: Rule(로컬 규칙, 1차 기본) / Jev(설정형 엔드포인트 슬롯) / LLMJudge
// (n8n 클라우드, 롤백 타깃). 모든 판단체는 같은 출력 스키마(§5)를 낸다.
//
// §31 Local First: 외부 판단체에는 질문+슬라이드 제목+RAG 점수 요약만 보낸다(PPT 원문 금지).
// §32 무엇을 보냈는지 fields_sent에 남긴다.

// ── PII 간이 탐지(§32) — 전화번호/이메일/주민번호 패턴. 탐지 시 외부 전송 필드에서 마스킹.
const PII_RES = [
  [/\b\d{3}-\d{2}-\d{5}\b/, '주민번호'],
  [/\b\d{2,3}-\d{3,4}-\d{4}\b/, '전화번호'],
  [/[\w.+-]+@[\w-]+\.[\w.]+/, '이메일'],
];
function detectPII(q) {
  for (const [re, kind] of PII_RES) if (re.test(q)) return kind;
  return null;
}
function minimalContext(input) {
  // 외부 전송 허용 필드 — 질문/슬라이드 제목/RAG 점수 요약만(본문·원문 전송 금지).
  return {
    question: input.q,
    slide_title: input.slideTitle || null,
    rag_top_score: input.rag ? input.rag.topScore : null,
    rag_reference_count: input.rag ? input.rag.count : null,
  };
}

// ── 1차 판단체: 로컬 규칙 라우터(§30 RuleDecisionProvider) ──────────────────
// 측정 사실 기반 설계: 절대 점수는 무관/관련을 못 가른다(무관 0.374 vs 자동지식 관련 0.536/0.740,
// 덱 본문 0.28~0.5가 뒤섞임). 그래서 규칙은 (1) 참조 유무 (2) 질문 유형 (3) 참조 출처(auto 지식은
// "그 질문을 위해 검증돼 습득된 것")를 쓰고, 절대 점수는 보조 신호로만 둔다. 섀도 모드가 이
// 휴리스틱의 실측 보정을 담당한다.
const RE_REASON = /(왜|어떻게|차이|비교|장단점|어떤|영향|근거|이유|생각|평가|설계|전략)/;
const RE_DEF = /(무슨 뜻|뭐예요|무엇|뭐야|meaning|what is|설명해|알려줘|정의)/i;
const RE_VAGUE = /^(이게|그게|그거|이거|저거)[.?!]?$|^.{0,3}$/; // 대명사뿐·과초단 질문
function ruleDecide(input) {
  const t0 = Date.now();
  const q = (input.q || '').trim();
  const refs = (input.rag && input.rag.count) || 0;
  const top = (input.rag && input.rag.topScore) || 0;
  const autoTop = !!(input.rag && input.rag.autoTop); // 최고 점수 참조가 자동 습득 지식
  const pii = detectPII(q);
  let d;
  if (RE_VAGUE.test(q)) {
    d = { route: 'ASK_CLARIFY', answerability: 'unclear', rag_sufficiency: 'none', requires_llm: false, confidence: 0.55, reason_code: 'vague_question' };
  } else if (!refs) {
    // 기존 클라이언트 체인과 동일 판정(참조 0 → 거절) — 섀도 합의율의 기준선.
    d = { route: 'NO_ANSWER', answerability: 'no', rag_sufficiency: 'none', requires_llm: false, should_acquire_knowledge: true, confidence: 0.95, reason_code: 'no_references' };
  } else if (RE_DEF.test(q) && autoTop && top >= 0.50) {
    // 정의형 질문 + 자동 습득 지식이 최고 점수 → 그 지식이 곧 검증된 직답(LLM 불필요, §6 DIRECT).
    // 기준 0.50·계수 0.45는 실측 보정(2026-10-05 평가): 자동지식 점수대 0.536~0.740에서
    // conf 0.94~0.95 → direct 게이트(0.92) 통과. 보정 전엔 rbac 0.898·ssot 미진입으로 절감 2건 모두 탈락.
    d = { route: 'DIRECT', answerability: 'yes', rag_sufficiency: 'sufficient', requires_llm: false, confidence: Math.min(0.95, 0.70 + top * 0.45), reason_code: 'auto_knowledge_definitional' };
  } else if (RE_REASON.test(q)) {
    // 추론/비교/평가형 — RAG만으론 불충분, LLM 추론 필요.
    d = { route: 'LLM_REASON', answerability: 'partial', rag_sufficiency: refs >= 2 ? 'partial' : 'insufficient', requires_llm: true, confidence: refs >= 2 ? 0.8 : 0.7, reason_code: 'reasoning_question' };
  } else if (top >= 0.55 && RE_DEF.test(q)) {
    d = { route: 'RAG_SHORT', answerability: 'yes', rag_sufficiency: 'sufficient', requires_llm: false, confidence: 0.7, reason_code: 'definitional_strong_ref' };
  } else {
    d = { route: 'RAG_LLM', answerability: 'yes', rag_sufficiency: 'partial', requires_llm: true, confidence: 0.85, reason_code: 'default_rag_with_references' };
  }
  return {
    ...d, provider: 'rule', model: 'rule-v1', request_ms: 0, response_ms: Date.now() - t0,
    fields_sent: ['q', 'rag.count', 'rag.topScore'], pii_detected: pii,
  };
}

// ── 설정형 슬롯: JevDecisionProvider (§30) — policy.jev.url에 실제 엔드포인트가 설정됐을 때만 활성.
async function jevDecide(input, cfg) {
  const t0 = Date.now();
  if (!cfg || !cfg.url) return { ok: false, reason: 'jev-not-configured' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeout_ms || 300); // §34 300ms 예산
  try {
    const r = await fetch(cfg.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...minimalContext(input), task: 'qa_route' }), signal: ac.signal,
    });
    const j = await r.json();
    return { ok: true, decision: {
      route: String(j.route || 'RAG_LLM'), answerability: j.answerability || 'unknown',
      rag_sufficiency: j.rag_sufficiency || 'unknown', requires_llm: !!j.requires_llm,
      should_acquire_knowledge: !!j.should_acquire_knowledge, confidence: Number(j.confidence) || 0.5,
      reason_code: j.reason_code || 'jev', provider: 'jev', model: j.model || 'jev',
      request_ms: 0, response_ms: Date.now() - t0,
      fields_sent: Object.keys(minimalContext(input)), pii_detected: detectPII(input.q || ''),
    } };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'jev-timeout' : 'jev-error', response_ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

// ── 롤백 타깃: LLMJudgeProvider (§30) — n8n 클라우드 LLM으로 라우트를 JSON으로 판정.
// cloudCall({content})는 server.js가 주입(프록시/키/모델 시험 주입 포함) — 이 모듈은 순수 유지.
const JUDGE_PROMPT = q => `당신은 발표 질의응답 라우터입니다. 아래 QA 상황을 다음 중 하나로 판정해 JSON 한 줄로만 답하세요.
라우트: DIRECT(검증된 지식으로 직답 가능) / RAG_SHORT(참조만으로 짧은 답) / RAG_LLM(참조+LLM 답변) / LLM_REASON(추론형) / NO_ANSWER(답변 불가) / ASK_CLARIFY(모호한 질문)
형식: {"route":"...","answerability":"yes|partial|no|unclear","rag_sufficiency":"sufficient|partial|insufficient|none","requires_llm":true|false,"should_acquire_knowledge":true|false,"confidence":0.0~1.0}
[상황] 질문: ${q.question}\n슬라이드 제목: ${q.slide_title || '-'}\nRAG: 참조 ${q.rag_reference_count}건, 최고 점수 ${q.rag_top_score}`;
async function llmJudgeDecide(input, cloudCall) {
  const t0 = Date.now();
  const ctx = minimalContext(input);
  try {
    const r = await cloudCall({ content: JUDGE_PROMPT(ctx) });
    if (!r || !r.ok || !r.content) return { ok: false, reason: (r && r.reason) || 'judge-empty' };
    const m = String(r.content).match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : null;
    if (!j || !j.route) return { ok: false, reason: 'judge-parse' };
    return { ok: true, decision: {
      route: String(j.route), answerability: j.answerability || 'unknown',
      rag_sufficiency: j.rag_sufficiency || 'unknown', requires_llm: !!j.requires_llm,
      should_acquire_knowledge: !!j.should_acquire_knowledge, confidence: Number(j.confidence) || 0.5,
      reason_code: 'llm_judge', provider: 'llm_judge', model: r.model || 'cloud',
      request_ms: 0, response_ms: Date.now() - t0,
      fields_sent: Object.keys(ctx), pii_detected: detectPII(input.q || ''),
    } };
  } catch (e) { return { ok: false, reason: 'judge-error', response_ms: Date.now() - t0 }; }
}

const PROVIDERS = { rule: ruleDecide, jev: jevDecide, llm_judge: llmJudgeDecide };
module.exports = { PROVIDERS, ruleDecide, jevDecide, llmJudgeDecide, detectPII, minimalContext, RE_REASON, RE_DEF, RE_VAGUE };
