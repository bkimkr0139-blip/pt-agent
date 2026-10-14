#!/usr/bin/env node
// 대화 대기(HOLD) 시나리오 시뮬레이션 [2026-10-14] — 실제 ppt-agent.html 스크립트를 node vm에서 실행해 상태 전이만 검증(약 20초 소요)
const fs=require('fs'),vm=require('vm'),path=require('path');
const html=fs.readFileSync(path.join(__dirname,'..','ppt-agent.html'),'utf8');
const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).sort((a,b)=>b.length-a.length)[0];
const stub=new Proxy(function(){},{get:(t,k)=>k===Symbol.toPrimitive?()=>'':k==='then'?undefined:stub,apply:()=>stub,construct:()=>stub,set:()=>true});
const store={},log=[];
const sb={__log:log,console:{log(){},warn(){},error(){},info(){}},setTimeout,clearTimeout,setInterval:()=>0,clearInterval(){},Promise,JSON,Math,Date,Array,Object,String,Number,RegExp,Set,Map,
  document:stub,navigator:{mediaDevices:null,userAgent:'node'},location:{hash:'',search:'',href:'http://x/'},localStorage:{getItem:k=>store[k]??null,setItem:(k,v)=>{store[k]=v},removeItem(){}},
  sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},speechSynthesis:stub,Audio:stub,Image:stub,fetch:async()=>({ok:false,json:async()=>({}),text:async()=>''}),requestAnimationFrame(){},addEventListener(){},removeEventListener(){}};
for(const k of Object.getOwnPropertyNames(globalThis))if(!(k in sb)&&!['process','global','require','module'].includes(k)){try{sb[k]=globalThis[k]}catch(_){}}
sb.window=sb;sb.self=sb;sb.globalThis=sb;vm.createContext(sb);
vm.runInContext(script+'\n;globalThis.__h={enterHold,get qaState(){return qaState},set qaState(v){qaState=v},set stt(v){_sttLastEvt=v},resume:resumeFromBackgroundPause,set playing(v){playing=v},RESUME_RE,detectIntent,judgeAddressee,isDiscussCue,DISCUSS_DONE_RE};',sb);
vm.runInContext('speakUnified=async(t)=>{__log.push("say:"+t)};resumeFromInterrupted=()=>{__log.push("RESUME")};qaLog=()=>{};',sb);
const H=sb.__h,sleep=ms=>new Promise(r=>setTimeout(r,ms));let bad=0;const chk=(n,c)=>{console.log((c?'ok  ':'FAIL')+' '+n);if(!c)bad++};
(async()=>{
  for(const t of ['계속 발표해 주세요','계속 진행합시다','발표 계속해주세요','이어서 진행해 주세요'])chk('재개 요청 인식: '+t,H.RESUME_RE.test(t));
  chk('잠깐만요 = pause',H.detectIntent('잠깐만요')==='pause');
  for(const [t,w] of [['아 잠깐만요 우리끼리 좀 토이 좀 하고요','pause'],['잠깐만요 우리끼리 토의 좀 하고요','pause'],['잠깐만요','pause'],['잠깐만요 질문 있습니다','ask'],['어 잠시만요 저희끼리 상의 좀 할게요','pause'],['변화를 확인하고 질문했습니다','ask'],['질문 있어요','ask'],['질문하겠습니다','ask']])chk('의도 '+t+' → '+w,H.detectIntent(t)===w);
  chk('토의 종료 인식',H.DISCUSS_DONE_RE.test('토의 다 했습니다')&&H.DISCUSS_DONE_RE.test('이제 얘기 끝났어요'));
  // 수신자 판정(LLM 없음 → 규칙 폴백): 사람끼리 vs AI에게
  for(const [t,buf,w] of [['과장님은 어떻게 생각하세요',[],'HUMAN'],['이거 내일까지 되겠어?',[],'HUMAN'],['이 사업의 KPI는 무엇인가요',[],'AGENT'],['그럼 예산은 얼마나 잡을까',[{t:'일정은 어떻게 하지',ts:Date.now()}],'HUMAN']])chk('수신자 '+t+' → '+w,(await H.judgeAddressee(t,buf))===w);
  H.playing=true;
  H.stt=Date.now();H.enterHold('test');
  chk('A1 HOLD 진입',H.qaState==='holding');
  await sleep(3000);H.stt=Date.now();
  await sleep(3500);chk('A2 대화 지속 중엔 묻지 않음',H.qaState==='holding'&&!log.length);
  await sleep(2500);chk('A3 대화 멈춘 뒤 "다시 발표해도 될까요?"',H.qaState==='confirming_continue'&&log.includes('say:다시 발표해도 될까요?'));
  await sleep(6000);chk('A4 질문 후 ~7초 시점엔 아직 재개 안 함',!log.includes('RESUME'));
  await sleep(5000);chk('A5 10초 무응답 → 재개',log.includes('RESUME'));
  log.length=0;H.qaState='confirming_continue';H.resume();chk('B 재개 호출 → RESUME',log.includes('RESUME')&&H.qaState==='idle');
  process.exit(bad?1:0);
})();
