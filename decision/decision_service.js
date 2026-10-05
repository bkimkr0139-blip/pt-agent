// [2026-10-05] Jev QA Router — 결정 서비스 (지시서 §11~12, §33~34).
// decideQA(): 판단체 실행 → 임계값 게이트 → 기록. 어느 단계가 실패해도 결과는 항상
// exec:'existing'(기존 QA 체인) — 발표 흐름 중단은 구조적으로 불가능(§33).
// Shadow 모드에서는 클라이언트가 이미 돌린 실제 QA 결과(actual)를 관찰해 함께 기록한다(§35).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getPolicy, applyThresholds } = require('./decision_policy');
const { PROVIDERS, detectPII } = require('./jev_client');
const { planFor } = require('./route_executor');

const LOG_PATH = process.env.PT_DECISION_DIR
  ? path.join(process.env.PT_DECISION_DIR, 'decision_log.jsonl')
  : path.join(__dirname, '..', 'eval', 'decision_log.jsonl');
const STATUS_PATH = process.env.PT_DECISION_DIR
  ? path.join(process.env.PT_DECISION_DIR, 'decision_status.json')
  : path.join(__dirname, '..', 'eval', 'decision_status.json');

function appendLog(rec) {
  try { fs.appendFileSync(LOG_PATH, JSON.stringify(rec) + '\n'); } catch (_) { /* 로그 실패가 QA를 죽이지 않는다 */ }
}

// 외부 판단체용 클라우드 호출 주입점 — server.js의 프록시/키/모델 시험 주입을 재사용한다.
let _cloudCall = null;
function setCloudCall(fn) { _cloudCall = fn; }

// input: {q, slideTitle, sessionMode, rag:{count,topScore,autoTop,sources}, actual:{engine,ragMiss,llmCalled,responseMs,ttsMs}, user}
async function decideQA(input) {
  const policy = getPolicy();
  if (policy.mode === 'off') return { engaged: false, mode: policy.mode };
  const t0 = Date.now();
  const pii = detectPII(input.q || '');
  const id = crypto.randomBytes(6).toString('hex');
  const rec = {
    ts: new Date().toISOString(), id, mode: policy.mode, policy_version: policy.version,
    user: input.user || null, q: pii ? '[PII 마스킹]' : input.q, q_len: (input.q || '').length,
    session_mode: input.sessionMode || null,
    slide: input.slideTitle || null,
    rag: { count: (input.rag && input.rag.count) || 0, topScore: input.rag ? input.rag.topScore : null, autoTop: !!(input.rag && input.rag.autoTop), sources: input.rag ? input.rag.sources : [] },
    decision: null, threshold: null,
    execution: { fallback: false, provider_error: null, response_ms: null, llm_called: null, plan_type: null },
    actual: input.actual || null,   // 섀도 관찰: 실제 체인이 한 일(엔진/거절여부/LLM호출/지연)
    outcome: input.outcome || null, // 라이브 이후 옵티마이저가 채우는 결과(재질문·중단 등)
    security: { fields_sent: null, pii_detected: pii },
  };
  // 1) 판단체 실행 — 기본 Rule(로컬, 즉답). 실패해도 항상 existing 폴백(§33).
  let d = null;
  try {
    if (policy.provider === 'rule') {
      d = PROVIDERS.rule(input);
    } else if (policy.provider === 'jev') {
      const r = await PROVIDERS.jev(input, policy.jev);
      if (r.ok) d = r.decision;
      else {
        // §34: Jev 타임아웃/장애 → 기존 QA로 즉시 폴백. Rule로 갈음하지 않는다(측정 오염 방지).
        rec.execution.fallback = true; rec.execution.provider_error = r.reason;
      }
    } else if (policy.provider === 'llm_judge' && _cloudCall) {
      const r = await PROVIDERS.llm_judge(input, _cloudCall);
      if (r.ok) d = r.decision;
      else { rec.execution.fallback = true; rec.execution.provider_error = r.reason; }
    } else {
      rec.execution.fallback = true; rec.execution.provider_error = 'provider-unavailable';
    }
  } catch (e) { rec.execution.fallback = true; rec.execution.provider_error = 'error:' + String(e.message).slice(0, 40); }
  if (d) {
    rec.decision = { route: d.route, answerability: d.answerability, rag_sufficiency: d.rag_sufficiency, requires_llm: !!d.requires_llm, should_interrupt: !!d.should_interrupt, should_acquire_knowledge: !!d.should_acquire_knowledge, confidence: d.confidence, reason_code: d.reason_code };
    rec.security.fields_sent = d.fields_sent;
    rec.execution.response_ms = d.response_ms;
    const g = applyThresholds(d, policy);
    rec.threshold = { route: g.route, exec: g.exec, reason_code: g.reason_code };
    rec.execution.plan_type = g.exec === 'existing' ? null : (planFor(g, d) || {}).type || null;
  }
  rec.execution.decision_ms = Date.now() - t0;
  appendLog(rec);
  // Shadow 모드에서는 판단이 사용자 경로에 절대 개입하지 않는다(§35) — engaged:false 고정.
  const engaged = policy.mode === 'active' || (policy.mode === 'canary' && rec.hashPct != null && rec.hashPct < policy.canary_pct);
  return { engaged: !!(engaged && !rec.execution.fallback && rec.threshold && rec.threshold.exec !== 'existing'), id, decision: rec.decision, threshold: rec.threshold, plan: rec.threshold && rec.threshold.exec !== 'existing' ? planFor(rec.threshold, d) : null, mode: policy.mode };
}

// 관리자 탭/상태용 지표 — 로그 꼬리 N건에서 산출(§12 KPI: LLM 회피율·오거절·오수용·지연).
function computeMetrics(tailN) {
  let lines = [];
  try {
    const all = fs.readFileSync(LOG_PATH, 'utf8').trim();
    lines = all ? all.split('\n').slice(-(tailN || 500)) : [];
  } catch { return { total: 0 }; }
  const recs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const n = recs.length;
  if (!n) return { total: 0 };
  const routes = {}; let avoid = 0, fReject = 0, fAccept = 0, fb = 0, actualN = 0;
  const lats = [];
  for (const r of recs) {
    const rt = (r.threshold && r.threshold.route) || (r.decision && r.decision.route) || '?';
    routes[rt] = (routes[rt] || 0) + 1;
    if (r.decision && !r.decision.requires_llm) avoid++;
    if (r.execution && r.execution.fallback) fb++;
    if (r.actual && r.actual.engine) {
      actualN++;
      if (r.actual.responseMs) lats.push(r.actual.responseMs);
      // 섀도 오류 판정: 거절 라우트를 냈는데 실제 체인은 답변함 → 오거절 후보.
      if ((rt === 'NO_ANSWER' || rt === 'ASK_CLARIFY') && r.actual.engine !== 'rag-miss') fReject++;
      // 직답/짧은답 라우트를 냈는데 실제 체인은 거절함 → 오수용 후보.
      if ((r.threshold && r.threshold.exec === 'direct') && r.actual.engine === 'rag-miss') fAccept++;
    }
  }
  const lat = lats.sort((a, b) => a - b);
  const pct = p => lat.length ? Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * p))]) : null;
  return {
    total: n, routes, fallback: fb,
    llm_avoidance: Math.round(100 * avoid / n),
    false_reject: actualN ? +(100 * fReject / actualN).toFixed(1) : null,
    false_accept: actualN ? +(100 * fAccept / actualN).toFixed(1) : null,
    answered_n: actualN,
    latency_ms: { p50: pct(0.5), p95: pct(0.95) },
  };
}

function writeStatus(extra) {
  const st = { generated_at: new Date().toISOString(), metrics: computeMetrics(1000), ...(extra || {}) };
  try { fs.writeFileSync(STATUS_PATH, JSON.stringify(st, null, 1)); } catch (_) {}
  return st;
}
function readStatus() { try { return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')); } catch { return null; } }

module.exports = { LOG_PATH, STATUS_PATH, decideQA, computeMetrics, writeStatus, readStatus, appendLog, setCloudCall };
