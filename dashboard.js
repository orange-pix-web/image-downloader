const $ = (selector) => document.querySelector(selector);
const imageInput = $("#images");
const promptInput = $("#prompts");
const taskBody = $("#tasks");
const summary = $("#summary");
const logEl = $("#log");
const startButton = $("#start");
const pauseButton = $("#pause");
const stateBadge = $("#run-state");

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
    maxRefreshes: Math.max(1, Number($("#max-refreshes").value) || 2)
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
}

function log(message) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function productName(filename) {
  return filename
    .replace(/\.[^.]+$/, "")
    // 支持 -生图提示词-v2、-生图提示词-第01组、_提示词_第二组等后缀。
    // 只从靠近文件名末尾的“提示词”标记开始删除，保留前面的完整产品名。
    .replace(/[-_ ]*(?:生图)?提示词(?:[-_ ].*)?$/i, "")
    .trim();
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
    row.innerHTML = `<td>${index + 1}</td><td></td><td></td><td>${task.expected}</td><td></td><td class="file-range"></td><td class="${statusClass}"></td>`;
    row.children[1].textContent = task.product;
    row.children[2].textContent = task.promptFile;
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
      row.children[4].appendChild(input);
    } else {
      const automatic = document.createElement("span");
      automatic.className = "auto-number";
      automatic.textContent = `自动 ${paddedNumber(task.startNumber)}`;
      row.children[4].appendChild(automatic);
    }
    row.children[5].textContent =
      `${task.product}_${paddedNumber(task.startNumber)}–${paddedNumber(task.endNumber)}`;
    row.children[6].textContent = task.status;
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

async function buildTasks() {
  const images = Array.from(imageInput.files);
  const prompts = Array.from(promptInput.files);
  if (!images.length || !prompts.length) {
    log("请选择产品图片和 Markdown 文件。");
    return;
  }

  const imageMap = new Map(images.map((file) => [productName(file.name), file]));
  const done = await completedIds();
  const savedStarts = await chrome.storage.local.get("productStartNumbers");
  const productStarts = savedStarts.productStartNumbers || {};
  const nextNumber = new Map();
  tasks = [];

  for (const promptFile of prompts) {
    const product = productName(promptFile.name);
    const image = imageMap.get(product);
    if (!image) {
      log(`未匹配：${promptFile.name} 找不到同名产品图片（识别产品名：${product}）。`);
      continue;
    }
    const rawPromptFile = await promptFile.text();
    const prompt = extractPrompt(rawPromptFile);
    const baseId = await digest(`${product}|${image.name}|${image.size}|${prompt}`);
    const startNumber = nextNumber.get(product) || Math.max(1, Number(productStarts[product]) || 1);
    const expected = expectedCount(rawPromptFile);
    const endNumber = startNumber + expected - 1;
    const id = await makeTaskId(baseId, startNumber);
    tasks.push({
      id, baseId, product, image, prompt,
      promptFile: promptFile.name,
      // 在清理固定结尾句前识别数量，避免删除文案影响预期图片数。
      expected,
      startNumber,
      endNumber,
      status: done.has(id) ? "已完成" : "待执行"
    });
    nextNumber.set(product, endNumber + 1);
  }
  render();
  await saveQueue();
  log(`任务列表已生成，成功匹配 ${tasks.length} 项。`);
}

async function findAiTab(preferredId) {
  if (!preferredId) {
    const saved = await chrome.storage.local.get("managerTargetTabId");
    preferredId = saved.managerTargetTabId;
  }
  if (preferredId) {
    try {
      const preferred = await chrome.tabs.get(preferredId);
      if (/^https:\/\/(chatgpt\.com|chat\.openai\.com|www\.doubao\.com)\//.test(preferred.url || "")) {
        return preferred;
      }
    } catch {
      // 标签页已关闭，继续查找其他可用页面。
    }
  }
  const tabs = await chrome.tabs.query({});
  const candidates = tabs.filter((tab) =>
    /^https:\/\/(chatgpt\.com|chat\.openai\.com|www\.doubao\.com)\//.test(tab.url || "")
  );
  if (!candidates.length) throw new Error("没有找到已打开的 ChatGPT 或豆包页面");
  return candidates.find((tab) => tab.active) || candidates[0];
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

async function downloadTask(task, images) {
  const numberedImages = images.map((image, index) => ({
    ...image,
    order: task.startNumber + index
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
        key: image.key
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
      const result = await chrome.runtime.sendMessage({
        type: "GPT_IMAGE_DOWNLOAD",
        images: [image],
        options: {
          folder: image.platform === "doubao" ? "豆包图片" : "ChatGPT图片",
          prefix: task.product
        }
      });
      if (!result?.jobId) throw new Error("无法启动下载");
      while (true) {
        await sleep(500);
        const status = await chrome.runtime.sendMessage({ type: "GPT_IMAGE_STATUS", jobId: result.jobId });
        if (status.job?.state === "complete") break;
        if (status.job?.state === "error") throw new Error(status.job.error);
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
        const tab = await findAiTab(task.runtime?.tabId);
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
            const before = await messageTab(tab.id, { type: "GPT_AUTOMATION_STATE" });
            baseline = new Set((before.images || []).map((image) => image.key));
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
            const dataUrl = await fileToDataUrl(task.image);
            const sent = await messageTab(tab.id, {
              type: "GPT_AUTOMATION_SEND",
              image: { dataUrl, name: task.image.name, type: task.image.type },
              prompt: task.prompt
            });
            if (!sent?.ok) throw new Error(sent?.error || "发送失败");
            task.runtime.stage = "waiting";
            await saveQueue();
            log("图片和提示词已发送，开始轮询。");
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

for (const input of document.querySelectorAll(".settings input")) {
  input.addEventListener("change", saveManagerSettings);
}

async function initializeManager() {
  await restoreManagerSettings();
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
