const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'workflow.js'), 'utf8');
test('逐张反推自然排序，每批持久化对应的一张图片，上传不混入产品或参考图', async () => {
  const rows = new Map(), sent = []; let id = 0;
  const inputs = {
    '#prompt-mode': { value: 'single-image' }, '#reverse-images': { files: [{name:'图10.png'}, {name:'图2.png'}] },
    '#prompt-batch-preview': {}, '#prompt-tab': {value:'12'}, '#batch-name': {value:''},
    '#product-name': {value:''}, '#prompt-instruction': {value:'自定义要求'}
  };
  const ctx = vm.createContext({
    $: key => inputs[key], state:{prompts:[]}, Core:{uuid:()=>String(++id)},
    escapeHtml: text => text, log(){}, nowName:()=> '任务', setStageOneButton(){},
    DB:{get:async(s,k)=> rows.get(s+':'+k), put:async(s,r)=>rows.set(s+':'+r.id,structuredClone(r)), all:async(s,index,k)=> [...rows.entries()].filter(([key,row])=>key.startsWith(s+':') && row[index]===k).map(([,row])=>row)},
    fileDataUrl:async file=> file.name,
    messageTab:async(tab,msg)=> {if(msg.type==='GPT_AUTOMATION_SEND'){sent.push(msg); return {ok:true};} return {messages:[],conversationUrl:'https://www.doubao.com/chat/1'};},
    waitForPromptReply:async(tab,base,batch)=> `回复${batch.numberStart}`,
    containsProcessWords:()=>false,
    saveAcceptedPromptBatch:async(batch)=> {await ctx.DB.put('batches',{...batch,status:'prompts-ready'});return {added:1};},
    loadAll:async()=>{},showView(){}
  });
  ctx.Core.parseNumberedPrompts = text => [{text}];
  vm.runInContext(source.slice(source.indexOf('function buildPromptBatchPlan'),source.indexOf('async function waitForPromptReply'))+source.slice(source.indexOf('async function runStageOne'),source.indexOf('async function importLocalPrompts')),ctx);
  ctx.saveAcceptedPromptBatch = async batch => { await ctx.DB.put('batches', {...batch, status:'prompts-ready'}); return {added:1}; };
  await ctx.runStageOne();
  assert.equal(sent.length,2);
  assert.deepEqual(sent.map(msg=>Array.from(msg.images,img=>img.dataUrl)),[['图2.png'],['图10.png']]);
  assert.match(sent[0].prompt,/【生图提示词01】/);assert.match(sent[1].prompt,/【生图提示词02】/);
  assert.equal(rows.get('settings:prompt-run').complete,true);
  assert.equal([...rows.keys()].filter(key=>key.startsWith('assets:')).length,2);
});
