const $ = selector => document.querySelector(selector);
const { WorkflowCore: Core, WorkflowDB: DB } = globalThis;
const state = { prompts: [], products: [], batches: [], assets: [], generations: [], queue: [], paused: false, vault: null, stageOnePlan: null, selectedPromptIds: new Set() };

function log(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  $('#log').textContent = `${line}\n${$('#log').textContent}`;
  $('#status').textContent = message;
}
function setStageOneButton(stateText, busy = true) {
  const button = $('#run-stage-one');
  button.dataset.idleText ||= button.textContent;
  button.textContent = stateText || button.dataset.idleText;
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
}
function setStageTwoButton(stateText, busy = true) {
  const button = $('#run-stage-two');
  button.dataset.idleText ||= button.textContent;
  button.textContent = stateText || button.dataset.idleText;
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fileDataUrl = file => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
const nowName = () => new Date().toLocaleString('zh-CN', { hour12: false }).replace(/[/:]/g, '-');
const chatUrl = url => /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url || '');
const containsProcessWords = text => /(参考图|样例图|视觉样例|复刻|复制参考|模仿参考|替换(?:为|成|产品)|原产品|当前产品名称|九宫格|宫格图|拼图|分镜|联系表|多画面|多版式并排)/.test(String(text || ''));
const includeGenerationReferences = () => document.querySelector('input[name="generation-image-mode"]:checked')?.value === 'linked';

async function loadAll() {
  [state.products, state.batches, state.assets, state.prompts, state.generations] = await Promise.all([
    DB.all('products'), DB.all('batches'), DB.all('assets'), DB.all('prompts'), DB.all('generations')
  ]);
  state.vault = (await DB.get('settings', 'vault'))?.handle || null;
  state.queue = (await DB.get('settings', 'queue'))?.items || [];
  state.selectedPromptIds = new Set([...state.selectedPromptIds].filter(id => state.prompts.some(prompt => prompt.id === id)));
  renderPrompts(); renderQueue();
  $('#vault-state').textContent = state.vault ? `已保存目录授权：${state.vault.name}` : '尚未授权。IndexedDB 本地工作流不受影响。';
}

async function refreshTabs(select) {
  const tabs = (await chrome.tabs.query({})).filter(tab => chatUrl(tab.url)).sort((a, b) => {
    const wanted = select.id === 'image-tab' ? /(生图|生成.*图|图片)/ : /(提示词|prompt)/i;
    const score = tab => wanted.test(tab.title || '') ? 1 : 0;
    return score(b) - score(a) || (b.lastAccessed || 0) - (a.lastAccessed || 0);
  });
  const old = select.value;
  select.innerHTML = '<option value="">请选择已登录的 ChatGPT 标签页</option>' + tabs.map(tab =>
    `<option value="${tab.id}">${escapeHtml(tab.title || 'ChatGPT')} · ID ${tab.id}</option>`).join('');
  if (tabs.some(tab => String(tab.id) === old)) select.value = old;
  else if (tabs.length) select.value = String(tabs[0].id);
  if (select.value) {
    const chosen = tabs.find(tab => String(tab.id) === select.value);
    log(`已连接候选页面：${chosen?.title || 'ChatGPT'}（ID ${select.value}）。`);
  }
}
function escapeHtml(value) { const div = document.createElement('div'); div.textContent = value; return div.innerHTML; }
async function messageTab(tabId, message) {
  if (!tabId) throw new Error('请先选择目标 ChatGPT 标签页');
  try { return await chrome.tabs.sendMessage(Number(tabId), message); }
  catch { throw new Error(`无法连接标签页 ID ${tabId}，请刷新该 ChatGPT 页面后重试`); }
}

function buildPromptBatchPlan() {
  const productFiles = [...$('#product-images').files];
  const referenceFiles = [...$('#reference-images').files];
  if (productFiles.length !== 1) throw new Error('每个任务必须且只能选择 1 张产品图');
  const groups = Core.batchReferences(referenceFiles, $('#reference-batch-size').value);
  let nextNumber = 1;
  const batches = groups.map((references, index) => {
    const expected = references.length || 1;
    const batch = { index, references, expected, numberStart: nextNumber, numberEnd: nextNumber + expected - 1 };
    nextNumber += expected;
    return batch;
  });
  state.stageOnePlan = { productFiles, referenceFiles, batches };
  $('#prompt-batch-preview').innerHTML = batches.map(batch => `<div class="batch-row"><strong>第 ${batch.index + 1} 批</strong><span>${batch.references.length ? batch.references.map(file => escapeHtml(file.name)).join('、') : '无参考图，仅使用产品图'}</span><span>提示词 ${batch.numberStart}–${batch.numberEnd}</span></div>`).join('');
  log(`已生成 ${batches.length} 个提示词批次，共计划生成 ${nextNumber - 1} 条提示词。`);
  return state.stageOnePlan;
}

async function saveBatchAssets(product, batch, productFiles, referenceFiles) {
  const assets = [];
  for (const [kind, files] of [['product', productFiles], ['reference', referenceFiles]]) {
    for (const file of files) {
      const asset = { id: Core.uuid(), productId: product.id, batchId: batch.id, kind, fileName: file.name, mime: file.type, blob: file, createdAt: Date.now() };
      assets.push(asset); await DB.put('assets', asset);
    }
  }
  return assets;
}

async function waitForPromptReply(tabId, baseline) {
  const deadline = Date.now() + 30 * 60 * 1000;
  let response = null, stable = 0, previous = '', lastDiagnostic = '';
  while (Date.now() < deadline) {
    await sleep(2500);
    const current = await messageTab(tabId, { type: 'GPT_WORKFLOW_ASSISTANT_STATE' });
    const messages = current.messages || [];
    const latest = current.latest || messages.at(-1);
    const changed = latest?.text && (
      messages.length > baseline.count ||
      latest.key !== baseline.latestKey ||
      latest.text !== baseline.latestText
    );
    const diagnostic = `消息 ${messages.length} 条 · 最新回复 ${latest?.text?.length || 0} 字 · ${current.generating ? '生成中' : '已停止'} · ${changed ? '检测到新回复' : '等待新回复'}`;
    if (diagnostic !== lastDiagnostic) {
      lastDiagnostic = diagnostic;
      log(diagnostic);
    }
    if (changed && !current.generating) {
      stable = latest.text === previous ? stable + 1 : 0; previous = latest.text;
      if (stable >= 1) { response = latest.text; break; }
    } else if (current.generating) {
      stable = 0;
    }
  }
  return response;
}

async function runStageOne() {
  const tabId = $('#prompt-tab').value;
  if (!tabId) throw new Error('请选择 ChatGPT 提示词标签页');
  const plan = buildPromptBatchPlan();
  const taskName = $('#batch-name').value.trim() || nowName();
  const product = { id: Core.uuid(), name: $('#product-name').value.trim() || plan.productFiles[0].name.replace(/\.[^.]+$/, ''), createdAt: Date.now() };
  await DB.put('products', product);
  let savedCount = 0;
  const basePosition = state.prompts.reduce((max, prompt) => Math.max(max, Number(prompt.position) || 0), -1) + 1;
  for (const item of plan.batches) {
    setStageOneButton(`第 ${item.index + 1}/${plan.batches.length} 批：准备发送…`);
    const batch = { id: Core.uuid(), productId: product.id, name: `${taskName}-第${item.index + 1}批`, groupName: taskName, batchIndex: item.index, expectedPrompts: item.expected, numberStart: item.numberStart, numberEnd: item.numberEnd, status: 'sending-prompts', promptTabId: Number(tabId), createdAt: Date.now() };
    await DB.put('batches', batch);
    const assets = await saveBatchAssets(product, batch, plan.productFiles, item.references);
    const before = await messageTab(tabId, { type: 'GPT_WORKFLOW_ASSISTANT_STATE' });
    const beforeMessages = before.messages || [];
    const beforeLatest = before.latest || beforeMessages.at(-1) || {};
    const baseline = { count: beforeMessages.length, latestKey: beforeLatest.key || '', latestText: beforeLatest.text || '' };
    const images = await Promise.all(assets.map(async asset => ({ dataUrl: await fileDataUrl(asset.blob), name: asset.fileName, type: asset.mime })));
    const numbering = `本批只有 1 张产品图，共有 ${item.references.length} 张视觉样例。请为${item.references.length ? '每张视觉样例分别' : '产品图'}生成 1 套独立提示词，共 ${item.expected} 套；${item.references.length === 10 ? '即 10 张视觉样例对应 10 套提示词。' : ''}每套提示词未来只生成 1 张完整的 1:1 正方形成图。标题必须依次使用【生图提示词${String(item.numberStart).padStart(2, '0')}】到【生图提示词${String(item.numberEnd).padStart(2, '0')}】，不要从 1 重新编号。10 套提示词是 10 个独立文字段落，绝不能写成九宫格、宫格图、拼图、分镜、联系表、多画面、多版式并排或把多个方案合成在一张图中。最终提示词中严禁出现“参考图”“样例图”“视觉样例”“复刻”“复制”“模仿”“替换”“原产品”“当前产品名称”等过程性措辞；必须改写为生图模型可直接执行的画面描述，并写出实际产品名称。`;
    const sent = await messageTab(tabId, { type: 'GPT_AUTOMATION_SEND', images, prompt: `${$('#prompt-instruction').value.trim()}\n\n${numbering}` });
    if (!sent?.ok) throw new Error(sent?.error || `第 ${item.index + 1} 批发送失败`);
    log(`第 ${item.index + 1}/${plan.batches.length} 批已发送，等待提示词 ${item.numberStart}–${item.numberEnd}。`);
    setStageOneButton(`第 ${item.index + 1}/${plan.batches.length} 批：等待回复…`);
    const response = await waitForPromptReply(tabId, baseline);
    if (!response) throw new Error(`等待第 ${item.index + 1} 批提示词超时；已保存的批次不会丢失`);
    const parsed = Core.parseNumberedPrompts(response);
    setStageOneButton(`第 ${item.index + 1}/${plan.batches.length} 批：保存 ${parsed.length} 条…`);
    if (parsed.length !== item.expected) throw new Error(`第 ${item.index + 1} 批应返回 ${item.expected} 条，实际识别到 ${parsed.length} 条；已停止后续批次，避免编号错位`);
    const invalidIndexes = parsed.map((prompt, index) => containsProcessWords(prompt.text) ? index + 1 : 0).filter(Boolean);
    if (invalidIndexes.length) log(`第 ${item.index + 1} 批的第 ${invalidIndexes.join('、')} 条仍有过程性措辞，已保存并标记“需检查”，不会阻塞下一批。`);
    const productAssetIds = assets.filter(asset => asset.kind === 'product').map(asset => asset.id);
    const referenceAssets = assets.filter(asset => asset.kind === 'reference');
    for (const [index, prompt] of parsed.entries()) await DB.put('prompts', {
      id: Core.uuid(), productId: product.id, batchId: batch.id,
      assetIds: [...productAssetIds, ...(referenceAssets[index] ? [referenceAssets[index].id] : [])],
      number: String(item.numberStart + index).padStart(2, '0'), text: prompt.text, position: basePosition + savedCount++, status: containsProcessWords(prompt.text) ? 'needs-review' : 'ready', createdAt: Date.now(), updatedAt: Date.now()
    });
    await DB.put('batches', { ...batch, status: 'prompts-ready', assistantResponse: response, updatedAt: Date.now() });
  }
  await loadAll(); showView('library'); log(`提示词生成完成：${plan.batches.length} 个批次，共保存 ${savedCount} 条，编号已连续校正。`);
}

async function importLocalPrompts() {
  const productFiles = [...$('#local-product-image').files];
  const referenceFiles = [...$('#local-reference-images').files];
  const directPromptFiles = [...$('#local-prompt-files').files];
  const folderPromptFiles = [...$('#local-prompt-folder').files].filter(file =>
    /提示词/i.test(file.name) && /\.(?:md|markdown|txt)$/i.test(file.name)
  );
  const fileMap = new Map();
  for (const file of [...directPromptFiles, ...folderPromptFiles]) {
    fileMap.set(`${file.webkitRelativePath || file.name}:${file.size}`, file);
  }
  const promptFiles = [...fileMap.values()].sort((a, b) =>
    (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, 'zh-CN', { numeric: true })
  );
  if (productFiles.length !== 1) throw new Error('导入本机提示词时必须选择 1 张产品图');
  if (!promptFiles.length) throw new Error('请选择至少一个本机 Markdown 或 TXT 提示词文件');
  const parsed = [];
  for (const file of promptFiles) {
    const text = (await file.text()).replace(/^\uFEFF/, '').trim();
    if (!text) continue;
    const items = Core.parseNumberedPrompts(text);
    for (const item of items) if (item.text?.trim()) parsed.push({ ...item, sourceFile: file.name });
  }
  if (!parsed.length) throw new Error('所选文件中没有识别到提示词内容');
  const now = Date.now();
  const product = {
    id: Core.uuid(),
    name: $('#local-product-name').value.trim() || productFiles[0].name.replace(/\.[^.]+$/, ''),
    source: 'local-import', createdAt: now
  };
  const batch = {
    id: Core.uuid(), productId: product.id, name: `本机导入-${nowName()}`,
    groupName: '本机导入', batchIndex: 0, expectedPrompts: parsed.length,
    numberStart: 1, numberEnd: parsed.length, status: 'prompts-ready', source: 'local-import', createdAt: now
  };
  await DB.put('products', product);
  await DB.put('batches', batch);
  const assets = await saveBatchAssets(product, batch, productFiles, referenceFiles);
  const productAsset = assets.find(asset => asset.kind === 'product');
  const references = assets.filter(asset => asset.kind === 'reference');
  const basePosition = state.prompts.reduce((max, prompt) => Math.max(max, Number(prompt.position) || 0), -1) + 1;
  const parsedNumbers = parsed.map(item => String(item.number || '').trim());
  const preserveNumbers = parsedNumbers.every(number => /^\d+$/.test(number)) && new Set(parsedNumbers).size === parsedNumbers.length;
  const importedIds = [];
  for (const [index, item] of parsed.entries()) {
    const id = Core.uuid(); importedIds.push(id);
    const text = item.text.trim();
    await DB.put('prompts', {
      id, productId: product.id, batchId: batch.id,
      assetIds: [productAsset?.id, references[index]?.id].filter(Boolean),
      number: preserveNumbers ? parsedNumbers[index].padStart(2, '0') : String(index + 1).padStart(2, '0'), text,
      position: basePosition + index,
      status: containsProcessWords(text) ? 'needs-review' : 'ready',
      source: 'local-import', sourceFile: item.sourceFile,
      createdAt: now, updatedAt: now
    });
  }
  await loadAll();
  state.selectedPromptIds = new Set(importedIds);
  renderPrompts();
  const referenceNote = references.length === parsed.length
    ? `并按顺序关联 ${references.length} 张参考图`
    : references.length ? `；已按顺序关联前 ${Math.min(references.length, parsed.length)} 张参考图，其余提示词不带参考图` : '，未关联参考图';
  log(`已从本机导入 ${parsed.length} 条提示词${referenceNote}。导入内容已自动选中。`);
  return importedIds;
}

function sortedPrompts() { return state.prompts.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.createdAt - b.createdAt); }
function renderPrompts() {
  const groups = new Map();
  for (const prompt of sortedPrompts()) {
    if (!groups.has(prompt.productId)) groups.set(prompt.productId, []);
    groups.get(prompt.productId).push(prompt);
  }
  $('#prompt-list').innerHTML = [...groups.entries()].map(([productId, prompts]) => {
    const product = state.products.find(x => x.id === productId);
    const cards = prompts.map(prompt => {
      const reference = (prompt.assetIds || []).map(id => state.assets.find(asset => asset.id === id)).find(asset => asset?.kind === 'reference');
      return `<article class="prompt-card${state.selectedPromptIds.has(prompt.id) ? ' selected' : ''}" data-id="${prompt.id}"><label class="prompt-select" title="选择这条提示词"><input class="prompt-check" type="checkbox" ${state.selectedPromptIds.has(prompt.id) ? 'checked' : ''}><span>选择</span></label><div class="prompt-main"><div class="prompt-card-head"><span class="drag" title="拖动卡片调整本产品内顺序">☰</span><label class="prompt-number-field">编号<input class="prompt-number" value="${escapeHtml(prompt.number)}"></label><span class="prompt-state">${prompt.status === 'needs-review' ? '<span class="review-badge">需检查</span>' : ''}</span><button class="secondary remove-prompt">删除</button></div><textarea class="prompt-text" aria-label="提示词 ${escapeHtml(prompt.number)}">${escapeHtml(prompt.text)}</textarea><div class="prompt-linked-asset" title="${escapeHtml(reference?.fileName || '没有关联参考图')}">${reference ? `关联参考图：${escapeHtml(reference.fileName)}` : '未关联参考图'}</div></div></article>`;
    }).join('');
    return `<section class="product-prompt-group" data-product-id="${escapeHtml(productId)}"><header class="product-prompt-heading"><div><span class="eyebrow">产品提示词</span><h3>${escapeHtml(product?.name || '未知产品')}</h3></div><div class="product-prompt-actions"><span>${prompts.length} 条</span><button type="button" class="secondary select-product-prompts">选择本产品</button></div></header><div class="prompt-grid">${cards}</div></section>`;
  }).join('') || '<p>还没有提示词。请先完成第一阶段。</p>';
  wirePromptDrag(); wireProductSelection(); wireMarqueeSelection(); updateSelectionCount();
  for (const card of document.querySelectorAll('.prompt-card')) {
    const prompt = state.prompts.find(p => p.id === card.dataset.id);
    const done = prompt.status === 'generated' || state.generations.some(g => g.promptId === prompt.id);
    const badge = document.createElement('span'); badge.className = done ? 'generation-badge done' : 'generation-badge'; badge.textContent = done ? '已生图' : '未生图';
    card.querySelector('.prompt-main').appendChild(badge);
  }
  for (const group of document.querySelectorAll('.product-prompt-group')) {
    const productId = group.dataset.productId;
    const assets = state.assets.filter(a => a.productId === productId && a.kind === 'product');
    const clear = document.createElement('button'); clear.className = 'secondary'; clear.textContent = `清除产品图（${assets.length}）`;
    clear.disabled = !assets.length;
    clear.addEventListener('click', async () => {
      if (!confirm('清除该产品在插件内保存的产品图？关联任务将无法发送，原始文件不受影响。')) return;
      const ids = new Set(assets.map(a => a.id));
      for (const asset of assets) await DB.remove('assets', asset.id);
      for (const prompt of state.prompts.filter(p => p.productId === productId)) await DB.put('prompts', { ...prompt, assetIds: (prompt.assetIds || []).filter(id => !ids.has(id)) });
      await loadAll(); log('已清除插件内的产品图，磁盘原文件保留。');
    });
    group.querySelector('.product-prompt-actions').appendChild(clear);
  }
}
function updateSelectionCount() {
  $('#selected-prompt-count').textContent = `已选择 ${state.selectedPromptIds.size} 条`;
  for (const card of document.querySelectorAll('.prompt-card')) {
    const selected = state.selectedPromptIds.has(card.dataset.id);
    card.classList.toggle('selected', selected);
    const check = card.querySelector('.prompt-check');
    if (check) check.checked = selected;
  }
  for (const group of document.querySelectorAll('.product-prompt-group')) {
    const ids = [...group.querySelectorAll('.prompt-card')].map(card => card.dataset.id);
    const allSelected = ids.length && ids.every(id => state.selectedPromptIds.has(id));
    const button = group.querySelector('.select-product-prompts');
    if (button) button.textContent = allSelected ? '取消本产品' : '选择本产品';
  }
}
function wireProductSelection() {
  for (const group of document.querySelectorAll('.product-prompt-group')) {
    group.querySelector('.select-product-prompts')?.addEventListener('click', () => {
      const ids = [...group.querySelectorAll('.prompt-card')].map(card => card.dataset.id);
      const allSelected = ids.length && ids.every(id => state.selectedPromptIds.has(id));
      for (const id of ids) allSelected ? state.selectedPromptIds.delete(id) : state.selectedPromptIds.add(id);
      updateSelectionCount();
    });
  }
}
function wirePromptDrag() {
  let dragged = null;
  for (const card of document.querySelectorAll('.prompt-card')) {
    const handle = card.querySelector('.drag');
    handle.addEventListener('pointerdown', () => card.draggable = true);
    handle.addEventListener('pointerup', () => { if (!dragged) card.draggable = false; });
    card.addEventListener('dragstart', event => { if (!card.draggable) return event.preventDefault(); dragged = card; card.classList.add('dragging'); });
    card.addEventListener('dragend', () => { card.draggable = false; card.classList.remove('dragging'); dragged = null; });
    card.addEventListener('dragover', event => event.preventDefault());
    card.addEventListener('drop', event => {
      event.preventDefault();
      if (!dragged || dragged === card || dragged.parentNode !== card.parentNode) return;
      const box = card.getBoundingClientRect();
      const sameRow = event.clientY >= box.top && event.clientY <= box.bottom;
      const before = sameRow ? event.clientX < box.left + box.width / 2 : event.clientY < box.top + box.height / 2;
      card.parentNode.insertBefore(dragged, before ? card : card.nextSibling);
    });
    card.querySelector('.prompt-check').addEventListener('change', event => {
      if (event.target.checked) state.selectedPromptIds.add(card.dataset.id); else state.selectedPromptIds.delete(card.dataset.id);
      updateSelectionCount();
    });
    card.querySelector('.remove-prompt').addEventListener('click', () => deletePrompts([card.dataset.id]).catch(error => log(error.message)));
  }
}
async function deletePrompts(ids) {
  if (!ids.length) throw new Error('请先选择要删除的提示词');
  if (!confirm(`删除选中的 ${ids.length} 条提示词及对应队列项？磁盘文件和已生成图片保留。`)) return;
  for (const id of ids) { await DB.remove('prompts', id); state.selectedPromptIds.delete(id); }
  state.queue = state.queue.filter(item => !ids.includes(item.promptId));
  await saveQueue(); await loadAll(); log(`已删除 ${ids.length} 条提示词。`);
}
function wireMarqueeSelection() {
  const root = $('#prompt-list');
  let start = null, box = null, original = null;
  const move = event => {
    if (!start || !box) return;
    const left = Math.min(start.x, event.clientX), top = Math.min(start.y, event.clientY);
    const right = Math.max(start.x, event.clientX), bottom = Math.max(start.y, event.clientY);
    Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
    state.selectedPromptIds = new Set(original);
    for (const card of root.querySelectorAll('.prompt-card')) {
      const rect = card.getBoundingClientRect();
      if (rect.left < right && rect.right > left && rect.top < bottom && rect.bottom > top) state.selectedPromptIds.add(card.dataset.id);
    }
    updateSelectionCount();
  };
  const end = () => {
    if (!start) return;
    start = null; box?.remove(); box = null;
    document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', end);
  };
  root.onpointerdown = event => {
    if (event.button !== 0 || event.target.closest('.prompt-card,button,input,textarea,label')) return;
    event.preventDefault();
    start = { x: event.clientX, y: event.clientY };
    original = (event.ctrlKey || event.metaKey) ? new Set(state.selectedPromptIds) : new Set();
    box = document.createElement('div'); box.className = 'selection-marquee'; document.body.appendChild(box);
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', end, { once: true });
  };
}
async function savePromptEdits(renumber = false) {
  const cards = [...document.querySelectorAll('.prompt-card')];
  const start = Number($('#renumber-start').value) || 1;
  for (const [position, card] of cards.entries()) {
    const old = state.prompts.find(x => x.id === card.dataset.id);
    const text = card.querySelector('.prompt-text').value.trim();
    await DB.put('prompts', { ...old, number: renumber ? String(start + position) : card.querySelector('.prompt-number').value.trim(), text, status: containsProcessWords(text) ? 'needs-review' : (old.status === 'generated' ? 'generated' : 'ready'), position, updatedAt: Date.now() });
  }
  await loadAll(); log(renumber ? '已批量重新编号；提示词 UUID 未改变。' : '提示词编辑和排序已保存。');
}

function promptCollectionMarkdown(prompts) {
  const created = new Date().toLocaleString('zh-CN', { hour12: false });
  return `# AI 商品图提示词\n\n导出时间：${created}\n\n${prompts.map(prompt => `## 生图提示词 ${prompt.number}\n\n${prompt.text}`).join('\n\n---\n\n')}\n`;
}
async function saveSelectedPromptsLocally() {
  const ids = [...state.selectedPromptIds];
  if (!ids.length) throw new Error('请先选择至少一条提示词');
  const button = $('#save-selected-prompts');
  button.disabled = true; button.textContent = '正在保存…';
  try {
    await savePromptEdits(false);
    const selected = sortedPrompts().filter(prompt => ids.includes(prompt.id));
    for (const prompt of selected) await DB.put('prompts', { ...prompt, savedLocallyAt: Date.now(), updatedAt: Date.now() });
    const blobUrl = URL.createObjectURL(new Blob([promptCollectionMarkdown(selected)], { type: 'text/markdown;charset=utf-8' }));
    await chrome.downloads.download({ url: blobUrl, filename: `AI提示词/提示词合集-${new Date().toISOString().replace(/[:.]/g, '-')}.md`, saveAs: false });
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    log(`已将 ${selected.length} 条提示词保存到 IndexedDB，并导出 Markdown 到下载目录。`);
  } finally {
    button.disabled = false; button.textContent = '导出选中 Markdown';
  }
}

async function recoverPendingPromptBatches() {
  const pending = state.batches.filter(batch => batch.status === 'sending-prompts' && batch.expectedPrompts && batch.promptTabId);
  for (const batch of pending) {
    if (state.prompts.some(prompt => prompt.batchId === batch.id)) continue;
    try {
      const current = await messageTab(batch.promptTabId, { type: 'GPT_WORKFLOW_ASSISTANT_STATE' });
      const parsed = Core.parseNumberedPrompts(current.latest?.text || '');
      const firstNumber = Number(parsed[0]?.number);
      const lastNumber = Number(parsed.at(-1)?.number);
      if (parsed.length !== batch.expectedPrompts || firstNumber !== Number(batch.numberStart) || lastNumber !== Number(batch.numberEnd)) continue;
      const assets = await DB.all('assets', 'batchId', batch.id);
      const productAssetIds = assets.filter(asset => asset.kind === 'product').map(asset => asset.id);
      const references = assets.filter(asset => asset.kind === 'reference');
      const basePosition = state.prompts.reduce((max, prompt) => Math.max(max, Number(prompt.position) || 0), -1) + 1;
      for (const [index, prompt] of parsed.entries()) await DB.put('prompts', {
        id: Core.uuid(), productId: batch.productId, batchId: batch.id,
        assetIds: [...productAssetIds, ...(references[index] ? [references[index].id] : [])],
        number: String(batch.numberStart + index).padStart(2, '0'), text: prompt.text,
        position: basePosition + index, status: 'ready', createdAt: Date.now(), updatedAt: Date.now()
      });
      await DB.put('batches', { ...batch, status: 'prompts-ready', assistantResponse: current.latest.text, recoveredAt: Date.now(), updatedAt: Date.now() });
      log(`已从 ChatGPT 恢复第 ${batch.batchIndex + 1} 批并保存 ${parsed.length} 条提示词。刷新前尚未发送的后续批次需要重新选择对应参考图。`);
      await loadAll();
    } catch (error) {
      log(`检查未完成批次失败：${error.message}`);
    }
  }
}

async function saveQueue() { await DB.put('settings', { id: 'queue', items: state.queue }); renderQueue(); await updateNamingPreview(); }
function renderQueue() {
  const pendingCount = state.queue.filter(item => item.status !== '完成').length;
  const completeCount = state.queue.length - pendingCount;
  $('#queue-summary').textContent = `${state.queue.length} 条提示词，预计生成并下载 ${state.queue.length} 张独立图片${completeCount ? `；已完成 ${completeCount} 张` : ''}`;
  let previousGroup = '';
  $('#queue-list').innerHTML = state.queue.map(item => {
    const prompt = state.prompts.find(x => x.id === item.promptId);
    const groupKey = item.runId ? `${item.runId}:${item.groupIndex}` : 'legacy';
    const product = state.products.find(x => x.id === prompt?.productId);
    const heading = groupKey !== previousGroup
      ? `<div class="queue-group"><strong>${item.runId ? `${escapeHtml(product?.name || '未知产品')} · 第 ${String(item.groupIndex).padStart(2, '0')}/${String(item.groupCount).padStart(2, '0')} 组` : '已有任务'}</strong><span>${item.runId ? `槽位 01–${String(item.groupSize).padStart(2, '0')} · ${item.groupSize} 张独立图片` : ''}</span></div>`
      : '';
    previousGroup = groupKey;
    return `${heading}<article class="queue-card"><span>${item.runId ? String(item.orderInGroup).padStart(2, '0') : escapeHtml(prompt?.number || '?')}</span><div><strong>提示词 ${escapeHtml(prompt?.number || '?')}</strong></div><div>${escapeHtml(prompt?.text?.slice(0, 160) || '提示词已删除')}</div><strong>${escapeHtml(item.status)}</strong></article>`;
  }).join('') || '<p>队列为空。请在提示词库勾选后加入。</p>';
}
async function queueSelected() {
  const ids = [...state.selectedPromptIds];
  if (!ids.length) throw new Error('请先选择至少一条提示词');
  await savePromptEdits(false);
  const selected = sortedPrompts().filter(prompt => ids.includes(prompt.id) && !state.queue.some(x => x.promptId === prompt.id && x.status !== '完成'));
  if (!selected.length) throw new Error('选中的提示词都已在未完成队列中，无需重复加入');
  const runId = Core.uuid();
  const groupSize = Number($('#generation-request-size').value) === 10 ? 10 : 1;
  const groups = Core.groupPromptsByProduct(selected, groupSize);
  for (const [groupIndex, group] of groups.entries()) {
    for (const [orderIndex, prompt] of group.prompts.entries()) state.queue.push({
      id: Core.uuid(), promptId: prompt.id, status: '等待', runId,
      groupIndex: groupIndex + 1, groupCount: groups.length, groupSize: group.prompts.length,
      orderInGroup: orderIndex + 1, createdAt: Date.now()
    });
  }
  await saveQueue(); setStageTwoButton('开始全部任务', false); showView('generate'); log(`已建立 ${groups.length} 组生图队列：${groups.map(group => group.prompts.length).join(' + ')}，共 ${selected.length} 张独立图片；不同产品不会混入同一组。`);
}

async function waitImages(tabId, baseline, expected) {
  const deadline = Date.now() + 40 * 60 * 1000; let signature = '', stable = 0, lastCount = -1;
  while (!state.paused && Date.now() < deadline) {
    await sleep(3000);
    const current = await messageTab(tabId, { type: 'GPT_AUTOMATION_STATE' });
    const fresh = (current.images || []).filter(x => !baseline.has(x.key));
    if (current.generationError && fresh.length < expected) {
      throw new Error(`ChatGPT 本轮生图失败：${current.generationError}`);
    }
    if (fresh.length !== lastCount) {
      lastCount = fresh.length;
      log(`已识别 ${Math.min(fresh.length, expected)}/${expected} 张本轮成图${current.generating ? '，ChatGPT 仍在生成' : ''}。`);
    }
    const next = fresh.map(x => x.key).join('|');
    stable = !current.generating && fresh.length >= expected && next === signature ? stable + 1 : 0; signature = next;
    if (stable >= 1) return fresh.slice(0, expected);
  }
  throw new Error(state.paused ? '队列已暂停' : '等待成图超时');
}
async function waitDownload(jobId) {
  if (!jobId) throw new Error('后台没有创建下载任务');
  const deadline = Date.now() + 5 * 60 * 1000;
  let missingRounds = 0;
  while (Date.now() < deadline) {
    await sleep(500);
    const result = await chrome.runtime.sendMessage({ type: 'GPT_IMAGE_STATUS', jobId });
    if (!result?.job) {
      missingRounds += 1;
      if (missingRounds >= 6) throw new Error('下载任务已丢失，请重新加载插件后重试');
      continue;
    }
    missingRounds = 0;
    if (result.job.state === 'complete') return;
    if (result.job.state === 'error') throw new Error(result.job.error || '图片下载失败');
  }
  throw new Error('图片下载超时');
}
async function sendNextGroupOnly() {
  const tabId = $('#image-tab').value;
  if (!tabId) throw new Error('请先选择当前可用的 ChatGPT 生图标签页');
  const candidates = state.queue.filter(item => item.status !== '完成' && item.stage !== 'manual-sent');
  if (!candidates.length) throw new Error('没有尚未发送的任务；如需重发，请先点“重置未完成任务”');
  const first = candidates[0];
  const groupKey = first.runId ? `${first.runId}:${first.groupIndex}` : first.id;
  const items = candidates.filter(item => (item.runId ? `${item.runId}:${item.groupIndex}` : item.id) === groupKey)
    .sort((a, b) => (a.orderInGroup || 1) - (b.orderInGroup || 1));
  const prompts = items.map(item => state.prompts.find(prompt => prompt.id === item.promptId));
  if (prompts.some(prompt => !prompt)) throw new Error('队列中存在已删除的提示词');
  const firstPrompt = prompts[0];
  const includeReferences = includeGenerationReferences();
  const assets = Core.generationAssets(state.assets, prompts, includeReferences);
  if (!assets.length) throw new Error('找不到该提示词关联的产品图');
  const images = await Promise.all(assets.map(async asset => ({ dataUrl: await fileDataUrl(asset.blob), name: asset.fileName, type: asset.mime })));
  const outgoingPrompt = Core.generationBatchPrompt(prompts, $('#custom-style').value, $('#strip-original-style').checked, includeReferences);
  if (!outgoingPrompt) throw new Error('清理风格后提示词为空');
  const sent = await messageTab(tabId, { type: 'GPT_AUTOMATION_SEND', images, prompt: outgoingPrompt });
  if (!sent?.ok) throw new Error(sent?.error || '发送失败');
  for (const item of items) {
    item.status = '已发送，手动下载';
    item.stage = 'manual-sent';
    item.tabId = Number(tabId);
  }
  await saveQueue();
  log(`已仅发送第 ${first.groupIndex || 1} 组：${includeReferences ? `1 张产品图 + ${Math.max(0, assets.length - 1)} 张关联参考图` : '1 张产品图'} + ${items.length} 条提示词。插件不会等待或自动下载，可在图片生成后使用“当前页面图片下载工具”。`);
}
async function runStageTwo() {
  const tabId = $('#image-tab').value;
  if (!tabId) throw new Error('请选择独立 ChatGPT 生图标签页');
  state.paused = false;
  const runnable = state.queue.filter(item => item.status !== '完成' && item.stage !== 'manual-sent');
  if (!runnable.length) throw new Error('队列中没有待执行的提示词');
  const grouped = new Map();
  for (const item of runnable) {
    const key = item.runId ? `${item.runId}:${item.groupIndex}` : item.id;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  const groups = [...grouped.values()];
  let failure = null;
  for (const [groupOffset, items] of groups.entries()) {
    if (state.paused) break;
    items.sort((a, b) => (a.orderInGroup || 1) - (b.orderInGroup || 1));
    const prompts = items.map(item => state.prompts.find(prompt => prompt.id === item.promptId));
    if (prompts.some(prompt => !prompt)) {
      for (const item of items) item.status = '失败：提示词不存在';
      await saveQueue(); continue;
    }
    const firstItem = items[0], firstPrompt = prompts[0];
    const product = state.products.find(x => x.id === firstPrompt.productId);
    const progress = `第 ${groupOffset + 1}/${groups.length} 组 · ${items.length} 张`;
    try {
      setStageTwoButton(`${progress}：准备发送…`);
      for (const item of items) item.status = '准备整组';
      await saveQueue();
      let baseline;
      const recovery = items.every(item => item.stage === 'waiting' && item.tabId === Number(tabId) && Array.isArray(item.baselineKeys));
      if (recovery) {
        baseline = new Set(firstItem.baselineKeys);
        log(`恢复第 ${firstItem.groupIndex || groupOffset + 1} 组的等待阶段，不会重复发送这一组提示词。`);
      } else {
        const before = await messageTab(tabId, { type: 'GPT_AUTOMATION_STATE' });
        baseline = new Set((before.images || []).map(x => x.key));
        const includeReferences = includeGenerationReferences();
        const assets = Core.generationAssets(state.assets, prompts, includeReferences);
        if (!assets.length) throw new Error('找不到该提示词关联的产品图');
        const images = await Promise.all(assets.map(async asset => ({ dataUrl: await fileDataUrl(asset.blob), name: asset.fileName, type: asset.mime })));
        for (const item of items) { item.stage = 'sending'; item.tabId = Number(tabId); item.baselineKeys = [...baseline]; }
        await saveQueue();
        const outgoingPrompt = Core.generationBatchPrompt(prompts, $('#custom-style').value, $('#strip-original-style').checked, includeReferences);
        if (!outgoingPrompt) throw new Error('清理风格后提示词为空，请取消自动清理或补充提示词内容');
        setStageTwoButton(`${progress}：上传产品图${includeReferences ? `、${Math.max(0, assets.length - 1)} 张参考图` : ''}和 ${items.length} 条提示词…`);
        const sent = await messageTab(tabId, { type: 'GPT_AUTOMATION_SEND', images, prompt: outgoingPrompt }); if (!sent?.ok) throw new Error(sent?.error || '发送失败');
        for (const item of items) { item.status = '等待画廊'; item.stage = 'waiting'; }
        await saveQueue();
      }
      setStageTwoButton(`${progress}：等待画廊 ${items.length} 张…`);
      const outputs = await waitImages(tabId, baseline, items.length);
      for (const [index, output] of outputs.entries()) {
        setStageTwoButton(`${progress}：下载 ${index + 1}/${outputs.length}…`);
        let dataUrl = null, mime = output.mime || 'image/png';
        const converted = await messageTab(tabId, { type: 'GPT_WORKFLOW_IMAGE_DATA', url: output.url });
        if (converted?.ok) {
          dataUrl = converted.dataUrl; mime = converted.mime || mime;
        } else if (output.downloadMethod === 'page-blob' || output.url?.startsWith('blob:')) {
          throw new Error(converted?.error || '无法读取 ChatGPT 页面成图');
        }
        const prompt = prompts[index], item = items[index];
        const slot = String(item.orderInGroup || index + 1).padStart(2, '0');
        const naming = (await DB.get('settings', 'output-naming')) || { mode: 'prompt', start: 1 };
        const productName = Core.safe(product?.name);
        const sequenceKey = `output-sequence:${productName}`;
        const sequence = (await DB.get('settings', sequenceKey)) || { last: 0, files: [] };
        const historicalNumbers = state.generations.filter(g => Core.safe(state.products.find(p => p.id === g.productId)?.name) === productName)
          .map(g => Number(g.fileName?.match(/-(\d+)\.[^.]+$/)?.[1]) || 0);
        const nextNumber = Math.max(Number(naming.start) || 1, (sequence.last || 0) + 1, Math.max(0, ...historicalNumbers) + 1);
        const filenameBase = `${productName}-${naming.mode === 'sequence' ? String(nextNumber).padStart(3, '0') : Core.safe(prompt.number)}`;
        const historyKey = `${prompt.id}:${output.key}`;
        const result = await chrome.runtime.sendMessage({
          type: 'GPT_IMAGE_DOWNLOAD',
          images: [{ url: dataUrl || output.url, key: output.key, mime, filenameBase, historyKey, order: index + 1 }],
          options: { folder: `AI图片工作流/${Core.safe(product?.name)}/成图`, prefix: '成图' }
        });
        if (!result?.ok) throw new Error(result?.error || `第 ${index + 1} 张下载任务创建失败`);
        await waitDownload(result.jobId);
        if (naming.mode === 'sequence') {
          await DB.put('settings', { id: sequenceKey, last: nextNumber, files: [...(sequence.files || []), { name: filenameBase, createdAt: Date.now() }] });
        }
        await updateNamingPreview();
        const blob = dataUrl ? await (await fetch(dataUrl)).blob() : null;
        await DB.put('generations', { id: Core.uuid(), productId: prompt.productId, batchId: prompt.batchId, promptId: prompt.id, queueId: item.id, runId: item.runId, groupIndex: item.groupIndex, slot: item.orderInGroup, tabId: Number(tabId), sourceKey: output.key, sourceUrl: output.url, blob, mime, fileName: `${filenameBase}.png`, createdAt: Date.now() });
        await DB.put('prompts', { ...prompt, status: 'generated', updatedAt: Date.now() });
        item.status = '完成'; item.stage = 'complete';
        await saveQueue();
        log(`第 ${firstItem.groupIndex || groupOffset + 1} 组：第 ${index + 1}/${outputs.length} 张已下载并保存。`);
      }
      log(`第 ${firstItem.groupIndex || groupOffset + 1} 组完成：一次请求生成并下载 ${outputs.length} 张独立图片。`);
    } catch (error) {
      for (const item of items) if (item.status !== '完成') item.status = state.paused ? '已暂停' : `失败：${error.message}`;
      await saveQueue();
      if (!state.paused) { failure = error; state.paused = true; }
      log(items[0].status);
      break;
    }
  }
  await loadAll();
  if (failure) throw failure;
  if (!state.paused && state.vault) await syncVault();
}

async function ensurePermission(handle) {
  const options = { mode: 'readwrite' };
  if ((await handle.queryPermission(options)) === 'granted') return true;
  return (await handle.requestPermission(options)) === 'granted';
}
async function directory(root, parts) { let current = root; for (const part of parts) current = await current.getDirectoryHandle(Core.safe(part), { create: true }); return current; }
async function writePath(root, path, data) {
  const parts = path.split('/'); const name = parts.pop(); const dir = await directory(root, parts);
  const file = await dir.getFileHandle(name, { create: true }); const writable = await file.createWritable(); await writable.write(data); await writable.close();
}
function productMarkdown(product, promptCount, generationCount) { return `---\ntype: ai-image-product\nuuid: ${JSON.stringify(product.id)}\n---\n# ${product.name}\n\n- [[提示词|全部提示词（${promptCount} 条）]]\n- 素材统一存放在 \`素材\` 目录\n- 生成结果统一存放在 \`成图\` 目录（${generationCount} 张）\n`; }
function uniqueVaultName(name, used) {
  const safeName = Core.safe(name, 'image.png');
  if (!used.has(safeName.toLowerCase())) { used.add(safeName.toLowerCase()); return safeName; }
  const dot = safeName.lastIndexOf('.'); const stem = dot > 0 ? safeName.slice(0, dot) : safeName; const ext = dot > 0 ? safeName.slice(dot) : '';
  let index = 2, candidate;
  do { candidate = `${stem} (${index++})${ext}`; } while (used.has(candidate.toLowerCase()));
  used.add(candidate.toLowerCase()); return candidate;
}
function compactPromptMarkdown(product, prompts, assetPaths, generationPaths) {
  const sections = prompts.map(prompt => {
    const assets = (prompt.assetIds || []).map(id => assetPaths.get(id)).filter(Boolean).map(path => `![[${path}]]`).join('\n');
    const outputs = (generationPaths.get(prompt.id) || []).map(path => `![[${path}]]`).join('\n');
    const done = prompt.status === 'generated' || state.generations.some(g => g.promptId === prompt.id);
    return `## 提示词 ${prompt.number}\n\n<!-- uuid: ${prompt.id} -->\n\n生图状态：${done ? '已生图' : '未生图'}\n\n${prompt.text}\n\n### 关联图片\n\n${assets || '暂无'}\n\n### 成图\n\n${outputs || '暂无'}`;
  }).join('\n\n---\n\n');
  return `---\ntype: ai-image-prompts\nproduct_uuid: ${JSON.stringify(product.id)}\n---\n# ${product.name} · 提示词\n\n返回：[[${Core.safe(product.name)}]]\n\n${sections || '暂无提示词'}\n`;
}
async function syncVault() {
  if (!state.vault) throw new Error('请先授权 Obsidian Vault 目录');
  if (!await ensurePermission(state.vault)) throw new Error('Vault 写入权限未授予');
  await loadAll();
  for (const product of state.products) {
    const prompts = sortedPrompts().filter(x => x.productId === product.id);
    const assets = state.assets.filter(x => x.productId === product.id);
    const base = `AI图片工作流/${Core.safe(product.name, product.id)}`;
    const fingerprints = new Map(), assetPaths = new Map(), usedProductNames = new Set(), usedReferenceNames = new Set();
    for (const asset of assets) {
      const fingerprint = `${asset.kind}|${asset.fileName}|${asset.blob?.size || 0}|${asset.mime || ''}`;
      let saved = fingerprints.get(fingerprint);
      if (!saved) {
        const folder = asset.kind === 'product' ? '素材/产品图' : '素材/参考图';
        const fileName = uniqueVaultName(asset.fileName, asset.kind === 'product' ? usedProductNames : usedReferenceNames);
        saved = `${folder}/${fileName}`; fingerprints.set(fingerprint, saved);
        await writePath(state.vault, `${base}/${saved}`, asset.blob);
      }
      assetPaths.set(asset.id, saved);
    }
    const generationPaths = new Map();
    for (const prompt of prompts) {
      const generations = state.generations.filter(x => x.promptId === prompt.id);
      for (const [index, generation] of generations.entries()) {
        try {
          let blob = generation.blob;
          if (!blob) {
            const response = await messageTab(generation.tabId || $('#image-tab').value, { type: 'GPT_WORKFLOW_IMAGE_DATA', url: generation.sourceUrl });
            if (response?.ok) blob = await (await fetch(response.dataUrl)).blob();
          }
          if (!blob) continue;
          const extension = /jpe?g/i.test(generation.mime || '') ? 'jpg' : /webp/i.test(generation.mime || '') ? 'webp' : 'png';
          const suffix = generations.length > 1 ? `-${index + 1}` : '';
          const path = `成图/${Core.safe(prompt.number)}${suffix}.${extension}`;
          await writePath(state.vault, `${base}/${path}`, blob);
          if (!generationPaths.has(prompt.id)) generationPaths.set(prompt.id, []);
          generationPaths.get(prompt.id).push(path);
        } catch { /* 页面图片可能已经过期，下载记录仍保留。 */ }
      }
    }
    const generationCount = [...generationPaths.values()].reduce((sum, paths) => sum + paths.length, 0);
    await writePath(state.vault, `${base}/${Core.safe(product.name, product.id)}.md`, productMarkdown(product, prompts.length, generationCount));
    await writePath(state.vault, `${base}/提示词.md`, compactPromptMarkdown(product, prompts, assetPaths, generationPaths));
  }
  $('#vault-state').textContent = `同步完成：${state.vault.name}/AI图片工作流`;
  log('Vault 简洁结构同步完成：素材已去重，提示词已合并。');
}

function showView(id) { if (document.body.classList.contains('simple-mode')) id = 'simple'; document.querySelectorAll('.view').forEach(x => x.classList.toggle('active', x.id === id)); document.querySelectorAll('#nav button').forEach(x => x.classList.toggle('active', x.dataset.view === id)); }
$('#nav').addEventListener('click', event => event.target.dataset.view && showView(event.target.dataset.view));
document.addEventListener('click', event => {
  const trigger = event.target.closest('[data-go]');
  if (trigger) showView(trigger.dataset.go);
});
$('#refresh-prompt-tabs').addEventListener('click', () => refreshTabs($('#prompt-tab')));
$('#refresh-image-tabs').addEventListener('click', () => refreshTabs($('#image-tab')));
$('#build-prompt-batches').addEventListener('click', () => { try { buildPromptBatchPlan(); } catch (error) { log(error.message); } });
for (const input of [$('#product-images'), $('#reference-images'), $('#reference-batch-size')]) {
  input.addEventListener('change', () => {
    state.stageOnePlan = null;
    $('#prompt-batch-preview').innerHTML = '<p>素材或批次大小已改变，请重新生成批次列表。</p>';
    setStageOneButton('生成并保存提示词', false);
  });
}
$('#run-stage-one').addEventListener('click', async () => {
  if ($('#run-stage-one').disabled) return;
  setStageOneButton('正在准备批次…');
  try {
    await runStageOne();
    setStageOneButton('提示词已保存', true);
  } catch (error) {
    log(`第一阶段失败：${error.message}`);
    showView('logs');
    setStageOneButton('重试生成提示词', false);
  }
});
$('#save-prompts').addEventListener('click', () => savePromptEdits(false).catch(error => log(error.message)));
$('#renumber').addEventListener('click', () => savePromptEdits(true).catch(error => log(error.message)));
$('#select-all-prompts').addEventListener('click', () => { state.selectedPromptIds = new Set(state.prompts.map(prompt => prompt.id)); renderPrompts(); });
$('#select-none-prompts').addEventListener('click', () => { state.selectedPromptIds.clear(); renderPrompts(); });
$('#save-selected-prompts').addEventListener('click', () => saveSelectedPromptsLocally().catch(error => log(`保存失败：${error.message}`)));
$('#import-local-prompts').addEventListener('click', async () => {
  const button = $('#import-local-prompts');
  const directButton = $('#use-local-prompts-now');
  directButton.disabled = true;
  button.disabled = true; button.textContent = '正在读取并保存…';
  try { await importLocalPrompts(); }
  catch (error) { log(`本机提示词导入失败：${error.message}`); }
  finally { button.disabled = false; directButton.disabled = false; button.textContent = '保存到提示词库'; }
});
$('#use-local-prompts-now').addEventListener('click', async () => {
  const button = $('#use-local-prompts-now');
  const saveButton = $('#import-local-prompts');
  button.disabled = true; saveButton.disabled = true; button.textContent = '正在解析并建立队列…';
  try {
    await importLocalPrompts();
    await queueSelected();
    log('本机提示词已直接解析并加入生图任务；请选择 ChatGPT 生图页面后开始。');
  } catch (error) {
    log(`直接使用本机提示词失败：${error.message}`);
  } finally {
    button.disabled = false; saveButton.disabled = false; button.textContent = '直接解析并去生图';
  }
});
$('#queue-selected').addEventListener('click', () => queueSelected().catch(error => log(error.message)));
$('#send-next-group').addEventListener('click', async () => {
  const button = $('#send-next-group');
  button.disabled = true; button.textContent = '正在发送…';
  try { await sendNextGroupOnly(); }
  catch (error) { log(`仅发送失败：${error.message}`); }
  finally { button.disabled = false; button.textContent = '仅发送下一组（手动下载）'; }
});
$('#reset-pending-queue').addEventListener('click', async () => {
  for (const item of state.queue) {
    if (item.status === '完成') continue;
    item.status = '等待'; delete item.stage; delete item.tabId; delete item.baselineKeys;
  }
  state.paused = false; await saveQueue(); setStageTwoButton('开始全部任务', false); log('未完成任务已重置，将从队列第一条重新发送。');
});
$('#clear-queue').addEventListener('click', async () => {
  if (!confirm('只清空生图任务队列，不会删除提示词。确定继续吗？')) return;
  state.queue = []; state.paused = false; await saveQueue(); setStageTwoButton('开始生成并下载', false); log('生图任务队列已清空，提示词库未受影响。');
});
$('#run-stage-two').addEventListener('click', async () => {
  if ($('#run-stage-two').disabled) return;
  $('#pause-queue').disabled = false;
  setStageTwoButton('正在准备任务…');
  try {
    await runStageTwo();
    setStageTwoButton(state.paused ? '继续生成' : '全部生成完成', state.paused ? false : true);
  } catch (error) {
    log(`第二阶段失败：${error.message}`);
    setStageTwoButton('重试生成', false);
  } finally {
    $('#pause-queue').disabled = true;
  }
});
$('#pause-queue').addEventListener('click', () => { if ($('#pause-queue').disabled) return; state.paused = true; $('#pause-queue').disabled = true; setStageTwoButton('正在暂停…'); log('将在当前轮询点暂停。'); });
$('#choose-vault').addEventListener('click', async () => { try { const handle = await showDirectoryPicker({ mode: 'readwrite' }); state.vault = handle; await DB.put('settings', { id: 'vault', handle }); $('#vault-state').textContent = `已授权：${handle.name}`; } catch (error) { if (error.name !== 'AbortError') log(error.message); } });
$('#sync-vault').addEventListener('click', () => syncVault().catch(error => log(`Vault 同步失败：${error.message}`)));
$('#clear-log').addEventListener('click', () => { $('#log').textContent = ''; log('日志显示已清空。'); });

async function initializeWorkflow() {
  setupSimpleWorkbench();
  $('#pause-queue').disabled = true;
  await Promise.all([loadAll(), refreshTabs($('#prompt-tab')), refreshTabs($('#image-tab'))]);
  await recoverPendingPromptBatches();
}
function setupSimpleWorkbench() {
  setupOutputNaming();
  setupDiskLibrary();
  const advancedButton = $('#open-advanced');
  advancedButton.className = 'secondary advanced-entry';
  advancedButton.textContent = '高级功能 →';
  $('.app-header').appendChild(advancedButton);
  const deleteButton = document.createElement('button'); deleteButton.className = 'secondary'; deleteButton.textContent = '删除选中提示词';
  deleteButton.addEventListener('click', () => deletePrompts([...state.selectedPromptIds]).catch(error => log(error.message)));
  $('.library-toolbar').appendChild(deleteButton);
  for (const selector of ['#local-product-image', '#product-images']) {
    const input = $(selector); const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'secondary'; clear.textContent = '清除所选产品图';
    clear.addEventListener('click', () => { input.value = ''; input.dispatchEvent(new Event('change', { bubbles: true })); });
    input.after(clear);
  }
  document.body.classList.add('simple-mode');
  const placements = [];
  const remember = node => { const marker = document.createComment('workbench-control'); node.before(marker); placements.push({ node, marker }); };
  const move = (selector, target) => { const node = $(selector); remember(node); $(target).appendChild(node); };
  for (const [selector, title] of [['#local-product-image', '产品图（1张）'], ['#local-prompt-files', '提示词文件（MD / TXT，可多选）'], ['#local-prompt-folder', '或选择提示词文件夹']]) {
    const label = document.createElement('label'); label.textContent = title; $('#simple-files').appendChild(label); const node = $(selector); const clear = selector === '#local-product-image' ? node.nextElementSibling : null; remember(node); label.appendChild(node); if (clear) { remember(clear); label.appendChild(clear); }
  }
  move('#image-tab', '#simple-binding'); move('#refresh-image-tabs', '#simple-binding');
  move('#queue-summary', '#simple-summary'); move('#clear-queue', '#simple-queue-actions');
  move('#queue-list', '#simple-queue'); move('#run-stage-two', '#simple-run'); move('#pause-queue', '#simple-run');
  move('#send-next-group', '#simple-run'); move('#log', '#simple-log');
  $('#simple-build').addEventListener('click', async () => {
    const button = $('#simple-build'); button.disabled = true; button.textContent = '正在解析文件…';
    try {
      $('#generation-request-size').value = '1';
      document.querySelector('input[name="generation-image-mode"][value="product"]').checked = true;
      $('#strip-original-style').checked = false; $('#custom-style').value = '';
      await importLocalPrompts(); await queueSelected();
    } catch (error) { log(`生成任务队列失败：${error.message}`); }
    finally { button.disabled = false; button.textContent = '生成任务队列'; }
  });
  const simpleParents = placements.map(({ node }) => ({ node, parent: node.parentNode }));
  $('#open-advanced').addEventListener('click', () => {
    for (const { node, marker } of placements) marker.after(node);
    document.body.classList.remove('simple-mode'); showView('library');
  });
  const back = document.createElement('button'); back.textContent = '返回简洁工作台'; back.className = 'text-button';
  back.addEventListener('click', () => { for (const { node, parent } of simpleParents) parent.appendChild(node); document.body.classList.add('simple-mode'); showView('simple'); }); $('#nav').appendChild(back);
  showView('simple');
}
initializeWorkflow().catch(error => log(`初始化失败：${error.message}`));

async function updateNamingPreview() {
  const target = $('#output-name-preview'); if (!target) return;
  const naming = (await DB.get('settings', 'output-naming')) || { mode: 'prompt', start: 1 };
  const prompt = state.prompts.find(p => p.id === state.queue.find(item => item.status !== '完成')?.promptId);
  const name = Core.safe(state.products.find(p => p.id === prompt?.productId)?.name, '产品名');
  const sequence = await DB.get('settings', `output-sequence:${name}`);
  const historical = state.generations.filter(g => Core.safe(state.products.find(p => p.id === g.productId)?.name) === name).map(g => Number(g.fileName?.match(/-(\d+)\.[^.]+$/)?.[1]) || 0);
  const next = Math.max(Number(naming.start) || 1, (sequence?.last || 0) + 1, Math.max(0, ...historical) + 1);
  target.textContent = naming.mode === 'sequence' ? `下一张：${name}-${String(next).padStart(3, '0')}.png；按产品分别顺延，已记住 ${sequence?.files?.length || 0} 个连续编号文件。` : `下一张：${name}-${prompt?.number || '01'}.png；编号来自提示词库。`;
}
function setupOutputNaming() {
  const box = document.createElement('details'); box.className = 'advanced';
  box.innerHTML = '<summary>图片命名与历史编号</summary><label>命名方式<select id="output-name-mode"><option value="prompt">产品名－提示词编号</option><option value="sequence">产品名－连续编号（自动接续历史）</option></select></label><label>连续编号起始值<input id="output-name-start" type="number" min="1" step="1" value="1"></label><p id="output-name-preview"></p><p class="field-help">成功下载后记录编号；同一产品名称共享历史。起始值低于历史编号时仍会顺延。手动下载和插件外的文件不会自动计入。</p>';
  $('#simple-run').after(box);
  const save = async () => {
    await DB.put('settings', { id: 'output-naming', mode: $('#output-name-mode').value, start: Math.max(1, Math.floor(Number($('#output-name-start').value) || 1)) });
    await updateNamingPreview();
  };
  $('#output-name-mode').addEventListener('change', () => save().catch(error => log(error.message)));
  $('#output-name-start').addEventListener('change', () => save().catch(error => log(error.message)));
  DB.get('settings', 'output-naming').then(naming => {
    if (naming) { $('#output-name-mode').value = naming.mode; $('#output-name-start').value = naming.start; }
    return updateNamingPreview();
  }).catch(error => log(error.message));
}

function setupDiskLibrary() {
  const fragment = $('#disk-library-template').content.cloneNode(true);
  const panel = fragment.querySelector('.disk-library');
  panel.open = true;
  $('.app-header').after(fragment);
  const entry = document.createElement('button');
  entry.type = 'button'; entry.className = 'knowledge-entry'; entry.textContent = '从知识库选择产品和提示词';
  $('.app-header').appendChild(entry);
  entry.addEventListener('click', () => { panel.open = true; panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  const roots = {};
  let filter = 'all';
  const tabs = document.createElement('nav'); tabs.className = 'disk-filters';
  const applyFilter = () => {
    for (const item of panel.querySelectorAll('.disk-file')) item.hidden = filter !== 'all' && item.dataset.state !== filter;
    for (const card of panel.querySelectorAll('.disk-row')) card.hidden = ![...card.querySelectorAll('.disk-file')].some(item => !item.hidden);
    for (const button of tabs.querySelectorAll('button')) button.classList.toggle('active', button.dataset.filter === filter);
  };
  for (const [value, label] of [['all', '全部提示词'], ['todo', '未生图提示词'], ['done', '已生图提示词']]) {
    const button = document.createElement('button'); button.textContent = label; button.dataset.filter = value;
    button.addEventListener('click', () => { filter = value; applyFilter(); }); tabs.appendChild(button);
  }
  $('#disk-list').before(tabs);
  const status = message => { $('#disk-status').textContent = message; };
  for (const [key, selector] of [['notes', '#disk-choose-notes'], ['images', '#disk-choose-images']]) {
    $(selector).addEventListener('click', async () => {
      try {
        const handle = await showDirectoryPicker({ mode: 'read', id: `workflow-${key}` });
        roots[key] = handle; await DB.put('settings', { id: `disk-${key}`, handle });
        status(`已关联：${Object.values(roots).map(handle => handle.name).join('、')}，点击扫描目录。`);
      } catch (error) { if (error.name !== 'AbortError') status(error.message); }
    });
  }
  async function walk(handle, prefix = '') {
    const files = [];
    for await (const [name, entry] of handle.entries()) {
      if (name.startsWith('.')) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === 'directory') files.push(...await walk(entry, path));
      else files.push({ path, handle: entry });
    }
    return files;
  }
  $('#disk-scan').addEventListener('click', async () => {
    const button = $('#disk-scan'); button.disabled = true;
    try {
      for (const key of ['notes', 'images']) {
        roots[key] ||= (await DB.get('settings', `disk-${key}`))?.handle;
        if (!roots[key]) throw new Error('请先关联知识库和附件两个目录');
        if (await roots[key].queryPermission({ mode: 'read' }) !== 'granted' && await roots[key].requestPermission({ mode: 'read' }) !== 'granted') throw new Error('目录读取权限未授予');
      }
      status('正在扫描目录…'); $('#disk-list').replaceChildren();
      const notes = await walk(roots.notes);
      const images = (await walk(roots.images)).filter(file => /(?:^|\/)产品图\//.test(file.path) && /\.(png|jpe?g|webp)$/i.test(file.path));
      const groups = new Map();
      for (const file of notes.filter(file => /纯净反推\//.test(file.path) && /提示词[^/]*\.(md|markdown|txt)$/i.test(file.path))) {
        const key = file.path.slice(0, file.path.lastIndexOf('/'));
        if (!groups.has(key)) groups.set(key, []); groups.get(key).push(file);
      }
      for (const [path, files] of groups) {
        files.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true }));
        const product = path.split('/')[0];
        const row = document.createElement('div'); row.className = 'disk-row';
        const title = document.createElement('strong'); title.textContent = `${path}（${files.length}个提示词文件）`;
        const fileList = document.createElement('div'); fileList.className = 'disk-file-list';
        for (const file of files) {
          const content = await (await file.handle.getFile()).text();
          const first = content.replace(/^\uFEFF/, '').split(/\r?\n/).find(line => line.trim()) || '';
          const marked = /^\s*(?:#{1,6}\s*)?已生图\s*$/.test(first);
          file.done = marked;
          const item = document.createElement('div'); item.className = 'disk-file'; item.dataset.state = file.done ? 'done' : 'todo';
          const label = document.createElement('label');
          const check = document.createElement('input'); check.type = 'checkbox'; check.checked = !file.done; file.check = check;
          const name = document.createElement('span'); name.textContent = `${file.path.split('/').at(-1)} · ${Core.parseNumberedPrompts(content).length}条`;
          const toggle = document.createElement('button'); toggle.className = 'secondary';
          const update = () => { toggle.textContent = file.done ? '已生图 · 改为未生图' : '未生图 · 标记已生图'; item.dataset.state = file.done ? 'done' : 'todo'; };
          update();
          toggle.addEventListener('click', async () => {
            toggle.disabled = true;
            let writable;
            try {
              const options = { mode: 'readwrite' };
              if (await file.handle.queryPermission(options) !== 'granted' && await file.handle.requestPermission(options) !== 'granted') throw new Error('未获得文件写入权限，状态未修改');
              const latest = await (await file.handle.getFile()).text();
              const next = !file.done;
              const updated = Core.setFileGeneratedStatus(latest, next);
              writable = await file.handle.createWritable();
              await writable.write(updated); await writable.close(); writable = null;
              file.done = next;
              check.checked = !file.done; update(); applyFilter();
              status(`已同步文件：${file.path}，${next ? '首行已添加“已生图”' : '已移除首行“已生图”标记'}。`);
            } catch (error) {
              if (writable) await writable.abort().catch(() => {});
              status(`写入失败：${error.message}`);
            } finally { toggle.disabled = false; }
          });
          label.append(check, name); item.append(label, toggle); fileList.appendChild(item);
        }
        const select = document.createElement('select'); select.setAttribute('aria-label', `${product}产品图`);
        const candidates = images.slice().sort((a, b) => {
          const score = file => (file.path.includes(product) ? 100 : 0) + (file.path.includes(path.split('/')[1]) ? 20 : 0) + (/正面/.test(file.path) ? 5 : 0) - (/背面/.test(file.path) ? 5 : 0);
          return score(b) - score(a);
        });
        const placeholder = new Option('请选择对应产品图', ''); select.appendChild(placeholder);
        candidates.forEach((file, index) => select.appendChild(new Option(file.path, String(index))));
        if (candidates[0]?.path.includes(product)) select.value = '0';
        const use = document.createElement('button'); use.textContent = '生成任务队列';
        use.addEventListener('click', async () => {
          use.disabled = true;
          try {
            if (select.value === '') throw new Error('请选择对应的产品图');
            const transfer = new DataTransfer();
            const selectedFiles = files.filter(file => file.check.checked && (filter === 'all' || (file.done ? 'done' : 'todo') === filter));
            if (!selectedFiles.length) throw new Error('请勾选需要生成的提示词文件');
            for (const file of selectedFiles) transfer.items.add(await file.handle.getFile());
            $('#local-prompt-files').files = transfer.files; $('#local-prompt-folder').value = '';
            const image = new DataTransfer(); image.items.add(await candidates[Number(select.value)].handle.getFile());
            $('#local-product-image').files = image.files; $('#local-reference-images').value = ''; $('#local-product-name').value = product;
            $('#generation-request-size').value = '1';
            document.querySelector('input[name="generation-image-mode"][value="product"]').checked = true;
            $('#strip-original-style').checked = false; $('#custom-style').value = '';
            await importLocalPrompts(); await queueSelected(); status(`已建立 ${path} 的逐条任务队列。`);
          } catch (error) { status(error.message); } finally { use.disabled = false; }
        });
        row.append(title, fileList, select, use); $('#disk-list').appendChild(row);
      }
      applyFilter();
      status(`已找到 ${groups.size} 组提示词、${images.length} 张产品图。请确认产品图后生成队列。`);
    } catch (error) { status(`扫描失败：${error.message}`); } finally { button.disabled = false; }
  });
}
