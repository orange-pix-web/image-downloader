const statusEl = document.querySelector("#status");
const downloadButton = document.querySelector("#download");
const rescanButton = document.querySelector("#rescan");
const clearHistoryButton = document.querySelector("#clear-history");
const dashboardButton = document.querySelector("#open-dashboard");
const folderInput = document.querySelector("#folder");
const prefixInput = document.querySelector("#prefix");

let foundImages = [];
let statusTimer = null;

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function scan() {
  downloadButton.disabled = true;
  statusEl.textContent = "正在扫描当前对话…";
  try {
    const tab = await currentTab();
    if (!tab?.id || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || "")) {
      throw new Error("请先打开 ChatGPT 对话页面");
    }
    const result = await chrome.tabs.sendMessage(tab.id, { type: "GPT_IMAGE_SCAN" });
    const allImages = result?.images || [];
    const filtered = await chrome.runtime.sendMessage({
      type: "GPT_IMAGE_FILTER_HISTORY",
      images: allImages
    });
    foundImages = filtered?.images || [];
    const downloadedCount = filtered?.downloadedCount || 0;
    statusEl.textContent = foundImages.length
      ? `待下载 ${foundImages.length} 张，已过滤 ${downloadedCount} 张下载过的图片。`
      : allImages.length
        ? `当前 ${allImages.length} 张图片都已经下载过。`
        : "没有找到生成图；请先滚动页面使图片加载，再重新扫描。";
    downloadButton.disabled = foundImages.length === 0;
  } catch (error) {
    foundImages = [];
    statusEl.textContent =
      error?.message?.includes("Receiving end")
        ? "扩展刚安装，请刷新 ChatGPT 页面后再试。"
        : error?.message || "扫描失败";
  }
}

async function saveOptions() {
  await chrome.storage.local.set({
    folder: folderInput.value,
    prefix: prefixInput.value
  });
}

async function monitor(jobId) {
  clearInterval(statusTimer);
  statusTimer = setInterval(async () => {
    const result = await chrome.runtime.sendMessage({
      type: "GPT_IMAGE_STATUS",
      jobId
    });
    const job = result?.job;
    if (!job) return;

    if (job.state === "running") {
      statusEl.textContent = `正在下载 ${job.current} / ${job.total}…`;
    } else if (job.state === "complete") {
      clearInterval(statusTimer);
      statusEl.textContent = `完成：已按顺序下载 ${job.total} 张图片。`;
      downloadButton.disabled = false;
    } else if (job.state === "error") {
      clearInterval(statusTimer);
      statusEl.textContent = `下载失败：${job.error}`;
      downloadButton.disabled = false;
    }
  }, 400);
}

downloadButton.addEventListener("click", async () => {
  if (!foundImages.length) return;
  downloadButton.disabled = true;
  await saveOptions();
  const result = await chrome.runtime.sendMessage({
    type: "GPT_IMAGE_DOWNLOAD",
    images: foundImages,
    options: {
      folder: folderInput.value,
      prefix: prefixInput.value
    }
  });
  if (result?.jobId) monitor(result.jobId);
});

rescanButton.addEventListener("click", scan);
dashboardButton.addEventListener("click", async () => {
  try {
    const tab = await currentTab();
    if (!tab?.id || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || "")) {
      throw new Error("请先打开 ChatGPT 页面");
    }
    await chrome.tabs.sendMessage(tab.id, { type: "GPT_PANEL_OPEN" });
    window.close();
  } catch (error) {
    statusEl.textContent = error?.message?.includes("Receiving end")
      ? "请刷新 ChatGPT 页面后再打开任务管理器。"
      : error.message;
  }
});
clearHistoryButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "GPT_IMAGE_CLEAR_HISTORY" });
  statusEl.textContent = "下载记录已清空。";
  await scan();
});

chrome.storage.local.get(["folder", "prefix"]).then((saved) => {
  if (saved.folder) folderInput.value = saved.folder;
  if (saved.prefix) prefixInput.value = saved.prefix;
  scan();
});
