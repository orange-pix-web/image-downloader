const $ = (selector) => document.querySelector(selector);
const imageInput = $("#images");
const referenceInput = $("#references");
const promptInput = $("#prompts");
const taskFolderInput = $("#task-folder");
const taskBody = $("#tasks");
const summary = $("#summary");
const logEl = $("#log");
const startButton = $("#start");
const pauseButton = $("#pause");
const stateBadge = $("#run-state");
const targetTabSelect = $("#target-tab");
const bindingDetail = $("#binding-detail");

if (
  window.top !== window ||
  new URLSearchParams(location.search).has("embedded") ||
  new URLSearchParams(location.search).has("manager")
) {
  document.body.classList.add("embedded");
}

let tasks = [];
let paused = false;
let running = false;
let boundTabId = null;
const DB_NAME = "ai-image-downloader";
const DB_VERSION = 1;
const QUEUE_STORE = "queue";

function openQueueDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveQueue() {
  const db = await openQueueDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(QUEUE_STORE, "readwrite");
    transaction.objectStore(QUEUE_STORE).put(tasks, "tasks");
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function loadQueue() {
  const db = await openQueueDb();
  const saved = await new Promise((resolve, reject) => {
    const request = db.transaction(QUEUE_STORE, "readonly")
      .objectStore(QUEUE_STORE).get("tasks");
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return saved;
}

async function clearQueue() {
  const db = await openQueueDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(QUEUE_STORE, "readwrite");
    transaction.objectStore(QUEUE_STORE).delete("tasks");
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

function managerSettings() {
  return {
    pollSeconds: Math.max(5, Number($("#poll-seconds").value) || 30),
    timeoutMinutes: Math.max(5, Number($("#timeout-minutes").value) || 40),
    stableRounds: Math.max(1, Number($("#stable-rounds").value) || 2),
    autoRefresh: $("#auto-refresh").checked,
    refreshMinutes: Math.max(1, Number($("#refresh-minutes").value) || 5),
    maxRefreshes: Math.max(1, Number($("#max-refreshes").value) || 2),
    newChatEachTask: $("#new-chat-each-task").checked,
    promptPreset: $("#prompt-preset").value,
    referenceMode: $("#reference-mode").value,
    brandName: $("#brand-name").value.trim(),
    specifiedCopy: $("#specified-copy").value.trim(),
    presetCount: Math.max(1, Math.min(20, Number($("#preset-count").value) || 1)),
    maxAttachments: Math.max(2, Math.min(20, Number($("#max-attachments").value) || 10)),
    folderOneToOne: $("#folder-one-to-one").checked,
    fixedPosition: $("#fixed-position").value,
    fixedPrompt: $("#fixed-prompt").value.trim(),
    forbiddenReferenceText: $("#forbidden-reference-text").value.trim(),
    productTextRules: $("#product-text-rules").value.trim(),
    disclaimerEnabled: $("#disclaimer-enabled").checked,
    disclaimerMode: $("#disclaimer-mode").value,
    disclaimerPosition: $("#disclaimer-position").value,
    disclaimerLayout: $("#disclaimer-layout").value,
    disclaimerFontPercent: Math.max(0.6, Math.min(4, Number($("#disclaimer-font-percent").value) || 1.2)),
    disclaimerOpacity: Math.max(30, Math.min(100, Number($("#disclaimer-opacity").value) || 65)),
    disclaimerBackground: $("#disclaimer-background").checked,
    disclaimerText: $("#disclaimer-text").value.trim(),
    customTemplate: $("#custom-template").value
  };
}

async function saveManagerSettings() {
  await chrome.storage.local.set({ managerSettings: managerSettings() });
}

async function restoreManagerSettings() {
  const saved = await chrome.storage.local.get("managerSettings");
  const value = saved.managerSettings;
  if (!value) return;
  $("#poll-seconds").value = value.pollSeconds ?? 30;
  $("#timeout-minutes").value = value.timeoutMinutes ?? 40;
  $("#stable-rounds").value = value.stableRounds ?? 2;
  $("#auto-refresh").checked = value.autoRefresh !== false;
  $("#refresh-minutes").value = value.refreshMinutes ?? 5;
  $("#max-refreshes").value = value.maxRefreshes ?? 2;
  $("#new-chat-each-task").checked = value.newChatEachTask === true;
  $("#prompt-preset").value = value.promptPreset || "original";
  $("#reference-mode").value = value.referenceMode || "auto";
  $("#brand-name").value = value.brandName || "";
  $("#specified-copy").value = value.specifiedCopy || "";
  $("#preset-count").value = value.presetCount || 1;
  $("#max-attachments").value = value.maxAttachments || 10;
  $("#folder-one-to-one").checked = value.folderOneToOne !== false;
  $("#fixed-position").value = value.fixedPosition || "append";
  $("#fixed-prompt").value = value.fixedPrompt || "";
  $("#forbidden-reference-text").value = value.forbiddenReferenceText || "";
  $("#product-text-rules").value = value.productTextRules || "";
  $("#disclaimer-enabled").checked = value.disclaimerEnabled === true;
  $("#disclaimer-mode").value = value.disclaimerMode || "overlay";
  $("#disclaimer-position").value = value.disclaimerPosition || "bottom-center";
  $("#disclaimer-layout").value = value.disclaimerLayout || "footer";
  $("#disclaimer-font-percent").value = value.disclaimerFontPercent || 1.2;
  $("#disclaimer-opacity").value = value.disclaimerOpacity || 65;
  $("#disclaimer-background").checked = value.disclaimerBackground !== false;
  $("#disclaimer-text").value = value.disclaimerText || "以上仅代表本产品的各种可使用场景\n不代表任何功效、症状等情况";
  $("#custom-template").value = value.customTemplate || "";
  updatePresetVisibility();
}

function updatePresetVisibility() {
  $("#custom-template-wrap").classList.toggle("hidden", $("#prompt-preset").value !== "custom");
}

function log(message) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAiPage(url) {
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com|www\.doubao\.com)\//.test(url || "");
}

async function refreshTabList(preferredId = boundTabId) {
  const tabs = (await chrome.tabs.query({})).filter((tab) => isAiPage(tab.url));
  targetTabSelect.innerHTML = "";
  for (const tab of tabs) {
    const option = document.createElement("option");
    option.value = String(tab.id);
    option.textContent = `${tab.title || "未命名页面"} — ${new URL(tab.url).hostname}`;
    option.title = tab.url;
    targetTabSelect.appendChild(option);
  }
  if (!tabs.length) {
    targetTabSelect.add(new Option("没有找到 ChatGPT 或豆包页面", ""));
    bindingDetail.textContent = "请先打开一个 AI 对话页面，再刷新列表。";
    return;
  }
  const selected = tabs.find((tab) => tab.id === Number(preferredId));
  targetTabSelect.value = String(selected?.id || tabs[0].id);
  await showBinding();
}

async function showBinding() {
  if (!boundTabId) {
    bindingDetail.textContent = "尚未绑定。请选择页面并点击“绑定所选页面”。";
    return;
  }
  try {
    const tab = await chrome.tabs.get(boundTabId);
    if (!isAiPage(tab.url)) throw new Error();
    bindingDetail.textContent = `已锁定：${tab.title || "未命名页面"} ｜ ${tab.url}`;
    targetTabSelect.value = String(boundTabId);
  } catch {
    bindingDetail.textContent = `原绑定标签页（ID ${boundTabId}）已关闭或不再是 AI 页面，请手动重新绑定。`;
  }
}

async function bindSelectedTab() {
  const tabId = Number(targetTabSelect.value);
  if (!tabId) return log("没有可绑定的 AI 页面。");
  const tab = await chrome.tabs.get(tabId);
  if (!isAiPage(tab.url)) return log("所选标签页已失效，请刷新页面列表。");
  boundTabId = tabId;
  await chrome.storage.local.set({ managerTargetTabId: tabId });
  for (const task of tasks) {
    if (task.status !== "执行中" && task.status !== "已完成") task.targetTabId = tabId;
  }
  await saveQueue();
  await showBinding();
  log(`已手动绑定生图页面：${tab.title || tab.url}`);
}

function productName(filename) {
  return filename
    .replace(/\.[^.]+$/, "")
    // 支持 -生图提示词-v2、-生图提示词-第01组、_提示词_第二组等后缀。
    // 只从靠近文件名末尾的“提示词”标记开始删除，保留前面的完整产品名。
    .replace(/[-_ ]*(?:生图)?提示词(?:[-_ ].*)?$/i, "")
    .trim();
}

function matchProductImage(promptProduct, imageEntries) {
  const exact = imageEntries.filter((entry) => entry.product === promptProduct);
  if (exact.length === 1) return { image: exact[0].file, matchedProduct: exact[0].product, mode: "exact" };
  if (exact.length > 1) return { ambiguous: exact.map((entry) => entry.file.name) };

  // 兼容“鸽虫净-无文案产品图提示词-第01组.md”对应“鸽虫净.png”。
  // 只接受产品名之后紧跟分隔符的前缀，避免“产品A”误匹配“产品AB”。
  const candidates = imageEntries
    .filter((entry) => new RegExp(`^${escapeRegExp(entry.product)}[-_ ]`).test(promptProduct))
    .sort((a, b) => b.product.length - a.product.length);
  if (!candidates.length) return null;
  const longest = candidates[0].product.length;
  const best = candidates.filter((entry) => entry.product.length === longest);
  if (best.length > 1) return { ambiguous: best.map((entry) => entry.file.name) };
  return { image: best[0].file, matchedProduct: best[0].product, mode: "prefix" };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function referenceProductName(filename) {
  return filename
    .replace(/\.[^.]+$/, "")
    .replace(/[-_ ]*(?:参考图|构图参考|场景参考|场景图)(?:[-_ ].*)?$/i, "")
    .trim();
}

function matchReferenceImages(product, referenceFiles, mode) {
  if (!referenceFiles.length) return [];
  if (mode === "common" || (mode === "auto" && referenceFiles.length === 1)) return referenceFiles;
  return referenceFiles.filter((file) => referenceProductName(file.name) === product);
}

const PRESET_LABELS = {
  original: "原始 Markdown",
  replace: "产品与品牌替换",
  composition: "仅参考构图",
  custom: "自定义模板"
};

function splitForbiddenText(value) {
  return value.split(/[、,，;；\n]+/).map((item) => item.trim()).filter(Boolean);
}

function forbiddenTextForProduct(product, settings) {
  const words = splitForbiddenText(settings.forbiddenReferenceText || "");
  for (const line of (settings.productTextRules || "").split(/\r?\n/)) {
    const separator = line.search(/[=＝:：]/);
    if (separator < 0) continue;
    const target = line.slice(0, separator).trim();
    if (target !== product) continue;
    words.push(...splitForbiddenText(line.slice(separator + 1)));
  }
  return Array.from(new Set(words));
}

function textReplacementRequirement(product, forbiddenWords) {
  if (!forbiddenWords.length) return "";
  const listed = forbiddenWords.map((word) => `【${word}】`).join("、");
  return `参考图禁用文字：${listed}。必须彻底删除这些旧产品名、旧品牌或旧文案，不得在生成图片的任何位置保留、变形、谐写、缩写或部分沿用。目标产品名称统一为【${product}】，产品包装、品牌Logo、标签和文字仅以最后一张产品图为准。输出前逐处检查，确保禁用文字完全不存在。`;
}

function disclaimerConfig(settings) {
  return {
    enabled: settings.disclaimerEnabled === true && Boolean(settings.disclaimerText),
    mode: settings.disclaimerMode || "overlay",
    position: settings.disclaimerPosition || "bottom-center",
    layout: settings.disclaimerLayout || "footer",
    fontPercent: settings.disclaimerFontPercent || 1.2,
    opacity: settings.disclaimerOpacity || 65,
    background: settings.disclaimerBackground !== false,
    text: settings.disclaimerText || ""
  };
}

function disclaimerPromptRequirement(config) {
  if (!config.enabled) return "";
  const position = {
    "bottom-center": "画面底部居中",
    "bottom-right": "画面右下角",
    "bottom-left": "画面左下角"
  }[config.position] || "画面底部";
  return `请在${position}的不重要安全区域加入以下小号声明文字，字号要小、低调、不显眼，但仍可辨认；不得遮挡产品主体、品牌Logo、产品名称、卖点文案或其他重要元素。声明必须逐字准确，不得改写、遗漏或产生错别字：\n【${config.text}】`;
}

function replaceTemplateVariables(template, variables) {
  return template.replace(/\{(产品名|品牌名|指定文案|禁用文字|文字替换要求|Markdown提示词|参考图数量|产品图序号|生成数量)\}/g, (_, key) => variables[key] ?? "");
}

function buildTaskPrompt(markdownPrompt, product, referenceCount, expected, settings) {
  const productImageIndex = referenceCount + 1;
  const forbiddenWords = forbiddenTextForProduct(product, settings);
  const replacementRequirement = textReplacementRequirement(product, forbiddenWords);
  const variables = {
    产品名: product,
    品牌名: settings.brandName || "以产品图包装为准",
    指定文案: settings.specifiedCopy || "无额外指定文案",
    Markdown提示词: markdownPrompt,
    参考图数量: String(referenceCount),
    产品图序号: String(productImageIndex),
    生成数量: String(expected),
    禁用文字: forbiddenWords.join("、"),
    文字替换要求: replacementRequirement
  };
  let prompt = markdownPrompt;

  if (settings.promptPreset === "replace") {
    prompt = `附件中的图1至图${referenceCount}为参考图，图${productImageIndex}为唯一产品依据。\n` +
      `保持参考图的画面比例、镜头视角、主体位置、背景结构和光影关系，将参考图中的原产品及原品牌完整替换为图${productImageIndex}中的${product}。\n` +
      `产品包装造型、颜色、品牌Logo和标签内容必须以图${productImageIndex}为准，不得混用参考图中的品牌、文字或包装元素。\n` +
      `品牌要求：${variables.品牌名}。指定文案：${variables.指定文案}。请生成${expected}张独立图片。\n\n${markdownPrompt}`;
  } else if (settings.promptPreset === "composition") {
    prompt = `附件中的图1至图${referenceCount}仅用于参考构图，图${productImageIndex}为唯一产品依据。\n` +
      `只参考构图关系、视角、景别、留白、背景布局和光影氛围，不复制参考图中的产品、品牌、Logo、文字、人物身份或独特素材。\n` +
      `以图${productImageIndex}中的${product}为唯一商品主体，重新设计原创电商图片。品牌要求：${variables.品牌名}。指定文案：${variables.指定文案}。请生成${expected}张独立图片。\n\n${markdownPrompt}`;
  } else if (settings.promptPreset === "custom") {
    prompt = replaceTemplateVariables(settings.customTemplate, variables).trim();
  }

  const fixed = settings.fixedPrompt;
  if (fixed) {
    if (settings.fixedPosition === "replace") prompt = fixed;
    else if (settings.fixedPosition === "prepend") prompt = `${fixed}\n\n${prompt}`.trim();
    else prompt = `${prompt}\n\n${fixed}`.trim();
  }
  if (replacementRequirement && !prompt.includes(replacementRequirement)) {
    prompt = `${prompt}\n\n${replacementRequirement}`.trim();
  }
  const disclaimer = disclaimerConfig(settings);
  if (disclaimer.enabled && ["prompt", "both"].includes(disclaimer.mode)) {
    prompt = `${prompt}\n\n${disclaimerPromptRequirement(disclaimer)}`.trim();
  }
  return prompt.trim();
}

function extractPrompt(text) {
  const fenced = text.match(/```(?:text|txt)?\s*([\s\S]*?)```/i);
  let prompt = (fenced ? fenced[1] : text).trim();
  const removableEndingSentences = [
    "每完成一张都重新读取对应提示词，不得沿用上一张的产品位置、文字位置或背景构图；输出前逐张核对产品名称、包装和全部指定中文。",
    "请按模板编号【01、02、03、04、05、06、07、08、09】依次生成9张独立图片。"
  ];

  // 按顺序仅删除末尾完全一致的固定句子，避免影响其他格式或正文。
  for (const sentence of removableEndingSentences) {
    if (prompt.endsWith(sentence)) {
      prompt = prompt.slice(0, -sentence.length).trimEnd();
    }
  }
  return prompt;
}

function expectedCount(prompt) {
  const patterns = [
    /生成\s*([一二三四五六七八九十\d]+)\s*张/,
    /([一二三四五六七八九十\d]+)\s*张图片/,
    /模板编号为【([^】]+)】/
  ];
  const chinese = { 一:1, 二:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9, 十:10 };
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (!match) continue;
    if (pattern.source.includes("模板编号")) return match[1].split(/[、,，]/).filter(Boolean).length;
    if (/^\d+$/.test(match[1])) return Number(match[1]);
    if (chinese[match[1]]) return chinese[match[1]];
  }
  return 1;
}

async function digest(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function completedIds() {
  const saved = await chrome.storage.local.get("completedAutomationTasks");
  return new Set(saved.completedAutomationTasks || []);
}

function paddedNumber(value) {
  return String(value).padStart(3, "0");
}

async function makeTaskId(baseId, startNumber) {
  return digest(`${baseId}|start:${startNumber}`);
}

async function rememberTask(task) {
  const ids = await completedIds();
  ids.add(task.id);
  const saved = await chrome.storage.local.get("automationHistory");
  const history = saved.automationHistory || [];
  history.push({
    id: task.id,
    product: task.product,
    promptFile: task.promptFile,
    promptPreset: task.promptPreset || "original",
    referenceFiles: (task.referenceImages || []).map((file) => file.name),
    forbiddenWords: task.forbiddenWords || [],
    disclaimer: task.disclaimer || null,
    count: task.expected,
    startNumber: task.startNumber,
    endNumber: task.endNumber,
    completedAt: new Date().toISOString()
  });
  await chrome.storage.local.set({
    completedAutomationTasks: Array.from(ids),
    automationHistory: history.slice(-1000)
  });
}

function render() {
  taskBody.innerHTML = "";
  const firstProductRows = new Set();
  tasks.forEach((task, index) => {
    const row = document.createElement("tr");
    const statusClass =
      task.status === "已完成" ? "status-complete" :
      task.status === "执行中" ? "status-running" :
      task.status?.startsWith("失败") ? "status-error" : "";
    const firstForProduct = !firstProductRows.has(task.product);
    firstProductRows.add(task.product);
    row.innerHTML = `<td>${index + 1}</td><td></td><td></td><td></td><td>${task.expected}</td><td></td><td class="file-range"></td><td class="${statusClass}"></td>`;
    row.children[1].textContent = task.product;
    row.children[2].textContent = task.promptFile;
    row.children[3].textContent = `${task.referenceImages?.length || 0}张 / ${PRESET_LABELS[task.promptPreset] || "原始 Markdown"}` +
      (task.forbiddenWords?.length ? ` / 禁词:${task.forbiddenWords.join("、")}` : "") +
      (task.disclaimer?.enabled ? " / 声明" : "");
    if (firstForProduct) {
      const input = document.createElement("input");
      input.className = "start-number";
      input.type = "number";
      input.min = "1";
      input.max = "999999";
      input.value = task.startNumber;
      input.disabled = running;
      input.title = `设置 ${task.product} 的起始编号`;
      input.addEventListener("change", async () => {
        const value = Math.max(1, Math.floor(Number(input.value) || 1));
        await setProductStartNumber(task.product, value);
      });
      row.children[5].appendChild(input);
    } else {
      const automatic = document.createElement("span");
      automatic.className = "auto-number";
      automatic.textContent = `自动 ${paddedNumber(task.startNumber)}`;
      row.children[5].appendChild(automatic);
    }
    row.children[6].textContent =
      `${task.product}_${paddedNumber(task.startNumber)}–${paddedNumber(task.endNumber)}`;
    row.children[7].textContent = task.status;
    taskBody.appendChild(row);
  });
  const pending = tasks.filter((task) => task.status !== "已完成").length;
  summary.textContent = `共 ${tasks.length} 个任务，待执行 ${pending} 个。`;
  startButton.disabled = !tasks.length || !pending || running;
}

async function setProductStartNumber(product, startNumber) {
  const saved = await chrome.storage.local.get("productStartNumbers");
  const settings = saved.productStartNumbers || {};
  settings[product] = startNumber;
  await chrome.storage.local.set({ productStartNumbers: settings });

  const done = await completedIds();
  let next = startNumber;
  for (const task of tasks.filter((item) => item.product === product)) {
    task.startNumber = next;
    task.endNumber = next + task.expected - 1;
    task.id = await makeTaskId(task.baseId, task.startNumber);
    task.status = done.has(task.id) ? "已完成" : "待执行";
    next = task.endNumber + 1;
  }
  render();
  await saveQueue();
  log(`${product} 起始编号已设为 ${paddedNumber(startNumber)}。`);
}

function folderGroups(files) {
  const groups = new Map();
  const imagePattern = /\.(png|jpe?g|webp)$/i;
  for (const file of files) {
    const parts = String(file.webkitRelativePath || file.name).split("/").filter(Boolean);
    const filename = parts.at(-1) || file.name;
    const categoryIndex = parts.findIndex((part) => ["产品图", "参考图", "提示词"].includes(part));
    let product = categoryIndex > 0 ? parts[categoryIndex - 1] : "";
    if (!product && /^卖点\.txt$/i.test(filename) && parts.length >= 2) product = parts.at(-2);
    if (!product) continue;
    if (!groups.has(product)) groups.set(product, { product, images: [], references: [], prompts: [], sellingPointFile: null });
    const group = groups.get(product);
    const category = categoryIndex >= 0 ? parts[categoryIndex] : "";
    if (category === "产品图" && imagePattern.test(filename)) group.images.push(file);
    else if (category === "参考图" && imagePattern.test(filename)) group.references.push(file);
    else if (category === "提示词" && /\.(md|txt)$/i.test(filename)) group.prompts.push(file);
    else if (/^卖点\.txt$/i.test(filename)) group.sellingPointFile = file;
  }
  return Array.from(groups.values());
}

function chunkFiles(files, size) {
  if (!files.length) return [[]];
  const chunks = [];
  for (let index = 0; index < files.length; index += size) chunks.push(files.slice(index, index + size));
  return chunks;
}

function referenceStem(file) {
  return file.name.replace(/\.[^.]+$/, "").replace(/^(?:参考图|构图参考|场景参考)[-_ ]*/i, "");
}

function sellingPointsForReferences(text, references) {
  if (!text.trim()) return "";
  const mapped = new Map();
  const common = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.search(/[=＝:：]/);
    if (separator < 0) common.push(line);
    else mapped.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const rows = [];
  references.forEach((file, index) => {
    const stem = referenceStem(file);
    const points = mapped.get(stem) || mapped.get(String(Number(stem))) || mapped.get(String(index + 1).padStart(2, "0"));
    if (points) rows.push(`参考图${index + 1}营销卖点：${points}`);
  });
  if (common.length) rows.push(`本批通用营销卖点：${common.join("；")}`);
  return rows.join("\n");
}

function batchReferenceRequirement(references, productImageIndex, sellingPoints, oneToOne) {
  if (!references.length) return "";
  let requirement = `本批附件图1至图${references.length}是按顺序排列的参考图，图${productImageIndex}是唯一产品图。`;
  if (oneToOne) {
    requirement += ` 必须生成${references.length}张独立图片：第1张输出对应参考图1，第2张输出对应参考图2，依此类推。每张输出分别保留对应参考图的构图层级、营销卖点数量、卖点含义和排版位置；只删除旧产品名和旧品牌，不得把营销卖点一起删除。`;
  }
  if (sellingPoints) requirement += `\n${sellingPoints}\n以上营销卖点必须逐条体现，不得遗漏。`;
  return requirement;
}

async function buildTasks() {
  const folderFiles = Array.from(taskFolderInput.files);
  const images = Array.from(imageInput.files);
  const references = Array.from(referenceInput.files);
  const prompts = Array.from(promptInput.files);
  if (!folderFiles.length && !images.length) {
    log("请选择产品图片，或者选择完整任务文件夹。");
    return;
  }
  if (!boundTabId) {
    log("请先在上方选择并绑定生图页面。");
    return;
  }
  try {
    const bound = await chrome.tabs.get(boundTabId);
    if (!isAiPage(bound.url)) throw new Error();
  } catch {
    log("绑定的生图标签页已失效，请重新绑定后再生成任务列表。");
    return;
  }

  const promptSettings = managerSettings();
  if (promptSettings.promptPreset === "custom" && !promptSettings.customTemplate.trim()) {
    log("已选择自定义模板，但模板内容为空。");
    return;
  }
  const done = await completedIds();
  const savedStarts = await chrome.storage.local.get("productStartNumbers");
  const productStarts = savedStarts.productStartNumbers || {};
  const nextNumber = new Map();
  tasks = [];
  const maxReferencesPerBatch = promptSettings.maxAttachments - 1;

  async function addProductTasks({ product, image, referenceFiles, promptFiles, sellingPointsText = "", folderMode = false }) {
    if (!image) return log(`未匹配：${product} 找不到产品图片。`);
    if (!promptFiles.length && promptSettings.promptPreset === "original" && !promptSettings.fixedPrompt) {
      return log(`未匹配：${product} 没有提示词；请提供 Markdown、选择预设或填写固定提示词。`);
    }
    if (["replace", "composition"].includes(promptSettings.promptPreset) && !referenceFiles.length) {
      return log(`未匹配参考图：${product} 当前预设需要至少一张参考图。`);
    }
    const orderedReferences = [...referenceFiles].sort((a, b) =>
      (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, "zh-CN", { numeric: true })
    );
    const batches = chunkFiles(orderedReferences, maxReferencesPerBatch);
    const sources = promptFiles.length
      ? promptFiles
      : [{ name: "内置预设（无 Markdown）", text: async () => "" }];
    for (const promptFile of sources) {
      const rawPromptFile = await promptFile.text();
      const markdownPrompt = extractPrompt(rawPromptFile);
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        const referenceImages = batches[batchIndex];
        const oneToOne = folderMode && promptSettings.folderOneToOne && referenceImages.length > 0;
        const expected = oneToOne
          ? referenceImages.length
          : promptFiles.length ? expectedCount(rawPromptFile) : promptSettings.presetCount;
        const sellingPoints = sellingPointsForReferences(sellingPointsText, referenceImages);
        const forbiddenWords = forbiddenTextForProduct(product, promptSettings);
        const disclaimer = disclaimerConfig(promptSettings);
        let prompt = buildTaskPrompt(markdownPrompt, product, referenceImages.length, expected, promptSettings);
        const batchRequirement = batchReferenceRequirement(referenceImages, referenceImages.length + 1, sellingPoints, oneToOne);
        if (batchRequirement) prompt = `${prompt}\n\n${batchRequirement}`.trim();
        if (!prompt) {
          log(`提示词为空：${product} / ${promptFile.name}，已跳过。`);
          continue;
        }
        const batchLabel = batches.length > 1 ? `第${batchIndex + 1}/${batches.length}批` : "";
        const referenceSignature = referenceImages.map((file) => `${file.name}:${file.size}:${file.lastModified}`).join("|");
        const baseId = await digest(`${product}|${image.name}|${image.size}|${referenceSignature}|${promptSettings.promptPreset}|${prompt}|${JSON.stringify(disclaimer)}`);
        const startNumber = nextNumber.get(product) || Math.max(1, Number(productStarts[product]) || 1);
        const endNumber = startNumber + expected - 1;
        const id = await makeTaskId(baseId, startNumber);
        tasks.push({
          id, baseId, product, image, referenceImages, prompt, forbiddenWords, disclaimer,
          promptPreset: promptSettings.promptPreset,
          promptFile: `${promptFile.name}${batchLabel ? `（${batchLabel}）` : ""}`,
          batchIndex: batchIndex + 1,
          batchTotal: batches.length,
          expected, startNumber, endNumber,
          status: done.has(id) ? "已完成" : "待执行",
          targetTabId: boundTabId
        });
        nextNumber.set(product, endNumber + 1);
        log(`已建立：${product}${batchLabel ? ` ${batchLabel}` : ""}，参考图 ${referenceImages.length} 张，产品图 1 张，预期输出 ${expected} 张。`);
      }
    }
  }

  if (folderFiles.length) {
    const groups = folderGroups(folderFiles);
    if (!groups.length) {
      log("任务文件夹中没有识别到“产品名/产品图、参考图、提示词”目录结构。");
      return;
    }
    for (const group of groups) {
      if (group.images.length !== 1) {
        log(`目录错误：${group.product}/产品图 中需要且只能有1张图片，当前 ${group.images.length} 张。`);
        continue;
      }
      const sellingPointsText = group.sellingPointFile ? await group.sellingPointFile.text() : "";
      await addProductTasks({
        product: group.product,
        image: group.images[0],
        referenceFiles: group.references,
        promptFiles: group.prompts,
        sellingPointsText,
        folderMode: true
      });
    }
  } else {
    const imageEntries = images.map((file) => ({ product: productName(file.name), file }));
    const sources = prompts.length
      ? prompts.map((file) => ({ file }))
      : imageEntries.map((entry) => ({ file: null, directMatch: { image: entry.file, matchedProduct: entry.product, mode: "exact" } }));
    for (const source of sources) {
      const promptProduct = source.directMatch?.matchedProduct || productName(source.file.name);
      const match = source.directMatch || matchProductImage(promptProduct, imageEntries);
      if (match?.ambiguous) {
        log(`匹配冲突：${source.file.name} 同时匹配 ${match.ambiguous.join("、")}。`);
        continue;
      }
      if (!match?.image) {
        log(`未匹配：${source.file.name} 找不到同名产品图片（识别产品名：${promptProduct}）。`);
        continue;
      }
      const product = match.matchedProduct;
      await addProductTasks({
        product,
        image: match.image,
        referenceFiles: matchReferenceImages(product, references, promptSettings.referenceMode),
        promptFiles: source.file ? [source.file] : []
      });
    }
  }
  render();
  await saveQueue();
  log(`任务列表已生成，成功匹配 ${tasks.length} 项。`);
}

async function findAiTab(preferredId) {
  const tabId = Number(preferredId || boundTabId);
  if (!tabId) throw new Error("尚未绑定生图标签页，请在管理器顶部手动绑定");
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isAiPage(tab.url)) throw new Error();
    return tab;
  } catch {
    throw new Error(`绑定的生图标签页（ID ${tabId}）已关闭或失效；任务已停止，不会切换到其他页面`);
  }
}

async function waitForPageConnection(tabId, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") {
        const state = await chrome.tabs.sendMessage(tabId, { type: "GPT_AUTOMATION_STATE" });
        if (state?.ok) return state;
      }
    } catch {
      // 页面刷新期间内容脚本尚未注入。
    }
    await sleep(1000);
  }
  throw new Error("页面刷新后60秒内未能重新连接");
}

function newConversationUrl(url) {
  const parsed = new URL(url);
  if (parsed.hostname === "chatgpt.com" || parsed.hostname === "chat.openai.com") {
    // 自定义 GPT 的对话地址为 /g/{GPT标识}/c/{对话标识}，新对话需保留 /g/{GPT标识}。
    const customGpt = parsed.pathname.match(/^(\/g\/[^/]+)/);
    return `${parsed.origin}${customGpt ? customGpt[1] : "/"}`;
  }
  if (parsed.hostname === "www.doubao.com") return `${parsed.origin}/chat/`;
  throw new Error("当前绑定页面不支持自动新建对话");
}

async function openFreshConversation(tab) {
  const url = newConversationUrl(tab.url);
  log(`正在打开新对话：${url}`);
  await chrome.tabs.update(tab.id, { url });
  await waitForPageConnection(tab.id);
  // 页面连接成功后稍候片刻，让输入框和上传控件完成初始化。
  await sleep(1200);
  return chrome.tabs.get(tab.id);
}

async function messageTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    throw new Error("无法连接 AI 对话页面，请刷新该页面后重试");
  }
}

async function waitForAllImages(tabId, baselineKeys, expected, task) {
  const settings = managerSettings();
  const pollMs = settings.pollSeconds * 1000;
  const timeoutMs = settings.timeoutMinutes * 60 * 1000;
  const refreshMs = settings.refreshMinutes * 60 * 1000;
  const runtime = task.runtime ||= {};
  runtime.stage = "waiting";
  runtime.tabId = tabId;
  runtime.baselineKeys = Array.from(baselineKeys);
  runtime.waitStartedAt ||= Date.now();
  runtime.lastProgressAt ||= Date.now();
  runtime.refreshCount ||= 0;
  runtime.lastCount ||= 0;
  runtime.lastSignature ||= "";
  runtime.observedKeys ||= [];
  let stable = runtime.stable || 0;
  await saveQueue();

  while (!paused && Date.now() - runtime.waitStartedAt < timeoutMs) {
    await sleep(pollMs);
    let state;
    try {
      state = await messageTab(tabId, { type: "GPT_AUTOMATION_STATE" });
    } catch {
      log("页面连接暂时中断，等待内容脚本重新连接。");
      state = await waitForPageConnection(tabId);
    }
    const fresh = (state.images || []).filter((image) => !baselineKeys.has(image.key));
    const signature = fresh.map((image) => image.key).join("|");
    const observed = new Set(runtime.observedKeys);
    const newlyObserved = fresh.filter((image) => !observed.has(image.key));

    if (newlyObserved.length > 0) {
      for (const image of newlyObserved) observed.add(image.key);
      runtime.observedKeys = Array.from(observed);
      runtime.lastProgressAt = Date.now();
      runtime.lastCount = Math.max(runtime.lastCount, fresh.length);
      runtime.refreshCount = 0;
      await saveQueue();
    }

    if (!state.generating && fresh.length >= expected && signature === runtime.lastSignature) stable += 1;
    else stable = 0;
    runtime.lastSignature = signature;
    runtime.stable = stable;
    log(`检测：已出现 ${fresh.length}/${expected} 张，生成中=${state.generating ? "是" : "否"}，稳定=${stable}/${settings.stableRounds}`);

    if (!state.generating && fresh.length >= expected && stable >= settings.stableRounds) {
      return fresh.slice(0, expected).map((image, index) => ({ ...image, order: index + 1 }));
    }

    const noProgressFor = Date.now() - runtime.lastProgressAt;
    if (
      settings.autoRefresh &&
      refreshMs > 0 &&
      noProgressFor >= refreshMs
    ) {
      if (runtime.refreshCount >= settings.maxRefreshes) {
        throw new Error(`连续无进展，已达到自动刷新上限 ${settings.maxRefreshes} 次`);
      }
      runtime.refreshCount += 1;
      runtime.lastProgressAt = Date.now();
      runtime.stable = 0;
      await saveQueue();
      log(`连续 ${settings.refreshMinutes} 分钟没有新图片，正在自动刷新页面（${runtime.refreshCount}/${settings.maxRefreshes}）。`);
      await chrome.tabs.reload(tabId);
      await waitForPageConnection(tabId);
      log("页面已重新连接，继续等待当前任务；不会重新发送提示词。");
    }
  }
  if (paused) throw new Error("任务已暂停");
  throw new Error(`等待超时，未确认全部 ${expected} 张图片生成完成`);
}

function wrapCanvasText(context, text, maxWidth) {
  const lines = [];
  for (const paragraph of String(text).split(/\r?\n/)) {
    let line = "";
    for (const character of paragraph) {
      const candidate = line + character;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = character;
      } else {
        line = candidate;
      }
    }
    lines.push(line || " ");
  }
  return lines;
}

function canvasToBlob(canvas, type = "image/png", quality = 0.96) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("声明图片编码失败")), type, quality);
  });
}

async function overlayDisclaimer(imageUrl, config) {
  const response = await fetch(imageUrl, { credentials: "include" });
  if (!response.ok) throw new Error(`读取原图失败（HTTP ${response.status}）`);
  const sourceBlob = await response.blob();
  const bitmap = await createImageBitmap(sourceBlob);
  try {
    const fontSize = Math.max(10, Math.round(bitmap.width * config.fontPercent / 100));
    const lineHeight = Math.ceil(fontSize * 1.35);
    const padding = Math.max(12, Math.round(bitmap.width * 0.02));
    const scratch = document.createElement("canvas");
    const scratchContext = scratch.getContext("2d");
    scratchContext.font = `${fontSize}px "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`;
    const lines = wrapCanvasText(scratchContext, config.text, bitmap.width - padding * 2);
    const blockHeight = lines.length * lineHeight;
    const footerHeight = config.layout === "footer" ? blockHeight + padding * 2 : 0;
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height + footerHeight;
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);

    let top = config.layout === "footer"
      ? bitmap.height + padding
      : bitmap.height - padding - blockHeight;
    if (config.layout === "footer") {
      context.fillStyle = "#f5f5f5";
      context.fillRect(0, bitmap.height, canvas.width, footerHeight);
    } else if (config.background) {
      context.fillStyle = "rgba(255,255,255,0.58)";
      context.fillRect(padding / 2, top - padding / 2, canvas.width - padding, blockHeight + padding);
    }

    context.font = `${fontSize}px "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`;
    context.textBaseline = "top";
    context.fillStyle = `rgba(45,45,45,${config.opacity / 100})`;
    const align = config.position.endsWith("right") ? "right" : config.position.endsWith("left") ? "left" : "center";
    context.textAlign = align;
    const x = align === "right" ? canvas.width - padding : align === "left" ? padding : canvas.width / 2;
    for (const line of lines) {
      context.fillText(line, x, top, canvas.width - padding * 2);
      top += lineHeight;
    }
    const outputBlob = await canvasToBlob(canvas, "image/png");
    const objectUrl = URL.createObjectURL(outputBlob);
    return { url: objectUrl, cleanup: () => URL.revokeObjectURL(objectUrl) };
  } finally {
    bitmap.close();
  }
}

async function downloadTask(task, images) {
  const disclaimer = task.disclaimer || { enabled: false };
  const disclaimerSuffix = disclaimer.enabled ? await digest(JSON.stringify(disclaimer)) : "";
  const numberedImages = images.map((image, index) => ({
    ...image,
    order: task.startNumber + index,
    historyKey: disclaimerSuffix ? `${image.key}|disclaimer:${disclaimerSuffix}` : image.key
  }));
  const filtered = await chrome.runtime.sendMessage({
    type: "GPT_IMAGE_FILTER_HISTORY",
    images: numberedImages
  });
  const pendingImages = (filtered.items || numberedImages).filter((image) => !image.downloaded);
  if (pendingImages.length !== numberedImages.length) {
    log(`恢复下载时已跳过 ${numberedImages.length - pendingImages.length} 张有历史记录的图片。`);
  }
  for (const image of pendingImages) {
    if (image.downloadMethod === "doubao-save") {
      const filenameBase =
        `豆包图片/${task.product}_${paddedNumber(image.order)}`;
      const armed = await chrome.runtime.sendMessage({
        type: "GPT_NATIVE_DOWNLOAD_ARM",
        filenameBase,
        key: image.historyKey
      });
      if (!armed?.ok) throw new Error(armed?.error || "无法准备豆包原图保存");
      const tab = await findAiTab();
      const saved = await messageTab(tab.id, { type: "GPT_DOUBAO_SAVE", key: image.key });
      if (!saved?.ok) throw new Error(saved?.error || "豆包原图保存失败");

      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        await sleep(500);
        const status = await chrome.runtime.sendMessage({
          type: "GPT_NATIVE_DOWNLOAD_STATUS",
          token: armed.token
        });
        if (status.job?.state === "complete") break;
        if (status.job?.state === "error") throw new Error(status.job.error);
      }
      const finalStatus = await chrome.runtime.sendMessage({
        type: "GPT_NATIVE_DOWNLOAD_STATUS",
        token: armed.token
      });
      if (finalStatus.job?.state !== "complete") throw new Error("等待豆包原图保存超时");
    } else {
      let prepared = null;
      if (disclaimer.enabled && ["overlay", "both"].includes(disclaimer.mode)) {
        log(`正在为 ${task.product}_${paddedNumber(image.order)} 精确叠加图片声明。`);
        prepared = await overlayDisclaimer(image.url, disclaimer);
      }
      const result = await chrome.runtime.sendMessage({
        type: "GPT_IMAGE_DOWNLOAD",
        images: [{ ...image, url: prepared?.url || image.url }],
        options: {
          folder: image.platform === "doubao" ? "豆包图片" : "ChatGPT图片",
          prefix: task.product
        }
      });
      if (!result?.jobId) throw new Error("无法启动下载");
      try {
        while (true) {
          await sleep(500);
          const status = await chrome.runtime.sendMessage({ type: "GPT_IMAGE_STATUS", jobId: result.jobId });
          if (status.job?.state === "complete") break;
          if (status.job?.state === "error") throw new Error(status.job.error);
        }
      } finally {
        prepared?.cleanup();
      }
    }
  }
}

async function run() {
  if (running) return;
  running = true;
  paused = false;
  startButton.disabled = true;
  pauseButton.disabled = false;
  stateBadge.textContent = "运行中";

  try {
    for (const task of tasks) {
      if (paused) break;
      if (task.status === "已完成") {
        log(`跳过历史任务：${task.product} / ${task.promptFile}`);
        continue;
      }
      task.status = "执行中";
      render();
      await saveQueue();
      log(`开始：${task.product}，预期 ${task.expected} 张。`);

      try {
        const tab = await findAiTab(task.runtime?.tabId || task.targetTabId);
        let images;
        if (task.runtime?.stage === "sending") {
          throw new Error("任务在发送阶段被中断，已停止以避免重复发送，请检查页面后重新建立任务");
        }
        if (task.runtime?.stage?.startsWith("downloading") && task.runtime.readyImages?.length) {
          images = task.runtime.readyImages;
          log("已恢复下载阶段，将跳过有下载历史的图片，不会重新发送提示词。");
        } else {
          let baseline;
          if (task.runtime?.stage?.startsWith("waiting") && task.runtime.baselineKeys?.length) {
            baseline = new Set(task.runtime.baselineKeys);
            log("已恢复等待中的任务，继续检测图片，不会重新发送提示词。");
            await waitForPageConnection(tab.id);
          } else {
            if (managerSettings().newChatEachTask) {
              task.runtime = {
                stage: "opening-conversation",
                tabId: tab.id
              };
              await saveQueue();
              await openFreshConversation(tab);
              log("新对话已就绪，准备上传产品图和提示词。");
            }
            const before = await messageTab(tab.id, { type: "GPT_AUTOMATION_STATE" });
            baseline = new Set((before.images || []).map((image) => image.key));
            let outgoingPrompt = task.prompt;
            if (
              before.platform === "doubao" &&
              task.disclaimer?.enabled &&
              task.disclaimer.mode === "overlay"
            ) {
              outgoingPrompt = `${outgoingPrompt}\n\n${disclaimerPromptRequirement(task.disclaimer)}`.trim();
              log("豆包原生保存无法下载后叠字，本任务已自动改为在生图提示词中添加声明。");
            }
            task.runtime = {
              stage: "sending",
              tabId: tab.id,
              baselineKeys: Array.from(baseline),
              waitStartedAt: Date.now(),
              lastProgressAt: Date.now(),
              refreshCount: 0,
              lastCount: 0,
              lastSignature: ""
            };
            await saveQueue();
            const uploadFiles = [...(task.referenceImages || []), task.image];
            const uploadImages = await Promise.all(uploadFiles.map(async (file) => ({
              dataUrl: await fileToDataUrl(file),
              name: file.name,
              type: file.type
            })));
            const sent = await messageTab(tab.id, {
              type: "GPT_AUTOMATION_SEND",
              images: uploadImages,
              prompt: outgoingPrompt
            });
            if (!sent?.ok) throw new Error(sent?.error || "发送失败");
            task.runtime.stage = "waiting";
            await saveQueue();
            log(`${uploadImages.length} 张附件和提示词已发送，开始轮询。`);
          }

          images = await waitForAllImages(tab.id, baseline, task.expected, task);
          task.runtime.stage = "downloading";
          task.runtime.readyImages = images;
          await saveQueue();
        }
        log(`全部 ${images.length} 张已出现，现在开始下载。`);
        await downloadTask(task, images);
        await rememberTask(task);
        task.status = "已完成";
        task.runtime = { stage: "complete" };
        await saveQueue();
        log(
          `完成：${task.product}，文件名 ${task.product}_${paddedNumber(task.startNumber)}–` +
          `${paddedNumber(task.endNumber)}。`
        );
      } catch (error) {
        task.status = `失败：${error.message}`;
        task.runtime ||= {};
        task.runtime.stage = task.runtime.stage?.startsWith("waiting")
          ? "waiting-paused"
          : task.runtime.stage?.startsWith("downloading")
            ? "downloading-paused"
            : "paused";
        await saveQueue();
        log(task.status);
        paused = true;
      }
      render();
    }
  } catch (error) {
    log(`无法开始：${error.message}`);
  } finally {
    running = false;
    pauseButton.disabled = true;
    startButton.disabled = paused ? false : !tasks.some((task) => task.status !== "已完成");
    stateBadge.textContent = paused ? "已暂停" : "已结束";
  }
}

$("#build").addEventListener("click", buildTasks);
$("#refresh-tabs").addEventListener("click", () => refreshTabList());
$("#bind-tab").addEventListener("click", bindSelectedTab);
startButton.addEventListener("click", run);
pauseButton.addEventListener("click", () => {
  paused = true;
  stateBadge.textContent = "正在暂停";
  log("收到暂停指令，将停止进入下一步。");
  saveQueue();
});
$("#clear-history").addEventListener("click", async () => {
  await chrome.storage.local.remove(["completedAutomationTasks", "automationHistory", "downloadedImageKeys"]);
  tasks.forEach((task) => { task.status = "待执行"; });
  tasks.forEach((task) => { task.runtime = null; });
  await saveQueue();
  render();
  log("全部任务历史和图片下载历史已清空。");
});

for (const input of document.querySelectorAll(".settings input, .prompt-builder input, .prompt-builder select, .prompt-builder textarea")) {
  input.addEventListener("change", saveManagerSettings);
}
$("#prompt-preset").addEventListener("change", updatePresetVisibility);

async function initializeManager() {
  await restoreManagerSettings();
  const savedBinding = await chrome.storage.local.get("managerTargetTabId");
  boundTabId = Number(savedBinding.managerTargetTabId) || null;
  await refreshTabList(boundTabId);
  tasks = await loadQueue();
  if (tasks.length) {
    render();
    log(`已从本地恢复 ${tasks.length} 个任务。`);
    const resumable = tasks.find(
      (task) =>
        task.status === "执行中" &&
        (task.runtime?.stage?.startsWith("waiting") ||
          task.runtime?.stage?.startsWith("downloading"))
    );
    if (resumable) {
      log("检测到刷新前未完成的任务，即将自动恢复。");
      setTimeout(run, 500);
    }
  }
}

initializeManager().catch((error) => log(`恢复任务失败：${error.message}`));
