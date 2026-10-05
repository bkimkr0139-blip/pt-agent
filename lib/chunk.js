// 참고 문서 청킹 — 예전엔 클라이언트(ppt-agent.html)의 두 군데(loadRefDocs, refInput2 핸들러)에
// 토씨 하나 안 틀리고 복붙돼 있던 로직을 서버로 옮기면서 한 곳으로 합침.
// 마크다운 헤딩 기준 1차 분할, 800자 넘으면 문장 경계로 2차 분할, 20자 미만 조각은 버림, 겹침 없음.
// [2026-10-05] 실측 진단 반영: (1) 2차 분할 500→800자 — 1536차원 임베딩은 800자도 충분히 소화하고,
// 조각이 잘게 쪼개질수록 문맥이 끊겨 스코어가 낮아졌다(배경 유사도 0.46 대비 top1 0.34).
// (2) 제목 뼈대 청크 병합 — 헤딩만으로 끝나는 80자 미만 조각("## 기대 시너지" 뒤에 곧장 다음
// 헤딩이 오는 구간)은 내용이 없는데도 제목 매칭으로 검색 상위를 차지하고, 정작 내용 청크는
// 스코어 필터에 탈락했다(실측: '시너지' 질문 top1=20자 제목 청크, 내용 청크 0.275 탈락).
function chunkText(text) {
  const sections = text.split(/(?=^#{1,3}\s)/m);
  const texts = [];
  for (const sec of sections) {
    const t = sec.trim();
    if (t.length < 20) continue;
    if (t.length <= 800) { texts.push(t); continue; }
    const parts = t.split(/(?<=[.!?\n])/);
    let cur = '';
    for (const p of parts) {
      if ((cur + p).length > 800 && cur) { texts.push(cur.trim()); cur = p; }
      else cur += p;
    }
    if (cur.trim().length > 20) texts.push(cur.trim());
  }
  // 제목 뼈대(짧은 헤딩 조각)는 바로 뒤 조각의 머리에 붙인다 — 제목은 뒤 내용을 설명하므로.
  // 연속된 헤딩만 있는 구간은 순차적으로 다음 내용 조각에 누적 병합된다.
  const merged = [];
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    if (t.length < 80 && i + 1 < texts.length && /^#{1,3}\s/.test(t)) { texts[i + 1] = t + '\n' + texts[i + 1]; continue; }
    merged.push(t);
  }
  return merged;
}
module.exports = { chunkText };
