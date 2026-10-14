// 핫워드 보정 단위 시험 [2026-10-14] — node battery/stt_hotword_unit.js
const S = require('../lib/stt_stream');
const hw = S.buildHotwords(['범정부 AI 공통기반', 'WIZBASE', '위즈베이스', 'IoT', 'AIoT', 'L3', 'BLE', 'KPI', '생활지원사', '전담사회복지사', '돌봄프로필', '통합앱']);
const T = [
  ['범 정부 아이 공통 기반을 쓰나요', '범정부 AI 공통기반을 쓰나요', false],
  ['범정부 에이아이 공통기반이 뭐예요', '범정부 AI 공통기반이 뭐예요', false],
  ['위저베이스는 무슨 일을 해요', '위즈베이스는 무슨 일을 해요', true],     // 철자 퍼지 교정 → 확인 질문 후보
  ['아이오티 기기와 엘삼 레벨', 'IoT 기기와 L3 레벨', false],
  ['전담 사회 복지사는 무슨 일', '전담사회복지사는 무슨 일', false],
  ['돌봄 프로필은 어디서 봐요', '돌봄프로필은 어디서 봐요', false],
  ['통합 앱이 뭐예요', '통합앱이 뭐예요', false],
  ['케이피아이 세 가지가 뭐예요', 'KPI 세 가지가 뭐예요', false],
  ['블루투스가 끊기면 외출인가요', '블루투스가 끊기면 외출인가요', false],   // 사용자 어휘는 임의 치환하지 않는다
  ['저는 아이를 키워요', '저는 아이를 키워요', false],                     // 일반 단어 오교정 방지
  ['오늘 날씨 어때요', '오늘 날씨 어때요', false],
];
let bad = 0;
for (const [i, want, sus] of T) { const r = S.applyHotwords(i, hw); const ok = r.text === want && (r.changes.length > 0) === sus; if (!ok) { bad++; console.log('FAIL', i, '→', r.text, JSON.stringify(r.changes)); } }
console.log('핫워드 보정', T.length - bad + '/' + T.length);
process.exit(bad ? 1 : 0);
