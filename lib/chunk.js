// 참고 문서 청킹 — 마크다운 헤딩 기준 1차 분할 → 800자 초과 시 구조 단위(문장·목록 항목·표 행)로 2차 분할.
// [2026-10-14 고도화 Phase 2] 겹침 10~20%(≈120자)·헤딩 유지(이어지는 조각 머리에 헤딩 재부착)·표 행/목록 항목 보존·
// 청크별 메타(title/section/slide_no/part)를 함께 반환한다. 기존 규칙(20자 미만 폐기, 80자 미만 제목 뼈대 병합)은 유지.
// [2026-10-05] 2차 분할 500→800자 — 1536차원 임베딩은 800자도 충분히 소화하고, 잘게 쪼갤수록 문맥이 끊겨 스코어가 낮아졌다.
// 제목 뼈대 청크는 내용이 없는데도 제목 매칭으로 검색 상위를 차지해 다음 조각과 병합한다.
const MAX = 800, OVERLAP = 120;
const HEAD_RE = /^(#{1,3})\s+(.+)$/;
const SLIDE_RE = /(?:슬라이드|slide|페이지|page|p\.)\s*(\d{1,3})|(\d{1,3})\s*(?:페이지|쪽|장표)/i;

// 한 섹션을 구조 단위로 쪼갠다: 표 행·목록 항목은 한 줄이 한 단위, 산문은 문장 단위.
function units(body) {
  const out = [];
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (/^\|/.test(t) || /^([-*•]|\d+[.)])\s+/.test(t)) { out.push(t); continue; }
    for (const s of t.split(/(?<=[.!?。다요죠])\s+/)) if (s.trim()) out.push(s.trim());
  }
  return out;
}
function isTableRow(u) { return /^\|/.test(u); }

function chunkDoc(text) {
  const sections = String(text || '').split(/(?=^#{1,3}\s)/m);
  const items = [];                 // { text, meta }
  let h1 = '';
  for (const sec of sections) {
    const t = sec.trim();
    if (t.length < 20) continue;
    const lines = t.split('\n');
    const m = HEAD_RE.exec(lines[0]);
    const headLine = m ? lines[0].trim() : '';
    const title = m ? m[2].trim() : '';
    if (m && m[1].length === 1) h1 = title;
    const sm = SLIDE_RE.exec(title);
    const meta = { title: title || undefined, section: (m && m[1].length > 1 ? h1 : '') || undefined, slide_no: sm ? +(sm[1] || sm[2]) : undefined };
    if (t.length <= MAX) { items.push({ text: t, meta: { ...meta, part: 1 } }); continue; }
    const body = m ? lines.slice(1).join('\n') : t;
    const us = units(body);
    const tableHead = us.find(isTableRow) && us.slice(0, 2).every(isTableRow) ? us.slice(0, 2).join('\n') : '';  // 표 머리글+구분행
    const room = MAX - (headLine ? headLine.length + 1 : 0);
    let cur = [], len = 0, part = 0;
    const flush = () => {
      if (!cur.length) return;
      part++;
      let txt = cur.join('\n');
      // 표가 이어지는 조각은 머리글을 다시 붙인다(행 구조 보존)
      if (part > 1 && tableHead && isTableRow(cur[0]) && !txt.startsWith(tableHead)) txt = tableHead + '\n' + txt;
      txt = (headLine ? headLine + '\n' : '') + txt;
      if (txt.trim().length > 20) items.push({ text: txt.trim(), meta: { ...meta, part } });
    };
    for (const u of us) {
      const add = u.length + 1;
      if (len + add > room && cur.length) {
        flush();
        // 겹침 — 직전 조각 끝에서 OVERLAP자 이내의 단위를 다음 조각 머리로 가져온다(표 행·목록 항목도 단위째)
        const keep = []; let kl = 0;
        for (let i = cur.length - 1; i >= 0 && kl + cur[i].length + 1 <= OVERLAP; i--) { keep.unshift(cur[i]); kl += cur[i].length + 1; }
        cur = keep; len = kl;
      }
      cur.push(u); len += add;
    }
    // 마지막 조각이 겹침분뿐이면(새 내용 없음) 버린다
    if (cur.length) flush();
  }
  // 제목 뼈대(짧은 헤딩 조각)는 바로 뒤 조각의 머리에 붙인다 — 연속된 헤딩만 있는 구간은 순차 병합.
  const merged = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.text.length < 80 && i + 1 < items.length && /^#{1,3}\s/.test(it.text)) {
      items[i + 1] = { text: it.text + '\n' + items[i + 1].text, meta: { ...items[i + 1].meta, title: items[i + 1].meta.title || it.meta.title } };
      continue;
    }
    merged.push(it);
  }
  return merged;
}
// 하위 호환 — 문자열 배열(기존 호출부)
function chunkText(text) { return chunkDoc(text).map(x => x.text); }
// 이미 저장된 청크 텍스트에서 메타를 복원(헤딩 파싱) — 재임베딩 없이 기존 청크에 메타를 백필할 때 쓴다.
function metaFromText(text) {
  const m = HEAD_RE.exec(String(text || '').split('\n')[0]);
  if (!m) return {};
  const sm = SLIDE_RE.exec(m[2]);
  return { title: m[2].trim(), slide_no: sm ? +(sm[1] || sm[2]) : undefined, part: 1 };
}
module.exports = { chunkText, chunkDoc, metaFromText, CHUNK_MAX: MAX, CHUNK_OVERLAP: OVERLAP };
