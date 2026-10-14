#!/usr/bin/env node
// 통합 Q&A 배터리 [2026-10-14 Phase 4] — 실제 ppt-agent.html 스크립트를 node vm에서 실행(DOM은 Proxy 스텁)하고,
// /ppt-agent/api/* 호출을 실제 pt-agent 서버(env QA_BASE, 쿠키 QA_COOKIE)로 보내 generateAnswer를 끝까지 돌린다.
//  사용: QA_BASE=http://127.0.0.1:18124 QA_COOKIE=ppt_sid=... node battery/qa_e2e.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const BASE = process.env.QA_BASE, COOKIE = process.env.QA_COOKIE;
const html = fs.readFileSync(path.join(__dirname, '..', 'ppt-agent.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).sort((a, b) => b.length - a.length)[0];
const stub = new Proxy(function () {}, { get: (t, k) => k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : stub, apply: () => stub, construct: () => stub, set: () => true });
const store = {};
const sandbox = {
  console: { log() {}, warn() {}, error() {}, info() {} }, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Promise, JSON, Math, Date, Array, Object, String, Number, RegExp, Set, Map, Error, URL, AbortController, Float32Array, Int16Array, Uint8Array, ArrayBuffer, Blob, FormData, TextEncoder, TextDecoder,
  document: stub, navigator: { mediaDevices: null, userAgent: 'node' }, location: { hash: '', search: '', href: 'http://x/' }, localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, speechSynthesis: stub, Audio: stub, Image: stub, AudioContext: undefined, webkitAudioContext: undefined, requestAnimationFrame: () => 0, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
  fetch: async (u, o = {}) => {
    const url = String(u); if (!url.startsWith('/ppt-agent/')) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    return fetch(BASE + url, { ...o, headers: { ...(o.headers || {}), Cookie: COOKIE } });
  },
};
for (const k of Object.getOwnPropertyNames(globalThis)) if (!(k in sandbox) && !['process', 'global', 'require', 'module'].includes(k)) { try { sandbox[k] = globalThis[k]; } catch (_) {} }
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(script + '\n;globalThis.__api={generateAnswer,ConvMgr,NO_INFO_MSG,get slides(){return slides},set slides(v){slides=v},set curSlideIdx(v){curSlideIdx=v},set sentences(v){sentences=v},set curSentenceIdx(v){curSentenceIdx=v},set refDocs(v){refDocs=v},set ragEnabled(v){ragEnabled=v},get RAG_BUDGET_MS(){return RAG_BUDGET_MS}};', sandbox, { filename: 'ppt-agent.html' });
const A = sandbox.__api;
A.slides = [{ title: '서울시 IoT·AI 스마트돌봄 시범사업', bullets: [], script: '이번 사업을 소개합니다.' }, { title: '기존 IoT와의 차이', bullets: [], script: '기존 IoT는 센서 알림 중심이었습니다.' }];
A.curSlideIdx = 1; A.sentences = ['기존 IoT는 센서 알림 중심이었습니다.', '이번에는 AI가 더해집니다.']; A.curSentenceIdx = 0; A.refDocs = [{ id: 1 }]; A.ragEnabled = true;
const NO = A.NO_INFO_MSG;
const CASES = [
  ['direct', '이번 시범사업은 어떤 사업인가요?'], ['direct', '기존 IoT와 이번 AI 융합 서비스의 차이는 무엇인가요?'], ['direct', '개인정보와 사생활 침해 문제는 어떻게 관리하나요?'],
  ['direct', 'AI가 위험을 발견하면 자동으로 112나 119에 신고하나요?'], ['direct', '핵심 KPI는 무엇인가요?'], ['direct', '2027년에는 무엇을 확대하려고 하나요?'],
  ['term', 'BLE는 뭐에 쓰나요?'], ['term', 'IoT가 뭐예요?'],
  ['follow', ['개인정보와 사생활 침해 문제는 어떻게 관리하나요?', '그럼 외부로 나가는 건 없나요?']], ['follow', ['AI가 위험을 발견하면 자동으로 112나 119에 신고하나요?', '그건 왜 그런가요?']],
  ['follow', ['핵심 KPI는 무엇인가요?', '그거 어떻게 검증하나요?']], ['follow', ['이번 시범사업은 어떤 사업인가요?', '규모는요?']],
  ['none', '내년 정확한 사업예산은 얼마야?'], ['none', '이 사업의 감리 업체 이름은 뭐야?'], ['none', '삼성전자 주가는 얼마야?'], ['none', '밀양시 인구는 몇 명이야?'], ['none', '이번 사업 시공사는 어디야?'], ['none', '계약 금액은 정확히 얼마입니까?'],
];
(async () => {
  const rows = [];
  for (const [cat, q] of CASES) {
    A.ConvMgr.reset();
    let qs = Array.isArray(q) ? q : [q], last;
    for (const qq of qs) {
      const stats = { errors: [] }; stats.convPromise = A.ConvMgr.prepare(qq);
      const t0 = Date.now(); const ans = await A.generateAnswer(qq, null, stats).catch(e => 'ERR ' + e.message); const conv = await stats.convPromise;
      A.ConvMgr.record(conv, stats.ragMiss ? NO : ans, { unanswered: !!stats.ragMiss });
      last = { cat, q: qq, ans: String(ans), ms: Date.now() - t0, miss: !!stats.ragMiss, src: stats.source, why: stats.verifyWhy, rewritten: conv.rewritten, refs: stats.ragRefs, top: stats.ragTop, tierF: stats.tierFiltered };
    }
    rows.push(last);
    console.log(`[${cat}] ${last.q}${last.rewritten ? '  ⇒ ' + last.rewritten : ''}\n   ${last.miss ? '🚫 거절' : '✅ 답변'} (${last.ms}ms, src=${last.src || '-'}, refs=${last.refs}, ${last.why || ''}) ${last.ans.slice(0, 160)}`);
  }
  const by = c => rows.filter(r => r.cat === c);
  const ok = (c, f) => by(c).filter(f).length + '/' + by(c).length;
  console.log('\n요약 — 직접·용어 답변 성공', ok('direct', r => !r.miss), ok('term', r => !r.miss), '| 후속질문 답변', ok('follow', r => !r.miss), '| 근거없음 거절', ok('none', r => r.miss));
  fs.writeFileSync(path.join(__dirname, 'qa_e2e_last.json'), JSON.stringify(rows, null, 1));
})();
