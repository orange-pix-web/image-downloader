const $ = (selector) => document.querySelector(selector);
const imageInput = $("#images");
const promptInput = $("#prompts");
const taskBody = $("#tasks");
const summary = $("#summary");
const logEl = $("#log");
const startButton = $("#start");
const pauseButton = $("#pause");
const stateBadge = $("#run-state");

if (window.top !== window || new URLSearchParams(location.search).has("embedded")) {
  document.body.classList.add("embedded");
}

let tasks = [];
let paused = false;
let running = false;

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
    .replace(/[-_ ]*(生图)?提示词(?:[-_ ]*v?\d+(?:\.\d+)*)?$/i, "")
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
  log(`任务列表已生成，成功匹配 ${tasks.length} 项。`);
}

async function findAiTab() {
  const tabs = await chrome.tabs.query({});
  const candidates = tabs.filter((tab) =>
    /^https:\/\/(chatgpt\.com|chat\.openai\.com|www\.doubao\.com)\//.test(tab.url || "")
  );
  if (!candidates.length) throw new Error("没有找到已打开的 ChatGPT 或豆包页面");
  return candidates.find((tab) => tab.active) || candidates[0];
}

async function messageTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    throw new Error("无法连接 AI 对话页面，请刷新该页面后重试");
  }
}

async function waitForAllImages(tabId, baselineKeys, expected) {
  const pollMs = Math.max(5, Number($("#poll-seconds").value) || 30) * 1000;
  const timeoutMs = Math.max(5, Number($("#timeout-minutes").value) || 40) * 60 * 1000;
  const stableNeeded = Math.max(1, Number($("#stable-rounds").value) || 2);
  const startedAt = Date.now();
  let stable = 0;
  let lastSignature = "";

  while (!paused && Date.now() - startedAt < timeoutMs) {
    await sleep(pollMs);
    const state = await messageTab(tabId, { type: "GPT_AUTOMATION_STATE" });
    const fresh = (state.images || []).filter((image) => !baselineKeys.has(image.key));
    const signature = fresh.map((image) => image.key).join("|");

    if (!state.generating && fresh.length >= expected && signature === lastSignature) stable += 1;
    else stable = 0;
    lastSignature = signature;
    log(`检测：已出现 ${fresh.length}/${expected} 张，生成中=${state.generating ? "是" : "否"}，稳定=${stable}/${stableNeeded}`);

    if (!state.generating && fresh.length >= expected && stable >= stableNeeded) {
      return fresh.slice(0, expected).map((image, index) => ({ ...image, order: index + 1 }));
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
  for (const image of numberedImages) {
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
    const tab = await findAiTab();
    for (const task of tasks) {
      if (paused) break;
      if (task.status === "已完成") {
        log(`跳过历史任务：${task.product} / ${task.promptFile}`);
        continue;
      }
      task.status = "执行中";
      render();
      log(`开始：${task.product}，预期 ${task.expected} 张。`);

      try {
        const before = await messageTab(tab.id, { type: "GPT_AUTOMATION_STATE" });
        const baseline = new Set((before.images || []).map((image) => image.key));
        const dataUrl = await fileToDataUrl(task.image);
        const sent = await messageTab(tab.id, {
          type: "GPT_AUTOMATION_SEND",
          image: { dataUrl, name: task.image.name, type: task.image.type },
          prompt: task.prompt
        });
        if (!sent?.ok) throw new Error(sent?.error || "发送失败");
        log("图片和提示词已发送，开始轮询。");

        const images = await waitForAllImages(tab.id, baseline, task.expected);
        log(`全部 ${images.length} 张已出现，现在开始下载。`);
        await downloadTask(task, images);
        await rememberTask(task);
        task.status = "已完成";
        log(
          `完成：${task.product}，文件名 ${task.product}_${paddedNumber(task.startNumber)}–` +
          `${paddedNumber(task.endNumber)}。`
        );
      } catch (error) {
        task.status = `失败：${error.message}`;
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
});
$("#clear-history").addEventListener("click", async () => {
  await chrome.storage.local.remove(["completedAutomationTasks", "automationHistory", "downloadedImageKeys"]);
  tasks.forEach((task) => { task.status = "待执行"; });
  render();
  log("全部任务历史和图片下载历史已清空。");
});
