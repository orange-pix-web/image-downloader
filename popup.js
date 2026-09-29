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
const timePickerEl = document.querySelector('#time-picker');
const timeStartEl = document.querySelector('#time-start');
const timeEndEl = document.querySelector('#time-end');
const deleteSelectedButton = document.querySelector('#delete-selected');
const autoDownloadButton = document.querySelector('#auto-download');
const autoDeleteWrap = document.querySelector('#auto-delete-wrap');
const autoDeleteAfterDownload = document.querySelector('#auto-delete-after-download');
const deleteDownloadedButton = document.querySelector('#delete-downloaded');
const togglePickerButton = document.querySelector('#toggle-picker');
const deleteWaitsEl = document.querySelector('#delete-waits');
const downloadDeleteWaitEl = document.querySelector('#download-delete-wait');
const deleteNextWaitEl = document.querySelector('#delete-next-wait');

let foundImages = [];
let selectedKeys = new Set();
let downloadingKeys = new Set();
let statusTimer = null;
let suppressPreview = false;
let pickerExpanded = false;

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function scan() {
  suppressPreview = false;
  downloadButton.disabled = true;
  statusEl.textContent = "正在扫描当前页面…";
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
      : "没有找到图片；请先滚动页面使列表加载，再重新扫描。";
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
  const libraryMode = foundImages.some((image) => image.platform === 'chatgpt-library');
  timePickerEl.hidden = !libraryMode;
  deleteSelectedButton.hidden = !libraryMode;
  autoDownloadButton.hidden = !libraryMode;
  autoDeleteWrap.hidden = !libraryMode;
  deleteWaitsEl.hidden = !libraryMode || !autoDeleteAfterDownload.checked;
  deleteDownloadedButton.hidden = !libraryMode;
  pickerEl.hidden = suppressPreview || !pickerExpanded || foundImages.length === 0;
  imageListEl.innerHTML = "";
  imageListEl.hidden = suppressPreview;
  togglePickerButton.textContent = pickerExpanded ? '隐藏手动选图面板' : '显示手动选图面板';
  togglePickerButton.hidden = foundImages.length === 0;
  for (const image of foundImages) {
    const label = document.createElement("label");
    const checked = selectedKeys.has(image.key);
    label.className =
      `image-choice${checked ? " selected" : ""}${image.downloaded ? " downloaded" : ""}${image.platform === 'chatgpt-library' ? ' library' : ''}`;
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
    if (image.platform === 'chatgpt-library') {
      number.textContent = image.filename;
      number.style.maxWidth = '70px';
      number.style.overflow = 'hidden';
      number.style.textOverflow = 'ellipsis';
      number.style.whiteSpace = 'nowrap';
      const date = document.createElement('span');
      date.className = 'image-date';
      date.textContent = image.modifiedText || '';
      const actions = document.createElement('span');
      actions.className = 'image-quick-actions';
      const down = document.createElement('button');
      down.type = 'button'; down.textContent = '↓'; down.title = '单独下载';
      down.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); startLibraryJob([image], 'download'); });
      const del = document.createElement('button');
      del.type = 'button'; del.textContent = '删'; del.title = '删除'; del.className = 'danger-fill';
      del.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); confirmDelete([image]); });
      actions.append(down, del); label.append(date, actions);
    }
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
  downloadButton.hidden = !pickerExpanded;
  deleteSelectedButton.disabled = count === 0;
  if (libraryMode) deleteSelectedButton.hidden = !pickerExpanded;
}

togglePickerButton.addEventListener('click', () => {
  pickerExpanded = !pickerExpanded;
  renderImagePicker();
});

function timeFilteredImages() {
  const start = timeStartEl.value ? new Date(timeStartEl.value).getTime() : -Infinity;
  const end = timeEndEl.value ? new Date(timeEndEl.value).getTime() : Infinity;
  return foundImages.filter((image) => image.modifiedAt && image.modifiedAt >= start && image.modifiedAt <= end);
}

async function startLibraryJob(items, action) {
  if (!items.length) { statusEl.textContent = '所选范围内没有可操作的图片。'; return; }
  const effectiveAction = action === 'download' && autoDeleteAfterDownload.checked ? 'download-delete' : action;
  const tab = await currentTab();
  downloadButton.disabled = true;
  deleteSelectedButton.disabled = true;
  const result = await chrome.runtime.sendMessage({
    type: 'GPT_LIBRARY_JOB', tabId: tab.id, items, action: effectiveAction,
    options: {
      folder: folderInput.value,
      downloadDeleteWaitMs: Math.max(1000, Number(downloadDeleteWaitEl.value || 3) * 1000),
      deleteNextWaitMs: Math.max(1000, Number(deleteNextWaitEl.value || 2) * 1000)
    }
  });
  if (result?.jobId) monitor(result.jobId, effectiveAction === 'delete' || effectiveAction === 'download-delete');
}

function confirmDelete(items) {
  if (!items.length) return;
  if (confirm(`确定要从 ChatGPT 资料库永久删除这 ${items.length} 张图片吗？此操作无法撤销。`)) {
    startLibraryJob(items, 'delete');
  }
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

async function monitor(jobId, rescanAfter = false) {
  clearInterval(statusTimer);
  statusTimer = setInterval(async () => {
    const result = await chrome.runtime.sendMessage({
      type: "GPT_IMAGE_STATUS",
      jobId
    });
    const job = result?.job;
    if (!job) return;

    if (job.state === "running") {
      const verb = job.action === 'delete' ? '删除' : job.action === 'download-delete' ? '下载并清理' : '下载';
      statusEl.textContent = job.total
        ? `正在${verb} ${job.current} / ${job.total}…`
        : `正在持续${verb}，已处理 ${job.current} 张…`;
    } else if (job.state === "complete") {
      clearInterval(statusTimer);
      const verb = job.action === 'delete' ? '删除' : job.action === 'download-delete' ? '下载并删除资料库中的' : '下载';
      statusEl.textContent = `完成：已${verb} ${job.total} 张图片。`;
      foundImages.forEach((image) => {
        if (downloadingKeys.has(image.key)) image.downloaded = true;
      });
      selectedKeys = new Set();
      downloadingKeys = new Set();
      renderImagePicker();
      if (rescanAfter) setTimeout(scan, 500);
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
  if (selectedImages.some((image) => image.platform === 'chatgpt-library')) {
    await saveOptions();
    startLibraryJob(selectedImages, 'download');
    return;
  }
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
deleteSelectedButton.addEventListener('click', () => confirmDelete(foundImages.filter((image) => selectedKeys.has(image.key))));
autoDownloadButton.addEventListener('click', async () => {
  const tab = await currentTab();
  suppressPreview = true;
  pickerEl.hidden = true;
  statusEl.textContent = '先处理当前页面，完成后再自动向下滚动…';
  autoDownloadButton.disabled = true;
  try {
    const action = autoDeleteAfterDownload.checked ? 'download-delete' : 'download';
    const result = await chrome.runtime.sendMessage({
      type: 'GPT_LIBRARY_STREAM_JOB', tabId: tab.id, action,
      options: {
        folder: folderInput.value,
        downloadDeleteWaitMs: Math.max(1000, Number(downloadDeleteWaitEl.value || 3) * 1000),
        deleteNextWaitMs: Math.max(1000, Number(deleteNextWaitEl.value || 2) * 1000)
      }
    });
    if (!result?.jobId) throw new Error(result?.error || '无法启动持续下载');
    monitor(result.jobId, action === 'download-delete');
  } catch (error) {
    statusEl.textContent = error.message || '自动滚动下载失败';
    autoDownloadButton.disabled = false;
  }
});
autoDeleteAfterDownload.addEventListener('change', () => {
  chrome.storage.local.set({ autoDeleteAfterDownload: autoDeleteAfterDownload.checked });
  deleteWaitsEl.hidden = !autoDeleteAfterDownload.checked;
});
for (const input of [downloadDeleteWaitEl, deleteNextWaitEl]) {
  input.addEventListener('change', () => chrome.storage.local.set({
    downloadDeleteWait: Number(downloadDeleteWaitEl.value) || 3,
    deleteNextWait: Number(deleteNextWaitEl.value) || 2
  }));
}
deleteDownloadedButton.addEventListener('click', async () => {
  if (!confirm('将自动扫描整个资料库，并永久删除所有已有成功下载记录的图片。确定继续吗？')) return;
  const tab = await currentTab();
  deleteDownloadedButton.disabled = true;
  statusEl.textContent = '正在扫描整个资料库并核对下载记录…';
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'GPT_LIBRARY_SCAN_ALL' });
    if (!result?.ok) throw new Error(result?.error || '自动扫描失败');
    const filtered = await chrome.runtime.sendMessage({ type: 'GPT_IMAGE_FILTER_HISTORY', images: result.images || [] });
    const downloaded = (filtered?.items || []).filter((item) => item.downloaded);
    if (!downloaded.length) {
      statusEl.textContent = '扫描完成，没有找到已下载且仍在资料库中的图片。';
      deleteDownloadedButton.disabled = false;
      return;
    }
    await startLibraryJob(downloaded, 'delete');
  } catch (error) {
    statusEl.textContent = error.message || '自动删除失败';
    deleteDownloadedButton.disabled = false;
  }
});
document.querySelector('#select-time').addEventListener('click', () => selectBy((image) => timeFilteredImages().some((item) => item.key === image.key)));
document.querySelector('#download-time').addEventListener('click', () => startLibraryJob(timeFilteredImages(), 'download'));
document.querySelector('#delete-time').addEventListener('click', () => confirmDelete(timeFilteredImages()));

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
    const result = await chrome.runtime.sendMessage({
      type: "GPT_OPEN_MANAGER",
      tabId: tab?.id
    });
    if (!result?.ok) throw new Error(result?.error || "无法打开任务管理器");
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

chrome.storage.local.get(["folder", "prefix", "autoDeleteAfterDownload", "downloadDeleteWait", "deleteNextWait"]).then((saved) => {
  if (saved.folder) folderInput.value = saved.folder;
  if (saved.prefix) prefixInput.value = saved.prefix;
  autoDeleteAfterDownload.checked = Boolean(saved.autoDeleteAfterDownload);
  downloadDeleteWaitEl.value = saved.downloadDeleteWait || 3;
  deleteNextWaitEl.value = saved.deleteNextWait || 2;
  scan();
});
