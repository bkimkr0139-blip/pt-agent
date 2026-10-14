#!/usr/bin/env node
// 서버 Streaming STT 평가 [2026-10-14, 고도화 지시서 §4.8] — 합성 발화(PCM16 16k)를 실시간 속도로 흘려 VAD·부분/최종 지연·용어 인식률을 측정한다.
//  node battery/stt_stream_eval.js <pcm디렉터리> [snrDb]     (u0.pcm.. + sents.json 필요)
const fs = require('fs'), path = require('path');
const S = require('../lib/stt_stream');
const dir = process.argv[2], snr = process.argv[3] ? +process.argv[3] : null, FAST = process.env.FAST === '1', NOHW = process.env.NOHW === '1';
const sents = JSON.parse(fs.readFileSync(path.join(dir, 'sents.json'), 'utf8'));
const HOT = ['범정부 AI 공통기반', '위즈베이스', 'IoT', 'L3', '전담사회복지사', '돌봄프로필', '생활지원사', 'KPI', '통합앱', '오경보', 'BLE', '밀양시', 'AIoT'];
const TERMS = { 0: '범정부 AI 공통기반', 1: '위즈베이스', 2: 'IoT', 3: 'L3', 4: '전담사회복지사', 5: '돌봄프로필', 7: '생활지원사', 8: 'KPI', 9: '통합앱', 10: '오경보', 12: '밀양시' };
const nk = s => String(s || '').toLowerCase().replace(/[\s.,!?]/g, '');
const cer = (a, b) => { a = nk(a); b = nk(b); const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) dp[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return dp[a.length][b.length] / Math.max(1, a.length); };
const noise = (pcm, snrDb) => { if (snrDb == null) return pcm; const a = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2); let p = 0; for (const v of a) p += v * v; p /= a.length; const sd = Math.sqrt(p / Math.pow(10, snrDb / 10)); const out = new Int16Array(a.length); for (let i = 0; i < a.length; i++) { const g = (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 1.73 * sd; out[i] = Math.max(-32768, Math.min(32767, a[i] + g)); } return Buffer.from(out.buffer); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const rows = [];
  for (let i = 0; i < sents.length; i++) {
    const speech = fs.readFileSync(path.join(dir, `u${i}.pcm`));
    const sil = n => Buffer.alloc(Math.round(16000 * n) * 2);
    const pcm = noise(Buffer.concat([sil(1.0), speech, sil(1.6)]), snr);
    const sess = S.createSession({ user: 'eval', hotwords: NOHW ? [] : HOT, log: () => {} });
    const onsetMs = 1000, endMs = 1000 + speech.length / 32;
    const t0 = Date.now(), ev = [];
    const CHMS = +(process.env.CHMS || 100), CH = 16 * CHMS * 2;   // 청크 길이(기본 100ms — 클라이언트와 동일)
    for (let off = 0; off < pcm.length; off += CH) {
      const target = t0 + (off / CH) * CHMS;
      if (!FAST) { const w = target - Date.now(); if (w > 0) await sleep(w); }
      for (const e of S.feed(sess, pcm.subarray(off, off + CH))) ev.push({ ...e, at: Date.now() - t0 });
    }
    for (let k = 0; k < 60 && !ev.some(e => e.type === 'final' || (e.type === 'speech_end')); k++) { await sleep(100); for (const e of S.drain(sess)) ev.push({ ...e, at: Date.now() - t0 }); }
    const ss = ev.find(e => e.type === 'speech_start'), p1 = ev.find(e => e.type === 'partial'), fin = ev.find(e => e.type === 'final');
    const term = TERMS[i], txt = fin ? fin.text : '', raw = fin ? fin.raw : '';
    rows.push({ i, start_ms: ss ? ss.at - onsetMs : null, partial_ms: p1 ? p1.at - onsetMs : null, final_ms: fin ? fin.at - endMs : null, cer: fin ? cer(sents[i], raw) : 1, term, termRaw: term ? S.variantsOf(term).some(v => nk(raw).includes(v)) : null, termFinal: term ? txt.includes(term) : null, raw, txt });
    process.stdout.write('.');
  }
  console.log();
  const med = a => { a = a.filter(x => x != null).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
  const p90 = a => { a = a.filter(x => x != null).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * 0.9))] : null; };
  const t = rows.filter(r => r.term);
  console.log(JSON.stringify({ mode: (FAST ? 'fast ' : 'realtime ') + (NOHW ? 'no-hotword ' : 'hotword ') + (snr == null ? 'clean' : 'snr' + snr + 'dB'), n: rows.length,
    speech_start_ms_p50: med(rows.map(r => r.start_ms)), partial_first_ms_p50: med(rows.map(r => r.partial_ms)), partial_first_ms_p90: p90(rows.map(r => r.partial_ms)),
    final_after_end_ms_p50: med(rows.map(r => r.final_ms)), final_after_end_ms_p90: p90(rows.map(r => r.final_ms)),
    CER_mean: +(rows.reduce((a, r) => a + r.cer, 0) / rows.length).toFixed(3), term_raw_ok: t.filter(r => r.termRaw).length + '/' + t.length, term_canonical_ok: t.filter(r => r.termFinal).length + '/' + t.length, no_final: rows.filter(r => !r.txt).length }, null, 0));
  if (process.env.V) for (const r of rows) console.log(r.i, '|', r.raw, '→', r.txt);
})();
