#!/usr/bin/env node
// admin 비밀번호 재설정 — 서버 로그인과 같은 scrypt(salt+hash) 방식으로 users 테이블만 갱신한다.
// 사용: node tools/reset-admin-password.js [사용자명(기본 admin)]
// 비밀번호는 터미널에서 입력(화면에 표시되지 않음)하며 어디에도 기록·출력하지 않는다.
const readline = require('readline');
const { db, hashPassword, newSalt } = require('../db');

const username = process.argv[2] || 'admin';
const user = db.prepare('SELECT id, role FROM users WHERE username=?').get(username);
if (!user) { console.error(`사용자 "${username}"가 없습니다.`); process.exit(1); }

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) process.stdout.write(s); };   // 입력 에코 숨김(프롬프트만 출력)
    rl.question(prompt, (ans) => { rl.close(); process.stdout.write('\n'); resolve(ans); });
  });
}

(async () => {
  const p1 = await askHidden('새 비밀번호(8자 이상): ');
  if (p1.length < 8) { console.error('8자 이상이어야 합니다.'); process.exit(1); }
  const p2 = await askHidden('한 번 더 입력: ');
  if (p1 !== p2) { console.error('두 입력이 다릅니다. 변경하지 않았습니다.'); process.exit(1); }
  const salt = newSalt();
  db.prepare('UPDATE users SET salt=?, hash=? WHERE username=?').run(salt, hashPassword(p1, salt), username);
  console.log(`✅ "${username}" 비밀번호를 변경했습니다. 새 비밀번호로 로그인하세요.`);
  process.exit(0);
})();
