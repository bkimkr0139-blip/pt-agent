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
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f1115;color:#e8e8ea;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
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
.wide{width:auto;max-width:96vw;overflow-x:auto}
.actBtn{width:auto;margin:2px 3px 2px 0;padding:4px 9px;font-size:.74rem}
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
function adminPage(notice) {
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
  return page('관리자 — PPT 발표 에이전트', `<div class="box wide">
<h1>사용자 관리</h1>
${notice ? `<div class="msg ok">${esc(notice)}</div>` : ''}
<table><thead><tr><th>아이디</th><th>권한</th><th>상태</th><th>가입일</th><th>문서</th><th>PPT</th><th>용량</th><th>호출(7일)</th><th>최근활동</th><th></th></tr></thead><tbody>${rows}</tbody></table>
<p style="margin-top:16px"><a href="${PREFIX}.html">발표 화면으로</a> · <a href="${PREFIX}/logout">로그아웃</a></p>
</div>`);
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

app.get(`${PREFIX}/admin`, requireAdmin, (req, res) => res.send(adminPage()));
app.post(`${PREFIX}/admin/approve`, requireAdmin, (req, res) => {
  db.prepare("UPDATE users SET status='approved', approved_at=?, approved_by=? WHERE username=?")
    .run(new Date().toISOString(), req.user.id, req.body.username);
  res.send(adminPage(`${req.body.username} 승인 완료`));
});
app.post(`${PREFIX}/admin/deactivate`, requireAdmin, (req, res) => {
  db.prepare("UPDATE users SET status='disabled' WHERE username=? AND role!='admin'").run(req.body.username);
  res.send(adminPage(`${req.body.username} 비활성화됨`));
});
app.post(`${PREFIX}/admin/reactivate`, requireAdmin, (req, res) => {
  db.prepare("UPDATE users SET status='approved' WHERE username=?").run(req.body.username);
  res.send(adminPage(`${req.body.username} 재활성화됨`));
});
app.post(`${PREFIX}/admin/reject`, requireAdmin, (req, res) => {
  // pending 거부든 승인된 계정 완전삭제든 동일 — FK CASCADE로 문서/청크/PPT/세션 다 같이 삭제됨.
  db.prepare("DELETE FROM users WHERE username=? AND role!='admin'").run(req.body.username);
  res.send(adminPage(`${req.body.username} 삭제됨`));
});
app.post(`${PREFIX}/admin/reset-password`, requireAdmin, (req, res) => {
  const { username, newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) return res.send(adminPage('비밀번호는 4자 이상이어야 합니다.'));
  const salt = newSalt();
  db.prepare('UPDATE users SET salt=?, hash=? WHERE username=?').run(salt, hashPassword(newPassword, salt), username);
  res.send(adminPage(`${username} 비밀번호 변경 완료`));
});

// ── n8n 프록시 — 비밀 키는 여기서만 붙인다 ──
async function proxyToN8n(req, res, webhookPath, eventType) {
  try {
    const body = { ...req.body, key: N8N_KEY };
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
  const docs = db.prepare('SELECT id,name,is_primary,source_bytes,created_at FROM documents WHERE user_id=? ORDER BY created_at').all(req.user.id);
  res.json(docs.map(d => ({ id: d.id, name: d.name, isPrimary: !!d.is_primary, sourceBytes: d.source_bytes, createdAt: d.created_at, chunkCount: docCountChunks(d.id) })));
});
app.patch(`${PREFIX}/api/docs/:id`, requireApiAuth, (req, res) => {
  const doc = db.prepare('SELECT id FROM documents WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE documents SET is_primary=? WHERE id=?').run(req.body.isPrimary ? 1 : 0, doc.id);
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
  const primaryIds = db.prepare('SELECT id FROM documents WHERE user_id=? AND is_primary=1').all(req.user.id).map(d => d.id);
  const rows = primaryIds.length
    ? db.prepare(`SELECT c.text,c.embedding,c.document_id,d.name as doc_name FROM chunks c JOIN documents d ON d.id=c.document_id WHERE c.user_id=? AND c.document_id IN (${primaryIds.map(() => '?').join(',')})`).all(req.user.id, ...primaryIds)
    : db.prepare(`SELECT c.text,c.embedding,c.document_id,d.name as doc_name FROM chunks c JOIN documents d ON d.id=c.document_id WHERE c.user_id=?`).all(req.user.id);
  if (!rows.length) return res.json([]);
  const qEmb = await embedViaN8n(query);
  if (!qEmb) return res.json([]);
  const scored = rows.map(r => ({ text: r.text, docId: r.document_id, docName: r.doc_name, score: cosineSim(qEmb, bufToEmb(r.embedding)) }))
    .sort((a, b) => b.score - a.score).slice(0, k || 3).filter(r => r.score > 0.3);
  logUsage(req.user.id, 'search_call', null);
  res.json(scored);
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

// ── 관리자 전용 — 소유권 체크 없이 아무 유저의 문서/PPT나 조회·삭제 ──
function adminListPage(title, backHref, rows, deleteAction) {
  return page(title, `<div class="box wide">
<h1>${esc(title)}</h1>
<table><thead><tr><th>이름</th><th>정보</th><th>날짜</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4">없음</td></tr>'}</tbody></table>
<p style="margin-top:16px"><a href="${backHref}">← 사용자 관리로</a></p>
</div>`);
}
app.get(`${PREFIX}/admin/users/:id/docs`, requireAdmin, (req, res) => {
  const user = findUserById(req.params.id);
  if (!user) return res.redirect(`${PREFIX}/admin`);
  const docs = db.prepare('SELECT * FROM documents WHERE user_id=? ORDER BY created_at').all(user.id);
  const rows = docs.map(d => `<tr><td>${esc(d.name)}${d.is_primary ? ' ⭐' : ''}</td><td>${docCountChunks(d.id)}청크 · ${fmtBytes(d.source_bytes)}</td><td>${esc((d.created_at || '').slice(0, 10))}</td>
<td><form method="post" action="${PREFIX}/admin/docs/${d.id}/delete" onsubmit="return confirm('삭제할까요?')"><button class="actBtn" type="submit" style="background:#8a3030">삭제</button></form></td></tr>`).join('');
  res.send(adminListPage(`${user.username}의 참고 문서`, `${PREFIX}/admin`, rows));
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
  res.send(adminListPage(`${user.username}의 저장된 PPT`, `${PREFIX}/admin`, rows));
});
app.post(`${PREFIX}/admin/ppts/:id/delete`, requireAdmin, (req, res) => {
  const ppt = db.prepare('SELECT user_id FROM presentations WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM presentations WHERE id=?').run(req.params.id);
  res.redirect(ppt ? `${PREFIX}/admin/users/${ppt.user_id}/ppts` : `${PREFIX}/admin`);
});

app.listen(PORT, '127.0.0.1', () => console.log(`ppt-agent 로그인 서버(v2) — http://127.0.0.1:${PORT}${PREFIX}.html (NODE_ENV=${process.env.NODE_ENV || '(none)'})`));
