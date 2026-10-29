const $ = selector => document.querySelector(selector);
let running = false, stopRequested = false;
const promptResults = [];
function safePromptFilename(value) {
  const name = String(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').replace(/[. ]+$/g,'').slice(0,100);
  return name || 'Grok提示词';
}
async function saveMarkdown(items, button) {
  if(!items.length) return;
  button.disabled = true;
  const product = safePromptFilename(items[0].product);
  const filename = items.length === 1
    ? `${product}-Grok提示词-第${String(items[0].batch).padStart(2,'0')}组.md`
    : `${product}-Grok提示词-全部.md`;
  const text = items.map(item => `# ${item.product} · 第${item.batch}批\n\n参考图编号：${item.from}–${item.to}\n\n${item.text}`).join('\n\n---\n\n') + '\n';
  const url = URL.createObjectURL(new Blob([text],{type:'text/markdown;charset=utf-8'}));
  try {
    const id = await chrome.downloads.download({url,filename,saveAs:true});
    if(id == null) throw new Error('保存任务未创建');
    log(`已发起保存：${filename}，请在浏览器下载列表确认完成。`);
  } catch(error) { log(`保存取消或失败：${error.message}`); }
  finally {
    // 给浏览器足够时间读取 Blob；避免保存对话框出现时提前释放。
    setTimeout(()=>URL.revokeObjectURL(url),60000);
    button.disabled = false;
  }
}
$('#save-all').addEventListener('click',()=>saveMarkdown(promptResults.slice(),$('#save-all')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function log(message) {
  const el = $('#log');
  el.textContent += `[${new Date().toLocaleTimeString('zh-CN')}] ${message}\n`;
  el.scrollTop = el.scrollHeight;
}
$('#open-window').hidden = new URLSearchParams(location.search).has('window');
$('#open-window').addEventListener('click', async () => {
  if (running) { log('任务正在执行，请完成或停止后再打开新窗口，以免重复发送。'); return; }
  const result = await chrome.runtime.sendMessage({ type:'GROK_OPEN_WINDOW' });
  if (!result?.ok) log(result?.error || '打开独立窗口失败');
});
function isGrok(url) {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && ['grok.com', 'www.grok.com'].includes(parsed.hostname); } catch { return false; }
}
async function refresh() {
  const previous = $('#tab').value;
  const tabs = (await chrome.tabs.query({})).filter(tab => isGrok(tab.url) || isGrok(tab.pendingUrl));
  $('#tab').replaceChildren(new Option('请选择 Grok 对话', ''));
  for (const tab of tabs) $('#tab').add(new Option(`${tab.title || 'Grok'} — ${tab.url || tab.pendingUrl}`, String(tab.id)));
  $('#tab').value = tabs.some(tab => String(tab.id) === previous) ? previous : tabs.length === 1 ? String(tabs[0].id) : '';
  $('#connection').textContent = tabs.length ? `找到 ${tabs.length} 个 Grok 页面。` : '未找到 Grok，请在同一浏览器、同一用户配置中打开 grok.com。';
}
async function send(id, message) {
  const tab = await chrome.tabs.get(id);
  if (!isGrok(tab.url)) throw new Error('所选 Grok 标签页已关闭或尚未加载完成');
  let result;
  try { result = await chrome.tabs.sendMessage(id, message); }
  catch { throw new Error('无法连接 Grok，请重新加载扩展、允许访问 grok.com，再刷新 Grok 页面'); }
  if (!result?.ok) throw new Error(result?.error || 'Grok 适配器未响应，请刷新页面');
  return result;
}
async function fileData(file) {
  return new Promise((resolve,reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name:file.name, type:file.type, dataUrl:reader.result });
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
    reader.readAsDataURL(file);
  });
}
async function waitReply(id, baseline) {
  const deadline = Date.now() + 10*60*1000;
  let last = '', since = 0;
  let reportAt = Date.now(), started = Date.now();
  while(Date.now() < deadline) {
    if(stopRequested) throw new Error('已停止等待；已发送的内容仍会在 Grok 中继续处理');
    const state = await send(id, { type:'GROK_STATE' });
    if(Date.now()-reportAt >= 30000) {
      log(`已等待 ${Math.round((Date.now()-started)/1000)} 秒；${state.generating ? 'Grok 正在生成' : state.text && state.text !== baseline ? '回复已出现，确认稳定中' : '尚未识别到新回复'}`);
      reportAt = Date.now();
    }
    if(state.text && state.text !== baseline && !state.generating) {
      if(state.text !== last) { last = state.text; since = Date.now(); }
      if(Date.now()-since >= 15000) return state.text;
    } else { last = ''; since = 0; }
    await sleep(2000);
  }
  throw new Error('等待 Grok 回复超时，请到 Grok 页面查看结果；不会自动重发');
}
async function run() {
  if(running) return;
  const id = Number($('#tab').value), product = $('#product').files[0];
  const refs = Array.from($('#references').files), instruction = $('#instruction').value.trim();
  if(!id || !product || !refs.length || !instruction) { $('#status').textContent = '请选择 Grok 页面、1张产品图、至少1张参考图，并填写生成要求。'; log($('#status').textContent); return; }
  const limit = Math.max(2, Math.min(20, Math.floor(Number($('#batch').value)||10)));
  running = true; stopRequested = false;
  $('#start').disabled = true; $('#stop').disabled = false;
  for(const input of document.querySelectorAll('input,select,textarea,#refresh,#check')) input.disabled = true;
  try {
    log(`开始任务：${product.name}，${refs.length} 张参考图，每批最多 ${limit} 个附件。`);
    await chrome.storage.local.set({ grokStandaloneInstruction:instruction, grokStandaloneBatch:limit });
    const productData = await fileData(product);
    const total = Math.ceil(refs.length/(limit-1));
    for(let offset=0, batch=1; offset<refs.length; offset+=limit-1,batch++) {
      if(stopRequested) break;
      $('#status').textContent = `第 ${batch}/${total} 批：准备上传`;
      log($('#status').textContent);
      const before = await send(id,{type:'GROK_STATE'});
      if(before.generating) throw new Error('Grok 正在回复，请完成后再启动');
      const subset = refs.slice(offset,offset+limit-1);
      const images = [...await Promise.all(subset.map(fileData)),productData];
      log(`附件读取完成：${subset.length} 张参考图 + 1 张产品图；正在交给 Grok 上传并发送。`);
      if(stopRequested) break;
      const prompt = `${instruction}\n\n本批前${subset.length}张为参考图，最后一张为产品图“${product.name}”。参考图对应总编号${offset+1}至${offset+subset.length}，请按这个编号输出，只生成文字提示词。`;
      let polling = false, previousStage = '';
      const progressTimer = setInterval(async () => {
        if(polling) return;
        polling = true;
        try {
          const progress = await send(id,{type:'GROK_UPLOAD_STATUS'});
          const labels = { locating:'正在定位上传控件', attached:'附件已添加，正在写入提示词', 'waiting-submit':`附件已添加（检测到 ${progress.attached || 0} 个），等待发送按钮`, sent:'已点击发送', error:progress.error };
          const label = labels[progress.stage];
          if(label && progress.stage !== previousStage) {
            previousStage = progress.stage;
            $('#status').textContent = `第 ${batch}/${total} 批：${label}`;
            log($('#status').textContent);
          }
        } catch { /* 主请求负责报告连接错误。 */ }
        finally { polling = false; }
      },1000);
      try { await send(id,{type:'GROK_SEND',images,prompt}); }
      finally { clearInterval(progressTimer); }
      $('#status').textContent = `第 ${batch}/${total} 批：已上传，等待 Grok 提示词`;
      log($('#status').textContent);
      const text = await waitReply(id,before.text);
      const card = document.createElement('div');
      card.className = 'batch-result';
      const fold = document.createElement('details');
      const title = document.createElement('summary'), result = document.createElement('pre');
      title.textContent = `第 ${batch} 批 · 参考图 ${offset+1}–${offset+subset.length} · ${text.length} 字（点击展开）`;
      const item = { product:product.name.replace(/\.[^.]+$/,''),batch,from:offset+1,to:offset+subset.length,text };
      promptResults.push(item);
      const save = document.createElement('button');
      save.className = 'secondary'; save.textContent = '保存本批提示词（Markdown）';
      save.addEventListener('click',()=>saveMarkdown([item],save));
      result.textContent = text;
      fold.append(title,result);
      card.append(fold,save);
      $('#results').append(card);
      $('#save-all').disabled = false;
      log(`第 ${batch}/${total} 批完成：收到 ${text.length} 字提示词。`);
    }
    $('#status').textContent = stopRequested ? '已停止后续批次' : '全部提示词已生成';
    log($('#status').textContent);
  } catch(error) { $('#status').textContent = error.message; log(`任务停止：${error.message}`); }
  finally {
    running = false; $('#start').disabled = false; $('#stop').disabled = true;
    for(const input of document.querySelectorAll('input,select,textarea,#refresh,#check')) input.disabled = false;
  }
}
$('#start').addEventListener('click',run);
$('#stop').addEventListener('click',()=>{stopRequested=true;$('#status').textContent='正在停止；不会取消已经发送到 Grok 的请求';log($('#status').textContent);});
$('#refresh').addEventListener('click',()=>refresh().catch(error=>$('#connection').textContent=error.message));
$('#check').addEventListener('click',async()=>{
  try {
    const state = await send(Number($('#tab').value),{type:'GROK_DIAGNOSTICS'});
    $('#diagnostics-wrap').hidden = false;
    $('#diagnostics-wrap').open = true;
    $('#diagnostics').textContent = JSON.stringify({ editor:state.editor, uploads:state.uploads, inputs:state.inputs, attachmentButtons:state.buttons, frames:state.frames },null,2);
    $('#connection').textContent = `已连接 · 输入框${state.editor?'已找到':'未找到'} · 上传控件 ${state.uploads} 个`;
    log($('#connection').textContent);
  } catch(error) { $('#connection').textContent=error.message;log(`连接检查失败：${error.message}`); }
});
for(const input of [$('#product'),$('#references')]) input.addEventListener('change',()=>{
  $('#files').textContent = `产品图：${$('#product').files[0]?.name || '未选择'}；参考图：${$('#references').files.length} 张`;
});
(async()=>{
  log(`Grok 管理器 ${chrome.runtime.getManifest().version} 已加载。`);
  const saved = await chrome.storage.local.get(['grokStandaloneInstruction','grokStandaloneBatch']);
  if(saved.grokStandaloneInstruction) $('#instruction').value=saved.grokStandaloneInstruction;
  if(saved.grokStandaloneBatch) $('#batch').value=saved.grokStandaloneBatch;
  await refresh();
})().catch(error=>$('#connection').textContent=error.message);
