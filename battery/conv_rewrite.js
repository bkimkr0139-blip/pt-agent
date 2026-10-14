const fs=require('fs'),cp=require('child_process');
const KEY=cp.execSync("/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:N8N_KEY' ~/Library/LaunchAgents/ai.wizbase.bcai.pt-agent.plist").toString().trim();
const h=fs.readFileSync(''+__dirname+'/../ppt-agent.html','utf8');
const blk=h.slice(h.indexOf('/*CONVMGR-BEGIN*/'),h.indexOf('/*CONVMGR-END*/'));
let slides=[{title:'개요'},{title:'IoT 기기 갱신 정책'},{title:'레벨 정책 L1-L4'},{title:'범정부 AI 공통기반 연계'},{title:'기대효과'},{title:'개인정보 보호'}];
let curSlideIdx=1,sentences=['기기는 2년 주기로 갱신합니다.','비용은 별도 산정합니다.'],curSentenceIdx=0;
const LOCAL_LLM='llm';
const realFetch=globalThis.fetch;
globalThis.fetch=(u,o)=>realFetch('http://127.0.0.1:5678/webhook/koen-local-llm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...JSON.parse(o.body),key:KEY})});
eval(blk.replace('const ConvMgr','global.ConvMgr'));
const C=global.ConvMgr;
// [직전 질문, 직전 답변, 현재 질문, 기대 키워드(하나 이상 포함)]
const CASES=[
['로컬 LLM을 사용합니까?','네, 로컬 LLM을 기본으로 사용합니다.','성능은?',['LLM']],
['2년 후 IoT 기기 갱신은 어떻게 합니까?','2년 주기로 갱신합니다.','그 비용은?',['갱신','IoT']],
['개인정보는 어떻게 보호합니까?','외부 전송 전에 마스킹합니다.','그럼 외부 LLM에는 안 나갑니까?',['개인정보','외부','LLM']],
['L1부터 L4까지 레벨 정책이 뭔가요?','레벨별로 권한을 나눕니다.','그건 왜 그런가요?',['레벨','L1','권한']],
['범정부 AI 공통기반과 어떻게 연계합니까?','API로 연계합니다.','언제부터 가능해요?',['공통기반','연계']],
['음성 에이전트의 STT는 무엇을 씁니까?','브라우저 음성 인식을 씁니다.','정확도는?',['STT','음성']],
['TTS 목소리는 어떤 것을 씁니까?','serena 목소리를 씁니다.','그거 바꿀 수 있어요?',['목소리','TTS']],
['RAG는 어떻게 구성했나요?','임베딩 검색을 씁니다.','그 방식의 한계는?',['RAG','임베딩','검색']],
['기대효과가 무엇인가요?','돌봄 인력 부담이 줄어듭니다.','그러면 비용은요?',['기대효과','돌봄','비용']],
['보안은 어떻게 합니까?','접근 권한을 분리합니다.','아까 말한 것과 뭐가 다른가요?',['보안','권한']],
['스마트 돌봄 대상은 누구입니까?','독거 어르신입니다.','그 인원은?',['돌봄','어르신','대상']],
['갱신 주기는 얼마입니까?','2년입니다.','왜 2년이에요?',['갱신','2년']],
['서울시는 어떤 방식을 씁니까?','센서 기반으로 합니다.','밀양시는요?',['밀양','방식','센서']],
['클라우드 LLM도 쓰나요?','허용된 계정만 씁니다.','그 기준은?',['클라우드','LLM','허용']],
['음성 인식이 틀리면 어떻게 하나요?','확인 질문을 합니다.','그 확인은 언제 해요?',['확인','음성']],
['발표 중 질문하면 어떻게 되나요?','발표를 멈추고 답합니다.','답한 다음에는요?',['질문','발표','답']],
['위험도 산정은 어떻게 하나요?','센서 값을 점수화합니다.','그 점수 기준은?',['위험도','점수']],
['데이터는 어디에 저장합니까?','로컬 서버에 저장합니다.','그게 안전한가요?',['저장','로컬','데이터']],
['장애가 나면 어떻게 합니까?','자동 재연결을 합니다.','그 시간은 얼마나 걸려요?',['장애','재연결']],
['사용자 교육은 어떻게 합니까?','현장 교육을 합니다.','그건 몇 번 하나요?',['교육']],
];
(async()=>{
  let ok=0,fail=0,unclear=0,t=[];
  for(const [pq,pa,q,kws] of CASES){
    C.reset();
    const p=await C.prepare(pq);C.record(p,pa,{});
    const t0=Date.now();const r=await C.prepare(q);t.push(Date.now()-t0);
    const good=!r.unclear&&r.rewritten&&kws.some(k=>r.query.includes(k));
    if(r.unclear)unclear++;
    good?ok++:(fail++,console.log('FAIL',q,'→',r.how,r.query));
    if(process.env.V)console.log(r.how,'|',q,'→',r.query);
  }
  t.sort((a,b)=>a-b);
  console.log('후속질문 재작성 성공',ok+'/'+CASES.length,'unclear',unclear,'p50 ms',t[Math.floor(t.length/2)],'max',t[t.length-1]);
})();
// 독립 질문 보존 시험 — 이을 대화가 있어도 고유 용어 질문은 용어를 잃지 않아야 한다
(async()=>{
  const S=[['IoT가 뭐예요','IoT'],['SSOT가 뭐야?','SSOT'],['위즈베이스는 어떤 회사입니까','위즈베이스'],['기존 IoT는 어떻게 되는건가요','IoT'],['RBAC이 뭔가요','RBAC'],['오늘 서울 날씨 어때요','날씨'],['데이터브릭스가 뭐하는 회사예요','데이터브릭스'],['L3 레벨은 뭔가요','L3']];
  let ok=0;
  for(const [q,k] of S){C.reset();const p=await C.prepare('로컬 LLM을 사용합니까?');C.record(p,'네, 로컬 LLM을 기본으로 사용합니다.',{});const r=await C.prepare(q);const g=r.query.includes(k);g?ok++:console.log('FAIL standalone',q,'→',r.query);if(process.env.V)console.log(r.how,'|',q,'→',r.query)}
  console.log('독립 질문 용어 보존',ok+'/'+S.length);
})();
