#!/usr/bin/env node
// RAG 평가 하네스 [2026-10-14, 고도화 지시서 §5.9] — 100문항 평가셋 생성(gen) + 검색 변형 비교(run).
//  node battery/rag_eval.js gen   → battery/rag_evalset.json (질문·정답 청크 seq 집합) 생성
//  node battery/rag_eval.js run   → Recall@3/@5·MRR을 범주별·변형별(legacy/dense/bm25/hybrid/hybrid+rerank)로 출력
// 임베딩·LLM은 n8n 게이트웨이(키는 LaunchAgent plist에서 읽음 — 출력하지 않음). 정답 청크는 "문서 49(수동 등록 Q&A 문서)"의 seq.
const fs = require('fs'), cp = require('child_process'), path = require('path');
const Database = require('better-sqlite3');
const rag = require('../lib/rag');
const DOC = +(process.env.DOC || 49), DB = path.join(__dirname, '..', 'data', 'app.db');
const SET = path.join(__dirname, 'rag_evalset.json'), EMB = path.join('/tmp', 'rag_eval_emb.json');
const KEY = cp.execSync("/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:N8N_KEY' ~/Library/LaunchAgents/ai.wizbase.bcai.pt-agent.plist").toString().trim();
const db = new Database(DB, { readonly: true });
const chunks = db.prepare('SELECT seq,text,embedding FROM chunks WHERE document_id=? ORDER BY seq').all(DOC)
  .map(r => ({ seq: r.seq, text: r.text, emb: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4), title: (/^#+\s*(.+)/.exec(r.text) || [])[1] || '' }));
const rawFetch = globalThis.fetch;
const post = (hook, body) => rawFetch('http://127.0.0.1:5678/webhook/' + hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, key: KEY }) }).then(r => r.json());
const llm = async (p) => ((await post('koen-local-llm', { messages: [{ role: 'user', content: p }] })).message || {}).content?.trim() || '';
const embCache = fs.existsSync(EMB) ? JSON.parse(fs.readFileSync(EMB, 'utf8')) : {};
async function embed(q) {
  if (embCache[q]) return Float32Array.from(embCache[q]);
  const j = await post('koen-openai-embed', { input: q });
  embCache[q] = j.embedding; fs.writeFileSync(EMB, JSON.stringify(embCache));
  return Float32Array.from(j.embedding);
}
const field = (t, k) => { const m = new RegExp('\\*\\*' + k + ':\\*\\*\\s*([\\s\\S]*?)(?:\\n\\n|$)').exec(t); return m ? m[1].trim() : ''; };
const qa = chunks.filter(c => /\*\*대표 질문/.test(c.text));
const pick = (arr, n, off = 0) => Array.from({ length: n }, (_, i) => arr[(Math.floor(i * arr.length / n) + off) % arr.length]);

async function gen() {
  const set = [];
  // ① 직접 문장 질문 25 — 청크의 '유사 질문' 첫 문장 그대로
  for (const c of pick(qa, 25, 0)) { const q = (field(c.text, '유사 질문').split(/(?<=\?)\s*/)[0] || field(c.text, '대표 질문')).trim(); set.push({ cat: 'direct', q, gold: [c.seq] }); }
  // ② 표현 변형 25 — 답변 내용만 보고 구어체로 새로 묻기(제목·키워드 단어 회피)
  for (const c of pick(qa, 25, 7)) {
    const p = '다음은 발표 자료의 한 대목입니다. 청중이 발표 중에 이 내용을 궁금해하며 음성으로 질문한다고 가정하고, 질문 한 문장만 쓰세요.\n규칙: 구어체로 20~40자, 아래 [제목]·[키워드]에 쓰인 단어는 피하고 다른 표현으로 돌려 말할 것, 질문만 출력.\n[제목] ' + c.title + '\n[키워드] ' + field(c.text, '검색 키워드') + '\n[내용] ' + field(c.text, '답변').slice(0, 500);
    set.push({ cat: 'paraphrase', q: (await llm(p)).split('\n')[0].replace(/^["“]|["”]$/g, ''), gold: [c.seq] });
  }
  // ③ 후속질문 20 — 직전 질문(대표 질문)+지시어 짧은 후속질문(LLM 생성)
  for (const c of pick(qa, 20, 3)) {
    const prev = field(c.text, '대표 질문');
    const p = '발표 중 청중이 "' + prev + '" 라고 묻고 발표자가 아래 내용으로 답했습니다. 청중이 이어서 묻는 아주 짧은 후속 질문(8~16자)을 한 개만 쓰세요. 반드시 "그거·그건·그 부분·그러면·아까" 같은 지시어나 생략형을 쓰고, 질문 주제어는 다시 말하지 마세요. 질문만 출력.\n[답변] ' + field(c.text, '답변').slice(0, 300);
    set.push({ cat: 'followup', prev, q: (await llm(p)).split('\n')[0].replace(/^["“]|["”]$/g, ''), gold: [c.seq] });
  }
  // ④ 고유명사·약어 10 / ⑤ 숫자·수치 10 — 문서 내용에서 직접 고른 실제형 질문(정답=해당 주제를 다루는 청크 seq, seq=RAG-QA 번호+2)
  const PROPER = [['BLE는 뭐에 쓰나요?', [14]], ['L1부터 L4까지가 뭔가요?', [50]], ['위즈베이스는 뭘 맡나요?', [12]], ['돌봄프로필이 뭐예요?', [32, 29]], ['전담사회복지사는 무슨 일을 해요?', [11]], ['통합앱이 현장 일을 어떻게 줄여요?', [13]], ['AI 말동무는 뭐예요?', [23]], ['KPI 세 가지가 뭐예요?', [29]], ['교차검증은 어떻게 해요?', [33]], ['음성AI는 야간에 뭘 해요?', [21, 22]]];
  const NUMBER = [['1,300가구가 모두 참여하나요?', [10]], ['과거 1,000가구 데이터가 있으면 바로 쓸 수 있나요?', [19]], ['2주에서 4주 기준은 왜예요?', [17]], ['5일 미션은 왜 하는 거예요?', [28]], ['112나 119에 자동 신고해요?', [26]], ['2027년에는 뭘 확대해요?', [41]], ['정확도가 몇 퍼센트예요?', [35]], ['KPI 달성률이 몇 퍼센트예요?', [34]], ['몇 개 기관이 참여해요?', [10]], ['시범사업 기간이 언제부터 언제까지예요?', [10]]];
  PROPER.forEach(([q, gold]) => set.push({ cat: 'proper', q, gold }));
  NUMBER.forEach(([q, gold]) => set.push({ cat: 'number', q, gold }));
  // ⑥ 근거 없음 10 — 문서에 없는 주제
  ['내년 정확한 사업예산은 얼마야?', '서울시장이 누구야?', '삼성전자 주가는 얼마야?', '이번 사업 시공사는 어디야?', '오늘 점심 메뉴 추천해 줘', '양자컴퓨터는 언제 상용화돼?', '밀양시 인구는 몇 명이야?', '이 사업의 감리 업체 이름은 뭐야?', '파이썬으로 리스트 정렬하는 방법 알려줘', '비트코인 가격 전망은 어때?']
    .forEach(q => set.push({ cat: 'noanswer', q, gold: [] }));
  fs.writeFileSync(SET, JSON.stringify(set, null, 1));
  const by = {}; set.forEach(x => by[x.cat] = (by[x.cat] || 0) + 1); console.log('평가셋', set.length, by, '→', SET);
}

const cosine = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / Math.sqrt(na * nb); };
const bg = t => { const s = new Set(); const k = String(t).replace(/[^가-힣]/g, ''); for (let i = 0; i < k.length - 1; i++) s.add(k.slice(i, i + 2)); return s; };
const idx = new rag.Bm25(chunks.map(c => ({ id: c.seq, text: c.text })));
function variants(qText, qEmb) {
  const dense = chunks.map(c => cosine(qEmb, c.emb));
  const bm = idx.score(qText);
  const rows = chunks.map((c, i) => ({ id: c.seq, text: c.text, title: c.title, dense: dense[i] }));
  const order = a => a.map((_, i) => i).sort((x, y) => a[y] - a[x]).map(i => chunks[i].seq);
  // legacy: 구 파이프라인(코사인 × 어휘 2-gram 가점)
  const qb = bg(qText);
  const legacy = chunks.map((c, i) => { const b = bg(c.text); let h = 0; for (const x of qb) if (b.has(x)) h++; return dense[i] * (1 + 0.25 * Math.min(1, h / Math.max(1, qb.size))); });
  const fused = rag.fuse(rows, bm);
  const rr = rag.rerank(qText, fused, rows);
  const prodRows = chunks.map((c, i) => ({ id: c.seq, seq: c.seq, text: c.text, dense: dense[i], docId: DOC, docName: 'doc', origin: 'manual', confidence: 1, project: '', meta: { title: c.title } }));
  const prod = rag.rankChunks(prodRows, { qText, k: 5, index: idx }).refs.map(r => r.seq);   // 서버 /api/search와 동일 함수(컷 포함)
  return { deployed: prod, legacy: order(legacy), dense: order(dense), bm25: order(Array.from(bm)), hybrid: fused.map(f => chunks[f.i].seq), 'hybrid+rerank': rr.map(f => chunks[f.i].seq), _top: { dense: Math.max(...dense), rr: rr[0] && rr[0].rerank, bm: Math.max(...bm) } };
}
async function run() {
  const set = JSON.parse(fs.readFileSync(SET, 'utf8'));
  const C = require('./_conv_loader')(db);   // ConvMgr (후속질문 재작성 재사용)
  const names = ['legacy', 'dense', 'bm25', 'hybrid', 'hybrid+rerank', 'deployed', 'hybrid+llm'];
  const llmMs = [];
  const agg = {}; const top = { answer: [], noanswer: [] };
  for (const it of set) {
    let qText = it.q;
    if (it.cat === 'followup') { C.reset(); const p = await C.prepare(it.prev); C.record(p, '(이전 답변)', {}); const r = await C.prepare(it.q); qText = r.query; it.rewritten = r.rewritten; }
    const v = variants(qText, await embed(qText));
    if (it.cat === 'noanswer') { top.noanswer.push(v._top); continue; }
    if (process.env.LLMRR !== '0') {   // LLM listwise 재랭크 — 하이브리드 상위 8을 질문과의 관련 순으로 재정렬(지연 측정)
      const cand = v.hybrid.slice(0, 8), t0 = Date.now();
      const body = cand.map((sq, i) => '[' + (i + 1) + '] ' + chunks.find(c => c.seq === sq).text.replace(/\s+/g, ' ').slice(0, 260)).join('\n');
      const out = await llm('질문에 답하는 데 가장 도움이 되는 순서대로 아래 후보 번호를 나열하세요. 번호만 쉼표로 출력하세요.\n[질문] ' + qText + '\n' + body + '\n[순서]');
      llmMs.push(Date.now() - t0);
      const ord = Array.from(new Set((out.match(/\d+/g) || []).map(Number).filter(n => n >= 1 && n <= cand.length))).map(n => cand[n - 1]);
      v['hybrid+llm'] = ord.concat(cand.filter(x => !ord.includes(x)), v.hybrid.slice(8));
    } else v['hybrid+llm'] = v.hybrid;
    top.answer.push(v._top);
    for (const n of names) {
      const rank = v[n].findIndex(s => it.gold.includes(s)) + 1;   // 정답 집합 중 가장 앞선 순위
      for (const key of [it.cat, 'ALL']) {
        const a = (agg[key] ||= {}); const x = (a[n] ||= { n: 0, r3: 0, r5: 0, mrr: 0 });
        x.n++; if (rank && rank <= 3) x.r3++; if (rank && rank <= 5) x.r5++; if (rank) x.mrr += 1 / rank;
        if (process.env.V && n === 'hybrid' && (!rank || rank > 3)) console.log('MISS', it.cat, '|', it.q, '→', qText.slice(0, 50), '| gold', it.gold.join(','), 'got', v[n].slice(0, 3).join(','));
      }
    }
  }
  const pct = (a, b) => (100 * a / b).toFixed(1).padStart(5) + '%';
  console.log('범주'.padEnd(10), '변형'.padEnd(14), 'n'.padStart(3), 'R@3'.padStart(7), 'R@5'.padStart(7), 'MRR'.padStart(6));
  for (const k of [...Object.keys(agg).filter(x => x !== 'ALL'), 'ALL']) for (const n of names) { const x = agg[k][n]; console.log(k.padEnd(10), n.padEnd(14), String(x.n).padStart(3), pct(x.r3, x.n).padStart(7), pct(x.r5, x.n).padStart(7), (x.mrr / x.n).toFixed(3).padStart(6)); }
  const q = a => { const s = [...a].sort((x, y) => x - y); return s.length ? [s[0], s[Math.floor(s.length / 2)], s[s.length - 1]].map(x => +x.toFixed(3)) : []; };
  console.log('상위 dense 점수(min/p50/max) 답변가능', q(top.answer.map(x => x.dense)), '근거없음', q(top.noanswer.map(x => x.dense)));
  console.log('상위 rerank 점수(min/p50/max) 답변가능', q(top.answer.map(x => x.rr)), '근거없음', q(top.noanswer.map(x => x.rr)));
  if (llmMs.length) { llmMs.sort((a, b) => a - b); console.log('LLM 재랭크 지연 p50/max ms', llmMs[Math.floor(llmMs.length / 2)], llmMs[llmMs.length - 1]); }
  fs.writeFileSync(path.join(__dirname, 'rag_eval_last.json'), JSON.stringify({ at: new Date().toISOString(), agg, top }, null, 1));
}
(async () => { const m = process.argv[2]; if (m === 'gen') await gen(); else if (m === 'run') await run(); else console.log('usage: gen|run'); })();
