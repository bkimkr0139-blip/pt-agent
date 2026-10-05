// ── 모델 교체 평가 페이지 (2026-10-04 v2) — 관리자 전용 ────────────────────
// v2: ① 조사 표를 스택별 탭 + 정돈된 표로 개편(특징/시장 피드백/기대 개선 열)
//     ② 차트를 SVG→div 봉으로 교체 (preserveAspectRatio:none이 텍스트를 좌우로
//        늘려 글자가 일그러지던 결함 수정 — 사용자 보고)
'use strict';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
*{box-sizing:border-box}body{margin:0;padding:24px 16px 60px;font:14px/1.6 -apple-system,'Apple SD Gothic Neo',sans-serif;background:#f4f4f6;color:#1c1c22}
.wrap{max-width:1014px;margin:0 auto} /* 관리자 콘솔 본문 열 폭(1280−사이드바216−간격18−패딩32)과 동일 — 화면 전환 시 좌우 흔들림 제거 */
h1{font-size:1.35rem;margin:0 0 4px}h2{font-size:1.05rem;margin:26px 0 10px}
.sub{color:#666;font-size:.85rem;margin-bottom:18px}
/* ── 헤더(좌: 제목·부제 / 우: 문서 다운로드) ── */
.hdr{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap}
.docbtn{flex:none;display:inline-block;margin-top:4px;background:#fff;border:1px solid #c9d4ee;color:#2b5fd9;border-radius:8px;padding:7px 14px;font-size:.83rem;font-weight:700;text-decoration:none;white-space:nowrap}
/* 관리자 콘솔 복귀 버튼 — 콘솔 사이드바 메뉴(.mI)와 동일한 이름·아이콘·다크 칩 스타일 */
.consoleBtn{display:inline-block;margin-top:10px;background:#1a1d24;border:1px solid #2a2e38;color:#c9cdd6;border-radius:9px;padding:8px 14px;font-size:.84rem;font-weight:600;text-decoration:none}
.consoleBtn:hover{background:#2b3a5c;border-color:#3d5a8a;color:#fff}
.docbtn:hover{background:#eef3ff}
.box{background:#fff;border:1px solid #e2e2e8;border-radius:12px;padding:16px 18px;margin-bottom:14px}
.warn{background:#fff7e8;border:1px solid #eed9a8;color:#6b5200;border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:.85rem}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}
.card{border:1px solid #e6e6ec;border-radius:10px;padding:10px 12px;background:#fafafc}
.card b{display:block;font-size:.95rem}.card small{color:#777}
button{background:#3a3a44;color:#fff;border:0;border-radius:8px;padding:7px 14px;font-size:.85rem;cursor:pointer}
button:hover{filter:brightness(1.15)}button:disabled{opacity:.45;cursor:default}
button.primary{background:#2b5fd9}button.ok{background:#1f7a3d}button.danger{background:#8a3030}
button.mini{padding:4px 10px;font-size:.78rem;border-radius:6px}
/* ── 정돈된 표 ── */
.tabs{display:flex;gap:6px;margin:0 0 10px;flex-wrap:wrap}
.tab{padding:6px 16px;border-radius:8px;background:#ececf1;color:#444;font-size:.85rem;cursor:pointer;border:1px solid #e0e0e6;user-select:none}
.tab.on{background:#2b5fd9;color:#fff;border-color:#2b5fd9;font-weight:700}
.tblWrap{overflow-x:auto;border:1px solid #e4e4ea;border-radius:10px;background:#fff}
table.tbl{width:100%;border-collapse:collapse;font-size:.82rem}
.tbl th{background:#f4f5f8;color:#555;padding:9px 12px;text-align:left;font-weight:700;border-bottom:2px solid #dfe2ea;white-space:nowrap;font-size:.78rem}
.tbl td{padding:8px 12px;border-bottom:1px solid #f0f1f5;vertical-align:top}
.tbl tr:last-child td{border-bottom:0}
.tbl tbody tr:nth-child(even) td{background:#fafbfd}
.tbl tbody tr:hover td{background:#eef3ff}
.tbl td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.tbl .mname{font-weight:700;font-size:.84rem;max-width:300px}
.tbl .mid{display:block;color:#999;font-size:.7rem;font-weight:400;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tbl .feat{color:#555;white-space:normal;max-width:180px}
.tbl .exp{color:#444;white-space:normal;max-width:230px;font-size:.8rem}
.badge{display:inline-block;border-radius:99px;padding:1px 9px;font-size:.72rem;font-weight:700;white-space:nowrap}
.badge.g3{background:#e2f3e7;color:#186a35}.badge.g2{background:#e3edff;color:#1d4fb8}.badge.g1{background:#f0eef4;color:#6b6880}
.pill{display:inline-block;border-radius:99px;padding:2px 10px;font-size:.75rem;font-weight:600}
.pill.ok{background:#e2f3e7;color:#186a35}.pill.no{background:#fbe4e4;color:#8a2323}.pill.mid{background:#fff3d6;color:#7a5c00}
/* ── div 기반 쌍봉 차트 (SVG 텍스트 왜곡 수정) ── */
.mbar{margin:12px 0 16px;border:1px solid #eef0f4;border-radius:10px;padding:10px 14px}
.mbar .lbl{font-size:.86rem;font-weight:700;margin-bottom:6px}
.crow{display:flex;align-items:center;gap:10px;margin:5px 0}
.crow .tag{width:36px;font-size:.76rem;color:#888;flex:none;text-align:right}
.crow .track{flex:1;height:15px;background:#eef0f4;border-radius:8px;overflow:hidden;min-width:60px}
.crow .fill{height:100%;border-radius:8px;transition:width .4s}
.fill.cur{background:#8a93a6}.fill.cand{background:#2b5fd9}
.crow .val{width:118px;font-size:.78rem;font-variant-numeric:tabular-nums;flex:none;white-space:nowrap;color:#333}
.delta{font-size:.78rem;font-weight:700;padding:1px 9px;border-radius:99px;margin-left:8px}
.delta.good{background:#e2f3e7;color:#186a35}.delta.bad{background:#fbe4e4;color:#8a2323}.delta.same{background:#eee;color:#666}
.verdict{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.verdict .big{font-size:1.15rem;font-weight:800;padding:6px 16px;border-radius:10px}
.v-good{background:#1f7a3d;color:#fff}.v-mid{background:#b7860b;color:#fff}.v-bad{background:#8a3030;color:#fff}
ul.userView{margin:8px 0 0;padding-left:18px}ul.userView li{margin:3px 0}
.muted{color:#777;font-size:.82rem}
.spin{display:inline-block;width:14px;height:14px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes sp{to{transform:rotate(360deg)}}
input[type=text],select{border:1px solid #ccc;border-radius:7px;padding:6px 9px;font-size:.85rem}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.logline{font-family:ui-monospace,Menlo,monospace;font-size:.75rem;background:#f6f6f8;border-radius:6px;padding:6px 9px;margin:3px 0;overflow:hidden;text-overflow:ellipsis}
`;

function pageHTML() {
  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>모델 교체 평가 — PPT 발표 에이전트</title>
<style>${CSS}</style>
<div class="wrap">
<div class="hdr">
  <div>
    <h1>🔄 모델 교체 평가</h1>
    <div class="sub">조사 → 벤치마크(실측) → 시험 운영(실제 트래픽) → 무결루프 검증 → 최종 승인/롤백</div>
    <a class="consoleBtn" href="/ppt-agent/admin">🛠️ 관리자 콘솔</a>
  </div>
  <a class="docbtn" href="/ppt-agent/admin/model-eval-docs" download>📄 평가 시스템 문서</a>
</div>
<div class="warn">⚠️ 벤치마크는 실제 GPU에서 돌아갑니다. <b>누군가 발표 중이면 실행하지 마세요</b> — 발표 음성 품질이 오염됩니다.</div>

<h2>현재 스택</h2>
<div class="grid3" id="curStack"></div>

<h2>1단계 · 최신 모델 조사</h2>
<div class="box">
  <div class="row" style="justify-content:space-between">
    <button class="primary" onclick="discover(this)">🔍 조사 실행 (HuggingFace)</button>
    <span id="discAt" class="muted"></span>
  </div>
  <div class="tabs" id="discTabs" style="margin-top:12px"></div>
  <div id="discOut"></div>
  <div class="muted" style="margin-top:8px">· 정렬: 최신 날짜순 · "기대 개선"은 모델명·태그에서 뽑은 <b>추정</b>이며, 실제 근거는 벤치마크(실측)에서만 나옵니다.<br>· LLM 후보가 설치되어 있지 않으면 터미널에서 <code>ollama pull &lt;모델&gt;</code> 후 새로고침하세요.</div>
</div>
<div class="box">
  <b>직접 벤치마크</b>
  <div class="row" style="margin-top:8px">
    <select id="llmPick" style="padding:6px 9px"></select>
    <button onclick="bench('llm')">LLM 비교 벤치마크</button>
  </div>
  <div class="row" style="margin-top:8px">
    <input type="text" id="ttsModel" placeholder="TTS 후보 HF repo id (예: mlx-community/...)" style="flex:1;min-width:220px">
    <input type="text" id="ttsVoice" placeholder="voice (기본 sohee)" style="width:150px">
    <button onclick="bench('tts')">TTS 비교 벤치마크</button>
  </div>
  <div class="row" style="margin-top:8px">
    <button onclick="bench('stt')">STT A/B 벤치마크 (Qwen3-ASR 8323 vs whisper 8782)</button>
  </div>
</div>
<div id="reportOut"></div>

<h2>2단계 · 시험 운영 (실제 발표 트래픽)</h2>
<div class="box" id="trialBox"><span class="muted">불러오는 중…</span></div>
`;
}

const CLIENT = `
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path,opt){const r=await fetch('/ppt-agent/admin/model-eval'+path,{...opt,headers:{'Content-Type':'application/json'}});
 if(!r.ok){let m='';try{m=(await r.json()).error}catch{m=r.status+' 오류'}throw new Error(m)}return r.json()}
function busy(btn,on,label){if(on){btn.dataset.t=btn.textContent;btn.disabled=true;btn.innerHTML='<span class="spin"></span>'+(label||'실행 중…')}
 else{btn.disabled=false;btn.textContent=btn.dataset.t||btn.textContent}}

/* ── div 기반 쌍봉 차트 — SVG 텍스트 왜곡 없음 ── */
function fmt(v,u){if(v==null)return'-';return (Math.round(v*100)/100)+(u?(' '+u):'')}
function barPair(m){
 const max=Math.max(m.cur||0,m.cand||0,0.0001)*1.12;
 let d=m.cur?Math.round((m.cand-m.cur)/m.cur*1000)/10:null;
 let good=m.lowerBetter?d<0:d>0;
 const cls=d==null||Math.abs(d)<1?'same':(good?'good':'bad');
 const row=(tag,v,fc)=>'<div class="crow"><span class="tag">'+tag+'</span>'+
   '<div class="track"><div class="fill '+fc+'" style="width:'+Math.max(1.5,(v||0)/max*100)+'%"></div></div>'+
   '<span class="val">'+esc(fmt(v,m.unit))+'</span></div>';
 return '<div class="mbar"><div class="lbl">'+esc(m.label)+
  '<span class="delta '+cls+'">'+(d==null?'비교 불가':(d>0?'+':'')+d+'%')+'</span></div>'+
  row('현재',m.cur,'cur')+row('후보',m.cand,'cand')+'</div>';
}
function renderReport(r,showTrial){
 const v=r.verdict||{};
 const vcls=v.verdict&&v.verdict.includes('권장')?'v-good':(v.verdict==='보류'||v.verdict==='교체 검토')?'v-mid':'v-bad';
 let h='<div class="box"><div class="row" style="justify-content:space-between">'+
  '<b>'+esc(r.stack.toUpperCase())+' 비교 — 현재 vs '+esc(r.candidate.model||r.candidate.name||'')+
  '<span class="muted"> ('+esc((r.created||'').slice(0,16).replace('T',' '))+' 실측)</span></b>'+
  (showTrial&&v.verdict&&v.verdict!=='비권장'?'<button class="primary" onclick="startTrial(\\''+r.stack+'\\',\\''+esc(r.candidate.model||r.candidate.name)+'\\',\\''+esc(r.candidate.voice||'')+'\\')">⏱ 시험 운영 시작</button>':'')+
  '</div>';
 (r.metrics||[]).forEach(m=>{h+=barPair(m)});
 (r.quality||[]).forEach(q=>{
  h+='<div style="margin:6px 0"><b style="font-size:.85rem">'+esc(q.label)+'</b> 현재 '+
   (q.cur?'<span class="pill ok">통과</span>':'<span class="pill no">실패</span>')+' → 후보 '+
   (q.cand?'<span class="pill ok">통과</span>':'<span class="pill no">실패</span>')+'</div>'});
 h+='<div class="verdict" style="margin-top:14px"><span class="big '+vcls+'">'+esc(v.verdict||'-')+'</span><div style="flex:1;min-width:260px">'+
  (v.reasons||[]).map(x=>'⚠️ '+esc(x)).join('<br>')+'</div></div>';
 if((v.userView||[]).length)h+='<b style="display:block;margin-top:12px;font-size:.88rem">👤 사용자 관점에서 나아진 점</b><ul class="userView">'+v.userView.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul>';
 h+='</div>';
 return h;
}
function renderTrial(rep){
 const t=rep.trial;
 if(!t){
  const last=rep.last;
  $('trialBox').innerHTML=(last?'<span class="muted">마지막 시험: '+esc(last.stack.toUpperCase())+' → '+esc(last.spec.model)+' — <b>'+(last.status==='approved'?'✅ 승인 확정':'↩️ 롤백됨')+'</b> ('+esc((last.finished_at||'').slice(0,16).replace('T',' '))+')</span><br>':'')+
   '<span class="muted">진행 중인 시험이 없습니다. 벤치마크 리포트에서 "시험 운영 시작"을 누르면 실제 트래픽이 후보 모델로 전환되고, 무결루프가 실제 로그를 수집합니다.</span>';
  return}
 let h='<div class="row" style="justify-content:space-between"><div><b>⏱ 시험 운영 중 — '+esc(t.stack.toUpperCase())+' → '+esc(t.spec.model||t.spec.name)+
  (t.spec.voice?' (voice '+esc(t.spec.voice)+')':'')+'</b><div class="muted">시작: '+esc((t.started_at||'').slice(0,16).replace('T',' '))+
  ' · 경과 '+esc((rep.window&&rep.window.hours)||0)+'시간 · 실제 트래픽이 후보로 흐릅니다</div></div>'+
  '<div class="row"><button onclick="tReport(this)">📊 검증 보고서</button>'+
  '<button class="ok" onclick="finish(true,this)">✅ 최종 승인(전환 확정)</button>'+
  '<button class="danger" onclick="finish(false,this)">↩️ 롤백(기존 복원)</button></div></div><div id="trialRep"></div>';
 if(rep.tts){const a=rep.tts.trial,b=rep.tts.baseline;
  h+='<div style="margin-top:12px">'+barPair({label:'문장 생성 성공 수(시험창 vs 직전 동일 길이 창)',cur:b.ok,cand:a.ok,unit:'건',lowerBetter:false})+
  barPair({label:'평균 생성 시간',cur:b.ok_ms_avg,cand:a.ok_ms_avg,unit:'ms',lowerBetter:true})+
  barPair({label:'분할 자동 구출(SPLIT-OK)',cur:b.split_ok,cand:a.split_ok,unit:'건',lowerBetter:false})+
  barPair({label:'최종 실패(폴백 위험)',cur:b.fail_final,cand:a.fail_final,unit:'건',lowerBetter:true})+'</div>'}
 if(rep.llm){const a=rep.llm.trial,b=rep.llm.baseline;
  h+='<div style="margin-top:12px">'+barPair({label:'LLM 호출 수(시험창 vs 직전 동일 길이 창)',cur:b.n,cand:a.n,unit:'건',lowerBetter:false})+
  barPair({label:'평균 응답 시간',cur:b.ms_avg,cand:a.ms_avg,unit:'ms',lowerBetter:true})+
  barPair({label:'오류 응답',cur:b.err,cand:a.err,unit:'건',lowerBetter:true})+'</div>'}
 if(rep.issues&&rep.issues.length){h+='<b style="font-size:.85rem;display:block;margin-top:10px">🛡 무결루프가 시험 중 잡은 이슈</b>'+
  rep.issues.slice(-8).map(i=>'<div class="logline">'+esc(i.ts)+' '+esc(i.code)+' ×'+esc(i.count)+' ('+esc(i.grade)+')</div>').join('')}
 else h+='<div class="muted" style="margin-top:10px">무결루프 이슈 없음 — 시험 중 새 실패 시그니처가 없다는 뜻입니다.</div>';
 $('trialBox').innerHTML=h;
}
/* ── 조사 결과: 스택별 탭 + 정돈된 표 ── */
let DISC=null,discTab='llm';
function gradeBadge(g){return '<span class="badge '+(g==='검증됨'?'g3':g==='주목'?'g2':'g1')+'">'+g+'</span>'}
function discTable(arr,stack){
 if(!arr||!arr.length)return '<div style="padding:14px;color:#888">조사 결과가 없습니다. 위의 "조사 실행"을 누르세요.</div>';
 let h='<div class="tblWrap"><table class="tbl"><thead><tr><th style="min-width:220px">모델</th><th>갱신</th><th>특징</th><th>시장 피드백</th><th style="min-width:200px">기대 개선 <span style="font-weight:400;color:#999">(추정)</span></th><th></th></tr></thead><tbody>';
 for(const m of arr){
  const act=stack==='llm'
   ?(m.installed?'<button class="mini primary" onclick="$(\\'llmPick\\').value=\\''+esc(m.installed)+'\\';bench(\\'llm\\')">벤치마크</button>':'<span class="muted">미설치</span>')
   :stack==='tts'
   ?'<button class="mini" onclick="$(\\'ttsModel\\').value=\\''+esc(m.id)+'\\'">선택</button>'
   :'<span class="muted">A/B 고정</span>';
  h+='<tr><td class="mname">'+esc(m.id.split('/').pop())+'<span class="mid">'+esc(m.id)+'</span></td>'+
   '<td class="num">'+esc(m.updated)+'</td>'+
   '<td class="feat">'+esc(m.feature||'-')+'</td>'+
   '<td class="num">'+gradeBadge(m.grade||'신규')+'<br><span style="font-size:.72rem;color:#888">↓'+esc(m.downloads_s||'0')+' ♥'+esc(m.likes||0)+'</span></td>'+
   '<td class="exp">'+esc(m.expect||'-')+'</td>'+
   '<td style="white-space:nowrap">'+act+'</td></tr>';
 }
 return h+'</tbody></table></div>';
}
function renderDisc(d){
 DISC=d;
 const tabs=[['llm','🧠 LLM'],['stt','🎙 STT'],['tts','🔊 TTS']];
 $('discTabs').innerHTML=tabs.map(([k,l])=>'<div class="tab'+(discTab===k?' on':'')+'" onclick="discTab=\\''+k+'\\';renderDisc(DISC)">'+l+'</div>').join('');
 $('discOut').innerHTML=discTable(d[discTab],discTab);
 $('discAt').textContent='마지막 조사: '+new Date(d.at).toLocaleString('ko-KR');
}
async function refresh(){
 try{
  const s=await api('/state');
  const g=s.registry;
  $('curStack').innerHTML=
   '<div class="card"><b>🧠 LLM</b><small>'+esc(g.llm.current)+'</small><br><small class="muted">'+esc(g.llm.via)+'</small></div>'+
   '<div class="card"><b>🎙 STT</b><small>'+esc(g.stt.current)+'</small><br><small class="muted">:8323 · 시험전환 수동(n8n)</small></div>'+
   '<div class="card"><b>🔊 TTS</b><small>'+esc(g.tts.current_model.split('/').pop())+' · '+esc(g.tts.current_voice)+'</small><br><small class="muted">프록시 :8321</small></div>';
  $('llmPick').innerHTML=(s.installed||[]).map(m=>'<option>'+esc(m)+'</option>').join('');
  if(s.discovery)renderDisc(s.discovery);
  const tr=await api('/trial/report');renderTrial(tr);
 }catch(e){console.warn(e)}
}
async function discover(btn){busy(btn,true,'조사 중…');try{const d=await api('/discover',{method:'POST'});discTab='llm';renderDisc(d)}catch(e){alert(e.message)}busy(btn,false)}
async function bench(stack){
 if(stack==='llm')return benchLLM($('llmPick').value);
 if(stack==='tts')return benchGen('tts',{model:$('ttsModel').value.trim(),voice:$('ttsVoice').value.trim()||'sohee'});
 return benchGen(stack,{});
}
async function benchLLM(model){
 if(!model)return alert('ollama 모델을 선택하세요');
 if(!confirm('LLM 벤치마크: 현재(qwen3:30b) vs '+model+'\\nGPU로 수 분 걸릴 수 있습니다. 발표 중이 아닌가요?'))return;
 $('reportOut').innerHTML='<div class="box"><span class="spin" style="border-color:#2b5fd9;border-top-color:transparent"></span>벤치마크 실행 중… (5개 태스크 × 2모델)</div>';
 try{const r=await api('/bench',{method:'POST',body:JSON.stringify({stack:'llm',candidate:{model}})});$('reportOut').innerHTML=renderReport(r,true)}
 catch(e){$('reportOut').innerHTML='';alert(e.message)}
}
async function benchGen(stack,cand){
 if(stack==='tts'&&!cand.model)return alert('TTS 후보 HF repo id를 입력하세요');
 if(!confirm('벤치마크를 실행합니다. 발표 중이 아닌가요?'))return;
 $('reportOut').innerHTML='<div class="box"><span class="spin" style="border-color:#2b5fd9;border-top-color:transparent"></span>벤치마크 실행 중…</div>';
 try{const r=await api('/bench',{method:'POST',body:JSON.stringify({stack,candidate:cand})});$('reportOut').innerHTML=renderReport(r,true)}
 catch(e){$('reportOut').innerHTML='';alert(e.message)}
}
async function startTrial(stack,model,voice){
 if(!confirm('실제 발표 트래픽을 후보 모델로 전환합니다.\\n'+stack+': '+model+'\\n시험 중 문제가 보이면 롤백하세요.'))return;
 try{await api('/trial/start',{method:'POST',body:JSON.stringify({stack,candidate:{model,voice}})});refresh()}
 catch(e){alert(e.message)}
}
async function tReport(btn){if(btn)busy(btn,true,'집계 중…');try{const r=await api('/trial/report');renderTrial(r)}catch(e){alert(e.message)}if(btn)busy(btn,false)}
async function finish(ok,btn){
 const t=confirm(ok?'시험을 최종 승인하고 전환을 확정할까요?':'시험을 중단하고 기존 모델로 되돌릴까요?');if(!t)return;
 try{await api('/trial/finish',{method:'POST',body:JSON.stringify({approve:ok})});refresh();alert(ok?'전환이 확정되었습니다.':'기존 모델로 복원되었습니다.')}
 catch(e){alert(e.message)}
}
refresh();
`;

module.exports = { pageHTML: () => pageHTML() + '<script>' + CLIENT + '</' + 'script>' };
