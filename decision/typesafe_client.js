// [2026-10-07] TypeSafe(Jev) 어댑터 — 상용 System One API ↔ 지시서 §5 결정 스키마 번역.
// Jev는 TypeSafe의 플래그십 System One 모델(https://docs.typesafe.ai). POST /v1/systemone
// 한 번의 호출에 여러 질문을 병렬 평가하므로 route/rag_sufficiency/needs_llm/acquire를
// 1콜로 얻는다(문서 권장: ask more than one question per call).
// §31 Local First: state는 질문+슬라이드 제목+RAG 요약뿐(PPT 원문 금지). API 키는
// TYPESAFE_API_KEY(또는 TYPESAFE_KEY) 환경변수로 서버 측만 보유 — 클라이언트로 절대 내보내지 않는다.
// Jev는 영어 기준 모델(문서: CJK 수용하나 정확도 낮음)이라 판정 기준(criteria)은 영어로
// 쓰고 state의 한국어 질문은 원문 유지 — 실측 배터리(eval/jev_battery.js)가 품질을 검증한다.

const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

// §5 라우트 화이트리스트 — Jev가 범위 밖 옵션을 내놓으면 RAG_LLM으로 강등(안전 기본값).
const ROUTES = ['DIRECT', 'RAG_SHORT', 'RAG_LLM', 'LLM_REASON', 'NO_ANSWER', 'ASK_CLARIFY'];
const ANSWERABILITY_BY_ROUTE = {
  DIRECT: 'yes', RAG_SHORT: 'yes', RAG_LLM: 'yes', LLM_REASON: 'partial', NO_ANSWER: 'no', ASK_CLARIFY: 'unclear',
};

// criteria는 영어 — jev_client.js ruleDecide(v1)와 같은 의미론의 영어판.
const QA_QUESTIONS = () => ({
  route: {
    type: 'choice',
    instructions: 'This is a live Q&A during a slide presentation. Retrieval already ran against the presentation knowledge base and returned the reference_count references shown in the state; top_score is the best similarity (0~1) and acquired marks whether the best reference was automatically acquired knowledge for this kind of question. Which route should this question take?',
    criteria: {
      DIRECT: 'The best reference is verified knowledge that directly answers the question; give a short direct answer without LLM generation',
      RAG_SHORT: 'A short answer can be extracted directly from the retrieved references without LLM generation',
      RAG_LLM: 'Answer by combining the retrieved references with LLM generation (default for on-topic questions)',
      LLM_REASON: 'Needs reasoning, comparison, or evaluation beyond restating the references',
      NO_ANSWER: 'The presentation material cannot plausibly answer this; decline and consider acquiring external knowledge',
      ASK_CLARIFY: 'Too vague or fragmentary to interpret as a question',
    },
  },
  rag_sufficiency: {
    type: 'choice',
    instructions: 'How sufficient are the retrieved references (see retrieval in the state) for answering this question?',
    criteria: {
      sufficient: 'References clearly contain the answer',
      partial: 'References help but do not fully cover the question',
      insufficient: 'References only marginally relate to the question',
      none: 'No usable references',
    },
  },
  needs_llm: {
    type: 'noul',
    instructions: 'Would a good answer require free-form generation or reasoning, rather than extracting a fact directly from the retrieved references?',
    criteria: { true: 'Needs generation or reasoning', false: 'A short extraction from references or acquired knowledge suffices' },
  },
  acquire: {
    type: 'noul',
    instructions: 'Is this question about something the presentation deck could not plausibly contain — e.g. general world knowledge, news, or current events — such that acquiring new knowledge from an external source is warranted before answering?',
    criteria: { true: 'External knowledge acquisition is warranted', false: 'The deck or already-acquired knowledge plausibly covers it' },
  },
});

function buildState(input) {
  return {
    question: input.q || '',
    slide_title: input.slideTitle || null,
    retrieval: {
      reference_count: (input.rag && input.rag.count) || 0,
      top_score: input.rag ? input.rag.topScore : null,
      best_is_acquired_knowledge: !!(input.rag && input.rag.autoTop),
    },
  };
}

// input(q/slideTitle/rag) → §5 스키마 decision. jevDecide(kind:'typesafe')와 배터리가 직접 사용.
async function typesafeDecide(input, cfg) {
  const t0 = Date.now();
  cfg = cfg || {};
  const key = process.env.TYPESAFE_API_KEY || process.env.TYPESAFE_KEY;
  if (!key) return { ok: false, reason: 'typesafe-no-key' };
  const ctx = {
    question: input.q, slide_title: input.slideTitle || null,
    rag_top_score: input.rag ? input.rag.topScore : null, rag_reference_count: (input.rag && input.rag.count) || 0,
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeout_ms || 3000);
  try {
    const r = await fetch(cfg.endpoint || TYPESAFE_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: buildState(input), model: cfg.model || 'jev-latest', questions: QA_QUESTIONS() }),
      signal: ac.signal,
    });
    if (!r.ok) {
      let detail = '';
      try { const j = await r.json(); detail = (j && (j.message || j.error)) ? String(j.message || j.error).slice(0, 60) : ''; } catch (_) { /* */ }
      return { ok: false, reason: 'typesafe-http-' + r.status + (detail ? ':' + detail : ''), response_ms: Date.now() - t0 };
    }
    const j = await r.json();
    const a = (j && j.answers) || {};
    const routeOk = !!(a.route && ROUTES.includes(a.route.choice));
    const route = routeOk ? a.route.choice : 'RAG_LLM';
    return { ok: true, decision: {
      route, answerability: ANSWERABILITY_BY_ROUTE[route],
      rag_sufficiency: (a.rag_sufficiency && a.rag_sufficiency.choice) || 'unknown',
      requires_llm: !!(a.needs_llm && a.needs_llm.noul >= 0.5),
      should_acquire_knowledge: !!(a.acquire && a.acquire.noul >= 0.5),
      confidence: a.route ? Number(a.route.confidence) || 0.5 : 0.5,
      reason_code: routeOk ? 'jev-choice' : 'jev-route-invalid',
      provider: 'jev', model: (j && j.model) || cfg.model || 'jev-latest',
      request_ms: 0, response_ms: Date.now() - t0,
      fields_sent: Object.keys(ctx), pii_detected: require('./jev_client').detectPII(input.q || ''),
      usage: (j && j.usage) || null,
      probabilities: routeOk ? a.route.probabilities : null,  // 로그·배터리 분석용 — 외부 전송 없음
    } };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'typesafe-timeout' : 'typesafe-error:' + String(e.message).slice(0, 40), response_ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

// CLI 스모크: node decision/typesafe_client.js '질문' [참조수] [최고점수] ['슬라이드제목'] [autoTop 0|1]
if (require.main === module) {
  const [q, refs, top, slide, autoTop] = process.argv.slice(2);
  typesafeDecide(
    { q, slideTitle: slide || null, rag: { count: Number(refs || 0), topScore: Number(top || 0), autoTop: autoTop === '1' } },
    { timeout_ms: Number(process.env.TS_TIMEOUT || 8000) }
  ).then(r => console.log(JSON.stringify(r, null, 2)));
}

module.exports = { TYPESAFE_ENDPOINT, typesafeDecide, buildState, QA_QUESTIONS };
