// Hybrid RAG 모듈 — Dense(임베딩) + BM25(어휘) 융합 + 로컬 특징 재랭커. [2026-10-14 고도화 Phase 2]
// 설계 메모:
//  · 한국어는 조사·어미가 붙어 단어 경계 토큰이 약하므로 한글 구간은 문자 2-gram, 영문·숫자는 통짜 토큰(소문자, 숫자 콤마 제거)으로 색인한다.
//    고유명사·약어·숫자·모델명(IoT, L3, 1,300)에 BM25가 강하다 — Dense의 약점을 메운다.
//  · Dense 점수는 임베딩 배경 유사도가 높아(무작위 쌍 중앙값 0.46) 단독 컷이 불안정 → 후보 풀 안에서 min-max 정규화 후 BM25와 가중 융합한다.
//  · 재랭커는 외부 모델 없이 결정적 특징 조합(융합점수·질문어 커버리지·제목 일치·숫자/고유토큰 정확 일치). 지연 0ms.
const STOP = new Set(['무엇', '어떻게', '어떤', '하나요', '합니까', '있나요', '인가요', '입니까', '되나요', '해주세요', '알려', '설명']);

function tokenize(text) {
  const t = String(text || '').toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1');
  const out = [];
  for (const m of t.matchAll(/[가-힣]+|[a-z][a-z0-9_]*|\d+(?:\.\d+)?/g)) {
    const w = m[0];
    if (/^[가-힣]/.test(w)) {
      if (w.length === 1) { out.push(w); continue; }
      for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
    } else out.push(w);
  }
  return out;
}
// 질문 핵심어(재랭커 커버리지용) — 의문·요청 어미 제거한 한글 2-gram + 영문·숫자 토큰
function queryTerms(q) {
  const toks = tokenize(q).filter(x => !STOP.has(x));
  return Array.from(new Set(toks));
}

class Bm25 {
  constructor(docs, { k1 = 1.2, b = 0.75 } = {}) {   // docs: [{id, text}]
    this.k1 = k1; this.b = b; this.docs = docs;
    this.tf = []; this.len = []; this.df = new Map();
    let tot = 0;
    for (const d of docs) {
      const tf = new Map();
      for (const w of tokenize(d.text)) tf.set(w, (tf.get(w) || 0) + 1);
      this.tf.push(tf); this.len.push([...tf.values()].reduce((a, c) => a + c, 0)); tot += this.len[this.len.length - 1];
      for (const w of tf.keys()) this.df.set(w, (this.df.get(w) || 0) + 1);
    }
    this.avg = docs.length ? tot / docs.length : 0; this.N = docs.length;
  }
  score(q) {
    const qt = Array.from(new Set(tokenize(q)));
    const res = new Float64Array(this.N);
    for (const w of qt) {
      const df = this.df.get(w); if (!df) continue;
      const idf = Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
      for (let i = 0; i < this.N; i++) {
        const f = this.tf[i].get(w); if (!f) continue;
        res[i] += idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * this.len[i] / (this.avg || 1)));
      }
    }
    return res;
  }
}

// 사용자별 색인 캐시 — 청크 집합 시그니처(개수+최대 id)가 바뀌면 재구축
const _cache = new Map();
function getIndex(key, sig, docs) {
  const c = _cache.get(key);
  if (c && c.sig === sig) return c.idx;
  const idx = new Bm25(docs);
  _cache.set(key, { sig, idx });
  return idx;
}

const norm01 = (arr) => {
  let mn = Infinity, mx = -Infinity;
  for (const v of arr) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const d = mx - mn;
  return arr.map(v => d > 1e-9 ? (v - mn) / d : (mx > 0 ? 1 : 0));
};

// 융합 가중 — 평가셋 그리드로 결정(battery/rag_eval.js)
const W_DENSE = +(process.env.RAG_WD || 0.45), W_BM25 = 1 - W_DENSE;

/**
 * rows[i] = {id, text, dense, ...}, bm25[i] = BM25 점수(같은 인덱스). 후보 풀(상위 poolK)을 융합 점수로 정렬해 반환.
 * dense는 이미 신뢰도 가중이 반영된 값이어야 한다.
 */
function fuse(rows, bm25, poolK = 20) {
  const idxByDense = rows.map((_, i) => i).sort((a, b) => rows[b].dense - rows[a].dense).slice(0, poolK);
  const idxByBm = rows.map((_, i) => i).filter(i => bm25[i] > 0).sort((a, b) => bm25[b] - bm25[a]).slice(0, poolK);
  const pool = Array.from(new Set([...idxByDense, ...idxByBm]));
  const dN = norm01(pool.map(i => rows[i].dense)), bN = norm01(pool.map(i => bm25[i]));
  return pool.map((i, k) => ({ i, dN: dN[k], bN: bN[k], fused: W_DENSE * dN[k] + W_BM25 * bN[k] }))
    .sort((a, b) => b.fused - a.fused);
}

// 특징 재랭커 — 융합 후보를 질문과의 구체적 일치도로 재정렬. rerank_score ∈ [0,1].
function rerank(query, cands, rows) {
  const qt = queryTerms(query);
  const qSpecial = qt.filter(w => /^[a-z0-9]/.test(w));          // 영문·숫자 토큰 — 정확 일치가 결정적
  const qKo = qt.filter(w => /^[가-힣]/.test(w));
  return cands.map(c => {
    const r = rows[c.i], lower = String(r.text || '').toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1');
    const cov = qKo.length ? qKo.filter(w => lower.includes(w)).length / qKo.length : 0;
    const spec = qSpecial.length ? qSpecial.filter(w => lower.includes(w)).length / qSpecial.length : 0;
    const head = String(r.title || '').toLowerCase();
    const headHit = head && qKo.length ? qKo.filter(w => head.includes(w)).length / qKo.length : 0;
    const score = 0.55 * c.fused + 0.25 * cov + 0.12 * headHit + (qSpecial.length ? 0.08 * spec : 0.08 * c.dN);
    return { ...c, cov, spec, headHit, rerank: Math.min(1, score) };
  }).sort((a, b) => b.rerank - a.rerank);
}

// 자료 계층 — A 공식(운영자 등록), B 관리자 검증(자동 습득이지만 신뢰도 1.0=관리자 수정·승인), C 자동 습득(참고용)
function tierOf(origin, confidence) {
  if (!origin || origin === 'manual') return 'A';
  return Number(confidence) >= 1 ? 'B' : 'C';
}
const SOURCE_TYPE = { A: 'official', B: 'verified', C: 'auto' };

module.exports = { tokenize, queryTerms, Bm25, getIndex, fuse, rerank, tierOf, SOURCE_TYPE, W_DENSE, W_BM25, norm01 };

// ── 통합 검색 — 서버 /api/search와 평가 하네스가 같은 함수를 쓴다(시험한 것 = 배포된 것) ──────────
const bigramSet = (t) => { const s = new Set(); const k = String(t || '').replace(/[^가-힣]/g, ''); for (let i = 0; i < k.length - 1; i++) s.add(k.slice(i, i + 2)); return s; };
/**
 * rows: [{id, seq, text, dense(원 코사인), docId, docName, origin, confidence, project, meta}]
 * opts: {k, project, index(Bm25, rows와 같은 순서), qText}
 * 반환 {refs, trace}. refs[*].score는 기존 호환 점수(코사인×신뢰도 가중×2-gram 가점).
 */
function rankChunks(rows, opts) {
  const { qText, k = 4, project = '', index } = opts;
  if (!rows.length) return { refs: [], trace: null };
  const bm = Array.from(index.score(qText));
  const projects = Array.from(new Set(rows.map(r => r.project).filter(Boolean)));
  const mentioned = new Set(projects.filter(p => String(qText).toLowerCase().includes(String(p).toLowerCase())));
  const pf = r => (!project || !r.project || r.project === project || mentioned.has(r.project)) ? 1 : 0.5;   // 타 프로젝트 문서는 명시 언급이 없으면 감쇠
  const qb = bigramSet(qText);
  const work = rows.map((r, i) => {
    const conf = r.confidence == null ? 1 : r.confidence, f = pf(r);
    let hit = 0; const bg = bigramSet(r.text); for (const b of qb) if (bg.has(b)) hit++;
    const wdense = r.dense * (0.6 + 0.4 * conf) * f;
    return { ...r, dense: wdense, legacy: wdense * (1 + 0.25 * Math.min(1, hit / Math.max(1, qb.size))), title: (r.meta && r.meta.title) || '' };
  });
  for (let i = 0; i < bm.length; i++) bm[i] *= pf(rows[i]);
  const fused = fuse(work, bm);
  const rr = rerank(qText, fused, work);
  const rrById = new Map(rr.map(x => [x.i, x]));
  // 순서 = 융합 점수(평가셋 최고). 융합 점수 차가 0.02 이내면 재랭커 점수로 타이브레이크.
  const order = fused.slice().sort((a, b) => (Math.abs(b.fused - a.fused) > 0.02) ? b.fused - a.fused : (rrById.get(b.i).rerank - rrById.get(a.i).rerank));
  const top = order.length ? order[0].fused : 0;
  const picked = order.filter(c => c.fused >= 0.45 * top && (work[c.i].legacy >= 0.25 || c.bN >= 0.3)).slice(0, k);
  const refs = picked.map(c => {
    const r = work[c.i], x = rrById.get(c.i), t = tierOf(r.origin, r.confidence);
    const m = r.meta || {};
    return {
      text: r.text, docId: r.docId, docName: r.docName, score: r.legacy, origin: r.origin || 'manual', confidence: r.confidence == null ? 1 : r.confidence,
      chunk_id: r.id, seq: r.seq, slide_no: m.slide_no ?? null, title: m.title || null, project: r.project || null,
      relevance: +c.fused.toFixed(3), rerank_score: +x.rerank.toFixed(3), tier: t, source_type: SOURCE_TYPE[t],
    };
  });
  const brief = (arr, key) => arr.slice(0, 3).map(x => [work[x.i].id, +x[key].toFixed(2)]);
  const bmOrder = bm.map((v, i) => [i, v]).sort((a, b) => b[1] - a[1]).slice(0, 3).filter(x => x[1] > 0).map(([i, v]) => [work[i].id, +v.toFixed(2)]);
  const denseOrder = work.map((r, i) => [i, r.dense]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([i, v]) => [work[i].id, +v.toFixed(3)]);
  return { refs, trace: { dense: denseOrder, bm25: bmOrder, fused: brief(order, 'fused'), rerank: brief(rr, 'rerank'), final: refs.map(r => r.chunk_id) } };
}
module.exports.rankChunks = rankChunks;
