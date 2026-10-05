// PPT 음성 발표 에이전트 — 로그인 게이트 서버 (v2, SQLite 기반).
//
// [2026-10-02] v1(파일: users.json + 메모리 세션)은 쿠키 Path 버그로 롤백됐다 — 세션 쿠키를
// `Path=/ppt-agent`로 스코프했는데, 실제 보호 대상 페이지는 `/ppt-agent.html`이라 RFC 6265
// 경로 매칭 규칙상(프리픽스의 바로 다음 글자가 '/'여야 함, 여긴 '.') 브라우저가 쿠키를 아예
// 돌려보내지 않았다. curl로는 쿠키를 수동 재생해서 테스트해 멀쩡해 보였지만 실제 브라우저에선
// 로그인 폼 제출 후 조용히 로그인 페이지로 되돌아오는 증상이었다. 이번엔 그 버그 "클래스"
// 자체를 없앴다 — 쿠키 Path를 `/`로 둬서 이 오리진의 어떤 경로든 항상 매칭되게 함.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, hashPassword, newSalt } = require('./db');
const { chunkText } = require('./lib/chunk');

const DOC_STORAGE_QUOTA_BYTES = 500 * 1024 * 1024; // 유저당 저장 한도(문서+PPT 합산) — ponytail: 고정값, 운영하면서 조정

const PORT = process.env.PORT || 8124;
const PREFIX = '/ppt-agent';
const PPT_HTML_PATH = path.join(__dirname, 'ppt-agent.html');
const COOKIE_NAME = 'ppt_sid';
// [2026-10-04] 깃허브에 공개 저장소로 올리게 되면서 비밀 키를 코드에 더는 못 박아둘 수 없음 —
// 환경변수로만 받는다. N8N_KEY가 비어있으면 n8n 쪽에서 당연히 거부할 테니, 그 상태로 조용히
// 배포해버리는 실수를 막으려고 시작할 때 바로 경고를 띄운다.
const N8N_BASE = process.env.N8N_BASE || 'http://127.0.0.1:5680';
const N8N_KEY = process.env.N8N_KEY || '';
if (!N8N_KEY) console.warn('⚠️  N8N_KEY 환경변수가 설정되지 않았습니다 — 스크립트/LLM/임베딩 호출이 전부 실패합니다.');
// [2026-10-02] Secure 쿠키는 HTTPS에서만 브라우저가 돌려보낸다 — 로컬 개발(http://127.0.0.1)
// 테스트에서 이게 꺼져 있어야 "또 로그인이 안 된다"는 착각 없이 테스트 가능. 운영(launchd
// plist)은 반드시 NODE_ENV=production으로 띄워야 Secure가 켜진다.
const IS_PROD = process.env.NODE_ENV === 'production';

// ── 사용자/세션 DB 접근 ────────────────────────────────────────────────
function findUserByUsername(u) { return db.prepare('SELECT * FROM users WHERE username=?').get(u); }
function findUserById(id) { return db.prepare('SELECT * FROM users WHERE id=?').get(id); }
function allUsers() { return db.prepare('SELECT * FROM users ORDER BY created_at').all(); }
function createUser(username, password) {
  const salt = newSalt();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users(username,salt,hash,role,status,created_at) VALUES(?,?,?,'user','pending',?)`)
    .run(username, salt, hashPassword(password, salt), now);
}
function touchLastLogin(id) { db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(new Date().toISOString(), id); }
function logUsage(userId, eventType, bytes) {
  db.prepare('INSERT INTO usage_events(user_id,event_type,bytes,created_at) VALUES(?,?,?,?)').run(userId, eventType, bytes || null, new Date().toISOString());
}
function usageSummary(userId) {
  const n = sql => db.prepare(sql).get(userId);
  const docCount = n('SELECT COUNT(*) v FROM documents WHERE user_id=?').v;
  const pptCount = n('SELECT COUNT(*) v FROM presentations WHERE user_id=?').v;
  const docBytes = n('SELECT COALESCE(SUM(source_bytes),0) v FROM documents WHERE user_id=?').v;
  const pptBytes = n('SELECT COALESCE(SUM(size_bytes),0) v FROM presentations WHERE user_id=?').v;
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const queryCount7d = db.prepare(`SELECT COUNT(*) v FROM usage_events WHERE user_id=? AND event_type IN ('script_call','llm_call','search_call') AND created_at>?`).get(userId, weekAgo).v;
  const lastActive = db.prepare('SELECT MAX(created_at) v FROM usage_events WHERE user_id=?').get(userId).v;
  return { docCount, pptCount, storageBytes: docBytes + pptBytes, queryCount7d, lastActive };
}
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function createSession(userId, userAgent) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date(), exp = new Date(now.getTime() + 14 * 86400000);
  db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,last_seen_at,user_agent) VALUES(?,?,?,?,?,?)')
    .run(sha256(token), userId, now.toISOString(), exp.toISOString(), now.toISOString(), userAgent || null);
  return token;
}
function findSession(token) {
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(sha256(token));
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(row.token_hash); return null; }
  db.prepare('UPDATE sessions SET last_seen_at=? WHERE token_hash=?').run(new Date().toISOString(), row.token_hash);
  return row;
}
function destroySession(token) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(token)); }

function parseCookies(req) {
  const header = req.headers.cookie, out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
// [2026-10-02] Path=/ — 이 오리진에서 서빙하는 어떤 경로든 항상 매칭됨(이전 버그의 근본 원인을
// 클래스째 제거). 더 이상 "이 라우트는 쿠키 경로에 포함되나?"를 사람이 확인할 필요가 없다.
function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; ${IS_PROD ? 'Secure; ' : ''}SameSite=Lax; Max-Age=${14 * 86400}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; ${IS_PROD ? 'Secure; ' : ''}SameSite=Lax; Max-Age=0`);
}
function currentUser(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const sess = findSession(token);
  if (!sess) return null;
  return findUserById(sess.user_id);
}

// ── 화면 (서버 렌더 HTML) ───────────────────────────────────────────────
function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtBytes(n) { if (!n) return '0B'; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ } return n.toFixed(1) + u[i]; }
function page(title, body) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f1115;color:#e8e8ea;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0} /* 중앙정렬은 .adm min-height:100vh로 무력화 — 항상 상단 고정 */
html{scrollbar-gutter:stable} /* [2026-10-05] 뷰포트 스크롤바는 html에 있으므로 root에 고정 — 탭 전환 좌우 흔들림 방지(body에 걸면 무효) */
.box{background:#1a1d24;border:1px solid #2a2e38;border-radius:12px;padding:32px;width:320px}
h1{font-size:1.2rem;margin:0 0 20px}
label{display:block;font-size:.85rem;color:#9a9ea8;margin:14px 0 6px}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #333a46;background:#12141a;color:#e8e8ea;font-size:.95rem}
button{width:100%;margin-top:20px;padding:11px;border:0;border-radius:8px;background:#5b8def;color:#fff;font-size:.95rem;font-weight:600;cursor:pointer}
button:hover{background:#4a7cdb}
.msg{font-size:.85rem;padding:10px 12px;border-radius:8px;margin-bottom:14px}
.msg.err{background:#3a1f22;color:#ff9a9a}
.msg.ok{background:#1f3a28;color:#8fe0a8}
a{color:#5b8def;text-decoration:none;font-size:.85rem}
table{width:100%;border-collapse:collapse;font-size:.8rem}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #2a2e38;white-space:nowrap}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.72rem}
.pill.pending{background:#3a3220;color:#e0c068}
.pill.approved{background:#1f3a28;color:#8fe0a8}
.pill.disabled{background:#3a1f22;color:#ff9a9a}
form.inline{display:inline}
.wide{width:100%;max-width:none;overflow-x:auto;box-sizing:border-box} /* [2026-10-05] 콘텐츠 길이와 무관하게 모든 탭의 프레임 폭·위치 통일 */
.actBtn{width:auto;margin:2px 3px 2px 0;padding:4px 9px;font-size:.74rem}
/* [2026-10-04] 관리자 콘솔 — 사이드바 메뉴 + 탭 콘텐츠 레이아웃 */
.adm{display:flex;width:100%;max-width:1280px;margin:0 auto;gap:18px;padding:20px 16px;align-items:flex-start;box-sizing:border-box;min-height:100vh} /* min-height 100vh — 탭 높이 차와 무관하게 상단 고정(중앙정렬 무력화) */
.side{flex:0 0 216px;background:#1a1d24;border:1px solid #2a2e38;border-radius:14px;padding:14px 10px;position:sticky;top:16px}
.side h1{font-size:1rem;margin:2px 8px 12px}
.mI{display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:9px;color:#c9cdd6;font-size:.86rem;text-decoration:none;margin:2px 0}
.mI:hover{background:#232833;color:#fff}
.mI.on{background:#2b3a5c;color:#fff;font-weight:600}
.mI .bd{margin-left:auto;font-size:.68rem;background:#3a3f4c;color:#cfd4de;border-radius:999px;padding:1px 7px}
.mI .bd.warn{background:#4a3d16;color:#e0c068}
.mSep{border-top:1px solid #2a2e38;margin:10px 6px}
.main{flex:1;min-width:0;overflow-x:hidden} /* 넘치는 콘텐츠가 페이지 가로 스크롤을 만들어 콘솔을 흔드는 것 차단(표는 .wide 안에서 자체 스크롤) */
.tabS{display:none}
.tabS.on{display:block}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(205px,1fr));gap:12px;margin:14px 0}
.card{background:#1a1d24;border:1px solid #2a2e38;border-radius:12px;padding:16px 18px;color:inherit;cursor:pointer;text-decoration:none;display:block}
.card:hover{border-color:#3d5a8a}
.card .k{font-size:.74rem;color:#9a9ea8}
.card .v{font-size:1.45rem;font-weight:700;margin-top:6px}
.card .s{font-size:.74rem;color:#767b86;margin-top:5px;line-height:1.5}
h2.sec{font-size:.95rem;margin:20px 0 8px}
@media(max-width:820px){.adm{flex-direction:column;padding:12px 10px;gap:12px}.side{position:static;flex:none;width:100%;box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;padding:8px}.side h1{width:100%;margin:4px 8px 6px}.mI{padding:7px 10px;font-size:.8rem}.mSep{display:none}}
/* [2026-10-05] 시스템 문서 탭 — 서브탭 + 마크다운 본문 스타일(.docView 스코프) */
.docTabs{display:flex;align-items:center;gap:6px;border-bottom:1px solid #2a2e38;padding:10px 0;margin-top:14px}
.docTab{width:auto;margin:0;padding:7px 14px;font-size:.8rem;border-radius:8px 8px 0 0;background:transparent;border:1px solid transparent;border-bottom:none;color:#9a9ea8;cursor:pointer;font-weight:600}
.docTab:hover{color:#e8e8ea}
.docTab.on{background:#12141a;border-color:#2a2e38;color:#fff}
.docDl{font-size:.78rem;background:#2b5fd9;color:#fff;border-radius:8px;padding:7px 12px;text-decoration:none}
.docDl:hover{background:#3d6fe8}
.docView{display:none;background:#12141a;border:1px solid #2a2e38;border-radius:0 10px 10px 10px;padding:22px 26px;margin-top:-1px;overflow-x:hidden;color:#c9cdd6;font-size:.84rem;line-height:1.75}
.docView.show{display:block}
.docView h2{font-size:1.12rem;color:#fff;margin:22px 0 10px;padding-bottom:8px;border-bottom:1px solid #2a2e38}
.docView h3{font-size:.98rem;color:#e8e8ea;margin:18px 0 8px}
.docView h4,.docView h5{font-size:.88rem;color:#d5d9e2;margin:14px 0 6px}
.docView p{margin:8px 0}
.docView ul,.docView ol{margin:8px 0;padding-left:22px}
.docView li{margin:4px 0}
.docView code{background:#1f232c;border:1px solid #2a2e38;border-radius:5px;padding:1px 6px;font-size:.8rem;color:#9fd0ff}
.docView pre.mdCode{background:#0d0f13;border:1px solid #2a2e38;border-radius:8px;padding:14px 16px;overflow-x:auto;font-size:.74rem;line-height:1.55;margin:10px 0}
.docView pre.mdCode code{background:none;border:none;padding:0}
.docView blockquote{margin:10px 0;padding:8px 14px;border-left:3px solid #5b8def;background:#181c24;border-radius:0 8px 8px 0;color:#aeb4c0}
.docView hr{border:none;border-top:1px solid #2a2e38;margin:18px 0}
.docView table{display:block;max-width:100%;overflow-x:auto;font-size:.76rem;margin:10px 0}
.docView th{color:#9fb6e8;white-space:nowrap}
.docView th,.docView td{padding:7px 9px}
</style></head><body>${body}</body></html>`;
}
function statusMessage(status) {
  if (status === 'pending') return '가입 승인 대기 중입니다. 관리자 승인 후 로그인할 수 있습니다.';
  if (status === 'disabled') return '비활성화된 계정입니다. 관리자에게 문의하세요.';
  return '로그인할 수 없는 계정 상태입니다.';
}
function loginPage({ error, notice } = {}) {
  return page('로그인 — PPT 발표 에이전트', `<div class="box">
<h1>PPT 발표 에이전트 로그인</h1>
${error ? `<div class="msg err">${esc(error)}</div>` : ''}
${notice ? `<div class="msg ok">${esc(notice)}</div>` : ''}
<form method="post" action="${PREFIX}/login">
<label>아이디</label><input name="username" autocomplete="username" required>
<label>비밀번호</label><input name="password" type="password" autocomplete="current-password" required>
<button type="submit">로그인</button>
</form>
<p style="margin-top:16px;text-align:center"><a href="${PREFIX}/register">계정이 없으신가요? 가입하기</a></p>
</div>`);
}
function registerPage({ error, notice } = {}) {
  return page('가입 — PPT 발표 에이전트', `<div class="box">
<h1>계정 만들기</h1>
${error ? `<div class="msg err">${esc(error)}</div>` : ''}
${notice ? `<div class="msg ok">${esc(notice)}</div>` : ''}
<form method="post" action="${PREFIX}/register">
<label>아이디</label><input name="username" autocomplete="username" required minlength="3">
<label>비밀번호</label><input name="password" type="password" autocomplete="new-password" required minlength="4">
<button type="submit">가입 신청</button>
</form>
<p style="margin-top:16px;text-align:center"><a href="${PREFIX}/login">이미 계정이 있으신가요? 로그인</a></p>
</div>`);
}
// [2026-10-04] 관리자 콘솔 고도화 — 산만한 단일 스크롤을 사이드바 메뉴(개요/사용자/폐루프/주석/도구)
// 로 분리. adminShell이 메뉴를 그리고 본문은 탭 섹션(.tabS)으로, 클라이언트 JS(admTab)가 전환.
// 하위 페이지(주석 상세, 사용자 문서/PPT 목록)도 같은 셸을 써서 어디서든 메뉴 이동 가능.
function loopLive() {
  try {
    const age = (Date.now() - fs.statSync(path.join(__dirname, 'integrity/watch.log')).mtimeMs) / 60000;
    return { ok: age <= 11, ageMin: age }; // 주기(5분)의 2배 안이면 가동 중으로 판정
  } catch { return { ok: false, ageMin: null }; }
}
function adminShell(active, inner) {
  const readJ = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
  const st = readJ(path.join(__dirname, 'integrity/status.json'), {});
  let pending = 0, annoN = 0;
  try { pending = db.prepare("SELECT COUNT(*) n FROM users WHERE status='pending'").get().n; } catch { /*  */ }
  try { annoN = db.prepare('SELECT COUNT(*) n FROM slide_annotations').get().n; } catch { /* 테이블 신설 전 */ }
  const live = loopLive();
  const apN = Array.isArray(st.auto_patches) ? st.auto_patches.length : 0;
  // [2026-10-05] 지식 관리 탭 뱃지 — 자동 습득 지식 수 + 대기 중 미답변 질문 수
  let knowN = 0, missPendN = 0;
  try { knowN = db.prepare("SELECT COUNT(*) n FROM documents WHERE origin='auto'").get().n; } catch { /* 컬럼 신설 전 */ }
  try {
    const kuid = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
    if (kuid) missPendN = knowledgeMissItems(kuid.id).filter(x => x.state === 'pending').length;
  } catch { /*  */ }
  const item = (id, icon, label, badge) => `<a class="mI${active === id ? ' on' : ''}" data-tab="${id}" href="${PREFIX}/admin?tab=${id}" onclick="return admTab('${id}')">${icon} ${label}${badge || ''}</a>`;
  return page('관리자 콘솔 — PPT 발표 에이전트', `<div class="adm">
<nav class="side">
<h1>🛠️ 관리자 콘솔</h1>
${item('dash', '📊', '개요')}
${item('users', '👥', '사용자 관리', pending ? `<span class="bd warn">승인 ${pending}</span>` : '')}
${item('loop', '🔄', '폐루프 감시', `<span class="bd">${live.ok ? '🟢' : '🔴'}${apN ? ' 패치' + apN : ''}</span>`)}
${item('knowledge', '🧠', '지식 관리', `<span class="bd">${knowN ? '🧠' + knowN : ''}${missPendN ? ` 대기${missPendN}` : ''}</span>`)}
${item('decision', '🧭', 'Decision Router', (() => { try { const dp = decisionPolicy.getPolicy(); return `<span class="bd">${dp.mode === 'shadow' ? '👀' : dp.mode === 'active' ? '🟢' : '⏸'}</span>`; } catch { return ''; } })())}
${item('anno', '🖍️', '발표 주석', annoN ? `<span class="bd">${annoN}</span>` : '')}
${item('docs', '📄', '시스템 문서')}
${item('tools', '🧰', '도구')}
<div class="mSep"></div>
<a class="mI" href="${PREFIX}.html">🌐 발표 화면</a>
<a class="mI" href="${PREFIX}/admin/model-eval">🔄 모델 교체 평가</a>
<div class="mSep"></div>
<a class="mI" href="${PREFIX}/logout">🚪 로그아웃</a>
</nav>
<main class="main">${inner}</main>
</div>
<script>
function admTab(t){
  const sec=document.querySelector('.tabS[data-tab="'+t+'"]');
  if(!sec)return true; // 탭이 없는 하위 페이지 — 메뉴 링크 그대로 따라감(실제 이동)
  document.querySelectorAll('.tabS').forEach(s=>s.classList.toggle('on',s.dataset.tab===t));
  document.querySelectorAll('.mI[data-tab]').forEach(m=>m.classList.toggle('on',m.dataset.tab===t));
  if(history.replaceState)history.replaceState(null,'','#'+t);
  window.scrollTo({top:0,left:0});
  return false;
}
// [2026-10-05] 새로고침·하위페이지 복귀 시 해시(#knowledge 등)로 탭 복원 — 지식 수정 페이지의
// "취소 — 지식 관리로" 링크(/admin#knowledge)가 이 복원에 의존한다.
try{const _h=(location.hash||'').replace('#','');if(_h)admTab(_h)}catch(e){}
// 문서 탭 안의 서브탭(전체 시스템 문서 ↔ 모델 교체 평가 문서) — 보기 전환 + 다운로드 버튼 동기화
function docTab(name){
  const sys=name==='sys';
  document.querySelectorAll('.docTab').forEach(b=>b.classList.toggle('on',b.dataset.doc===name));
  const s=document.getElementById('docSys'),e=document.getElementById('docEval');
  if(s)s.style.display=sys?'block':'none';
  if(e)e.style.display=sys?'none':'block';
  const dlS=document.getElementById('dlSys'),dlE=document.getElementById('dlEval');
  if(dlS)dlS.style.display=sys?'':'none';
  if(dlE)dlE.style.display=sys?'none':'';
  return false;
}
addEventListener('DOMContentLoaded',()=>{const h=decodeURIComponent(location.hash.slice(1));
  if(h&&h!==${JSON.stringify(active)}&&document.querySelector('.tabS[data-tab="'+CSS.escape(h)+'"]'))admTab(h);});
</script>`);
}

// 개요 탭 — 핵심 지표 카드 + 승인 대기 빠른 처리 + 바로가기. 각 카드는 해당 탭으로 이동.
function overviewPanel() {
  const one = (q, fb = 0) => { try { return db.prepare(q).get(); } catch { return fb; } };
  const uAll = one("SELECT COUNT(*) n FROM users").n, uPending = one("SELECT COUNT(*) n FROM users WHERE status='pending'").n;
  const ppt = one('SELECT COUNT(*) n, COALESCE(SUM(size_bytes),0) b, COALESCE(SUM(slide_count),0) s FROM presentations');
  let anno = { n: 0, m: 0, a: 0 };
  try { anno = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(kind='memo'),0) m, COALESCE(SUM(kind='auto'),0) a FROM slide_annotations").get(); } catch { /*  */ }
  const readJ = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
  const st = readJ(path.join(__dirname, 'integrity/status.json'), {});
  const live = loopLive();
  const fmtT = s => String(s || '').replace('T', ' ').slice(5, 16);
  const pendRows = (() => {
    let rows = [];
    try { rows = db.prepare("SELECT username, created_at FROM users WHERE status='pending' ORDER BY created_at LIMIT 10").all(); } catch { /*  */ }
    return rows.map(u => `<tr><td>${esc(u.username)}</td><td>${esc((u.created_at || '').slice(0, 10))}</td>
<td><form class="inline" method="post" action="${PREFIX}/admin/approve"><input type="hidden" name="username" value="${esc(u.username)}"><button class="actBtn" type="submit">승인</button></form>
<form class="inline" method="post" action="${PREFIX}/admin/reject" onsubmit="return confirm('${esc(u.username)} 신청을 삭제할까요?')"><input type="hidden" name="username" value="${esc(u.username)}"><button class="actBtn" type="submit" style="background:#8a3030">삭제</button></form></td></tr>`).join('')
      || '<tr><td colspan="3" style="color:#888">승인 대기 없음</td></tr>';
  })();
  return `<div class="box wide">
<h1>📊 개요</h1>
<div class="cards">
<a class="card" href="#users" onclick="return admTab('users')"><div class="k">👥 사용자</div><div class="v">${uAll}<small style="font-size:.85rem;color:#9a9ea8">명</small></div><div class="s">${uPending ? `승인 대기 <b style="color:#e0c068">${uPending}</b>건` : '승인 대기 없음'}</div></a>
<a class="card" href="#users" onclick="return admTab('users')"><div class="k">🗂️ 저장된 발표</div><div class="v">${ppt.n}<small style="font-size:.85rem;color:#9a9ea8">개</small></div><div class="s">슬라이드 ${ppt.s}개 · ${fmtBytes(ppt.b)}</div></a>
<a class="card" href="#anno" onclick="return admTab('anno')"><div class="k">🖍️ 발표 주석</div><div class="v">${anno.n}<small style="font-size:.85rem;color:#9a9ea8">건</small></div><div class="s">메모 ${anno.m} · 음성오류 자동 ${anno.a}</div></a>
<a class="card" href="#loop" onclick="return admTab('loop')"><div class="k">🔄 폐루프 감시</div><div class="v">${live.ok ? '🟢' : '🔴'} <small style="font-size:.95rem;color:#9a9ea8">${live.ok ? '가동 중' : '정지 의심'}</small></div><div class="s">누적 자동 패치 ${Array.isArray(st.auto_patches) ? st.auto_patches.length : 0}건 · 마지막 스캔 ${fmtT(st.last_scan) || '-'}</div></a>
</div>
<h2 class="sec">승인 대기</h2>
<table><thead><tr><th>아이디</th><th>신청일</th><th></th></tr></thead><tbody>${pendRows}</tbody></table>
<h2 class="sec">바로가기</h2>
<p><a href="${PREFIX}/admin/model-eval">🔄 모델 교체 평가</a> · <a href="#docs" onclick="return admTab('docs')">📄 시스템 문서</a> · <a href="${PREFIX}.html">🌐 발표 화면</a></p>
</div>`;
}

// 도구·문서 탭 — 평가 모듈/문서 다운로드/발표 화면 바로가기 + 현재 서버 상태 요약.
function toolsPanel() {
  const readJ = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
  const pol = readJ('/Users/wizbase/works/bc-ai/tts_policy.json', {});
  const live = loopLive();
  // 주의: 외부 템플릿 안에서 "삼항 → 템플릿 → 삼항" 4중 중첩은 V8 파서가 "Missing }"로 실패 —
  // 복잡한 분기 문자열은 반드시 변수로 먼저 계산한다.
  const liveTxt = live.ok
    ? `🟢 가동 중 (마지막 기록 ${live.ageMin.toFixed(0)}분 전)`
    : `🔴 정지 의심 (${live.ageMin == null ? '기록 없음' : live.ageMin.toFixed(0) + '분 전'})`;
  return `<div class="box wide">
<h1>🧰 도구 · 문서</h1>
<div class="cards">
<a class="card" href="${PREFIX}/admin/model-eval"><div class="k">모델 교체 평가</div><div class="v" style="font-size:1.1rem">🔄 평가 열기</div><div class="s">조사 → 실측 벤치마크 → 시험 운영 → 무결루프 검증 → 승인/롤백</div></a>
<a class="card" href="#docs" onclick="return admTab('docs')"><div class="k">시스템 문서</div><div class="v" style="font-size:1.1rem">📄 열람 · 다운로드</div><div class="s">전체 시스템 문서 + 모델 교체 평가 문서를 화면에서 읽고 .md 내려받기</div></a>
<a class="card" href="${PREFIX}.html"><div class="k">발표 화면</div><div class="v" style="font-size:1.1rem">🌐 열기</div><div class="s">발표 · 주석(색연필/메모) · 질의응답</div></a>
</div>
<h2 class="sec">서버 상태</h2>
<table><tbody>
<tr><td style="width:180px;color:#9a9ea8">TTS 정책</td><td>v${pol.version ?? '?'} — attempts ${pol.attempts ?? '?'}, cap×${pol.cap_mult ?? 1}, floor×${pol.floor_mult ?? 1} <small style="color:#767b86">(by ${esc(pol.updated_by || '?')})</small></td></tr>
<tr><td style="color:#9a9ea8">폐루프 감시자</td><td>${liveTxt}</td></tr>
<tr><td style="color:#9a9ea8">서버 가동 시간</td><td>${Math.floor(process.uptime() / 3600)}시간 ${Math.floor(process.uptime() % 3600 / 60)}분</td></tr>
</tbody></table>
</div>`;
}

// [2026-10-05, 사용자 요청] 경량 Markdown→HTML 변환기 — 의존성 추가 없이 시스템 문서를
// 관리자 콘솔에서 바로 읽을 수 있게. system.md가 쓰는 구성만 지원: 헤딩/표/코드펜스/인용/
// 목록/수평선/굵음/인라인코드/링크. 나머지는 단락으로 안전하게 떨어짐.
function mdToHtml(md) {
  const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inline = s => escHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  const lines = String(md).split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const L = lines[i];
    if (/^```/.test(L)) { // 코드 펜스
      const buf = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
      i++;
      out.push('<pre class="mdCode">' + escHtml(buf.join('\n')) + '</pre>');
      continue;
    }
    if (/^\|/.test(L) && i + 1 < lines.length && /^\|[\s:|-]+$/.test(lines[i + 1])) { // 표
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      out.push('<table><thead><tr>' + head.map(h => '<th>' + inline(h) + '</th>').join('') + '</tr></thead><tbody>'
        + body.map(r => '<tr>' + head.map((_, k) => '<td>' + inline(r[k] || '') + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    const h = L.match(/^(#{1,4})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length + 1}>` + inline(h[2]) + `</h${h[1].length + 1}>`); i++; continue; }
    if (/^(-|\*|\d+\.)\s+/.test(L)) { // 목록(중첩 없는 1단)
      const ol = /^\d/.test(L);
      const buf = [];
      while (i < lines.length && /^(-|\*|\d+\.)\s+/.test(lines[i])) {
        buf.push('<li>' + inline(lines[i].replace(/^(-|\*|\d+\.)\s+/, '')) + '</li>'); i++;
      }
      out.push(ol ? '<ol>' + buf.join('') + '</ol>' : '<ul>' + buf.join('') + '</ul>');
      continue;
    }
    if (/^>\s?/.test(L)) { // 인용 — 연속 줄 하나로
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(inline(lines[i].replace(/^>\s?/, ''))); i++; }
      out.push('<blockquote>' + buf.join('<br>') + '</blockquote>');
      continue;
    }
    if (/^---+$/.test(L.trim())) { out.push('<hr>'); i++; continue; }
    if (!L.trim()) { i++; continue; }
    const buf = [inline(L)]; // 단락 — 빈 줄 전까지
    for (i++; i < lines.length && lines[i].trim() && !/^(#|```|\||>|-|\*|\d+\.|---)/.test(lines[i]); i++) buf.push(inline(lines[i]));
    out.push('<p>' + buf.join('<br>') + '</p>');
  }
  return out.join('\n');
}

// 시스템 문서 탭 — 전체 시스템 문서/모델 교체 평가 문서를 서브탭으로 화면에서 바로 읽고,
// 각 문서마다 스냅샷 부록이 붙은 원본(.md) 다운로드 버튼을 제공.
function docsPanel() {
  const readDoc = f => { try { return mdToHtml(fs.readFileSync(path.join(__dirname, f), 'utf8')); } catch (e) { return '<p>문서를 읽을 수 없습니다: ' + esc(String(e.message || e)) + '</p>'; } };
  const sysHtml = readDoc('docs/system.md');
  const evalHtml = readDoc('docs/model-eval.md');
  return `<div class="box wide">
<h1>📄 시스템 문서</h1>
<p style="color:#9a9ea8;font-size:.82rem;margin:6px 0 0">문서를 화면에서 바로 읽을 수 있습니다. 다운로드는 읽는 시점의 살아있는 상태(TTS 정책·무결 감시 결과·패치 대기열)를 스냅샷 부록으로 덧붙여 내려줍니다.</p>
<div class="docTabs">
<button class="docTab on" data-doc="sys" onclick="return docTab('sys')">📘 전체 시스템 문서</button>
<button class="docTab" data-doc="eval" onclick="return docTab('eval')">🔄 모델 교체 평가 문서</button>
<span style="flex:1"></span>
<a class="docDl" id="dlSys" href="${PREFIX}/admin/system-docs" download>⬇️ 다운로드 (.md)</a>
<a class="docDl" id="dlEval" href="${PREFIX}/admin/model-eval-docs" download style="display:none">⬇️ 다운로드 (.md)</a>
</div>
<div class="docView show" id="docSys">${sysHtml}</div>
<div class="docView" id="docEval" style="display:none">${evalHtml}</div>
</div>`;
}

// [2026-10-04, 사용자 요청] 관리자 페이지 "폐루프(무결 감시) 현황" 패널 — 감시자 가동 상태,
// 최근 스캔 결과, 자동 패치 이력, 코드 패치 대기열을 한 화면에서 확인. "지금 스캔"으로 즉시 실행.
const { exec } = require('child_process');
function integrityPanel() {
  const readJ = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
  const st = readJ(path.join(__dirname, 'integrity/status.json'), {});
  const pol = readJ('/Users/wizbase/works/bc-ai/tts_policy.json', {});
  let issues = [];
  try {
    issues = fs.readFileSync(path.join(__dirname, 'integrity/issues.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse(); // 최신 먼저
  } catch { /* 기록 없음 */ }
  const patchCount = issues.filter(i => Array.isArray(i.auto_patch) && i.auto_patch.length).length;
  const codeQueue = issues.filter(i => i.grade === 'code').length;
  // 감시자 생존 판정 — loopLive() 공용 헬퍼(사이드바 배지와 동일 판정)
  const live = loopLive();
  const fmtT = s => String(s || '').replace('T', ' ').slice(5, 16); // MM-DD HH:MM
  const gradeTag = i => i.grade === 'code'
    ? '<span class="pill" style="background:#fbe4e4;color:#8a2323">코드</span>'
    : '<span class="pill" style="background:#e3edff;color:#1d4fb8">자동</span>';
  const action = i => {
    if (Array.isArray(i.auto_patch) && i.auto_patch.length)
      return '🤖 ' + i.auto_patch.map(p => `${p.key} ${p.from}→${p.to}`).join(', ') + ' 적용';
    return i.grade === 'code' ? '📋 코드 패치 대기열 적립' : '추적 중 (조건 미달/쿨다운)';
  };
  const rows = issues.slice(0, 12).map(i => `<tr>
<td style="white-space:nowrap">${fmtT(i.ts)}</td>
<td style="font-weight:700;white-space:nowrap">${esc(i.code)}</td>
<td>${gradeTag(i)}</td>
<td style="text-align:right">${i.count ?? 1}</td>
<td>${esc(i.desc || '')}</td>
<td style="white-space:nowrap">${action(i)}</td>
</tr>`).join('') || '<tr><td colspan="6" style="color:#888">아직 감지된 이슈가 없습니다.</td></tr>';
  const ap = Array.isArray(st.auto_patches) ? st.auto_patches : [];
  return `<div class="box wide">
<h1>🔄 폐루프 (무결 감시) 현황</h1>
<p>
<span class="pill ${live.ok ? 'approved' : 'disabled'}">${live.ok ? `🟢 감시자 가동 중 (5분 주기 · 마지막 기록 ${live.ageMin.toFixed(0)}분 전)` : `🔴 감시자 정지 의심 — 마지막 기록 ${live.ageMin == null ? '?' : live.ageMin.toFixed(0)}분 전`}</span>
&nbsp; <b>마지막 스캔</b> ${fmtT(st.last_scan)} &nbsp;·&nbsp; <b>TTS 정책</b> v${pol.version ?? '?'} (attempts ${pol.attempts ?? '?'}, cap×${pol.cap_mult ?? 1}, floor×${pol.floor_mult ?? 1}, by ${esc(pol.updated_by || '?')})
</p>
<table><thead><tr><th>누적 TTS 성공</th><th>분할 자동구출</th><th>자동 패치(누적)</th><th>코드 패치 대기열</th><th>최근 스캔 자동조정</th></tr></thead>
<tbody><tr>
<td>${st.totals?.tts_ok ?? st.stats?.tts_ok ?? 0}건</td>
<td>${st.totals?.tts_split_rescue ?? st.stats?.tts_split_rescue ?? 0}건</td>
<td>${patchCount}건</td>
<td>${codeQueue}건</td>
<td>${ap.length ? ap.map(p => `${p.key} ${p.from}→${p.to}`).join(', ') : '없음'}</td>
</tr></tbody></table>
<h2 style="font-size:.95rem;margin:14px 0 6px">최근 감지 · 조치 (최신순)</h2>
<table><thead><tr><th>시각</th><th>코드</th><th>분류</th><th>건수</th><th>내용</th><th>조치</th></tr></thead><tbody>${rows}</tbody></table>
<p style="margin-top:12px">
<form class="inline" method="post" action="${PREFIX}/admin/integrity-scan" style="display:inline"><button class="actBtn" type="submit" style="background:#2b5fd9">🛰️ 지금 스캔 실행</button></form>
<a href="${PREFIX}/admin?tab=loop"><button class="actBtn" type="button">↻ 새로고침</button></a>
&nbsp; <small style="color:#888">스캔은 로그 증분만 읽습니다(발표 중 실행해도 무영향). 자동조정은 30분 쿨다운·클램프로 제한됩니다.</small>
</p>
</div>`;
}

// [2026-10-04, 사용자 요청] 관리자 "🖍️ 발표 주석" 패널 — 발표 중 기록(그리기/메모/음성오류 자동)을
// PPT별로 요약. 페이지별 원본 대조 상세는 /admin/annotations/:pptId.
function annotationPanel() {
  let ppts = [], latest = [];
  try {
    ppts = db.prepare(`SELECT p.id, p.name, p.slide_count, u.username,
      COUNT(a.id) total, SUM(a.kind='draw') draws, SUM(a.kind='memo') memos, SUM(a.kind='auto') autos, MAX(a.created_at) last_at
      FROM slide_annotations a JOIN presentations p ON p.id=a.ppt_id JOIN users u ON u.id=p.user_id
      GROUP BY a.ppt_id ORDER BY MAX(a.created_at) DESC LIMIT 8`).all();
  } catch { /* 테이블 신설 전 */ }
  try {
    latest = db.prepare(`SELECT a.slide_idx, a.kind, a.category, a.quote, a.text, a.created_at, p.name pname
      FROM slide_annotations a JOIN presentations p ON p.id=a.ppt_id
      WHERE a.kind IN ('memo','auto') ORDER BY a.id DESC LIMIT 5`).all();
  } catch { /*  */ }
  const fmtT = s => String(s || '').replace('T', ' ').slice(5, 16);
  const latestRows = latest.map(m => `<tr>
<td style="white-space:nowrap">${fmtT(m.created_at)}</td>
<td>${esc((m.pname || '').slice(0, 22))}</td>
<td style="text-align:right">${m.slide_idx + 1}</td>
<td style="white-space:nowrap">${m.kind === 'auto' ? '🤖' : '📝'} ${esc(m.category || '')}</td>
<td style="white-space:normal;max-width:340px">${esc(((m.quote ? '"' + m.quote + '" — ' : '') + (m.text || '')).slice(0, 90))}</td>
</tr>`).join('') || '<tr><td colspan="5" style="color:#888">아직 발표 주석이 없습니다.</td></tr>';
  const pptRows = ppts.map(p => `<tr>
<td><a href="${PREFIX}/admin/annotations/${p.id}">${esc(p.name)}</a></td>
<td>${esc(p.username)}</td>
<td style="text-align:right">${p.slide_count}</td>
<td style="text-align:right">${p.draws || 0}</td>
<td style="text-align:right">${p.memos || 0}</td>
<td style="text-align:right">${p.autos || 0}</td>
<td style="white-space:nowrap">${fmtT(p.last_at)}</td>
</tr>`).join('') || '<tr><td colspan="7" style="color:#888">주석이 달린 발표가 아직 없습니다.</td></tr>';
  return `<div class="box wide">
<h1>🖍️ 발표 주석 (색연필 · 메모)</h1>
<p style="color:#9a9ea8;font-size:.82rem;margin:6px 0 10px">발표자가 발표 중 슬라이드에 표시하고 남긴 기록 — PPT 이름을 누르면 페이지별 원본 노트 대조 화면. 전체 기록은 integrity/annotations.jsonl에도 적립(폐루프 관리).</p>
<table><thead><tr><th>PPT</th><th>사용자</th><th>슬라이드</th><th>그리기</th><th>메모</th><th>자동(음성오류)</th><th>최근</th></tr></thead><tbody>${pptRows}</tbody></table>
<h2 style="font-size:.95rem;margin:14px 0 6px">최근 메모</h2>
<table><thead><tr><th>시각</th><th>PPT</th><th>페이지</th><th>분류</th><th>내용</th></tr></thead><tbody>${latestRows}</tbody></table>
</div>`;
}

// 관리자: PPT별 페이지 상세 — 업로드 원본(파싱된 제목/노트/불릿)과 주석(그리기 SVG + 메모) 나란히 대조.
// 원본 pptx 바이너리는 보존되지 않고 파싱 결과가 원본이므로, 그 파싱 원문을 "원본"으로 보여준다.
// (라우트 등록은 app 생성 후 — 함수는 위에, route는 아래 API 섹션에 둠)
const adminAnnotationDetail = (req, res) => {
  const ppt = db.prepare('SELECT p.*, u.username FROM presentations p JOIN users u ON u.id=p.user_id WHERE p.id=?').get(req.params.pptId);
  if (!ppt) return res.status(404).send('PPT를 찾을 수 없습니다.');
  let annos = [];
  try { annos = db.prepare('SELECT * FROM slide_annotations WHERE ppt_id=? ORDER BY slide_idx, id').all(ppt.id); } catch { /*  */ }
  const bySlide = {};
  for (const a of annos) {
    const c = bySlide[a.slide_idx] || (bySlide[a.slide_idx] = { draw: null, memos: [] });
    if (a.kind === 'draw') c.draw = a; else c.memos.push(a);
  }
  let slidesMeta = [];
  try {
    slidesMeta = JSON.parse(ppt.slides_json).map(s => ({
      title: s.title || '', note: s.note || '',
      bullets: Array.isArray(s.bullets) ? s.bullets : [],
    }));
  } catch { /*  */ }
  const maxIdx = Math.max(slidesMeta.length, ...Object.keys(bySlide).map(Number).map(n => n + 1), 0);
  const cards = [];
  for (let i = 0; i < maxIdx; i++) {
    const meta = slidesMeta[i] || { title: '(원본 정보 없음)', note: '', bullets: [] };
    const cell = bySlide[i] || { draw: null, memos: [] };
    const strokes = cell.draw && cell.draw.strokes ? JSON.parse(cell.draw.strokes) : [];
    const polys = strokes.map(st =>
      `<polyline points="${(st.pts || []).map(p => (p[0] * 100).toFixed(2) + ',' + (p[1] * 100).toFixed(2)).join(' ')}" fill="none" stroke="${esc(st.c || '#ff3b30')}" stroke-width="${st.w || 3}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" opacity=".85"/>`).join('');
    const memoHtml = cell.memos.map(m => `<div style="margin:8px 0;padding:8px 10px;background:#20242e;border-left:3px solid ${m.kind === 'auto' ? '#e0c068' : '#5b8def'};border-radius:6px;font-size:.8rem">
<b style="color:#9fb6e8">${m.kind === 'auto' ? '🤖 자동(음성오류)' : '📝 ' + esc(m.category || '메모')}</b>
${m.quote ? `<blockquote style="margin:6px 0 4px;color:#e0c068;font-size:.78rem">"${esc(m.quote)}"</blockquote>` : ''}
<div style="white-space:pre-wrap">${esc(m.text || '')}</div>
<div style="color:#767b86;font-size:.7rem;margin-top:4px">${esc(String(m.created_at || '').replace('T', ' ').slice(5, 16))}</div></div>`).join('') ||
      '<p style="color:#767b86;font-size:.78rem">메모 없음</p>';
    const has = strokes.length || cell.memos.length;
    cards.push(`<div style="background:#1a1d24;border:1px solid ${has ? '#3d5a8a' : '#2a2e38'};border-radius:10px;padding:14px 16px;margin-bottom:14px">
<h3 style="margin:0 0 10px;font-size:.92rem">페이지 ${i + 1} — ${esc(meta.title) || '(제목 없음)'} ${has ? '<span class="pill approved">주석 있음</span>' : ''}</h3>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
  <div style="min-width:0"><b style="font-size:.78rem;color:#9a9ea8">원본 스피커노트 (업로드 파싱)</b>
    <pre style="white-space:pre-wrap;font-size:.78rem;color:#c9cdd6;background:#12141a;border:1px solid #2a2e38;border-radius:8px;padding:10px;max-height:260px;overflow-y:auto;margin:6px 0">${esc(meta.note) || '(노트 없음)'}</pre>
    <b style="font-size:.78rem;color:#9a9ea8">원본 불릿</b>
    <ul style="font-size:.78rem;color:#c9cdd6;margin:6px 0 0;padding-left:18px">${meta.bullets.map(b => '<li>' + esc(b) + '</li>').join('') || '<i style="color:#767b86">없음</i>'}</ul></div>
  <div style="min-width:0"><b style="font-size:.78rem;color:#9a9ea8">발표자 주석</b>
    <div style="aspect-ratio:16/9;background:#12141a;border:1px solid #2a2e38;border-radius:8px;margin:6px 0;position:relative;overflow:hidden">
      ${polys ? `<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%">${polys}</svg>` : '<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#767b86;font-size:.75rem">그리기 없음</span>'}
    </div>${memoHtml}</div>
</div></div>`);
  }
  res.send(adminShell('anno', `<div class="box wide">
<h1>🖍️ ${esc(ppt.name)} <span style="font-size:.8rem;color:#9a9ea8">${esc(ppt.username)} · ${ppt.slide_count}슬라이드</span></h1>
<p style="margin:6px 0 14px"><a href="${PREFIX}/admin?tab=anno">← 주석 목록으로</a></p>
${cards.join('') || '<p style="color:#888">기록 없음</p>'}
</div>`));
};

// [2026-10-05, 사용자 요청] 지식 관리 탭 — 자동 습득 폐루프의 관리 화면.
// 1) 지식 리스트: 문서 전체(수동 manual/자동 auto)에 출처·신뢰도 배지 + 3단 신뢰도 조정/삭제.
// 2) 미답변 질문: rag-miss.jsonl을 정규화 질문 기준 최근순 유니크로 — 대기(습득/제외 액션),
//    습득됨(auto 문서가 지금 존재), 제외(재습득 안 함) 상태 표시.
function knowledgeMissItems(userId) {
  const acq = knowAcquiredSet(userId), dis = knowDismissedSet();
  const seen = new Set(), items = [];
  try {
    const lines = fs.readFileSync(path.join(__dirname, 'eval', 'rag-miss.jsonl'), 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0 && items.length < 50; i--) {
      if (!lines[i].trim()) continue;
      let j; try { j = JSON.parse(lines[i]); } catch { continue; }
      const nq = normQ(j.q || '');
      if (!nq || seen.has(nq)) continue;
      seen.add(nq);
      items.push({ q: j.q, nq, ts: j.ts || null, reason: j.reason || null,
        ragTop: j.ragTop ?? (Array.isArray(j.events) && j.events[0] ? j.events[0].ragTop ?? null : null),
        state: dis.has(nq) ? 'dismissed' : (acq.has(nq) ? 'acquired' : 'pending') });
    }
  } catch { /* 파일 없음 */ }
  return items;
}
function confBadge(c) {
  const lv = c >= 0.8 ? ['높음', '#2f8a4c'] : c >= 0.45 ? ['보통', '#8a6a20'] : ['낮음', '#8a3030'];
  return `<span class="pill" style="background:${lv[1]}">${lv[0]} ${Number(c).toFixed(1)}</span>`;
}
function knowledgePanel(kuid) {
  if (!kuid) return '<div class="box wide"><h1>🧠 지식 관리</h1><p style="color:#888">관리자 계정을 찾을 수 없습니다.</p></div>';
  let docs = [];
  try { docs = db.prepare('SELECT id,name,is_primary,origin,confidence,source_bytes,created_at FROM documents WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(kuid); } catch { /* 컬럼 신설 전 */ }
  const autoN = docs.filter(d => (d.origin || 'manual') === 'auto').length;
  const miss = knowledgeMissItems(kuid);
  const pendN = miss.filter(x => x.state === 'pending').length;
  const confBtns = d => {
    const conf = d.confidence == null ? 1 : d.confidence;
    const cur = { high: 1, mid: 0.5, low: 0.3 };
    return `<form class="inline" method="post" action="${PREFIX}/admin/knowledge/confidence"><input type="hidden" name="id" value="${d.id}">`
      + Object.keys(cur).map(lv => `<button class="actBtn" name="level" value="${lv}" type="submit"${Math.abs(conf - cur[lv]) < 0.01 ? ' style="background:#2b5fd9"' : ''}>${{ high: '높음', mid: '보통', low: '낮음' }[lv]}</button>`).join('')
      + '</form>';
  };
  const docRows = docs.map(d => {
    const origin = d.origin || 'manual';
    const conf = d.confidence == null ? 1 : d.confidence;
    return `<tr>
<td><input type="checkbox" class="knowChk" form="knowBulkForm" name="ids" value="${d.id}" data-auto="${origin === 'auto' ? 1 : 0}" style="vertical-align:middle"></td>
<td>${d.is_primary ? '⭐ ' : ''}<a href="${PREFIX}/admin/knowledge/${d.id}/edit" style="color:#c9cdd6;text-decoration:none" title="내용 열람·수정">${esc(d.name)}</a><br><small style="color:#767b86">${fmtBytes(d.source_bytes || 0)} · ${docCountChunks(d.id)}청크</small></td>
<td>${origin === 'auto' ? '<span class="pill" style="background:#2b5fd9">🧠 자동</span>' : '<span class="pill" style="background:#3a3a44">📎 수동</span>'}</td>
<td>${confBadge(conf)}</td>
<td>${confBtns(d)}</td>
<td>${esc((d.created_at || '').slice(0, 10))}</td>
<td><a class="actBtn" href="${PREFIX}/admin/knowledge/${d.id}/edit" style="text-decoration:none;display:inline-block;background:#2b5fd9">✏️ 수정</a>
<form class="inline" method="post" action="${PREFIX}/admin/knowledge/delete" onsubmit="return confirm('${esc(d.name)} 을(를) 삭제할까요?${origin === 'auto' ? ' 이 질문은 재습득 대상에서도 제외됩니다.' : ''}')"><input type="hidden" name="id" value="${d.id}"><button class="actBtn" type="submit" style="background:#8a3030">삭제</button></form></td>
</tr>`;
  }).join('') || '<tr><td colspan="7" style="color:#888">문서 없음 — 발표 화면 업로드 또는 아래 수동 추가 사용</td></tr>';
  const stBadge = s => s === 'acquired' ? '<span class="pill" style="background:#2f8a4c">습득됨</span>'
    : s === 'dismissed' ? '<span class="pill" style="background:#3a3a44">제외</span>'
    : '<span class="pill" style="background:#8a6a20">대기</span>';
  const missRows = miss.map(m => {
    const acts = m.state === 'pending'
      ? `<form class="inline" method="post" action="${PREFIX}/admin/knowledge/acquire"><input type="hidden" name="q" value="${esc(m.q)}"><button class="actBtn" type="submit">🧠 지금 습득</button></form>
<form class="inline" method="post" action="${PREFIX}/admin/knowledge/dismiss" onsubmit="return confirm('이 질문을 제외할까요? 다시 습득 제안되지 않습니다.')"><input type="hidden" name="q" value="${esc(m.q)}"><button class="actBtn" type="submit" style="background:#3a3a44">제외</button></form>`
      : (m.state === 'acquired' ? '<small style="color:#767b86">로컬 지식으로 답변 가능</small>' : '<small style="color:#767b86">재습득 안 함</small>');
    return `<tr><td>${esc(m.q)}</td><td><small>${esc((m.ts || '').slice(5, 16).replace('T', ' '))}</small></td>
<td><small>${m.reason === 'answer_tts_timeout' ? '음성 초과' : '자료 미스'}</small></td><td><small>${m.ragTop == null ? '-' : Number(m.ragTop).toFixed(3)}</small></td>
<td>${stBadge(m.state)}</td><td>${acts}</td></tr>`;
  }).join('') || '<tr><td colspan="6" style="color:#888">미답변 질문 없음 — 모든 질문에 답하고 있습니다 🎉</td></tr>';
  return `<div class="box wide">
<h1>🧠 지식 관리</h1>
<p style="color:#9a9ea8;font-size:.8rem;margin-top:6px">발표 중 답하지 못한 질문(rag-miss)은 클라우드 LLM으로 답을 얻어 <b>자동 임베딩</b>됩니다. 발표가 거듭될수록 로컬 답변 커버리지가 넓어집니다. 자동 지식은 신뢰도 <b>보통 0.5</b>(클라우드가 [불확실] 표기 시 <b>낮음 0.3</b>)에서 시작하며, 검토 후 높이거나 삭제하세요. 신뢰도는 답변 프롬프트에 출처 표기로 반영됩니다.</p>
<div class="cards">
<a class="card" href="#knowledge" onclick="return false"><div class="k">📚 로컬 지식</div><div class="v">${docs.length}<small style="font-size:.85rem;color:#9a9ea8">건</small></div><div class="s">수동 ${docs.length - autoN} · 자동 습득 🧠 ${autoN}</div></a>
<a class="card" href="#knowledge" onclick="return false"><div class="k">❓ 미답변 질문 대기</div><div class="v">${pendN}<small style="font-size:.85rem;color:#9a9ea8">건</small></div><div class="s">습득 대기 ${pendN} · 습득됨 ${miss.filter(x => x.state === 'acquired').length} · 제외 ${miss.filter(x => x.state === 'dismissed').length}</div></a>
</div>
<h2 class="sec">미답변 질문 (최근순)</h2>
<table><thead><tr><th>질문</th><th>감지</th><th>사유</th><th>RAG top</th><th>상태</th><th></th></tr></thead><tbody>${missRows}</tbody></table>
<h2 class="sec">수동 지식 추가</h2>
<form method="post" action="${PREFIX}/admin/knowledge/add" style="margin:8px 0 4px">
<input name="name" placeholder="지식 이름(예: RBAC 개념)" required style="width:280px;padding:6px 8px;font-size:.8rem;background:#0d0f13;border:1px solid #2a2e38;border-radius:6px;color:#e8e8ea">
<select name="level" style="padding:6px 8px;font-size:.8rem;background:#0d0f13;border:1px solid #2a2e38;border-radius:6px;color:#e8e8ea;margin:0 6px"><option value="high">신뢰도 높음</option><option value="mid">보통</option><option value="low">낮음</option></select>
<textarea name="text" placeholder="지식 내용을 입력하세요. 발표 질의응답에 답하는 형태의 완결된 문장으로 쓰는 것이 임베딩 검색에 유리합니다." required rows="4" style="display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:8px;font-size:.8rem;background:#0d0f13;border:1px solid #2a2e38;border-radius:6px;color:#e8e8ea"></textarea>
<button class="actBtn" type="submit" style="margin-top:6px">＋ 추가·임베딩</button>
</form>
<h2 class="sec">지식 리스트 (최근 100건)</h2>
<form id="knowBulkForm" method="post" action="${PREFIX}/admin/knowledge/delete-many" onsubmit="return knowBulkConfirm()" style="margin:6px 0">
<button class="actBtn" type="submit" style="background:#8a3030">🗑 선택 삭제</button>
<small style="color:#767b86;margin-left:8px">체크한 문서를 일괄 삭제합니다. 자동 습득(🧠) 건은 해당 질문이 재습득 대상에서 제외됩니다.</small>
</form>
<table><thead><tr><th style="width:30px"><input type="checkbox" id="knowSelAll" onclick="knowSelAllChk(this)" title="전체 선택" style="vertical-align:middle"></th><th>문서</th><th>출처</th><th>신뢰도</th><th>조정</th><th>등록</th><th></th></tr></thead><tbody>${docRows}</tbody></table>
<script>
function knowSelAllChk(cb){document.querySelectorAll('input.knowChk').forEach(c=>c.checked=cb.checked)}
function knowBulkConfirm(){const c=document.querySelectorAll('input.knowChk:checked');if(!c.length){alert('삭제할 문서를 먼저 체크하세요.');return false}const a=[...c].filter(x=>x.dataset.auto==='1').length;return confirm('선택한 '+c.length+'개 문서를 삭제할까요?'+(a?' (자동 습득 '+a+'건 포함 — 해당 질문은 재습득 대상에서 제외됩니다.)':''))}
</script>
</div>`;
}

// [2026-10-05, 사용자 요청] 지식 내용 열람·수정 — 실시간 자동 습득 지식을 관리자가 검수·수정하면
// 전문을 재청크·재임베딩한다. 수정본은 관리자 검수로 보고 신뢰도 높음(1.0)을 적용하며, 자동 문서의
// 이름 변경 시 원질문을 재습득 금지로 기록해 폐루프(재습득) 의미규칙을 유지한다.
function knowledgeEditPage(doc, content, notice, err) {
  const auto = (doc.origin || 'manual') === 'auto';
  return adminShell('knowledge', `<div class="box wide">
<h1>✏️ 지식 수정 — 문서#${doc.id} <span class="pill" style="background:${auto ? '#2b5fd9' : '#3a3a44'}">${auto ? '🧠 자동 습득' : '📎 수동'}</span></h1>
${notice ? `<div class="msg ok">${esc(notice)}</div>` : ''}${err ? `<div class="msg ok" style="background:#5c2525">${esc(err)}</div>` : ''}
<p style="color:#9a9ea8;font-size:.8rem">${auto ? '발표 중 답하지 못한 질문(rag-miss)으로 클라우드에서 자동 습득된 문서입니다. 내용을 검토·수정한 뒤 저장하면 <b>전체 재임베딩</b>과 신뢰도 <b>높음(1.0)</b>이 적용됩니다. 이름을 바꾸면 원래 질문은 재습득 금지로 기록됩니다(수정한 지식이 같은 질문으로 덮이지 않음).' : '저장하면 전체 재임베딩과 신뢰도 높음(1.0)이 적용됩니다.'}</p>
<form method="post" action="${PREFIX}/admin/knowledge/update">
<input type="hidden" name="id" value="${doc.id}">
<label style="display:block;font-size:.78rem;color:#9a9ea8;margin:8px 0 4px">이름</label>
<input name="name" value="${esc(doc.name)}" required style="width:460px;max-width:100%;padding:6px 8px;font-size:.8rem;background:#0d0f13;border:1px solid #2a2e38;border-radius:6px;color:#e8e8ea">
<label style="display:block;font-size:.78rem;color:#9a9ea8;margin:12px 0 4px">내용 — 전문을 자유롭게 편집하세요. 저장 시 다시 청크·임베딩됩니다.</label>
<textarea name="text" required rows="16" style="display:block;width:100%;box-sizing:border-box;padding:8px;font-size:.8rem;line-height:1.55;background:#0d0f13;border:1px solid #2a2e38;border-radius:6px;color:#e8e8ea">${esc(content)}</textarea>
<div style="margin-top:10px"><button class="actBtn" type="submit" style="background:#2b5fd9">💾 저장·재임베딩</button>
<a href="${PREFIX}/admin#knowledge" style="margin-left:12px;color:#9a9ea8;font-size:.8rem">취소 — 지식 관리로</a></div>
</form>
</div>`);
}
// [2026-10-05] 🧭 Decision Router 탭 (지시서 §26) — 결정 레이어의 모드·라우트 분포·KPI·임계값·
// 최근 판단. 지표는 decision_log.jsonl 꼬리에서 실시간 산출, 옵티마이저 결과는 decision_status.json.
function decisionRouterPanel() {
  const p = decisionPolicy.getPolicy();
  const m = decisionService.computeMetrics(500);
  const st = decisionService.readStatus();
  const modeBadge = { shadow: ['Shadow', '#2b5fd9'], canary: ['Canary', '#8a6a20'], active: ['Active', '#2f8a4c'], off: ['끔', '#3a3a44'] }[p.mode] || [p.mode, '#3a3a44'];
  let recent = [];
  try {
    const lines = fs.readFileSync(decisionService.LOG_PATH, 'utf8').trim().split('\n');
    recent = lines.slice(-15).reverse().map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { /* 로그 없음 */ }
  const routeTotal = m.total ? Object.values(m.routes || {}).reduce((a, b) => a + b, 0) : 0;
  const routeRows = Object.entries(m.routes || {}).sort((a, b) => b[1] - a[1]).map(([r, n]) => {
    const pct = routeTotal ? Math.round(100 * n / routeTotal) : 0;
    return `<tr><td><b>${r}</b></td><td>${n}</td><td><div style="background:#1a5c3a;border-radius:4px;height:14px;width:${Math.max(2, pct)}px;display:inline-block;vertical-align:middle"></div> ${pct}%</td></tr>`;
  }).join('') || '<tr><td colspan="3" style="color:#888">기록 없음 — 다음 QA부터 축적됩니다</td></tr>';
  const thRows = [['direct_answer_high', 'DIRECT 직답 하한'], ['no_answer_high', 'NO_ANSWER 확정 하한'], ['llm_required_high', 'LLM_REASON 하한'], ['answer_mid', 'RAG_SHORT 하한']].map(([k, label]) => {
    const c = decisionPolicy.CLAMPS[k] || [null, null];
    return `<tr><td>${label}</td><td><code>${k}</code></td><td>${Number(p[k]).toFixed(2)}</td><td><small style="color:#767b86">${c[0]}~${c[1]} (클램프)</small></td></tr>`;
  }).join('');
  const recentRows = recent.map(r => {
    const rt = (r.threshold && r.threshold.route) || '?';
    const conf = r.decision ? Number(r.decision.confidence).toFixed(2) : '-';
    const fb = r.execution && r.execution.fallback ? '<span class="pill" style="background:#8a6a20">폴백</span>' : '';
    const eng = r.actual && r.actual.engine === 'rag-miss' ? '<span class="pill" style="background:#8a3030">거절</span>' : '<span class="pill" style="background:#2f8a4c">답변</span>';
    return `<tr><td><small>${esc((r.ts || '').slice(5, 16).replace('T', ' '))}</small></td><td>${esc((r.q || '').slice(0, 34))}</td><td><b>${rt}</b>${fb}</td><td>${conf}</td><td>${eng}</td><td><small>${r.execution && r.execution.provider_error ? esc(r.execution.provider_error) : (r.decision && r.decision.reason_code) || '-'}</small></td></tr>`;
  }).join('') || '<tr><td colspan="6" style="color:#888">아직 판단 기록이 없습니다</td></tr>';
  const kpi = (ok, v) => v == null ? '<small style="color:#767b86">데이터 대기</small>' : `<span class="pill" style="background:${ok ? '#2f8a4c' : '#8a3030'}">${v}</span>`;
  return `<div class="box wide">
<h1>🧭 Decision Router</h1>
<p style="color:#9a9ea8;font-size:.8rem;margin-top:6px">RAG와 LLM 사이에서 "이 질문에 답할 수 있는가"를 판단하는 결정 레이어. 현재 <b>Shadow Mode</b> — 판단은 기록 전용이고 실제 QA는 기존 체인 그대로 동작합니다. 판단 <b>${m.total}</b>건 적재(≥100건에서 전환 검토). 임계값은 <code>eval/decision_policy.json</code>(tts_policy와 별개)에서 관리됩니다.</p>
<div class="cards">
<a class="card" href="#decision" onclick="return false"><div class="k">동작 모드</div><div class="v"><span class="pill" style="background:${modeBadge[1]};font-size:1rem">${modeBadge[0]}</span></div><div class="s">판단체 ${esc(p.provider)} · 정책 v${p.version} · Canary ${p.canary_pct}%</div></a>
<a class="card" href="#decision" onclick="return false"><div class="k">LLM 회피율 (판단)</div><div class="v">${m.total ? m.llm_avoidance + '%' : '-'}<small style="font-size:.85rem;color:#9a9ea8">/목표 ~60%</small></div><div class="s">현재 실측 기준선 86.7%(qa_log)</div></a>
<a class="card" href="#decision" onclick="return false"><div class="k">오거절 (False Reject)</div><div class="v">${kpi((m.false_reject ?? 5) <= 5, m.false_reject == null ? null : m.false_reject + '%')}</div><div class="s">KPI ≤5% — 거절 판단했는데 실제론 답변됨</div></a>
<a class="card" href="#decision" onclick="return false"><div class="k">오수용 (False Accept)</div><div class="v">${kpi((m.false_accept ?? 3) <= 3, m.false_accept == null ? null : m.false_accept + '%')}</div><div class="s">KPI ≤3% — 직답 판단했는데 실제론 거절됨</div></a>
</div>
<div style="display:flex;gap:24px;flex-wrap:wrap;margin-top:10px">
<div style="flex:1;min-width:260px">
<h2 class="sec">라우트 분포 (최근 500판단)</h2>
<table><thead><tr><th>라우트</th><th>건수</th><th>비중</th></tr></thead><tbody>${routeRows}</tbody></table>
</div>
<div style="flex:1;min-width:260px">
<h2 class="sec">임계값</h2>
<table><thead><tr><th>게이트</th><th>키</th><th>현재</th><th>범위</th></tr></thead><tbody>${thRows}</tbody></table>
<p style="font-size:.75rem;color:#767b86;margin:6px 0 0">옵티마이저(python3 decision/decision_optimizer.py)가 오류율·표본 50건·30분 쿨다운·1회 ±0.03 클램프 안에서 자동 조정합니다.</p>
<form method="post" action="${PREFIX}/admin/decision-optimize" style="margin-top:8px"><button class="actBtn" type="submit" style="background:#2b5fd9">⚙️ 지금 최적화 실행</button>
${st ? `<small style="color:#767b86;margin-left:8px">최근 실행 ${(st.generated_at || '').slice(5, 16).replace('T', ' ')}${st.adjustments && st.adjustments.length ? ' — 조정 ' + st.adjustments.length + '건' : ' — 조정 없음'}</small>` : ''}</form>
</div>
</div>
<h2 class="sec">최근 판단 (15건)</h2>
<table><thead><tr><th>시각</th><th>질문</th><th>라우트</th><th>신뢰도</th><th>실제결과</th><th>사유</th></tr></thead><tbody>${recentRows}</tbody></table>
</div>`;
}

function adminPage(notice, activeTab = 'dash', opts = {}) {
  const users = allUsers();
  const rows = users.map(u => {
    const usage = usageSummary(u.id);
    const pill = u.status === 'pending' ? 'pending' : (u.status === 'disabled' ? 'disabled' : 'approved');
    const label = { pending: '대기중', approved: '승인됨', disabled: '비활성', rejected: '거부됨' }[u.status] || u.status;
    return `<tr>
<td>${esc(u.username)}</td>
<td>${u.role === 'admin' ? '관리자' : '사용자'}</td>
<td><span class="pill ${pill}">${label}</span></td>
<td>${esc((u.created_at || '').slice(0, 10))}</td>
<td><a href="${PREFIX}/admin/users/${u.id}/docs">${usage.docCount}</a></td>
<td><a href="${PREFIX}/admin/users/${u.id}/ppts">${usage.pptCount}</a></td>
<td>${fmtBytes(usage.storageBytes)}</td>
<td>${usage.queryCount7d}</td>
<td>${usage.lastActive ? esc(usage.lastActive.slice(0, 16).replace('T', ' ')) : '-'}</td>
<td>
${u.status === 'pending' ? `<form class="inline" method="post" action="${PREFIX}/admin/approve"><input type="hidden" name="username" value="${esc(u.username)}"><button class="actBtn" type="submit">승인</button></form>` : ''}
${u.status === 'approved' && u.role !== 'admin' ? `<form class="inline" method="post" action="${PREFIX}/admin/deactivate"><input type="hidden" name="username" value="${esc(u.username)}"><button class="actBtn" type="submit" style="background:#8a6a20">비활성화</button></form>` : ''}
${u.status === 'disabled' ? `<form class="inline" method="post" action="${PREFIX}/admin/reactivate"><input type="hidden" name="username" value="${esc(u.username)}"><button class="actBtn" type="submit">재활성화</button></form>` : ''}
${u.username !== 'admin' ? `<form class="inline" method="post" action="${PREFIX}/admin/reject" onsubmit="return confirm('${esc(u.username)} 계정을 완전히 삭제할까요? 문서/PPT도 모두 삭제됩니다.')"><input type="hidden" name="username" value="${esc(u.username)}"><button class="actBtn" type="submit" style="background:#8a3030">삭제</button></form>` : ''}
<form class="inline" method="post" action="${PREFIX}/admin/reset-password" onsubmit="return confirm('${esc(u.username)}의 비밀번호를 바꿀까요?')">
<input type="hidden" name="username" value="${esc(u.username)}">
<input name="newPassword" placeholder="새 비밀번호" required minlength="4" style="width:90px;padding:3px 6px;font-size:.72rem;display:inline-block">
<button class="actBtn" type="submit" style="background:#3a3a44">변경</button>
</form>
</td>
</tr>`;
  }).join('');
  const sec = (id, html) => `<section class="tabS${activeTab === id ? ' on' : ''}" data-tab="${id}">${html}</section>`;
  // 지식 관리는 "운영 중인 관리자" 계정의 지식을 다룬다 — knowledge 라우트는 req.user.id를 넘기고,
  // 일반 렌더는 첫 관리자 계정(운영자)으로 해석한다.
  const kuid = opts.knowUid || ((db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() || {}).id);
  return adminShell(activeTab, `${notice ? `<div class="msg ok">${esc(notice)}</div>` : ''}
${sec('dash', overviewPanel())}
${sec('users', `<div class="box wide">
<h1>👥 사용자 관리</h1>
<table><thead><tr><th>아이디</th><th>권한</th><th>상태</th><th>가입일</th><th>문서</th><th>PPT</th><th>용량</th><th>호출(7일)</th><th>최근활동</th><th></th></tr></thead><tbody>${rows}</tbody></table>
</div>`)}
${sec('knowledge', knowledgePanel(kuid))}
${sec('decision', decisionRouterPanel())}
${sec('loop', integrityPanel())}
${sec('anno', annotationPanel())}
${sec('docs', docsPanel())}
${sec('tools', toolsPanel())}`);
}

// ── 앱 ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: false }));
// PPT 저장(이미지 base64 포함)이 커서 전역 한도를 80mb로 — 라우트별로 따로 두면 같은 Content-Type에
// 파서가 두 번 걸려 바디를 다시 못 읽는 문제가 생기므로 하나로 통일(ponytail: 인증된 소수 내부
// 사용자용 도구라 전역 상향의 비용이 낮음).
app.use(express.json({ limit: '80mb' }));
// [2026-10-02] 접근 로그 — 이전 서버는 console.log 3번이 전부라 쿠키 버그가 나도 추적 불가능했다.
// 이제 "로그인 성공 다음 요청에 user=가 비어있다" 같은 걸 로그 한 줄로 바로 알 수 있다.
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const user = req.user ? req.user.username : 'anon';
    console.log(`${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode} ${Date.now() - t0}ms user=${user}`);
  });
  next();
});

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.redirect(`${PREFIX}/login`);
  if (user.status !== 'approved') return res.status(403).send(loginPage({ error: statusMessage(user.status) }));
  req.user = user;
  next();
}
function requireApiAuth(req, res, next) {
  const user = currentUser(req);
  if (!user || user.status !== 'approved') return res.status(401).json({ error: '로그인이 필요합니다.' });
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.redirect(`${PREFIX}/login`);
  if (user.role !== 'admin') return res.redirect(`${PREFIX}.html`);
  req.user = user;
  next();
}

app.get(PREFIX, (req, res) => res.redirect(`${PREFIX}.html`));
app.get(`${PREFIX}.html`, requireAuth, (req, res) => {
  // [2026-10-02, 사용자 요청] 계정 아이디를 눌러야 로그아웃(+관리자면 관리자 페이지)이 뜨는
  // 드롭다운으로 변경 — 항상 아이콘 두 개가 떠 있던 것보다 더 명확하게 "이 계정" 느낌을 줌.
  const nav = `<div id="acctWrap" style="position:relative;margin-right:4px">
<button class="iconBtn" style="width:auto;padding:0 10px;gap:5px" onclick="event.stopPropagation();document.getElementById('acctMenu').classList.toggle('show')">👤 ${esc(req.user.username)}</button>
<div id="acctMenu" class="acctMenu">
${req.user.role === 'admin' ? `<a href="${PREFIX}/admin">🛠️ 관리자 페이지</a>` : ''}
<a href="${PREFIX}/logout">🚪 로그아웃</a>
</div>
</div>
<script>document.addEventListener('click',()=>{const m=document.getElementById('acctMenu');if(m)m.classList.remove('show')})</script>`;
  const html = fs.readFileSync(PPT_HTML_PATH, 'utf8').replace('<!--USER_NAV-->', nav);
  // [2026-10-04] no-cache — 브라우저(Safari 등)가 HTML을 휴리스틱 캐싱해 이전 버전으로 계속 동작하는 사례 방지.
  // no-store가 아닌 no-cache: 매 요청 ETag 재검증만 하므로 트래픽 부담 없이 항상 최신 유지.
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(html);
});

app.get(`${PREFIX}/login`, (req, res) => res.send(loginPage({ notice: req.query.registered ? '가입 신청이 접수됐습니다. 관리자 승인 후 로그인할 수 있습니다.' : undefined })));
app.post(`${PREFIX}/login`, (req, res) => {
  const { username, password } = req.body;
  const user = findUserByUsername(username || '');
  if (!user || hashPassword(password || '', user.salt) !== user.hash) {
    console.warn(`로그인 실패(${!user ? '존재하지 않는 아이디' : '비밀번호 불일치'}):`, username);
    return res.status(401).send(loginPage({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' }));
  }
  if (user.status !== 'approved') return res.status(403).send(loginPage({ error: statusMessage(user.status) }));
  const token = createSession(user.id, req.headers['user-agent']);
  touchLastLogin(user.id);
  logUsage(user.id, 'login', null);
  setSessionCookie(res, token);
  res.redirect(`${PREFIX}.html`);
});

app.get(`${PREFIX}/register`, (req, res) => res.send(registerPage()));
app.post(`${PREFIX}/register`, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.length < 3 || password.length < 4) {
    return res.status(400).send(registerPage({ error: '아이디는 3자 이상, 비밀번호는 4자 이상이어야 합니다.' }));
  }
  if (findUserByUsername(username)) return res.status(409).send(registerPage({ error: '이미 사용 중인 아이디입니다.' }));
  createUser(username, password);
  res.redirect(`${PREFIX}/login?registered=1`);
});

app.get(`${PREFIX}/logout`, (req, res) => {
  const token = parseCookies(req)[COOKIE_NAME];
  if (token) destroySession(token);
  clearSessionCookie(res);
  res.redirect(`${PREFIX}/login`);
});

app.get(`${PREFIX}/admin`, requireAdmin, (req, res) => {
  const t = ['dash', 'users', 'loop', 'anno', 'docs', 'tools', 'knowledge', 'decision'].includes(req.query.tab) ? req.query.tab : 'dash';
  res.send(adminPage(undefined, t));
});
app.post(`${PREFIX}/admin/approve`, requireAdmin, (req, res) => {
  db.prepare("UPDATE users SET status='approved', approved_at=?, approved_by=? WHERE username=?")
    .run(new Date().toISOString(), req.user.id, req.body.username);
  res.send(adminPage(`${req.body.username} 승인 완료`, 'users'));
});
app.post(`${PREFIX}/admin/deactivate`, requireAdmin, (req, res) => {
  db.prepare("UPDATE users SET status='disabled' WHERE username=? AND role!='admin'").run(req.body.username);
  res.send(adminPage(`${req.body.username} 비활성화됨`, 'users'));
});
app.post(`${PREFIX}/admin/reactivate`, requireAdmin, (req, res) => {
  db.prepare("UPDATE users SET status='approved' WHERE username=?").run(req.body.username);
  res.send(adminPage(`${req.body.username} 재활성화됨`, 'users'));
});
app.post(`${PREFIX}/admin/reject`, requireAdmin, (req, res) => {
  // pending 거부든 승인된 계정 완전삭제든 동일 — FK CASCADE로 문서/청크/PPT/세션 다 같이 삭제됨.
  db.prepare("DELETE FROM users WHERE username=? AND role!='admin'").run(req.body.username);
  res.send(adminPage(`${req.body.username} 삭제됨`, 'users'));
});
app.post(`${PREFIX}/admin/reset-password`, requireAdmin, (req, res) => {
  const { username, newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) return res.send(adminPage('비밀번호는 4자 이상이어야 합니다.', 'users'));
  const salt = newSalt();
  db.prepare('UPDATE users SET salt=?, hash=? WHERE username=?').run(salt, hashPassword(newPassword, salt), username);
  res.send(adminPage(`${username} 비밀번호 변경 완료`, 'users'));
});
// 폐루프 패널의 "지금 스캔" — 감시자를 즉시 1회 실행하고 결과가 반영된 페이지로 되돌린다.
// 스캔은 로그 증분만 읽으므로 발표 중에도 무영향. 스캔 갱신 대기 3초 후 렌더.
app.post(`${PREFIX}/admin/integrity-scan`, requireAdmin, (req, res) => {
  exec(`launchctl kickstart -k gui/${process.getuid()}/ai.wizbase.ptagent.integrity`, () => {});
  setTimeout(() => res.send(adminPage('폐루프 스캔 실행 완료 — 최근 감지·조치가 갱신되었습니다.', 'loop')), 3000);
});
// [2026-10-05] Decision Router — 임계값 옵티마이저 수동 실행(§16). 자동 주기 실행은
// decision/com.ai.wizbase.ptagent.decision-opt.plist(LaunchAgent) 또는 콘솔 버튼.
app.post(`${PREFIX}/admin/decision-optimize`, requireAdmin, (req, res) => {
  exec(`cd '${__dirname}' && python3 decision/decision_optimizer.py 2>&1`, { timeout: 60000 }, (err, stdout) => {
    const msg = err ? `옵티마이저 실행 실패 — ${String(stdout || err.message).slice(0, 120)}`
      : `임계값 최적화 완료 — ${String(stdout).trim().split('\n').filter(Boolean).pop()}`;
    res.send(adminPage(msg, 'decision'));
  });
});
// [2026-10-04, 사용자 요청] 관리자 메뉴 "시스템 문서" — 정적 문서(docs/system.md)에 다운로드
// 시점의 살아있는 상태(TTS 정책 버전/무결 감시 결과/패치 대기열)를 부록 스냅샷으로 덧붙여 내려준다.
app.get(`${PREFIX}/admin/system-docs`, requireAdmin, (req, res) => {
  let doc;
  try {
    doc = fs.readFileSync(path.join(__dirname, 'docs/system.md'), 'utf8');
  } catch {
    return res.status(500).send('시스템 문서 파일(docs/system.md)을 찾을 수 없습니다.');
  }
  const p2 = n => String(n).padStart(2, '0');
  const now = new Date();
  const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  const snap = [];
  try {
    const p = JSON.parse(fs.readFileSync('/Users/wizbase/works/bc-ai/tts_policy.json', 'utf8'));
    snap.push(`- TTS 정책: v${p.version} (${p.updated_by}, ${p.updated}) — attempts ${p.attempts}, temp 사다리 ${JSON.stringify(p.temp_ladder)}, cap_mult ${p.cap_mult}, floor_mult ${p.floor_mult}`);
  } catch { snap.push('- TTS 정책: 파일 읽기 실패'); }
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'integrity/status.json'), 'utf8'));
    const issues = s.counts && Object.keys(s.counts).length ? ` — 이슈 ${JSON.stringify(s.counts)}` : ' — 이슈 없음';
    snap.push(`- 최근 무결 감시: ${(s.last_scan || '?').replace('T', ' ').slice(0, 16)}${issues}`);
    snap.push(`- TTS 누적 통계: 성공 ${s.totals?.tts_ok ?? s.stats?.tts_ok ?? 0}건, 분할 구출 ${s.totals?.tts_split_rescue ?? s.stats?.tts_split_rescue ?? 0}건`);
  } catch { snap.push('- 무결 감시: 기록 없음'); }
  try {
    const lines = fs.readFileSync(path.join(__dirname, 'integrity/issues.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    const codes = [...new Set(lines.map(l => { try { return JSON.parse(l).code; } catch { return '?'; } }))];
    snap.push(`- 코드 패치 대기열: ${lines.length}건${codes.length ? ' (' + codes.join(', ') + ')' : ''}`);
  } catch { snap.push('- 코드 패치 대기열: 없음'); }
  const out = doc + `\n---\n\n## 부록: 다운로드 시점 상태 스냅샷 (${stamp} ${p2(now.getHours())}:${p2(now.getMinutes())} KST)\n\n${snap.join('\n')}\n`;
  const fname = encodeURIComponent(`pt-agent-시스템문서-${stamp}.md`);
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="pt-agent-system-docs-${stamp}.md"; filename*=UTF-8''${fname}`);
  res.send(out);
});
// [2026-10-04, 사용자 요청] 모델 교체 평가 화면 우측 상단 "평가 시스템 문서" 다운로드.
// docs/model-eval.md(시스템체계·세부기능·특장점·타 시스템 적용방안)에 현재 스택/시험 상태 스냅샷을 덧붙인다.
app.get(`${PREFIX}/admin/model-eval-docs`, requireAdmin, (req, res) => {
  let doc;
  try {
    doc = fs.readFileSync(path.join(__dirname, 'docs/model-eval.md'), 'utf8');
  } catch {
    return res.status(500).send('문서 파일(docs/model-eval.md)을 찾을 수 없습니다.');
  }
  const p2 = n => String(n).padStart(2, '0');
  const now = new Date();
  const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  const snap = [];
  try {
    const r = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval/registry.json'), 'utf8'));
    snap.push(`- 현재 스택: LLM ${r.llm?.current || '?'} / STT ${r.stt?.current || '?'} / TTS ${r.tts?.current_model || '?'} (${r.tts?.current_voice || ''})`);
  } catch { snap.push('- 스택 레지스트리: 파일 읽기 실패'); }
  try {
    const t = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval/trial.json'), 'utf8'));
    if (t.status === 'trial') {
      snap.push(`- 시험 운영: **진행 중** — ${t.stack} → ${t.spec?.model || '?'} (시작 ${t.started_at})`);
    } else {
      snap.push(`- 마지막 시험: ${t.stack || '?'} → ${t.spec?.model || '?'} — ${t.status === 'approved' ? '✅ 승인 확정' : '↩️ 롤백'} (${t.finished_at || '?'})`);
    }
  } catch { snap.push('- 시험 이력: 없음'); }
  try {
    const files = fs.readdirSync(path.join(__dirname, 'eval/results')).filter(f => f.endsWith('.json'));
    snap.push(`- 벤치마크 리포트 보관: ${files.length}건 (eval/results/)`);
  } catch { /* results 디렉터리 없음 — 생략 */ }
  const out = doc + `\n---\n\n## 부록: 다운로드 시점 상태 스냅샷 (${stamp} ${p2(now.getHours())}:${p2(now.getMinutes())} KST)\n\n${snap.join('\n')}\n`;
  const fname = encodeURIComponent(`pt-agent-모델교체평가시스템문서-${stamp}.md`);
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="pt-agent-model-eval-docs-${stamp}.md"; filename*=UTF-8''${fname}`);
  res.send(out);
});
// ── 모델 교체 평가 (2026-10-04) — 조사→벤치→시험→무결루프 검증→승인/롤백 ──
const evalPage = require('./eval_page');
app.get(`${PREFIX}/admin/model-eval`, requireAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store').type('html').send(evalPage.pageHTML());
});
app.get(`${PREFIX}/admin/model-eval/state`, requireAdmin, async (req, res) => res.json(await meval.state()));
app.post(`${PREFIX}/admin/model-eval/discover`, requireAdmin, async (req, res) => {
  try { res.json(await meval.discover()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post(`${PREFIX}/admin/model-eval/bench`, requireAdmin, async (req, res) => {
  try {
    const { stack, candidate } = req.body || {};
    if (!stack || typeof stack !== 'string') return res.status(400).json({ error: 'stack 필요' });
    if (stack === 'tts' && !(candidate && candidate.model)) return res.status(400).json({ error: 'TTS 후보 model 필요' });
    if (stack === 'llm' && !(candidate && candidate.model)) return res.status(400).json({ error: 'LLM 후보 model 필요' });
    res.json(await meval.runComparison(stack, candidate || {}));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get(`${PREFIX}/admin/model-eval/trial/report`, requireAdmin, (req, res) => res.json(meval.trialReport()));
app.post(`${PREFIX}/admin/model-eval/trial/start`, requireAdmin, (req, res) => {
  try {
    const { stack, candidate } = req.body || {};
    res.json(meval.trialStart(stack, candidate || {}));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post(`${PREFIX}/admin/model-eval/trial/finish`, requireAdmin, (req, res) => {
  try { res.json(meval.trialFinish(!!(req.body && req.body.approve))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── n8n 프록시 — 비밀 키는 여기서만 붙인다 ──
const meval = require('./model_eval');
async function proxyToN8n(req, res, webhookPath, eventType) {
  try {
    const body = { ...req.body, key: N8N_KEY };
    // [2026-10-04] 모델 시험 운영 중이면 LLM 호출을 후보 모델로 주입 — n8n 게이트웨이가
    // b.model을 존중하므로 n8n/클라이언트 무수정. 롤백은 trial.json 반영 즉시 복원.
    const t = meval.trial();
    if (t && t.status === 'trial' && t.stack === 'llm' && t.spec.model) body.model = t.spec.model;
    const r = await fetch(`${N8N_BASE}/webhook/${webhookPath}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await r.text();
    logUsage(req.user.id, eventType, null);
    res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(text);
  } catch (e) {
    res.status(502).json({ error: 'upstream 요청 실패: ' + e.message });
  }
}
app.post(`${PREFIX}/api/script`, requireApiAuth, (req, res) => proxyToN8n(req, res, 'koen-openai-script', 'script_call'));
app.post(`${PREFIX}/api/llm`, requireApiAuth, (req, res) => proxyToN8n(req, res, 'koen-local-llm', 'llm_call'));

// ── 개인화 RAG — 임베딩은 서버만 n8n을 호출(클라이언트가 부를 수 있는 /api/embed 라우트 자체를
// 안 둔다). 예전엔 koen-openai-embed가 키 체크 없이 열려 있었는데, 그걸 "키를 요구하게" 고치는
// 대신 클라이언트가 그 웹훅의 존재 자체를 모르게 만들어 더 확실하게 닫았다. ──
async function embedViaN8n(text) {
  try {
    const r = await fetch(`${N8N_BASE}/webhook/koen-openai-embed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: text, key: N8N_KEY }),
    });
    const j = await r.json().catch(() => ({}));
    return j.embedding || null;
  } catch (e) { return null; }
}
function cosineSim(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
// chunks.embedding은 Float32Array 버퍼로 저장(JSON 문자열 대비 4~8배 작음).
function embToBuf(arr) { return Buffer.from(Float32Array.from(arr).buffer); }
function bufToEmb(buf) { return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)); }

function docCountChunks(docId) { return db.prepare('SELECT COUNT(*) v FROM chunks WHERE document_id=?').get(docId).v; }

app.post(`${PREFIX}/api/docs`, requireApiAuth, async (req, res) => {
  const { name, text } = req.body;
  if (!name || !text) return res.status(400).json({ error: 'name과 text가 필요합니다.' });
  const texts = chunkText(text);
  const now = new Date().toISOString();
  const docId = db.prepare('INSERT INTO documents(user_id,name,is_primary,source_bytes,created_at) VALUES(?,?,0,?,?)')
    .run(req.user.id, name, Buffer.byteLength(text, 'utf8'), now).lastInsertRowid;
  const ins = db.prepare('INSERT INTO chunks(document_id,user_id,seq,text,embedding,char_count) VALUES(?,?,?,?,?,?)');
  let seq = 0;
  for (const t of texts) {
    const emb = await embedViaN8n(t);
    if (emb) ins.run(docId, req.user.id, seq++, t, embToBuf(emb), t.length);
  }
  logUsage(req.user.id, 'doc_upload', Buffer.byteLength(text, 'utf8'));
  res.json({ id: docId, name, chunkCount: seq, isPrimary: false });
});
app.get(`${PREFIX}/api/docs`, requireApiAuth, (req, res) => {
  const docs = db.prepare('SELECT id,name,is_primary,source_bytes,created_at,origin,confidence FROM documents WHERE user_id=? ORDER BY created_at').all(req.user.id);
  res.json(docs.map(d => ({ id: d.id, name: d.name, isPrimary: !!d.is_primary, sourceBytes: d.source_bytes, createdAt: d.created_at, chunkCount: docCountChunks(d.id), origin: d.origin || 'manual', confidence: d.confidence == null ? 1 : d.confidence })));
});
app.patch(`${PREFIX}/api/docs/:id`, requireApiAuth, (req, res) => {
  const doc = db.prepare('SELECT id FROM documents WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  if (req.body.isPrimary !== undefined) db.prepare('UPDATE documents SET is_primary=? WHERE id=?').run(req.body.isPrimary ? 1 : 0, doc.id);
  // [2026-10-05] 신뢰도 조정 — 관리 콘솔과 같은 값 체계(높음 1.0/보통 0.5/낮음 0.3, 0~1 임의값 허용)
  if (req.body.confidence !== undefined) {
    const c = Math.max(0, Math.min(1, Number(req.body.confidence)));
    if (!Number.isNaN(c)) db.prepare('UPDATE documents SET confidence=? WHERE id=?').run(c, doc.id);
  }
  res.json({ ok: true });
});
app.delete(`${PREFIX}/api/docs/:id`, requireApiAuth, (req, res) => {
  const doc = db.prepare('SELECT id FROM documents WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM documents WHERE id=?').run(doc.id); // chunks는 FK CASCADE로 같이 삭제
  logUsage(req.user.id, 'doc_delete', null);
  res.json({ ok: true });
});
app.get(`${PREFIX}/api/docs/:id/chunks`, requireApiAuth, (req, res) => {
  const doc = db.prepare('SELECT id FROM documents WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  res.json(db.prepare('SELECT text FROM chunks WHERE document_id=? ORDER BY seq LIMIT 10').all(doc.id));
});
// "주로 참고" 문서가 하나라도 지정돼 있으면 그 문서들로만 검색 범위를 좁힘(기존 클라이언트 searchRef와
// 동일한 규칙) — 전부 req.user.id로 스코프돼 있어 다른 유저의 청크는 애초에 쿼리에 안 걸림.
app.post(`${PREFIX}/api/search`, requireApiAuth, async (req, res) => {
  const { query, k } = req.body;
  if (!query) return res.json([]);
  // [2026-10-05] 자동 습득 지식(origin='auto')은 '주로 참고' 스코프와 무관하게 항상 검색 대상 —
  // QA 거절로 습득된 지식은 원래 덱에 없던 내용이라 is_primary로 좁히면 영영 검색되지 않는다.
  const primaryIds = db.prepare('SELECT id FROM documents WHERE user_id=? AND is_primary=1').all(req.user.id).map(d => d.id);
  const autoIds = db.prepare("SELECT id FROM documents WHERE user_id=? AND origin='auto'").all(req.user.id).map(d => d.id);
  const scopeIds = primaryIds.length ? Array.from(new Set([...primaryIds, ...autoIds])) : null;
  const rows = scopeIds
    ? db.prepare(`SELECT c.text,c.embedding,c.document_id,d.name as doc_name,d.origin as origin,d.confidence as confidence FROM chunks c JOIN documents d ON d.id=c.document_id WHERE c.user_id=? AND c.document_id IN (${scopeIds.map(() => '?').join(',')})`).all(req.user.id, ...scopeIds)
    : db.prepare(`SELECT c.text,c.embedding,c.document_id,d.name as doc_name,d.origin as origin,d.confidence as confidence FROM chunks c JOIN documents d ON d.id=c.document_id WHERE c.user_id=?`).all(req.user.id);
  if (!rows.length) return res.json([]);
  const qEmb = await embedViaN8n(query);
  if (!qEmb) return res.json([]);
  // [2026-10-05 v9d] 신뢰도 랭킹 반영 — 자동 습득 문서의 conf(0.5/0.3)가 랭킹에 전혀 반영되지 않아
  // 불확실(conf 0.3) 청크가 1차 문서와 동등 경쟁했다(실측 오염: 불만 원문·STT 잡음이 임베딩돼 RAG에 유입).
  // 점수에 신뢰도 가중(1.0→×1.0, 0.5→×0.8, 0.3→×0.72)을 두고 컷 판정도 같은 가중 점수로 일관 적용.
  const ranked = rows.map(r => ({ text: r.text, docId: r.document_id, docName: r.doc_name, score: cosineSim(qEmb, bufToEmb(r.embedding)) * (0.6 + 0.4 * (r.confidence == null ? 1 : r.confidence)), origin: r.origin || 'manual', confidence: r.confidence == null ? 1 : r.confidence }))
    .sort((a, b) => b.score - a.score);
  // [2026-10-05] 커버리지 개선 — 이 임베딩 모델은 동일 도메인 한국어 텍스트에서 청크 간 배경 유사도
  // 자체가 높다(실측: 무작위 쌍 중앙값 0.462, p90 0.641). 절대 컷 0.3은 관련 문서(top1 0.34)까지
  // 간당간당 걸러내 5문항 중 1건만 매칭됐다. 상대 컷(top×0.85, 배경 수준과 무관하게 최상위 근처만
  // 통과)에 낮은 절대 바닥(0.25, 완전 무관 질문 차단)을 함께 적용한다.
  const top = ranked.length ? ranked[0].score : 0;
  const cut = Math.max(0.25, top * 0.85);
  const scored = ranked.slice(0, k || 3).filter(r => r.score >= cut);
  logUsage(req.user.id, 'search_call', null);
  res.json(scored);
});

// ── 지식 자동 습득 폐루프 [2026-10-05, 사용자 요청] ──────────────────────────
// 로컬 RAG에 없는 질문(rag-miss 거절)을 클라우드 LLM(koen-openai-script)으로 답해 같은 유저의
// documents/chunks에 자동 임베딩한다. 발표가 거듭될수록 자동 지식이 쌓여 로컬 답변 커버리지가
// 넓어진다("로컬 지식화 후 답변"). 신뢰도: 운영자 수동 1.0 / 자동 확신 0.5 / 클라우드가
// [불확실] 표기 0.3 — 관리자 콘솔 '지식 관리' 탭에서 조회·조정·삭제한다.
const KNOW_LEDGER = path.join(__dirname, 'eval', 'knowledge.jsonl');
const KNOW_DISMISS = path.join(__dirname, 'eval', 'knowledge-dismissed.jsonl');
const CONF_MANUAL = 1.0, CONF_AUTO = 0.5, CONF_AUTO_UNCERTAIN = 0.3;
const _knowInFlight = new Set(); // 같은 질문 중복 습득 방지(발표 중 연속 거절·콘솔 동시 클릭)
const normQ = q => String(q || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
const knowName = q => '자동학습: ' + normQ(q);

// 습득 상태 판정 — 콘솔 백로그 목록에서 쓴다. 습득됨=같은 정규화 질문의 auto 문서가 "지금" 존재.
function knowAcquiredSet(userId) {
  const set = new Set();
  try {
    for (const d of db.prepare("SELECT name FROM documents WHERE user_id=? AND origin='auto'").all(userId)) {
      if (d.name.startsWith('자동학습: ')) set.add(d.name.slice('자동학습: '.length));
    }
  } catch { /* 컬럼 신설 전 */ }
  return set;
}
function knowDismissedSet() {
  const set = new Set();
  try {
    for (const l of fs.readFileSync(KNOW_DISMISS, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { const j = JSON.parse(l); if (j.q) set.add(normQ(j.q)); } catch { /* 부분 행 무시 */ }
    }
  } catch { /* 파일 없음 */ }
  return set;
}
function knowLedger(rec) { try { fs.appendFileSync(KNOW_LEDGER, JSON.stringify(rec) + '\n'); } catch (_) {} }

// 실제 습득 — 클라우드 답변 1회 + 임베딩 1회(청크는 질문+답변 합본 1~2개). 수동(콘솔) 호출도
// 같은 함수를 쓰고 ledger source로만 구분한다. 실패해도 발표 흐름을 건드리지 않는다(호출부 비동기).
async function acquireKnowledge(userId, q, opts = {}) {
  const nq = normQ(q);
  if (!nq) return { ok: false, reason: 'empty' };
  const name = knowName(q);
  if (_knowInFlight.has(userId + ':' + name)) return { ok: false, reason: 'in-flight' };
  _knowInFlight.add(userId + ':' + name);
  const t0 = Date.now();
  try {
    if (knowDismissedSet().has(nq)) return { ok: false, reason: 'dismissed' };
    const dup = db.prepare("SELECT id FROM documents WHERE user_id=? AND origin='auto' AND name=?").get(userId, name);
    if (dup) return { ok: false, reason: 'duplicate', docId: dup.id };
    // 1) 클라우드 답변 — proxyToN8n과 같은 게이트웨이·모델 시험 주입 규칙을 그대로 쓴다.
    const ctx = '당신은 발표 질의응답용 지식 사전을 편찬하고 있습니다. 다음 질문에 대해 객관적 사실만 한국어로 2~4문장으로 정리하세요. 수치·고유명사·날짜는 확실한 것만 쓰고, 확신이 없으면 답변 맨 앞에 [불확실]이라고 표기하세요.'
      + (opts.context ? '\n[질문 배경] ' + String(opts.context).slice(0, 120) : '') + '\n[질문] ' + q;
    const body = { messages: [{ role: 'user', content: ctx }], key: N8N_KEY };
    const t = meval.trial();
    if (t && t.status === 'trial' && t.stack === 'llm' && t.spec.model) body.model = t.spec.model;
    const r = await fetch(`${N8N_BASE}/webhook/koen-openai-script`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    let ans = String(j.content || '').trim();
    if (!ans) { console.log(`[지식 습득 실패] "${name}" — 클라우드 빈 응답(${Date.now() - t0}ms) — n8n 게이트웨이 확인 필요`); return { ok: false, reason: 'cloud-empty' }; }
    const uncertain = /^\[불확실\]/.test(ans) || ans.includes('[불확실]');
    ans = ans.replace(/\[불확실\]\s*/g, '').trim();
    // 2) 임베딩 — 청크 본문에 질문을 함께 넣는다(질문형 쿼리와의 코사인 적중률↑).
    const full = `${q}\n${ans}`;
    const docId = db.prepare('INSERT INTO documents(user_id,name,is_primary,source_bytes,created_at,origin,confidence) VALUES(?,?,0,?,?,?,?)')
      .run(userId, name, Buffer.byteLength(full, 'utf8'), new Date().toISOString(), 'auto', uncertain ? CONF_AUTO_UNCERTAIN : CONF_AUTO).lastInsertRowid;
    const ins = db.prepare('INSERT INTO chunks(document_id,user_id,seq,text,embedding,char_count) VALUES(?,?,?,?,?,?)');
    let seq = 0;
    for (const t2 of chunkText(full)) {
      const emb = await embedViaN8n(t2);
      if (emb) ins.run(docId, userId, seq++, t2, embToBuf(emb), t2.length);
    }
    if (!seq) { db.prepare('DELETE FROM documents WHERE id=?').run(docId); return { ok: false, reason: 'embed-fail' }; }
    const conf = uncertain ? CONF_AUTO_UNCERTAIN : CONF_AUTO;
    knowLedger({ ts: new Date().toISOString(), user: opts.userName || 'unknown', q: nq, docId, confidence: conf, uncertain, chars: ans.length, ms: Date.now() - t0, source: opts.source || 'auto' });
    console.log(`[지식 습득] "${name}" → 문서#${docId} 신뢰도 ${conf} (${Date.now() - t0}ms, ${seq}청크)`);
    return { ok: true, docId, confidence: conf };
  } catch (e) {
    console.log(`[지식 습득 실패] "${q}" — ${((e && e.message) || e)} (${Date.now() - t0}ms)`);
    return { ok: false, reason: 'error:' + ((e && e.message) || '').slice(0, 60) };
  } finally {
    _knowInFlight.delete(userId + ':' + name);
  }
}
// 발표 중 클라이언트 rag-miss 거절 → 즉시 202 응답 후 백그라운드 습득(답변 흐름 무영향).
app.post(`${PREFIX}/api/knowledge/acquire`, requireApiAuth, (req, res) => {
  const q = String((req.body && req.body.q) || '').trim();
  if (!q) return res.status(400).json({ error: 'q 필요' });
  const nq = normQ(q);
  if (knowDismissedSet().has(nq) || knowAcquiredSet(req.user.id).has(nq)) return res.json({ accepted: true, dedup: true });
  res.json({ accepted: true, dedup: false });
  acquireKnowledge(req.user.id, q, { context: (req.body && req.body.context) || '', userName: req.user.username, source: 'auto' })
    .catch(() => {});
});
// 관리자 콘솔 백로그 "지금 습득" — 폼 POST라 동기 완료 후 결과 메시지와 함께 렌더.
app.post(`${PREFIX}/admin/knowledge/acquire`, requireAdmin, async (req, res) => {
  const q = String(req.body.q || '').trim();
  if (!q) return res.send(adminPage('질문이 비어 있습니다.', 'knowledge', { knowUid: req.user.id }));
  const r = await acquireKnowledge(req.user.id, q, { userName: req.user.username, source: 'manual-acquire' });
  const msg = r.ok ? `"${q}" 습득 완료 — 신뢰도 ${r.confidence}(자동 0.5·불확실 0.3)로 임베딩됐습니다.`
    : r.reason === 'duplicate' ? `"${q}" — 이미 습득된 질문입니다.`
    : r.reason === 'dismissed' ? `"${q}" — 제외 처리된 질문입니다(제외 해제는 knowledge-dismissed.jsonl 편집).`
    : `"${q}" 습득 실패(${r.reason}) — 클라우드/n8n 상태를 확인하세요.`;
  res.send(adminPage(msg, 'knowledge', { knowUid: req.user.id }));
});
app.post(`${PREFIX}/admin/knowledge/confidence`, requireAdmin, (req, res) => {
  const level = { high: CONF_MANUAL, mid: CONF_AUTO, low: CONF_AUTO_UNCERTAIN }[req.body.level];
  const id = Number(req.body.id);
  if (!level || !id) return res.send(adminPage('신뢰도 변경 요청이 올바르지 않습니다.', 'knowledge', { knowUid: req.user.id }));
  db.prepare('UPDATE documents SET confidence=? WHERE id=? AND user_id=?').run(level, id, req.user.id);
  res.send(adminPage(`문서#${id} 신뢰도를 ${level}(으)로 변경했습니다.`, 'knowledge', { knowUid: req.user.id }));
});
app.post(`${PREFIX}/admin/knowledge/delete`, requireAdmin, (req, res) => {
  const id = Number(req.body.id);
  const doc = db.prepare('SELECT id,name,origin FROM documents WHERE id=? AND user_id=?').get(id, req.user.id);
  if (!doc) return res.send(adminPage('이미 삭제된 문서입니다.', 'knowledge', { knowUid: req.user.id }));
  db.prepare('DELETE FROM documents WHERE id=?').run(doc.id); // chunks FK CASCADE
  if (doc.origin === 'auto') { // 자동 습득 지식 삭제 = "이 질문은 다시 습득하지 마" 의사로 기록
    const q = doc.name.startsWith('자동학습: ') ? doc.name.slice('자동학습: '.length) : doc.name;
    try { fs.appendFileSync(KNOW_DISMISS, JSON.stringify({ ts: new Date().toISOString(), q, docId: doc.id, by: 'delete' }) + '\n'); } catch (_) {}
  }
  res.send(adminPage(`"${doc.name}" 삭제 완료${doc.origin === 'auto' ? ' — 이 질문은 재습득 대상에서 제외됩니다.' : ''}`, 'knowledge', { knowUid: req.user.id }));
});
app.post(`${PREFIX}/admin/knowledge/dismiss`, requireAdmin, (req, res) => {
  const q = String(req.body.q || '').trim();
  if (!q) return res.send(adminPage('제외할 질문이 비어 있습니다.', 'knowledge', { knowUid: req.user.id }));
  try { fs.appendFileSync(KNOW_DISMISS, JSON.stringify({ ts: new Date().toISOString(), q: normQ(q), by: req.user.username }) + '\n'); } catch (_) {}
  res.send(adminPage(`"${q}" — 미답변 목록에서 제외했습니다.`, 'knowledge', { knowUid: req.user.id }));
});
// 수동 지식 추가 — 콘솔 폼 POST. 출처 manual, 신뢰도는 폼 선택(기본 높음 1.0). 임베딩은
// 발표 화면 업로드(/api/docs)와 같은 chunkText+embedViaN8n 경로.
app.post(`${PREFIX}/admin/knowledge/add`, requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim() || '수동 지식';
  const text = String(req.body.text || '').trim();
  if (!text) return res.send(adminPage('지식 내용을 입력하세요.', 'knowledge', { knowUid: req.user.id }));
  const conf = { high: CONF_MANUAL, mid: CONF_AUTO, low: CONF_AUTO_UNCERTAIN }[req.body.level] || CONF_MANUAL;
  const docId = db.prepare('INSERT INTO documents(user_id,name,is_primary,source_bytes,created_at,origin,confidence) VALUES(?,?,0,?,?,?,?)')
    .run(req.user.id, name, Buffer.byteLength(text, 'utf8'), new Date().toISOString(), 'manual', conf).lastInsertRowid;
  const ins = db.prepare('INSERT INTO chunks(document_id,user_id,seq,text,embedding,char_count) VALUES(?,?,?,?,?,?)');
  let seq = 0;
  for (const t of chunkText(text)) {
    const emb = await embedViaN8n(t);
    if (emb) ins.run(docId, req.user.id, seq++, t, embToBuf(emb), t.length);
  }
  knowLedger({ ts: new Date().toISOString(), user: req.user.username, q: name, docId, confidence: conf, uncertain: false, chars: text.length, ms: 0, source: 'manual' });
  res.send(adminPage(`"${name}" 추가 완료 — ${seq}청크 임베딩, 신뢰도 ${conf}.`, 'knowledge', { knowUid: req.user.id }));
});
// [2026-10-05, 사용자 요청] 지식 내용 수정 — 습득 전문을 열람·편집해 저장하면 재청크·재임베딩.
// 임베딩을 모두 성공한 뒤 트랜잭션으로 치환하므로 임베딩 실패 시 기존 청크가 그대로 보존된다.
app.get(`${PREFIX}/admin/knowledge/:id/edit`, requireAdmin, (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.id);
  if (!doc) return res.redirect(`${PREFIX}/admin`);
  let content = '';
  try { content = db.prepare('SELECT text FROM chunks WHERE document_id=? ORDER BY seq').all(doc.id).map(c => c.text).join('\n'); } catch { /* 청크 없음 */ }
  res.send(knowledgeEditPage(doc, content));
});
app.post(`${PREFIX}/admin/knowledge/update`, requireAdmin, async (req, res) => {
  const id = Number(req.body.id);
  const doc = db.prepare('SELECT * FROM documents WHERE id=? AND user_id=?').get(id, req.user.id);
  if (!doc) return res.send(adminPage('수정할 문서를 찾을 수 없습니다.', 'knowledge', { knowUid: req.user.id }));
  let content = '';
  try { content = db.prepare('SELECT text FROM chunks WHERE document_id=? ORDER BY seq').all(doc.id).map(c => c.text).join('\n'); } catch { /* 청크 없음 */ }
  const name = String(req.body.name || '').trim() || doc.name;
  const text = String(req.body.text || '').trim();
  if (!text) return res.send(knowledgeEditPage(doc, content, null, '내용이 비어 있습니다. 지식을 없애려면 목록의 삭제를 사용하세요.'));
  // 1) 재임베딩 선완료 — 전부 성공해야 치환 진행(중간 실패 시 기존 청크 보존)
  const fresh = [];
  try {
    for (const t of chunkText(text)) { const emb = await embedViaN8n(t); if (emb) fresh.push([t, emb]); }
  } catch { /* fresh 비어 아래 분기에서 안내 */ }
  if (!fresh.length) return res.send(knowledgeEditPage(doc, content, null, '임베딩 실패 — 기존 내용이 유지됐습니다. n8n 게이트웨이 상태를 확인한 뒤 다시 시도하세요.'));
  db.transaction(() => {
    db.prepare('UPDATE documents SET name=?, source_bytes=?, confidence=? WHERE id=?').run(name, Buffer.byteLength(text, 'utf8'), CONF_MANUAL, id);
    db.prepare('DELETE FROM chunks WHERE document_id=?').run(id);
    const ins = db.prepare('INSERT INTO chunks(document_id,user_id,seq,text,embedding,char_count) VALUES(?,?,?,?,?,?)');
    fresh.forEach(([t, emb], i) => ins.run(id, doc.user_id, i, t, embToBuf(emb), t.length));
  })();
  // 2) 자동 문서의 이름 변경 = 원질문과의 연결 해제 — 같은 질문이 재습득되지 않도록 금지 기록
  if ((doc.origin || 'manual') === 'auto') {
    const oldQ = doc.name.startsWith('자동학습: ') ? doc.name.slice('자동학습: '.length) : doc.name;
    const newQ = name.startsWith('자동학습: ') ? name.slice('자동학습: '.length) : name;
    if (normQ(oldQ) !== normQ(newQ)) {
      try { fs.appendFileSync(KNOW_DISMISS, JSON.stringify({ ts: new Date().toISOString(), q: normQ(oldQ), docId: id, by: 'rename' }) + '\n'); } catch (_) {}
    }
  }
  knowLedger({ ts: new Date().toISOString(), user: req.user.username, q: name, docId: id, confidence: CONF_MANUAL, uncertain: false, chars: text.length, ms: 0, source: 'admin-edit' });
  console.log(`[지식 수정] 문서#${id} "${name}" — 재임베딩 ${fresh.length}청크, 신뢰도 1.0 (by ${req.user.username})`);
  res.send(adminPage(`문서#${id} "${name}" 수정 완료 — ${fresh.length}청크 재임베딩, 신뢰도 높음(1.0) 적용.`, 'knowledge', { knowUid: req.user.id }));
});
// 일괄 삭제 — 리스트 체크박스(ids[]) 전용. 단건 삭제와 같은 의미규칙: 자동 문서는 해당 질문 재습득 금지 기록.
app.post(`${PREFIX}/admin/knowledge/delete-many`, requireAdmin, (req, res) => {
  let ids = req.body.ids;
  if (!Array.isArray(ids)) ids = ids ? [ids] : [];
  ids = [...new Set(ids.map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 200);
  if (!ids.length) return res.send(adminPage('선택된 문서가 없습니다 — 체크 후 삭제하세요.', 'knowledge', { knowUid: req.user.id }));
  let n = 0, autoN = 0;
  const get = db.prepare('SELECT id,name,origin FROM documents WHERE id=? AND user_id=?');
  db.transaction(() => {
    for (const id of ids) {
      const d = get.get(id, req.user.id);
      if (!d) continue;
      db.prepare('DELETE FROM documents WHERE id=?').run(id); // chunks FK CASCADE
      n++;
      if ((d.origin || 'manual') === 'auto') {
        autoN++;
        const q = d.name.startsWith('자동학습: ') ? d.name.slice('자동학습: '.length) : d.name;
        try { fs.appendFileSync(KNOW_DISMISS, JSON.stringify({ ts: new Date().toISOString(), q, docId: d.id, by: 'bulk-delete' }) + '\n'); } catch (_) {}
      }
    }
  })();
  console.log(`[지식 일괄삭제] ${n}건(자동 ${autoN}) by ${req.user.username}`);
  res.send(adminPage(`${n}개 문서 삭제 완료${autoN ? ` — 자동 습득 ${autoN}건의 질문은 재습득 대상에서 제외됩니다.` : ''}`, 'knowledge', { knowUid: req.user.id }));
});

// ── Jev QA Router 결정 레이어 [2026-10-05, 지시서 적용] ─────────────────────
// RAG와 LLM 사이의 "답변 가능성 판단 계층". 초기 배포는 Shadow Mode(§35) — 판단은
// 백그라운드 기록 전용이고 사용자에게는 기존 QA 결과가 그대로 간다. 판단체/임계값/모드는
// eval/decision_policy.json에서 관리(tts_policy.json과 별개, §21).
const decisionPolicy = require('./decision/decision_policy');
const decisionService = require('./decision/decision_service');
// LLMJudge 롤백 타깃(§37)용 클라우드 호출 주입 — 지식 습득과 같은 게이트웨이·모델 시험 주입.
decisionService.setCloudCall(async ({ content }) => {
  const body = { messages: [{ role: 'user', content }], key: N8N_KEY };
  const t = meval.trial();
  if (t && t.status === 'trial' && t.stack === 'llm' && t.spec.model) body.model = t.spec.model;
  const r = await fetch(`${N8N_BASE}/webhook/koen-openai-script`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.content) return { ok: false, reason: 'cloud-empty' };
  return { ok: true, content: String(j.content), model: (t && t.spec && t.spec.model) || 'default' };
});
// 섀도 관찰 — 클라이언트가 "이미 완료한" QA(질문+실제 체인 결과)를 받아 판단·기록만 한다.
// 즉시 202식 응답 + 판단 비동기: 이 엔드포인트는 사용자 QA 결과에 개입할 방법이 구조적으로 없다.
app.post(`${PREFIX}/api/decision/observe`, requireApiAuth, (req, res) => {
  const b = req.body || {};
  if (!b.q) return res.status(400).json({ error: 'q 필요' });
  res.json({ accepted: true });
  decisionService.decideQA({
    q: String(b.q).slice(0, 300),
    slideTitle: b.slideTitle ? String(b.slideTitle).slice(0, 120) : null,
    sessionMode: b.sessionMode || null, user: req.user.username,
    rag: b.rag || {}, actual: b.actual || null, outcome: b.outcome || null,
  }).catch(() => {});
});

// [2026-10-04] 클라이언트 재생 진단 수집 — 브라우저 dbgBox 내용을 서버 로그로 전송받아
// "소리가 안 난다" 재현 시 원격으로 죽는 지점(TTS 응답/디코딩/재생차단/폴백)을 판별한다.
// 1.5초 버퍼 묶음 + pagehide(sendBeacon) — 발표 종료 후 시연 사이트로 이동해도 유실되지 않게.
app.post(`${PREFIX}/api/dbg`, requireApiAuth, (req, res) => {
  const lines = (req.body && Array.isArray(req.body.lines)) ? req.body.lines : [];
  if (lines.length) {
    const tag = lines.length > 6 ? lines.slice(0, 6).join(' ⏎ ') + ` …(+${lines.length - 6})` : lines.join(' ⏎ ');
    console.log(`[클라이언트 진단] user=${req.user.username}: ${tag.replace(/\n/g, ' ')}`);
  }
  res.json({ ok: true });
});

// [2026-10-05] Q&A 품질 폐루프 — 발표 중 질문-답변 이벤트(RAG/LLM/TTS 시간, 추임새 횟수,
// 텍스트 대체 여부)를 구조화해 eval/qa_log.jsonl에 적재한다. eval 배터리와 함께 회귀 추적용.
app.post(`${PREFIX}/api/qa-log`, requireApiAuth, (req, res) => {
  const b = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!b) return res.status(400).json({ error: 'payload 필요' });
  const rec = { ts: new Date().toISOString(), user: req.user.username,
    state: b.state || null, q: String(b.q || '').slice(0, 300),
    ragMs: b.ragMs ?? null, scriptMs: b.scriptMs ?? null, llmMs: b.llmMs ?? null,
    engine: b.engine || null, ragRefs: b.ragRefs ?? null, ragTimeout: !!b.ragTimeout,
    fillers: b.fillers ?? null, answerChars: b.answerChars ?? null, answerTtsMs: b.answerTtsMs ?? null,
    errors: Array.isArray(b.errors) ? b.errors.slice(0, 5) : [],
    events: Array.isArray(b.events) ? b.events.slice(0, 20) : [] };
  try { fs.appendFileSync(path.join(__dirname, 'eval', 'qa_log.jsonl'), JSON.stringify(rec) + '\n'); } catch (_) {}
  // [2026-10-05] 자가개선 폐루프 진입점 — 사용자 음성 문제 기록(state='issue')과 발표 종료
  // 요약(session_end)은 eval/issues.jsonl에도 적어 다음 개선 세션이 qa_log 전체를 훑기 전에
  // 우선 볼 수 있게 한다. 발화 원문은 events의 issue.utterance에 있다.
  if (rec.state === 'issue' || rec.state === 'session_end') {
    try { fs.appendFileSync(path.join(__dirname, 'eval', 'issues.jsonl'), JSON.stringify(rec) + '\n'); } catch (_) {}
  }
  // [2026-10-05] 답변 못 한 질문 폐루프 — 클라이언트가 state='rag_miss'로 보낸 기록(자료 미스 또는
  // 답변 음성 시간 초과)을 eval/rag-miss.jsonl에도 적어 관리자의 RAG 보강(임베딩) 요청 목록으로
  // 쓴다. 다음 발표 전 이 파일을 임베딩하면 같은 질문에 정상 답변이 가능해진다.
  if (rec.state === 'rag_miss') {
    try { fs.appendFileSync(path.join(__dirname, 'eval', 'rag-miss.jsonl'), JSON.stringify(Object.assign({}, rec, { reason: b.reason || null })) + '\n'); } catch (_) {}
  }
  res.json({ ok: true });
});

// ── 무결 루프: TTS 정책 배포 ──
// integrity_watch가 로그를 스캔해 tts_policy.json을 자동 조정하면, 클라이언트/프록시가 다음
// 실행에 그 값을 그대로 반영한다(코드 수정 없이 매개변수 패치). 정책 파일이 없으면 기본값.
app.get(`${PREFIX}/api/tts-policy`, requireApiAuth, (req, res) => {
  const defaults = { version: 0, attempts: 2, temp_ladder: [0.3, 0.15], floor_mult: 1.0,
    cap_mult: 1.0, split_char_fallback: true, client_tts_timeout_ms: 60000 };
  try {
    const p = JSON.parse(fs.readFileSync('/Users/wizbase/works/bc-ai/tts_policy.json', 'utf8'));
    res.json(Object.assign(defaults, p));
  } catch (e) {
    res.json(defaults);
  }
});

// ── 개인화 PPT 저장소 ──
app.post(`${PREFIX}/api/ppts`, requireApiAuth, (req, res) => {
  const { name, slides } = req.body;
  if (!name || !slides) return res.status(400).json({ error: 'name과 slides가 필요합니다.' });
  const slidesJson = JSON.stringify(slides);
  const bytes = Buffer.byteLength(slidesJson, 'utf8');
  const used = db.prepare('SELECT COALESCE(SUM(size_bytes),0) v FROM presentations WHERE user_id=?').get(req.user.id).v;
  if (used + bytes > DOC_STORAGE_QUOTA_BYTES) return res.status(413).json({ error: `저장 용량 한도(${Math.round(DOC_STORAGE_QUOTA_BYTES / 1024 / 1024)}MB)를 초과했습니다.` });
  const now = new Date().toISOString();
  const id = db.prepare('INSERT INTO presentations(user_id,name,slides_json,size_bytes,slide_count,created_at) VALUES(?,?,?,?,?,?)')
    .run(req.user.id, name, slidesJson, bytes, slides.length, now).lastInsertRowid;
  logUsage(req.user.id, 'ppt_save', bytes);
  res.json({ id });
});
app.get(`${PREFIX}/api/ppts`, requireApiAuth, (req, res) => {
  const rows = db.prepare('SELECT id,name,size_bytes,slide_count,created_at FROM presentations WHERE user_id=? ORDER BY created_at DESC').all(req.user.id);
  res.json(rows.map(r => ({ id: r.id, name: r.name, size: r.size_bytes, slideCount: r.slide_count, createdAt: r.created_at })));
});
app.get(`${PREFIX}/api/ppts/:id`, requireApiAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM presentations WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ id: row.id, name: row.name, size: row.size_bytes, slideCount: row.slide_count, createdAt: row.created_at, slides: JSON.parse(row.slides_json) });
});
app.delete(`${PREFIX}/api/ppts/:id`, requireApiAuth, (req, res) => {
  const row = db.prepare('SELECT id FROM presentations WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM presentations WHERE id=?').run(row.id);
  logUsage(req.user.id, 'ppt_delete', null);
  res.json({ ok: true });
});

// ── 발표 중 주석 (색연필 드로잉 + 메모) [2026-10-04, 사용자 요청] ──
// kind: draw=슬라이드 위 그리기(슬라이드당 1행, 재저장 시 교체) / memo=수동 메모 / auto=음성오류 자동 기록.
// 모든 기록은 integrity/annotations.jsonl에도 적립 — 폐루프가 관리하는 기록으로 흘러가고,
// 관리자 페이지 "🖍️ 발표 주석" 패널에서 페이지별 원본 대조로 열람한다.
app.post(`${PREFIX}/api/annotations`, requireApiAuth, (req, res) => {
  const { pptId, slideIdx, kind, category, quote, text, strokes } = req.body || {};
  if (!pptId || !Number.isInteger(slideIdx) || !['draw', 'memo', 'auto'].includes(kind)) {
    return res.status(400).json({ error: 'pptId, slideIdx(정수), kind(draw|memo|auto)가 필요합니다.' });
  }
  const ppt = db.prepare('SELECT id,name FROM presentations WHERE id=? AND user_id=?').get(pptId, req.user.id);
  if (!ppt) return res.status(404).json({ error: 'PPT를 찾을 수 없습니다.' });
  const now = new Date().toISOString();
  if (kind === 'draw') db.prepare("DELETE FROM slide_annotations WHERE ppt_id=? AND slide_idx=? AND kind='draw'").run(pptId, slideIdx);
  const info = db.prepare('INSERT INTO slide_annotations(ppt_id,user_id,slide_idx,kind,category,quote,text,strokes,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(pptId, req.user.id, slideIdx, kind, category || null, quote || null, text || null,
      Array.isArray(strokes) ? JSON.stringify(strokes).slice(0, 400000) : null, now);
  try {
    fs.appendFileSync(path.join(__dirname, 'integrity/annotations.jsonl'), JSON.stringify({
      ts: now, user: req.user.username, ppt: ppt.id, ppt_name: ppt.name, slide: slideIdx + 1,
      kind, category: category || '', text: (text || '').slice(0, 300), quote: (quote || '').slice(0, 200),
    }) + '\n');
  } catch { /* 기록 파일 실패가 서비스에 영향 주지 않게 */ }
  res.json({ ok: true, id: info.lastInsertRowid });
});
app.get(`${PREFIX}/api/annotations/:pptId`, requireApiAuth, (req, res) => {
  const rows = db.prepare('SELECT slide_idx,kind,category,quote,text,strokes,created_at FROM slide_annotations WHERE ppt_id=? AND user_id=? ORDER BY id').all(req.params.pptId, req.user.id);
  res.json({ rows: rows.map(r => ({ ...r, strokes: r.strokes ? JSON.parse(r.strokes) : null })) });
});
// [2026-10-04] 관리자 주석 상세 페이지 — 핸들러는 위에 선언(adminAnnotationDetail), 등록은 app 생성 후 여기서.
app.get(`${PREFIX}/admin/annotations/:pptId`, requireAdmin, adminAnnotationDetail);

// ── 관리자 전용 — 소유권 체크 없이 아무 유저의 문서/PPT나 조회·삭제 ──
function adminListPage(title, rows) {
  return adminShell('users', `<div class="box wide">
<h1>${esc(title)}</h1>
<table><thead><tr><th>이름</th><th>정보</th><th>날짜</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4">없음</td></tr>'}</tbody></table>
<p style="margin-top:16px"><a href="${PREFIX}/admin?tab=users">← 사용자 관리로</a></p>
</div>`);
}
app.get(`${PREFIX}/admin/users/:id/docs`, requireAdmin, (req, res) => {
  const user = findUserById(req.params.id);
  if (!user) return res.redirect(`${PREFIX}/admin`);
  const docs = db.prepare('SELECT * FROM documents WHERE user_id=? ORDER BY created_at').all(user.id);
  const rows = docs.map(d => `<tr><td>${esc(d.name)}${d.is_primary ? ' ⭐' : ''}</td><td>${docCountChunks(d.id)}청크 · ${fmtBytes(d.source_bytes)}</td><td>${esc((d.created_at || '').slice(0, 10))}</td>
<td><form method="post" action="${PREFIX}/admin/docs/${d.id}/delete" onsubmit="return confirm('삭제할까요?')"><button class="actBtn" type="submit" style="background:#8a3030">삭제</button></form></td></tr>`).join('');
  res.send(adminListPage(`${user.username}의 참고 문서`, rows));
});
app.post(`${PREFIX}/admin/docs/:id/delete`, requireAdmin, (req, res) => {
  const doc = db.prepare('SELECT user_id FROM documents WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM documents WHERE id=?').run(req.params.id);
  res.redirect(doc ? `${PREFIX}/admin/users/${doc.user_id}/docs` : `${PREFIX}/admin`);
});
app.get(`${PREFIX}/admin/users/:id/ppts`, requireAdmin, (req, res) => {
  const user = findUserById(req.params.id);
  if (!user) return res.redirect(`${PREFIX}/admin`);
  const ppts = db.prepare('SELECT id,name,size_bytes,slide_count,created_at FROM presentations WHERE user_id=? ORDER BY created_at DESC').all(user.id);
  const rows = ppts.map(p => `<tr><td>${esc(p.name)}</td><td>${p.slide_count}슬라이드 · ${fmtBytes(p.size_bytes)}</td><td>${esc((p.created_at || '').slice(0, 10))}</td>
<td><form method="post" action="${PREFIX}/admin/ppts/${p.id}/delete" onsubmit="return confirm('삭제할까요?')"><button class="actBtn" type="submit" style="background:#8a3030">삭제</button></form></td></tr>`).join('');
  res.send(adminListPage(`${user.username}의 저장된 PPT`, rows));
});
app.post(`${PREFIX}/admin/ppts/:id/delete`, requireAdmin, (req, res) => {
  const ppt = db.prepare('SELECT user_id FROM presentations WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM presentations WHERE id=?').run(req.params.id);
  res.redirect(ppt ? `${PREFIX}/admin/users/${ppt.user_id}/ppts` : `${PREFIX}/admin`);
});

app.listen(PORT, '127.0.0.1', () => console.log(`ppt-agent 로그인 서버(v2) — http://127.0.0.1:${PORT}${PREFIX}.html (NODE_ENV=${process.env.NODE_ENV || '(none)'})`));
