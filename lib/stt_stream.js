// 서버 Streaming STT — VAD + 부분/최종 전사 + PT 핫워드 보정. [2026-10-14 고도화 Phase 3]
// 전송: 브라우저가 16kHz PCM16 청크(≈200ms)를 HTTP POST로 올리고, 응답에 쌓인 이벤트(speech_start/partial/final)를 돌려받는다
//  (WebSocket은 frp→nginx 체인의 Upgrade 설정에 의존하므로 쓰지 않는다 — 프록시 무수정으로 동작).
// ASR: Qwen3-ASR(:8323 /stt) — context 필드로 도메인 용어 편향, 응답 후 핫워드 퍼지 보정(철자·띄어쓰기·영문 약어 한글 독음).
const SR = 16000, FRAME = 320;                    // 20ms 프레임
const ON_FRAMES = 4, HANGOVER_FRAMES = 45, PREROLL_FRAMES = 15;   // 시작 80ms 연속 · 종료 900ms 무음 · 선행 300ms 보존
const MAX_UTT_FRAMES = 1000;                      // 20초 강제 종결
const MIN_SPEECH_FRAMES = 15;                     // 300ms 미만은 잡음으로 폐기
const PARTIAL_EVERY_MS = 500;

// ── 핫워드 보정 ────────────────────────────────────────────────────────────────
const LETTER = { a: '에이', b: '비', c: '씨', d: '디', e: '이', f: '에프', g: '지', h: '에이치', i: '아이', j: '제이', k: '케이', l: '엘', m: '엠', n: '엔', o: '오', p: '피', q: '큐', r: '알', s: '에스', t: '티', u: '유', v: '브이', w: '더블유', x: '엑스', y: '와이', z: '제트' };
const DIGIT = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
const READ = { ai: ['에이아이', '아이', '에이 아이'], iot: ['아이오티', '아이오 티'], aiot: ['에이아이오티'], rag: ['래그', '라그', '알에이지'], llm: ['엘엘엠'], sllm: ['에스엘엘엠'], stt: ['에스티티'], tts: ['티티에스'], ble: ['비엘이'], kpi: ['케이피아이'], ssot: ['에스소트'], rbac: ['알백', '알비에이씨'], mcp: ['엠씨피'], api: ['에이피아이'], gpu: ['지피유'], pt: ['피티'] };
const normKo = (s) => String(s || '').toLowerCase().replace(/[\s.,!?·~\-_/()'"“”‘’:;]/g, '');
function readingsOf(tok) {
  const k = tok.toLowerCase();
  if (READ[k]) return READ[k].map(normKo);
  const out = k.split('').map(ch => LETTER[ch] || (/\d/.test(ch) ? DIGIT[+ch] : ch)).join('');
  return [normKo(out)];
}
// 핫워드 1개 → 매칭 변형(정규화 문자열) 목록. 라틴 토큰은 한글 독음 변형을 곱한다(최대 8개).
function variantsOf(h) {
  const parts = String(h).split(/(\s+)/).filter(x => x !== '');
  let acc = [''];
  for (const p of parts) {
    let opts;
    if (/^\s+$/.test(p)) opts = [''];
    else if (/^[A-Za-z][A-Za-z0-9]*$/.test(p)) opts = [normKo(p), ...readingsOf(p)];
    else opts = [normKo(p)];
    const next = [];
    for (const a of acc) for (const o of opts) { next.push(a + o); if (next.length >= 24) break; }
    acc = next;
  }
  return Array.from(new Set(acc.filter(Boolean))).slice(0, 8);
}
function lev(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (dp[i][j] < rowMin) rowMin = dp[i][j];
    }
    if (rowMin > cap) return cap + 1;
  }
  return dp[a.length][b.length];
}
function buildHotwords(list) {
  const seen = new Set(), hw = [];
  for (const raw of list || []) {
    const h = String(raw || '').trim();
    if (h.length < 2 || h.length > 40 || seen.has(h.toLowerCase())) continue;
    seen.add(h.toLowerCase());
    const variants = variantsOf(h);
    if (variants.length) hw.push({ h, variants, len: normKo(h).length });
  }
  return hw.sort((a, b) => b.len - a.len);   // 긴 용어 우선(부분 일치 선점 방지)
}
/**
 * 전사문에 핫워드 보정을 적용한다. 반환 {text, changes:[{from,to,dist}]}
 *  · dist 0 = 띄어쓰기·영문 독음 같은 결정적 교정 → 조용히 적용
 *  · dist ≥ 1 = 철자 차이 퍼지 교정 → changes에 담아 호출부가 "…를 말씀하신 건가요?" 확인에 쓴다
 */
function applyHotwords(text, hotwords) {
  const words = String(text || '').split(/(\s+)/);
  const idx = []; words.forEach((w, i) => { if (!/^\s+$/.test(w) && w !== '') idx.push(i); });
  const changes = []; const used = new Set();
  const out = words.slice();
  for (const hw of hotwords) {
    for (let start = 0; start < idx.length; start++) {
      // 시작 어절마다 span(1~6)을 모두 평가해 거리가 가장 작은(동률이면 가장 긴) 구간을 채택 — 짧은 구간의 어중간한 일치가 긴 정답 구간을 선점하지 않게
      let pick = null;
      for (let span = 1; span <= 6 && start + span <= idx.length; span++) {
        const sel = idx.slice(start, start + span);
        if (sel.some(i => used.has(i))) break;
        const cand = normKo(sel.map(i => words[i]).join(''));
        if (cand.length < 2) continue;
        const cur = sel.map(i => words[i]).join(' ');
        if (cur.replace(/[.,!?]+$/, '') === hw.h) { pick = { exact: true, sel }; break; }
        for (const v of hw.variants) {
          const cap = v.length < 4 ? 0 : v.length < 8 ? 1 : 2;
          for (const tail of [0, 1, 2]) {
            // 조사가 붙은 어절("공통기반을") — 끝 1~2음절은 조사로 보고 떼어 비교
            const core = tail ? cand.slice(0, cand.length - tail) : cand;
            if (core.length < 2 || (tail && (!/[가-힣]$/.test(cand) || tail >= normKo(words[sel[sel.length - 1]]).length))) continue;   // 조사는 마지막 어절 안의 끝음절만(어절 통째로 먹지 않게)
            const d = lev(core, v, cap);
            if (d <= cap && (!pick || d < pick.d || (d === pick.d && sel.length > pick.sel.length) || (d === pick.d && sel.length === pick.sel.length && tail < pick.tail))) pick = { d, tail, sel, cur };
          }
        }
      }
      if (!pick) continue;
      if (pick.exact) { pick.sel.forEach(i => used.add(i)); continue; }
      const { sel, tail } = pick;
      const last = words[sel[sel.length - 1]];
      const trail = (last.match(/[.,!?]+$/) || [''])[0];
      const lastRaw = last.replace(/[.,!?]+$/, '');
      out[sel[0]] = hw.h + (tail ? lastRaw.slice(lastRaw.length - tail) : '') + trail;
      for (let k = 1; k < sel.length; k++) out[sel[k]] = '';
      for (let i = sel[0] + 1; i < sel[sel.length - 1]; i++) if (/^\s+$/.test(words[i])) out[i] = '';
      sel.forEach(i => used.add(i));
      if (pick.d > 0) changes.push({ from: pick.cur, to: hw.h, dist: pick.d });
    }
  }
  return { text: out.join('').replace(/\s{2,}/g, ' ').trim(), changes };
}
// ASR context 문자열 — 핫워드를 쉼표 나열(600자 상한)
function contextOf(hotwords) {
  let s = '다음은 발표에 나오는 용어입니다: ', n = 0;
  for (const h of hotwords) { if ((s + h.h).length > 560) break; s += (n++ ? ', ' : '') + h.h; }
  return n ? s : '';
}

// ── WAV/PCM ────────────────────────────────────────────────────────────────────
function pcmToWav(pcm /* Buffer of int16le */) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const frameRms = (buf, off) => { let s = 0; for (let i = 0; i < FRAME; i++) { const v = buf.readInt16LE(off + i * 2); s += v * v; } return Math.sqrt(s / FRAME); };

// ── 세션 ───────────────────────────────────────────────────────────────────────
const sessions = new Map();
const TTL_MS = 10 * 60 * 1000;
function sweep() { const now = Date.now(); for (const [k, s] of sessions) if (now - s.touched > TTL_MS) sessions.delete(k); }

function createSession({ user, hotwords, asrUrl, log, meet }) {
  sweep();
  const sid = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const hw = buildHotwords(hotwords);
  const s = {
    sid, user, hw, context: contextOf(hw), asrUrl: asrUrl || 'http://127.0.0.1:8323', log: log || (() => {}),
    meet: !!meet, peak: 0,   // [2026-10-16] 화상회의(가상 믹서) 입력 — 레벨이 낮을 수 있어 VAD 하한을 낮추고, 구간 최대 RMS를 클라이언트에 알려 진단한다
    touched: Date.now(), events: [], rest: Buffer.alloc(0), floor: 150, speaking: false, onRun: 0, offRun: 0,
    pre: [], utt: [], uttFrames: 0, silentFrames: 0, startedAt: 0, lastPartialAt: 0, asrBusy: false, pending: 0, seq: -1, bytes: 0, uttNo: 0,
  };
  sessions.set(sid, s);
  return s;
}
const getSession = (sid) => { const s = sessions.get(sid); if (s) s.touched = Date.now(); return s; };

async function asr(s, pcm) {
  const fd = new FormData();
  fd.append('data', new Blob([pcmToWav(pcm)], { type: 'audio/wav' }), 'u.wav');
  if (s.context) fd.append('context', s.context);
  const t0 = Date.now();
  const r = await fetch(s.asrUrl + '/stt', { method: 'POST', body: fd, signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  let text = j && j.ok ? String(j.text || '').trim() : '';
  // [2026-10-14 실측] 짧은 발화(<1초)에서 Qwen3-ASR가 context 문자열(핫워드 나열)을 그대로 되읊는다 → 핫워드 3개 이상이 쉼표로 나열된 전사는 컨텍스트 누출로 보고 폐기
  if (text && s.hw.length >= 3) {
    const hits = s.hw.filter(h => text.includes(h.h)).length, commas = (text.match(/,/g) || []).length;
    if (hits >= 3 && commas >= 2 || (commas >= 3 && hits >= 2)) text = '';
  }
  return { text, ms: Date.now() - t0, dropped: !!(j && j.dropped) };
}
const uttPcm = (s) => Buffer.concat(s.utt);

async function runPartial(s, uttNo) {
  if (s.asrBusy) return;
  s.asrBusy = true;
  try {
    const t0 = Date.now(), r = await asr(s, uttPcm(s));
    if (!r.text || s.uttNo !== uttNo) return;           // 이미 종결됐거나 새 발화로 넘어감
    const c = applyHotwords(r.text, s.hw);
    s.events.push({ type: 'partial', text: c.text, ms_since_start: Date.now() - s.startedAt, asr_ms: r.ms, uttNo });
  } catch (e) { s.log('partial 실패: ' + e.message); }
  finally { s.asrBusy = false; }
}
async function runFinal(s, uttNo, pcm, endedAt, startedAt, speechMs) {
  // 최종은 부분 인식 중이어도 대기 후 수행(순서 보장). 20초 상한.
  for (let i = 0; i < 100 && s.asrBusy; i++) await new Promise(r => setTimeout(r, 100));
  s.asrBusy = true;
  try {
    const r = await asr(s, pcm);
    if (!r.text) { s.events.push({ type: 'speech_end', dropped: true, uttNo, speech_ms: speechMs }); return; }
    const c = applyHotwords(r.text, s.hw);
    const ev = { type: 'final', text: c.text, raw: r.text, uttNo, asr_ms: r.ms, speech_ms: speechMs, end_to_final_ms: Date.now() - endedAt, suspect: c.changes[0] || null, corrected: c.text !== r.text };
    s.events.push(ev);
    s.log(JSON.stringify({ ts: new Date().toISOString(), user: s.user, sid: s.sid, uttNo, speech_ms: speechMs, asr_ms: r.ms, end_to_final_ms: ev.end_to_final_ms, raw: r.text.slice(0, 120), text: c.text.slice(0, 120), changes: c.changes.slice(0, 3) }));
  } catch (e) { s.events.push({ type: 'error', message: 'asr: ' + e.message }); s.log('final 실패: ' + e.message); }
  finally { s.asrBusy = false; }
}

/** PCM16LE 청크를 먹이고 VAD를 진행한다. 이미 쌓인 이벤트를 비우며 반환(비동기 ASR 결과는 다음 호출에 실린다). */
function feed(s, chunk) {
  s.bytes += chunk.length;
  let buf = s.rest.length ? Buffer.concat([s.rest, chunk]) : chunk;
  let off = 0;
  const now = Date.now();
  while (buf.length - off >= FRAME * 2) {
    const frame = buf.subarray(off, off + FRAME * 2); off += FRAME * 2;
    const rms = frameRms(frame, 0);
    if (rms > s.peak) s.peak = rms;
    const thrOn = Math.max(s.meet ? 220 : 450, s.floor * 3.5), thrOff = Math.max(s.meet ? 150 : 300, s.floor * 2.2);
    if (!s.speaking) {
      s.pre.push(frame); if (s.pre.length > PREROLL_FRAMES) s.pre.shift();
      if (rms >= thrOn) s.onRun++; else { s.onRun = 0; s.floor = Math.min(800, Math.max(40, s.floor * 0.97 + rms * 0.03)); }
      if (s.onRun >= ON_FRAMES) {
        s.speaking = true; s.uttNo++; s.startedAt = now; s.lastPartialAt = now - PARTIAL_EVERY_MS + 250;   // 첫 부분 인식은 발화 시작 약 250ms 뒤(이후 500ms 간격)
        s.utt = s.pre.slice(); s.uttFrames = s.utt.length; s.silentFrames = 0; s.pre = [];
        s.events.push({ type: 'speech_start', uttNo: s.uttNo, floor: Math.round(s.floor) });
      }
    } else {
      s.utt.push(frame); s.uttFrames++;
      if (rms < thrOff) s.silentFrames++; else s.silentFrames = 0;
      const end = s.silentFrames >= HANGOVER_FRAMES || s.uttFrames >= MAX_UTT_FRAMES;
      if (end) {
        const speechFrames = s.uttFrames - s.silentFrames;
        s.speaking = false; s.onRun = 0;
        const pcm = uttPcm(s), no = s.uttNo, st = s.startedAt;
        s.utt = []; s.uttFrames = 0; s.silentFrames = 0;
        if (speechFrames < MIN_SPEECH_FRAMES) s.events.push({ type: 'speech_end', dropped: true, uttNo: no, speech_ms: speechFrames * 20 });
        else {
          s.events.push({ type: 'speech_active_end', uttNo: no, speech_ms: speechFrames * 20 });
          runFinal(s, no, pcm, now, st, speechFrames * 20);   // 비동기 — 결과 이벤트는 다음 feed 응답에 실림
        }
      } else if (now - s.lastPartialAt >= PARTIAL_EVERY_MS && s.uttFrames >= 17 && !s.asrBusy) {
        s.lastPartialAt = now; runPartial(s, s.uttNo);
      }
    }
  }
  s.rest = off < buf.length ? Buffer.from(buf.subarray(off)) : Buffer.alloc(0);
  const ev = s.events; s.events = [];
  return ev;
}
function drain(s) { const ev = s.events; s.events = []; return ev; }

module.exports = { createSession, getSession, feed, drain, applyHotwords, buildHotwords, variantsOf, contextOf, pcmToWav, sessions, SR };
