// 참고 문서 청킹 — 예전엔 클라이언트(ppt-agent.html)의 두 군데(loadRefDocs, refInput2 핸들러)에
// 토씨 하나 안 틀리고 복붙돼 있던 로직을 서버로 옮기면서 한 곳으로 합침.
// 마크다운 헤딩 기준 1차 분할, 500자 넘으면 문장 경계로 2차 분할, 20자 미만 조각은 버림, 겹침 없음.
function chunkText(text) {
  const sections = text.split(/(?=^#{1,3}\s)/m);
  const texts = [];
  for (const sec of sections) {
    const t = sec.trim();
    if (t.length < 20) continue;
    if (t.length <= 500) { texts.push(t); continue; }
    const parts = t.split(/(?<=[.!?\n])/);
    let cur = '';
    for (const p of parts) {
      if ((cur + p).length > 500 && cur) { texts.push(cur.trim()); cur = p; }
      else cur += p;
    }
    if (cur.trim().length > 20) texts.push(cur.trim());
  }
  return texts;
}
module.exports = { chunkText };
