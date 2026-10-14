// ppt-agent.html의 ConvMgr 블록을 노드에서 로드(후속질문 재작성 평가용) — slides/LLM 스텁 주입.
const fs = require('fs'), cp = require('child_process');
module.exports = function load(db) {
  const KEY = cp.execSync("/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:N8N_KEY' ~/Library/LaunchAgents/ai.wizbase.bcai.pt-agent.plist").toString().trim();
  const h = fs.readFileSync(__dirname + '/../ppt-agent.html', 'utf8');
  const blk = h.slice(h.indexOf('/*CONVMGR-BEGIN*/'), h.indexOf('/*CONVMGR-END*/'));
  const g = globalThis; g.slides = []; g.curSlideIdx = 0; g.sentences = []; g.curSentenceIdx = 0; g.LOCAL_LLM = 'llm';
  const realFetch = g.fetch;
  g.fetch = (u, o) => realFetch('http://127.0.0.1:5678/webhook/koen-local-llm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...JSON.parse(o.body), key: KEY }) });
  (0, eval)(blk.replace('const ConvMgr', 'globalThis.ConvMgr'));
  return g.ConvMgr;
};
