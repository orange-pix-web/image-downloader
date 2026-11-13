const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');
test('结束无法恢复的旧任务，保留完成批次、提示词和素材，并允许新建',async()=>{
 const rows=new Map([['settings:prompt-run',{id:'prompt-run',complete:false,plan:{batches:[{batchId:'a'},{batchId:'b'}]}}],['batches:a',{id:'a',status:'sending-prompts'}],['batches:b',{id:'b',status:'prompts-ready'}],['prompts:p',{id:'p',text:'已保存'}],['assets:x',{id:'x'}]]);
 const ctx=vm.createContext({Date,DB:{get:async(s,k)=>rows.get(s+':'+k),put:async(s,r)=>rows.set(s+':'+r.id,r)}});
 const source=fs.readFileSync(path.join(__dirname,'..','workflow.js'),'utf8');vm.runInContext(source.slice(source.indexOf('async function archivePromptRun'),source.indexOf('function setupPromptRecovery')),ctx);
 assert.equal(await ctx.archivePromptRun(),true);assert.equal(rows.get('settings:prompt-run').complete,true);assert.equal(rows.get('batches:a').status,'archived-prompts');assert.equal(rows.get('batches:b').status,'prompts-ready');assert.equal(rows.get('prompts:p').text,'已保存');assert.ok(rows.has('assets:x'));assert.ok([...rows.keys()].some(k=>k.startsWith('settings:prompt-run-archive:')));assert.equal(await ctx.archivePromptRun(),false);
});
