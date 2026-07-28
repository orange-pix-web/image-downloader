const statusEl = document.querySelector("#status");
const downloadButton = document.querySelector("#download");
const rescanButton = document.querySelector("#rescan");
const clearHistoryButton = document.querySelector("#clear-history");
const dashboardButton = document.querySelector("#open-dashboard");
const folderInput = document.querySelector("#folder");
const prefixInput = document.querySelector("#prefix");
const pickerEl = document.querySelector("#picker");
const imageListEl = document.querySelector("#image-list");
const selectionCountEl = document.querySelector("#selection-count");
const rangeStartEl = document.querySelector("#range-start");
const rangeEndEl = document.querySelector("#range-end");

let foundImages = [];
let selectedKeys = new Set();
let downloadingKeys = new Set();
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
    if (!tab?.id || !/^https:\/\/(chatgpt\.com|chat\.openai\.com|www\.doubao\.com)\//.test(tab.url || "")) {
      throw new Error("请先打开 ChatGPT 或豆包对话页面");
    }
    const result = await chrome.tabs.sendMessage(tab.id, { type: "GPT_IMAGE_SCAN" });
    const allImages = result?.images || [];
    const filtered = await chrome.runtime.sendMessage({
      type: "GPT_IMAGE_FILTER_HISTORY",
      images: allImages
    });
    foundImages = filtered?.items || (filtered?.images || []).map((image) => ({
      ...image,
      downloaded: false
    }));
    const downloadedCount = filtered?.downloadedCount || 0;
    selectedKeys = new Set(
      foundImages.filter((image) => !image.downloaded).map((image) => image.key)
    );
    statusEl.textContent = allImages.length
      ? `找到 ${allImages.length} 张图片，其中 ${downloadedCount} 张有下载记录。`
      : "没有找到生成图；请先滚动页面使图片加载，再重新扫描。";
    renderImagePicker();
  } catch (error) {
    foundImages = [];
    selectedKeys.clear();
    pickerEl.hidden = true;
    statusEl.textContent =
      error?.message?.includes("Receiving end")
        ? "扩展刚安装，请刷新 ChatGPT 页面后再试。"
        : error?.message || "扫描失败";
  }
}

function renderImagePicker() {
  pickerEl.hidden = foundImages.length === 0;
  imageListEl.innerHTML = "";
  for (const image of foundImages) {
    const label = document.createElement("label");
    const checked = selectedKeys.has(image.key);
    label.className =
      `image-choice${checked ? " selected" : ""}${image.downloaded ? " downloaded" : ""}`;
    label.title = image.downloaded
      ? `第 ${image.order} 张：有下载记录，仍可手动选择`
      : `第 ${image.order} 张`;

    const thumbnail = document.createElement("img");
    thumbnail.src = image.url;
    thumbnail.alt = `第 ${image.order} 张`;
    thumbnail.loading = "lazy";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = checked;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedKeys.add(image.key);
      else selectedKeys.delete(image.key);
      renderImagePicker();
    });
    const number = document.createElement("span");
    number.className = "image-number";
    number.textContent = String(image.order).padStart(3, "0");
    label.append(thumbnail, checkbox, number);
    if (image.downloaded) {
      const state = document.createElement("span");
      state.className = "image-state";
      state.textContent = "已下";
      label.appendChild(state);
    }
    imageListEl.appendChild(label);
  }
  const count = foundImages.filter((image) => selectedKeys.has(image.key)).length;
  selectionCountEl.textContent = `已选 ${count} / ${foundImages.length} 张`;
  downloadButton.textContent = count ? `下载已选择的 ${count} 张图片` : "请先选择图片";
  downloadButton.disabled = count === 0;
}

function selectBy(predicate) {
  selectedKeys = new Set(foundImages.filter(predicate).map((image) => image.key));
  renderImagePicker();
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
      foundImages.forEach((image) => {
        if (downloadingKeys.has(image.key)) image.downloaded = true;
      });
      selectedKeys = new Set();
      downloadingKeys = new Set();
      renderImagePicker();
    } else if (job.state === "error") {
      clearInterval(statusTimer);
      statusEl.textContent = `下载失败：${job.error}`;
      downloadButton.disabled = false;
    }
  }, 400);
}

downloadButton.addEventListener("click", async () => {
  const selectedImages = foundImages.filter((image) => selectedKeys.has(image.key));
  if (!selectedImages.length) return;
  downloadingKeys = new Set(selectedImages.map((image) => image.key));
  downloadButton.disabled = true;
  await saveOptions();
  const result = await chrome.runtime.sendMessage({
    type: "GPT_IMAGE_DOWNLOAD",
    images: selectedImages,
    options: {
      folder: folderInput.value,
      prefix: prefixInput.value
    }
  });
  if (result?.jobId) monitor(result.jobId);
});

rescanButton.addEventListener("click", scan);
document.querySelector("#select-new").addEventListener("click", () => {
  selectBy((image) => !image.downloaded);
});
document.querySelector("#select-all").addEventListener("click", () => {
  selectBy(() => true);
});
document.querySelector("#select-none").addEventListener("click", () => {
  selectBy(() => false);
});
document.querySelector("#invert").addEventListener("click", () => {
  const previous = selectedKeys;
  selectedKeys = new Set(
    foundImages.filter((image) => !previous.has(image.key)).map((image) => image.key)
  );
  renderImagePicker();
});
document.querySelector("#select-range").addEventListener("click", () => {
  const start = Math.max(1, Number(rangeStartEl.value) || 1);
  const end = Math.max(start, Number(rangeEndEl.value) || start);
  selectBy((image) => image.order >= start && image.order <= end);
});
dashboardButton.addEventListener("click", async () => {
  try {
    const tab = await currentTab();
    if (!tab?.id || !/^https:\/\/(chatgpt\.com|chat\.openai\.com|www\.doubao\.com)\//.test(tab.url || "")) {
      throw new Error("请先打开 ChatGPT 或豆包页面");
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
