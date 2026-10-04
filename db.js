// SQLite 저장소 — 이전 users.json(파일 전체 읽고-고치고-덮어쓰기, 동시쓰기 레이스 있음) 대체.
// better-sqlite3 사용 이유: 동기 API라 기존 코드 스타일(loadUsers/saveUsers류) 그대로 유지 가능하고,
// WAL 모드로 동시 읽기/단일 쓰기가 안전함. Node 내장 node:sqlite는 아직 Experimental이라
// 비밀번호 해시를 다루는 저장소로는 보수적으로 피함.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','disabled')),
  created_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by INTEGER REFERENCES users(id),
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  source_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB NOT NULL,
  char_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_user ON chunks(user_id);
CREATE TABLE IF NOT EXISTS presentations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slides_json TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  slide_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_presentations_user ON presentations(user_id);
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('login','doc_upload','doc_delete','ppt_save','ppt_delete','script_call','llm_call','search_call')),
  bytes INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage_events(user_id, created_at);
`);

// 최초 1회 마이그레이션 — 기존 users.json(있다면)을 그대로 가져옴. 같은 scrypt salt/hash를
// 그대로 쓰므로 admin/bckim 계정 비밀번호 재설정 불필요.
function migrateFromJsonIfNeeded() {
  const count = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (count > 0) return;
  const jsonPath = path.join(__dirname, 'users.json');
  if (!fs.existsSync(jsonPath)) return;
  let old;
  try { old = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (e) { return; }
  const ins = db.prepare(`INSERT INTO users(username,salt,hash,role,status,created_at,approved_at)
    VALUES(@username,@salt,@hash,@role,@status,@created_at,@approved_at)`);
  const tx = db.transaction(rows => { for (const u of rows) ins.run(u); });
  tx(old.map(u => ({
    username: u.username, salt: u.salt, hash: u.hash, role: u.role || 'user',
    status: u.approved ? 'approved' : 'pending',
    created_at: u.createdAt || new Date().toISOString(),
    approved_at: u.approved ? (u.createdAt || new Date().toISOString()) : null,
  })));
  console.log(`users.json에서 ${old.length}개 계정 마이그레이션 완료`);
}
migrateFromJsonIfNeeded();

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function newSalt() { return crypto.randomBytes(16).toString('hex'); }

// 관리자 계정이 하나도 없으면 시드 — 최초 설치 시에만 동작(이미 마이그레이션됐으면 count>0이라 스킵).
// [2026-10-04] 공개 저장소에 올라가므로 고정된 기본 비밀번호를 코드에 박아두면 안 됨 —
// ADMIN_SEED_PASSWORD를 환경변수로 주면 그걸 쓰고, 안 주면 매번 무작위로 생성해서 시작 로그에
// 한 번만 찍어준다(운영자가 그 로그에서 받아가서 바로 바꾸는 걸 전제).
function seedAdminIfNeeded() {
  const existing = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
  if (existing) return;
  const password = process.env.ADMIN_SEED_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const salt = newSalt();
  db.prepare(`INSERT INTO users(username,salt,hash,role,status,created_at,approved_at)
    VALUES(?,?,?,'admin','approved',?,?)`)
    .run('admin', salt, hashPassword(password, salt), new Date().toISOString(), new Date().toISOString());
  console.log(`관리자 계정 생성됨: admin / ${password} — 로그인 후 반드시 비밀번호를 바꾸세요.`);
}
seedAdminIfNeeded();

module.exports = { db, hashPassword, newSalt };
