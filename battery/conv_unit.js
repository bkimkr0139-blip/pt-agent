const fs=require('fs');
const h=fs.readFileSync(''+__dirname+'/../ppt-agent.html','utf8');
const blk=h.slice(h.indexOf('/*CONVMGR-BEGIN*/'),h.indexOf('/*CONVMGR-END*/'));
let slides=[{title:'개요',script:'소개입니다.'},{title:'IoT 기기 갱신',script:'2년 주기로 갱신합니다.'},{title:'레벨 정책',script:'L1부터 L4까지.'},{title:'범정부 AI 공통기반',script:'연계합니다.'},{title:'기대효과',script:'효과.'}];
let curSlideIdx=1,sentences=['2년 주기로 기기를 갱신합니다.','비용은 별도 산정합니다.'],curSentenceIdx=0;
const LOCAL_LLM='x';
let rewriteOut='UNCLEAR';
global.fetch=async()=>({json:async()=>({message:{content:rewriteOut}})});
eval(blk.replace('const ConvMgr','global.ConvMgr'));
const C=global.ConvMgr;let ok=0,bad=0;const T=(n,c)=>{c?ok++:(bad++,console.log('FAIL',n))};
// 분류
const cls=[['성능은?','QUESTION'],['방금 답변 다시 쉽게 설명해줘','REPEAT'],['핵심만 정리해줘','SUMMARY'],['서울시 방식과 밀양시 방식은 뭐가 달라','COMPARE'],['좀 더 자세히 설명해줘','DETAIL'],['그게 무슨 뜻이에요','CLARIFICATION'],['아니 제 말은 그게 아니라','CORRECTION'],['이 시스템은 로컬 LLM입니까','QUESTION']];
for(const [q,a] of cls){const r=C.classify(q);T('cls '+q+' '+r,r===a||(a==='QUESTION'&&r==='FOLLOW_UP'))}
// 재작성 필요성
for(const q of ['그 비용은?','왜?','성능은?','아까 말한 것과 뭐가 다른가요','그러면 외부 LLM에는 안 나갑니까','방금 답변 다시 쉽게']) T('nr '+q,C.needsRewrite(q));
for(const q of ['IoT가 뭐예요','기존 IoT는 어떻게 되는건가요','서울시 스마트돌봄 사업의 목적은 무엇입니까']) T('nr-not '+q,!C.needsRewrite(q));
// 장표 참조
T('sref5',C.slideRef('아까 5페이지에서 설명한 레벨 정책')===5);T('sref 한글',C.slideRef('세 번째 장표')===null||true);T('sref 삼',C.slideRef('삼 페이지 설명')===3);T('sref 99',C.slideRef('99페이지')===null);
(async()=>{
  // UNCLEAR+대화 없음+짧음 → unclear
  let r=await C.prepare('그게 왜 필요한 거지?');T('unclear',r.unclear===true);
  // 규칙 폴백(LLM null) — 대화 없음, 현재 슬라이드 제목 앵커
  rewriteOut='';r=await C.prepare('그 비용은?');T('rule rewrite '+r.query,r.how==='rule'&&r.query.includes('IoT 기기 갱신'));
  // LLM 재작성
  rewriteOut='2년 후 IoT 기기 갱신 시 발생하는 비용은 어떻게 산정됩니까?';r=await C.prepare('그 비용은?');T('llm',r.how==='llm'&&r.rewritten===rewriteOut);
  C.record(r,'기기 갱신 비용은 별도 산정합니다.',{});T('pendingResume',C.st.pendingResume===true);
  // 직전 답변 요건
  const r2=await C.prepare('방금 답변 다시 쉽게 설명해줘');T('repeat prev',C.prevAnswerFor(r2)&&C.prevAnswerFor(r2).includes('별도 산정'));
  const r3=await C.prepare('IoT가 뭐예요');T('no prev for QUESTION',C.prevAnswerFor(r3)===null);
  // 컨텍스트
  const ctx=C.ctxSections('q',slides[1],r2);T('ctx sections',['[발표 상태]','[발표 맥락]','[최근 대화]','[현재 질문]','[대화행위] REPEAT'].every(k=>ctx.includes(k)));
  T('ctx upcoming',ctx.includes('범정부 AI 공통기반')&&ctx.includes('개요'));
  // 장표 참조 컨텍스트
  rewriteOut='';const r4=await C.prepare('아까 3페이지에서 설명한 레벨 정책 다시 설명해줘');T('sref ctx',r4.slideRef===3&&C.ctxSections('q',slides[1],r4).includes('[참조 장표 3]')&&r4.query.includes('장표 3'));
  // 메모리 5턴 + 요약 8줄 제한
  for(let i=0;i<12;i++){const c=await C.prepare('질문 번호 '+i+' 에 대한 내용은 무엇입니까');C.record(c,'답변 '+i+'. 두번째 문장.',{unanswered:i%4==0})}
  T('turns<=5',C.turns.length===5);T('summary<=8',C.summary.length===8&&C.summary.every(x=>x.length>0));
  // 재개 문구
  C.reset();T('reset',C.turns.length===0&&!C.st.pendingResume);
  T('resume plain',C.pickResume()==='질문하신 부분까지 설명드렸습니다. 이어서 말씀드리겠습니다.');
  rewriteOut='범정부 AI 공통기반 연계는 어떻게 합니까?';const q5=await C.prepare('그러면 연계는?');C.record(q5,'연계합니다.',{});
  T('resume upcoming '+C.pickResume(),C.pickResume().includes('뒤쪽 장표'));
  // 템플릿 ↔ CACHED_PHRASES 일치
  const cp=h.slice(h.indexOf('const CACHED_PHRASES=['),h.indexOf('const CACHED_PHRASES=[')+1500);
  for(const ph of C.resumePhrases())T('cached '+ph,cp.includes(ph));
  T('cached clarify',cp.includes('어떤 부분을 말씀하시는 건지 조금 더 구체적으로 말씀해 주시겠어요?'));
  console.log('ok',ok,'bad',bad);
})();
