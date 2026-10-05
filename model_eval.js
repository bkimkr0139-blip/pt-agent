// ── 모델 교체 평가 프로세스 (2026-10-04, v9.3) ─────────────────────────────
// 관리자가 "조사 → 벤치마크 → 차트 판단 → 시험 운영 → 무결루프 검증 → 최종 승인/롤백"
// 전 과정을 관리자 페이지에서 실행할 수 있게 하는 모듈. 모든 수치는 실측이며,
// 시험 성적은 무결루프가 수집한 실제 발표 트래픽 로그에서 계산한다(조작 불가).
//
// 전환 메커니즘:
//   LLM — server.js proxyToN8n이 trial.json(status=trial)을 읽어 body.model을 주입
//         (n8n koen_local_llm 게이트웨이가 b.model을 존중하므로 무수정).
//   TTS — tts_policy.json에 tts_model/tts_voice를 쓰면 프록시가 요청마다 강제 적용
//         (mtime 감지, 재시작 불필요). 클라이언트 무수정.
//   STT — 발표 QA는 브라우저 Web Speech API, 8323은 n8n 서비스용이라 자동 전환 없음.
//         벤치마크(A/B)까지 제공, 전환은 수동(n8n koen_local_stt 대상 변경).
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = __dirname;
const EVAL = path.join(BASE, 'eval');
const REG = path.join(EVAL, 'registry.json');
const DISC = path.join(EVAL, 'discovery.json');
const TRIAL = path.join(EVAL, 'trial.json');
const RESULTS = path.join(EVAL, 'results');
const POLICY = '/Users/wizbase/works/bc-ai/tts_policy.json';
const PROXY_LOG = '/Users/wizbase/works/bc-ai/mlx-tts-proxy.log';
const PT_LOG = path.join(BASE, 'pt-agent.log');
const ISSUES = path.join(BASE, 'integrity/issues.jsonl');

const DEFAULT_REGISTRY = {
  updated: null,
  llm: { current: 'qwen3:30b-a3b-instruct-2507-q4_K_M', via: 'n8n koen_local_llm → ollama (:11434)' },
  stt: { current: 'mlx-community/Qwen3-ASR-1.7B-4bit', endpoint: 'http://127.0.0.1:8323/stt', alt: { name: 'whisper large-v3-turbo', endpoint: 'http://127.0.0.1:8782/stt' } },
  tts: { current_model: 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16', current_voice: 'sohee', endpoint: 'mlx_tts_proxy (:8321)' },
};

const LLM_MAX_GB = 48;   // 96GB 머신 — TTS/STT/시스템과 공존 가능한 상한(경고용)
const OLLAMA = 'http://127.0.0.1:11434';
const TTS_PROXY = 'http://127.0.0.1:8321/v1/audio/speech';
const DISC_QUERIES = {
  llm: ['qwen3 gguf', 'exaone gguf', 'gemma-3 gguf', 'glm-4 gguf', 'gpt-oss gguf', 'llama-4 gguf'],
  stt: ['qwen3-asr', 'whisper mlx', 'sensevoice mlx', 'kyutai stt ko'],
  tts: ['qwen3-tts', 'kokoro mlx', 'tts mlx korean', 'piper ko_KR'],
};
// 벤치마크 태스크 — 발표 도메인 고정. 언어 올바름(qwen2.5:14b의 중국어 답변 결함 클래스) 필수 포함.
const LLM_TASKS = [
  { id: 'script', name: '발표 대본 생성', min: 60, max: 500,
    sys: '당신은 한국어 발표 대본 작성가입니다. 반드시 한국어로만 답합니다.',
    user: '다음 내용으로 3문장짜리 발표 대본을 한국어로 작성하세요.\n내용: 3분기 매출이 전분기 대비 12% 증가했으며, 신규 고객 유입이 주요 동력이었습니다.' },
  { id: 'qa', name: '근거형 QA', min: 10, max: 400,
    sys: '주어진 자료만 근거로 반드시 한국어로 답하세요.',
    user: '자료: 무결 루프는 발표 로그를 5분 주기로 스캔해 TTS 정책을 자동 조정한다.\n질문: 무결 루프는 무엇을 어떤 주기로 하나요?' },
  { id: 'instruct', name: '지시 이행(목록화)', min: 15, max: 400,
    sys: '지시를 정확히 따라 반드시 한국어로만 답하세요.',
    user: '아래 항목을 번호 붙인 목록으로 출력하고, 각 줄을 마침표로 끝내세요.\n항목: 속도, 안정성, 비용' },
  { id: 'language', name: '언어 올바름(한국어 고정)', min: 15, max: 300,
    sys: '반드시 한국어로만 답하세요. 다른 언어는 금지입니다.',
    user: '음성 발표 에이전트의 장점을 한 문장으로 설명하세요.' },
  { id: 'summary', name: '요약(길이 적정성)', min: 40, max: 400,
    sys: '간결하게 반드시 한국어로 요약하세요.',
    user: '다음을 2문장으로 요약하세요: TTS 프록시는 문장 단위 생성, 길이 게이트, 조각 분할 폴백으로 EOS 결함을 방어한다. 클라이언트는 수정할 필요가 없다.' },
];
const TTS_SENTS = [
  '안녕하세요. 오늘 발표를 시작하겠습니다.',
  'RAG와 LLM을 결합하면 검색 품질이 크게 향상됩니다.',
  '무결 루프는 로그를 분석해 정책을 자동으로 조정합니다.',
  '첫째, 속도입니다. 둘째, 안정성입니다.',
  '3분기 매출은 12퍼센트 증가했습니다. 감사합니다.',
];

// ── 공용 유틸 ───────────────────────────────────────────────────────────────
const loadJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const saveJson = (p, o) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const t = p + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 1)); fs.renameSync(t, p);
};
const hangul = s => (s.match(/[가-힣]/g) || []).length;
const cjk = s => (s.match(/[一-鿿㐀-䶿]/g) || []).length;
function parseWavDur(buf) {
  try {
    if (buf.length < 44 || buf.slice(0, 4).toString() !== 'RIFF') return 0;
    let pos = 12, rate = 24000, ch = 1, bits = 16, data = 0;
    while (pos + 8 <= buf.length) {
      const cid = buf.slice(pos, pos + 4).toString(); const size = buf.readUInt32LE(pos + 4);
      if (cid === 'fmt ') { rate = buf.readUInt32LE(pos + 12); ch = buf.readUInt16LE(pos + 10); bits = buf.readUInt16LE(pos + 22); }
      else if (cid === 'data') { data = size; break; }
      pos += 8 + size + (size & 1);
    }
    return data / (rate * ch * bits / 8);
  } catch { return 0; }
}
const pct = (a, b) => (a === 0 ? null : Math.round((b - a) / a * 1000) / 10); // cur 대비 cand 변화(%)

// ── 1단계: 후보 조사 (HuggingFace API) ─────────────────────────────────────
// [2026-10-04] 후보 행 강화 — 모델명·태그에서 특징/시장 피드백 등급/기대 개선을 추출해
// 관리자가 벤치마크 전에 1차 선별을 쉽게 한다. 기대 개선은 메타데이터 추정이며
// 실제 근거는 벤치마크(실측)에서만 나온다 — UI에도 그렇게 표기.
function fmtCount(n) { return n >= 1000 ? (Math.round(n / 100) / 10) + 'k' : String(n || 0); }
function deriveInfo(m, stack) {
  const name = m.id.split('/').pop();
  const lower = name.toLowerCase();
  const tags = m.tags || [];
  const params = (lower.match(/(\d+(?:\.\d+)?)\s*[bB](?![a-z])/) || [])[1] || null;
  const quant = (name.match(/I?Q\d[A-Za-z0-9_]*/) || [])[0] || null;
  const fam = (lower.match(/qwen[\d.]*|llama[\d.]*|gemma[\d.]*|exaone[\d.]*|glm[\d.]*|gpt-?oss[\w-]*|kokoro[\w-]*|whisper[\w.-]*|sensevoice[\w-]*|piper/) || [''])[0];
  const isMlx = tags.includes('mlx') || lower.includes('mlx') || m.id.startsWith('mlx-community/');
  const isOnnx = tags.includes('onnx') || lower.includes('onnx');
  const feat = [];
  if (params) feat.push(params);
  if (quant) feat.push(quant);
  if (fam) feat.push(fam);
  if (isMlx) feat.push('MLX');
  else if (isOnnx) feat.push('ONNX');
  if (lower.includes('distill')) feat.push('증류');
  if (lower.includes('vision') || tags.includes('vision')) feat.push('비전');
  if (lower.includes('abliterated') || lower.includes('uncensored')) feat.push('검열제거⚠');
  const dl = m.downloads || 0;
  const grade = dl >= 1000 ? '검증됨' : dl >= 100 ? '주목' : '신규';
  let expect = '';
  if (stack === 'llm') {
    const p = params ? parseFloat(params) : null;
    if (lower.includes('abliterated')) expect = '검열 제거 변형 — 발표용으로 권장하지 않음';
    else if (p && p >= 40) expect = '대형 — 품질 상승 여력, 속도·메모리 감수(벤치 필수)';
    else if (p && p >= 10) expect = '동급 대역 — 벤치에서 직접 비교 필요';
    else if (p) expect = '경량 — 속도 대폭 기대, 품질 하락 위험';
    else expect = '파라미터 미표기 — 벤치에서 직접 확인';
    if (fam.startsWith('qwen3') && !lower.includes('abliterated')) expect += ' · 현행 qwen3 계열(호환성 양호)';
    else if (fam && !fam.startsWith('qwen3')) expect += ' · 타계열 — 한국어 벤치 필수';
    if (lower.includes('distill')) expect += ' · 증류 품질 검증 필요';
  } else if (stack === 'stt') {
    if (fam.startsWith('whisper')) expect = '검증된 표준 계열 — 정확도·속도 균형';
    else if (fam.startsWith('sensevoice')) expect = '경량 다국어 — 한국어 벤치 필수';
    else expect = '신규 계열 — 한국어 정확도 벤치 필수';
    if (isMlx) expect += ' · MLX 네이티브(기존 파이프라인 호환 가능)';
  } else {
    if (fam.startsWith('kokoro')) expect = '경량 실시간형 — 음색 다양성 제한 가능';
    else if (fam.startsWith('qwen3-tts') || fam.startsWith('qwen')) expect = '현행 Qwen3-TTS 계열 — 같은 프록시 경로 재사용 가능';
    else expect = '신규 엔진 가능성 — 파이프라인 호환 벤치 필수';
    if (isOnnx) expect += ' · ONNX는 별도 런타임 필요';
    else if (isMlx) expect += ' · MLX 네이티브';
  }
  return { feature: feat.join(' · '), grade, downloads_s: fmtCount(dl), likes: m.likes || 0, expect };
}
async function discover() {
  const cached = loadJson(DISC, null);
  if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached;
  const out = { at: Date.now(), llm: [], stt: [], tts: [] };
  let ollamaList = [];
  try {
    const r = await fetch(OLLAMA + '/api/tags', { signal: AbortSignal.timeout(4000) });
    ollamaList = (await r.json()).models.map(m => m.name);
  } catch { /* ollama 꺼짐 — 설치 판정만 비활성 */ }
  const isInst = id => ollamaList.find(n => { const b = id.split('/').pop().toLowerCase().replace(/\.gguf$/, ''); const f = n.toLowerCase().split(':')[0].replace(/[^a-z0-9.]/g, ''); return b.includes(f) || f.includes(b.split('-')[0]); });
  for (const [stack, queries] of Object.entries(DISC_QUERIES)) {
    const seen = new Set();
    for (const q of queries) {
      let arr = [];
      try {
        // [2026-10-04] 최신순+검증 다운로드 필터 — 무분별 파인튜 업로드 걸러내기(다운로드 10+)
        const fl = stack === 'llm' ? '&filter=gguf' : '';
        const r = await fetch(`https://huggingface.co/api/models?search=${encodeURIComponent(q)}${fl}&sort=lastModified&direction=-1&limit=16`, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'pt-agent-eval' } });
        if (r.ok) arr = await r.json();
      } catch { continue; }
      for (const m of arr) {
        if (seen.has(m.id) || m.private) continue;
        if ((m.downloads || 0) < 10) continue;
        seen.add(m.id);
        out[stack].push({
          id: m.id, updated: (m.lastModified || '').slice(0, 10), downloads: m.downloads || 0, likes: m.likes || 0,
          installed: stack === 'llm' ? (isInst(m.id) || null) : undefined,
          ...deriveInfo({ id: m.id, tags: m.tags, downloads: m.downloads, likes: m.likes }, stack),
        });
      }
    }
    // [2026-10-04, 사용자 요청] 최신 날짜순 정렬
    out[stack].sort((a, b) => b.updated.localeCompare(a.updated));
    out[stack] = out[stack].slice(0, 10);
  }
  saveJson(DISC, out);
  return out;
}

// ── 2단계: 벤치마크 ─────────────────────────────────────────────────────────
async function benchLLM(model) {
  const tasks = [];
  for (const t of LLM_TASKS) {
    let ttft = null, content = '', stats = null;
    const t0 = Date.now();
    try {
      const r = await fetch(OLLAMA + '/api/chat', {
        method: 'POST', body: JSON.stringify({
          model, messages: [{ role: 'system', content: t.sys }, { role: 'user', content: t.user }],
          stream: true, think: false, keep_alive: '10m', options: { num_ctx: 4096, temperature: 0.1, num_predict: 512 },
        }),
        signal: AbortSignal.timeout(180000),
      });
      if (!r.ok) throw new Error('ollama ' + r.status);
      const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { done, value } = await rd.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          const c = j.message && j.message.content;
          if (c) { if (ttft === null && c.trim()) ttft = Date.now() - t0; content += c; }
          if (j.done) { stats = j; }
        }
      }
    } catch (e) {
      tasks.push({ id: t.id, name: t.name, error: String(e.message || e).slice(0, 120) });
      continue;
    }
    const h = hangul(content), cj = cjk(content);
    // [2026-10-04] 언어 비율은 '문자' 기준 분모 — 숫자·문장부호가 분모에 끼면 "1. 속도." 같은
    // 완벽한 지시 이행도 한국어 비율 0.44로 깎이는 오탐(qwen3:30b 실측)이 발생한다.
    const letters = (content.match(/[가-힣a-zA-Z一-鿿㐀-䶿]/g) || []).length || 1;
    tasks.push({
      id: t.id, name: t.name, ttft_ms: ttft, total_ms: Date.now() - t0,
      tokps: stats && stats.eval_duration ? Math.round(stats.eval_count / stats.eval_duration * 1e9 * 10) / 10 : null,
      korean_ratio: Math.round(h / letters * 1000) / 1000,
      cjk_ratio: Math.round(cj / letters * 1000) / 1000,
      out_len: content.length, out_head: content.slice(0, 80),
      len_ok: content.length >= t.min && content.length <= t.max,
    });
  }
  const ok = tasks.filter(t => !t.error);
  const lang_ok = ok.length > 0 && ok.every(t => t.cjk_ratio < 0.01 && t.korean_ratio > 0.5);
  const pass = ok.filter(t => t.len_ok && t.cjk_ratio < 0.01).length;
  const tt = ok.filter(t => t.tokps != null);
  return {
    model,
    tasks,
    tokps: tt.length ? Math.round(tt.reduce((a, t) => a + t.tokps, 0) / tt.length * 10) / 10 : null,
    ttft_ms: ok.length ? Math.round(ok.reduce((a, t) => a + (t.ttft_ms || 0), 0) / ok.length) : null,
    language_pass: lang_ok,
    task_pass: pass + '/' + LLM_TASKS.length,
    task_pass_n: pass, task_total: LLM_TASKS.length,
    at: new Date().toISOString(),
  };
}

async function benchSTT(endpoint, label, limit = 8) {
  const dir = '/Users/wizbase/works/voice-agent/bench';
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.wav')).slice(0, limit);
  const rows = [];
  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, f));
    const dur = parseWavDur(buf);
    const t0 = Date.now();
    let ok = false, text = '', dropped = null;
    try {
      const r = await fetch(endpoint, { method: 'POST', body: buf, headers: { 'Content-Type': 'audio/wav' }, signal: AbortSignal.timeout(60000) });
      ok = r.ok;
      if (ok) { const j = await r.json(); text = j.text || ''; dropped = j.dropped ?? null; }
    } catch { ok = false; }
    const ms = Date.now() - t0;
    // [2026-10-04] dur 방어 — 파싱 실패/극단값이 RTF를 왜곡하지 않게 하한 검사
    rows.push({ file: f, ok, ms, dur: Math.round(dur * 100) / 100, rtf: dur >= 0.3 ? Math.round(ms / 1000 / dur * 1000) / 1000 : null, empty: !text.trim(), dropped });
  }
  const okRows = rows.filter(r => r.ok);
  const rtfs = okRows.filter(r => r.rtf != null);
  return {
    endpoint, label, n: rows.length, ok_n: okRows.length,
    ms_avg: okRows.length ? Math.round(okRows.reduce((a, r) => a + r.ms, 0) / okRows.length) : null,
    rtf_avg: rtfs.length ? Math.round(rtfs.reduce((a, r) => a + r.rtf, 0) / rtfs.length * 1000) / 1000 : null,
    empty_n: okRows.filter(r => r.empty).length, dropped_total: okRows.reduce((a, r) => a + (r.dropped || 0), 0),
    rows, at: new Date().toISOString(),
  };
}

async function benchTTS(model, voice) {
  const rows = [];
  for (const s of TTS_SENTS) {
    const t0 = Date.now();
    let ok = false, dur = 0, ms = 0;
    try {
      const r = await fetch(TTS_PROXY, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, voice: voice || 'sohee', input: s, response_format: 'wav' }),
        signal: AbortSignal.timeout(120000),
      });
      ms = Date.now() - t0;
      if (r.ok) { const buf = Buffer.from(await r.arrayBuffer()); dur = parseWavDur(buf); ok = dur > 0; }
    } catch { ms = Date.now() - t0; ok = false; }
    rows.push({ s: s.slice(0, 18), ok, ms, chars_ps: ok && dur >= 0.3 ? Math.round(s.length / dur * 10) / 10 : null });
  }
  const okRows = rows.filter(r => r.ok);
  const cps = okRows.filter(r => r.chars_ps);
  return {
    model, voice: voice || 'sohee', n: rows.length, ok_n: okRows.length,
    ms_avg: okRows.length ? Math.round(okRows.reduce((a, r) => a + r.ms, 0) / okRows.length) : null,
    natural_rate: cps.length ? Math.round(cps.filter(r => r.chars_ps >= 4.0 && r.chars_ps <= 7.0).length / cps.length * 100) : null,
    chars_ps_avg: cps.length ? Math.round(cps.reduce((a, r) => a + r.chars_ps, 0) / cps.length * 10) / 10 : null,
    rows, at: new Date().toISOString(),
  };
}

// ── 3단계: 비교 리포트 + 판정 ───────────────────────────────────────────────
let _busy = false;
async function runComparison(stack, cand) {
  if (_busy) throw new Error('벤치마크가 이미 실행 중입니다. 완료 후 다시 시도하세요.');
  _busy = true;
  try {
    const reg = loadJson(REG, DEFAULT_REGISTRY);
    let report;
    if (stack === 'llm') {
      const cur = await benchLLM(reg.llm.current);
      const candB = await benchLLM(cand.model);
      const metrics = [
        { key: 'tokps', label: '생성 속도 (tok/s)', cur: cur.tokps, cand: candB.tokps, unit: 'tok/s', lowerBetter: false },
        { key: 'ttft', label: '첫 응답 지연 (TTFT)', cur: cur.ttft_ms, cand: candB.ttft_ms, unit: 'ms', lowerBetter: true },
      ];
      const reasons = [], userView = [];
      if (!candB.language_pass) {
        reasons.push('치명: 한국어 고정 지시에서 이탈(중국어/한자 오염) — 발표 대본에 그대로 노출될 위험');
      } else if (!cur.language_pass && candB.language_pass) {
        userView.push('현재 모델에서 발생하던 언어 이탈이 후보에서는 관찰되지 않음');
      }
      if (candB.language_pass) userView.push(`언어 올바름 검사 통과(한국어 비율·중국어 오염 검사 5개 태스크)`);
      if (cur.tokps && candB.tokps) userView.push(`문장 생성 속도 ${candB.tokps > cur.tokps ? '+' : ''}${pct(cur.tokps, candB.tokps)}% (${cur.tokps}→${candB.tokps} tok/s)`);
      if (cur.ttft_ms && candB.ttft_ms) userView.push(`첫 응답까지 ${candB.ttft_ms < cur.ttft_ms ? '-' : '+'}${Math.abs(pct(cur.ttft_ms, candB.ttft_ms))}% (${cur.ttft_ms}→${candB.ttft_ms}ms)`);
      userView.push(`태스크 통과 ${cur.task_pass_n}/${cur.task_total} → ${candB.task_pass_n}/${candB.task_total}`);
      let verdict = '보류';
      if (!candB.language_pass) verdict = '비권장';
      else if (candB.task_pass_n > cur.task_pass_n && candB.tokps && cur.tokps && candB.tokps >= cur.tokps * 0.9) verdict = '교체 권장';
      else if (candB.task_pass_n === cur.task_pass_n && candB.tokps && cur.tokps && candB.tokps > cur.tokps * 1.15) verdict = '교체 권장';
      else if (candB.task_pass_n < cur.task_pass_n) reasons.push('태스크 통과율이 현재보다 낮음');
      report = {
        id: 'llm-' + Date.now(), stack, created: new Date().toISOString(),
        candidate: { model: cand.model },
        current_summary: { model: reg.llm.current, ...cur }, candidate_summary: { model: cand.model, ...candB },
        metrics,
        quality: [
          { label: '언어 올바름(한국어)', cur: cur.language_pass, cand: candB.language_pass },
          { label: '태스크 통과', cur: cur.task_pass, cand: candB.task_pass },
        ],
        verdict: { verdict, reasons, userView },
      };
    } else if (stack === 'stt') {
      const cur = await benchSTT(reg.stt.endpoint, 'Qwen3-ASR(8323)');
      const alt = reg.stt.alt;
      const candB = await benchSTT(alt.endpoint, alt.name);
      const metrics = [
        { key: 'rtf', label: '실시간 계수 (RTF, 낮을수록 빠름)', cur: cur.rtf_avg, cand: candB.rtf_avg, unit: '×', lowerBetter: true },
        { key: 'ms', label: '평균 처리 시간', cur: cur.ms_avg, cand: candB.ms_avg, unit: 'ms', lowerBetter: true },
        { key: 'empty', label: '빈 결과(인식 실패)', cur: cur.empty_n, cand: candB.empty_n, unit: '건', lowerBetter: true },
      ];
      const userView = [`샘플 ${cur.n}개 실측 — 성공 ${cur.ok_n} vs ${candB.ok_n}건`];
      if (cur.rtf_avg && candB.rtf_avg) userView.push(`인식 속도 ${candB.rtf_avg < cur.rtf_avg ? '+' : ''}${pct(cur.rtf_avg, candB.rtf_avg)}% (RTF ${cur.rtf_avg}→${candB.rtf_avg})`);
      report = {
        id: 'stt-' + Date.now(), stack, created: new Date().toISOString(),
        candidate: { name: alt.name, endpoint: alt.endpoint },
        current_summary: { model: reg.stt.current, ...cur }, candidate_summary: { model: alt.name, ...candB },
        metrics, quality: [],
        verdict: {
          verdict: candB.rtf_avg && cur.rtf_avg && candB.rtf_avg < cur.rtf_avg * 0.95 && candB.empty_n <= cur.empty_n ? '교체 검토' : '보류',
          reasons: ['STT는 발표 QA에 브라우저 Web Speech를 사용 — 8323 전환은 n8n koen_local_stt 대상 수동 변경 필요'],
          userView,
        },
      };
    } else if (stack === 'tts') {
      const cur = await benchTTS(reg.tts.current_model, reg.tts.current_voice);
      const candB = await benchTTS(cand.model, cand.voice);
      const metrics = [
        { key: 'ok', label: '생성 성공률', cur: Math.round(cur.ok_n / cur.n * 100), cand: Math.round(candB.ok_n / candB.n * 100), unit: '%', lowerBetter: false },
        { key: 'ms', label: '평균 생성 지연', cur: cur.ms_avg, cand: candB.ms_avg, unit: 'ms', lowerBetter: true },
        { key: 'natural', label: '자연 길이 비율(4~7자/초)', cur: cur.natural_rate, cand: candB.natural_rate, unit: '%', lowerBetter: false },
      ];
      const userView = [];
      userView.push(`5문장 실측 성공 ${cur.ok_n}/${cur.n} → ${candB.ok_n}/${candB.n} (실패 시 브라우저 폴백 목소리 노출)`);
      if (cur.chars_ps_avg && candB.chars_ps_avg) userView.push(`말하기 속도 ${cur.chars_ps_avg}→${candB.chars_ps_avg}자/초 (자연 범위 4~7)`);
      userView.push('음색·억양은 발표 화면의 미리듣기 또는 voice-samples 청취로 직접 확인 권장');
      let verdict = '보류';
      if (candB.ok_n === candB.n && candB.ok_n >= cur.ok_n && (cur.ms_avg && candB.ms_avg && candB.ms_avg <= cur.ms_avg * 1.2)) verdict = '시험 권장';
      report = {
        id: 'tts-' + Date.now(), stack, created: new Date().toISOString(),
        candidate: { model: cand.model, voice: cand.voice || 'sohee' },
        current_summary: { model: reg.tts.current_model, voice: reg.tts.current_voice, ...cur },
        candidate_summary: { model: cand.model, voice: cand.voice || 'sohee', ...candB },
        metrics, quality: [],
        verdict: { verdict, reasons: [], userView },
      };
    } else throw new Error('알 수 없는 스택: ' + stack);
    saveJson(path.join(RESULTS, report.id + '.json'), report);
    return report;
  } finally { _busy = false; }
}

// ── 4단계: 시험 운영 (trial) ────────────────────────────────────────────────
const trial = () => loadJson(TRIAL, null);
function trialStart(stack, cand) {
  if (trial() && trial().status === 'trial') throw new Error('이미 진행 중인 시험이 있습니다: ' + trial().stack + ' — 먼저 승인/롤백하세요.');
  if (stack === 'stt') throw new Error('STT 자동 전환 미지원 — n8n koen_local_stt 대상 수동 변경 필요(문서 §7 참조).');
  const reg = loadJson(REG, DEFAULT_REGISTRY);
  const t = { stack, spec: cand, started_at: new Date().toISOString(), status: 'trial', backup: {} };
  if (stack === 'tts') {
    const p = loadJson(POLICY, {});
    t.backup.policy_tts_model = p.tts_model ?? null;
    t.backup.policy_tts_voice = p.tts_voice ?? null;
    p.tts_model = cand.model; p.tts_voice = cand.voice || 'sohee';
    p.version = (p.version || 0) + 1; p.updated = t.started_at; p.updated_by = 'model_eval-trial';
    saveJson(POLICY, p);
  }
  saveJson(TRIAL, t);
  return t;
}
function trialFinish(approve) {
  const t = trial();
  if (!t || t.status !== 'trial') throw new Error('진행 중인 시험이 없습니다.');
  if (t.stack === 'tts') {
    const p = loadJson(POLICY, {});
    if (approve) {
      const reg = loadJson(REG, DEFAULT_REGISTRY);
      reg.updated = new Date().toISOString();
      reg.tts.current_model = t.spec.model; reg.tts.current_voice = t.spec.voice || 'sohee';
      saveJson(REG, reg); // 정책 tts_model은 유지 — 프록시가 계속 강제(확정된 진실원)
    } else {
      if (t.backup.policy_tts_model === null) delete p.tts_model; else p.tts_model = t.backup.policy_tts_model;
      if (t.backup.policy_tts_voice === null) delete p.tts_voice; else p.tts_voice = t.backup.policy_tts_voice;
      p.version = (p.version || 0) + 1; p.updated = new Date().toISOString(); p.updated_by = 'model_eval-rollback';
      saveJson(POLICY, p);
    }
  }
  if (!approve && t.stack === 'llm') fs.rmSync(TRIAL, { force: true });
  else { t.status = approve ? 'approved' : 'rolled_back'; t.finished_at = new Date().toISOString(); saveJson(TRIAL, t); }
  if (approve && t.stack === 'llm') {
    const reg = loadJson(REG, DEFAULT_REGISTRY);
    reg.updated = new Date().toISOString(); reg.llm.current = t.spec.model; saveJson(REG, reg);
  }
  return { ...t, approved: approve };
}

// ── 5단계: 시험 검증 보고서 — 실제 트래픽 로그에서 계산(무결루프 연동) ───────
function tsOf(line) { const m = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/); return m ? m[1] : null; }
function readLogLines(p) { try { return fs.readFileSync(p, 'utf8').split('\n'); } catch { return []; } }
function trialReport() {
  const t = trial();
  if (!t || t.status !== 'trial') return { trial: null, last: t || null }; // 완료된 시험은 히스토리로
  const start = t.started_at.slice(0, 19).replace('T', ' ');
  const startMs = Date.parse(t.started_at);
  const winMs = Math.max(60 * 1000, Date.now() - startMs);
  const beforeSince = new Date(startMs - winMs).toISOString().slice(0, 19).replace('T', ' ');
  const out = { trial: t, window: { start, hours: Math.round(winMs / 3600000 * 10) / 10 }, issues: [], policy_patches: 0 };

  const px = readLogLines(PROXY_LOG);
  const cnt = (from, to) => {
    const r = { ok: 0, ok_elapsed: 0, reject_trunc: 0, reject_run: 0, split_ok: 0, fail_final: 0, req: 0 };
    for (const l of px) {
      const ts = tsOf(l); if (!ts || ts < from || ts >= to) continue;
      if (l.includes('] OK ')) { r.ok++; const m = l.match(/elapsed=([\d.]+)s/); if (m) r.ok_elapsed += parseFloat(m[1]); }
      else if (l.includes('reason=truncated')) r.reject_trunc++;
      else if (l.includes('reason=runaway')) r.reject_run++;
      else if (l.includes('SPLIT-OK')) r.split_ok++;
      else if (l.includes('FAIL-FINAL')) r.fail_final++;
      else if (l.includes('] REQ ')) r.req++;
    }
    return r;
  };
  if (t.stack === 'tts') {
    out.tts = { trial: cnt(start, '9999'), baseline: cnt(beforeSince, start) };
    const fmt = (c) => ({ ...c, ok_ms_avg: c.ok ? Math.round(c.ok_elapsed / c.ok * 1000) : null });
    out.tts.trial = fmt(out.tts.trial); out.tts.baseline = fmt(out.tts.baseline);
  }
  if (t.stack === 'llm') {
    const ll = readLogLines(PT_LOG).filter(l => /POST \/ppt-agent\/api\/(llm|script) \d{3} \d+ms/.test(l));
    const agg = (from, to) => {
      const ms = []; let err = 0;
      for (const l of ll) {
        const ts = (l.match(/^(\d{4}-\d{2}-\d{2}T[\d:]{8})/) || [])[1];
        if (!ts) continue; const norm = ts.replace('T', ' ');
        if (norm < from || norm >= to) continue;
        const m = l.match(/ (\d{3}) (\d+)ms/); if (!m) continue;
        if (m[1][0] !== '2') err++; else ms.push(+m[2]);
      }
      return { n: ms.length, err, ms_avg: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null };
    };
    out.llm = { trial: agg(start, '9999-12-31 23:59:59'), baseline: agg(beforeSince, start) };
  }
  try {
    for (const l of fs.readFileSync(ISSUES, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { const j = JSON.parse(l); if (j.ts >= t.started_at) out.issues.push({ ts: j.ts.slice(0, 16), code: j.code, count: j.count, grade: j.grade }); } catch { }
    }
  } catch { }
  return out;
}

// ── 상태 종합 ───────────────────────────────────────────────────────────────
async function state() {
  const reg = loadJson(REG, null);
  if (!reg) { saveJson(REG, DEFAULT_REGISTRY); }
  let installed = [];
  try {
    const r = await fetch(OLLAMA + '/api/tags', { signal: AbortSignal.timeout(2500) });
    installed = (await r.json()).models.map(m => m.name).filter(n => !n.includes('embed') && !n.includes('vl'));
  } catch { /* ollama 꺼짐 */ }
  return { registry: reg || DEFAULT_REGISTRY, discovery: loadJson(DISC, null), trial: trial(), busy: _busy, installed };
}

module.exports = { state, discover, runComparison, trial, trialStart, trialFinish, trialReport, benchLLM, benchSTT, benchTTS };
