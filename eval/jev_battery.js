// [2026-10-07] Jev(TypeSafe) 섀도 배터리 — decision_log.jsonl의 실측 샘플을 상용 Jev로 재생해
// rule-v1과 대조한다(라우트 일치율·거절 합의·지연·토큰). 지시서 §12 KPI 실측 + 백로그 ③.
// 사용: TYPESAFE_KEY=... node eval/jev_battery.js [샘플수]
// 429/529는 1회 백오프 재시도 — 섀도 트래픽이 본 경로를 밀지 않는다(§35).
const fs = require('fs');
const path = require('path');
const { typesafeDecide } = require('../decision/typesafe_client');

const LOG = path.join(__dirname, 'decision_log.jsonl');
const GAP_MS = 350;  // 레이트리밋 배려 샷 간격

const pct = arr => p => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null;

async function main() {
  const limit = Number(process.argv[2] || 60);
  const recs = fs.readFileSync(LOG, 'utf8').trim().split('\n')
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(r => r && r.provider !== 'jev-shadow' && r.q && r.q !== '[PII 마스킹]')
    .slice(-limit);
  if (!recs.length) { console.log('재생할 샘플이 없습니다:', LOG); return; }
  console.log(`샘플 ${recs.length}건 재생 시작 (간격 ${GAP_MS}ms)…\n`);
  let agree = 0, judged = 0, tokens = 0, cost = 0;
  let missN = 0, missReject = 0, ansN = 0, ansFalseReject = 0;
  const lats = [], rows = [], misses = [];
  for (const r of recs) {
    const input = { q: r.q, slideTitle: r.slide, rag: { count: r.rag && r.rag.count, topScore: r.rag ? r.rag.topScore : 0, autoTop: !!(r.rag && r.rag.autoTop) } };
    let res = await typesafeDecide(input, { timeout_ms: Number(process.env.TS_TIMEOUT || 8000) });
    if (!res.ok && ['typesafe-http-429', 'typesafe-http-529'].includes(res.reason)) {
      await new Promise(ok => setTimeout(ok, 2500));  // 백오프 후 1회 재시도
      res = await typesafeDecide(input, { timeout_ms: Number(process.env.TS_TIMEOUT || 8000) });
    }
    const ruleRoute = (r.threshold && r.threshold.route) || (r.decision && r.decision.route) || '?';
    if (!res.ok) { rows.push([r.q.slice(0, 22), ruleRoute, 'ERR:' + res.reason]); continue; }
    const d = res.decision;
    lats.push(d.response_ms);
    if (d.usage) tokens += (d.usage.input_tokens || 0) + (d.usage.output_tokens || 0);
    judged++;
    if (d.route === ruleRoute) agree++;
    const actualMiss = r.actual ? r.actual.engine === 'rag-miss' : null;
    if (actualMiss === true) { missN++; if (d.route === 'NO_ANSWER') missReject++; else misses.push(r.q + ' → ' + d.route); }
    else if (actualMiss === false) { ansN++; if (d.route === 'NO_ANSWER') { ansFalseReject++; misses.push(r.q + ' → 오거절'); } }
    rows.push([r.q.slice(0, 22), ruleRoute, d.route, d.route === ruleRoute ? '=' : 'X', String(d.confidence), d.response_ms + 'ms']);
    await new Promise(ok => setTimeout(ok, GAP_MS));
  }
  const p = pct(lats.slice().sort((a, b) => a - b));
  const w = [24, 11, 11, 2, 5, 8];
  console.log(rows.map(r => r.map((c, i) => String(c).padEnd(w[i])).join(' ')).join('\n'));
  console.log('\n── 요약 ──────────────────────────────');
  console.log(`라우트 일치(rule-v1 대비): ${agree}/${judged} = ${judged ? Math.round(100 * agree / judged) : 0}%`);
  console.log(`거절 합의(RAG미스→NO_ANSWER): ${missReject}/${missN}   오거절(답변됐는데 NO_ANSWER): ${ansFalseReject}/${ansN}`);
  console.log(`지연 p50/p95: ${p(0.5)}ms / ${p(0.95)}ms (rule-v1: 0ms)`);
  console.log(`토큰 합계: ${tokens}   실패: ${rows.filter(r => String(r[2]).startsWith('ERR')).length}건`);
  if (misses.length) console.log('불일치 상세:\n  ' + misses.join('\n  '));
}
main().catch(e => { console.error('배터리 실패:', e.message); process.exit(1); });
