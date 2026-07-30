const activeJobs = new Map();
const HISTORY_KEY = "downloadedImageKeys";
let armedNativeDownload = null;
let armedApiDownload = null;

async function openManagerWindow() {
  const dashboardBase = chrome.runtime.getURL("dashboard.html");
  const allTabs = await chrome.tabs.query({});
  const existing = allTabs.find((tab) => tab.url?.startsWith(dashboardBase));
  if (existing?.windowId) {
    await chrome.windows.update(existing.windowId, { focused: true });
    await chrome.tabs.update(existing.id, { active: true });
    return existing.windowId;
  }
  const created = await chrome.windows.create({
    url: `${dashboardBase}?manager=1`,
    type: "popup",
    width: 480,
    height: 860,
    focused: true
  });
  return created.id;
}

function normalizedDownloadExtension(item) {
  const mime = String(item.mime || "").toLowerCase();
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("jpeg") || mime.includes("jpg") || mime.includes("jfif")) return "jpg";

  const match = String(item.filename || item.url || "").match(/\.(png|webp|gif|jpe?g|jfif)(?:$|[?#])/i);
  if (!match) return "png";
  const ext = match[1].toLowerCase();
  return ext === "jpeg" || ext === "jfif" ? "jpg" : ext;
}

async function getDownloadedKeys() {
  const saved = await chrome.storage.local.get(HISTORY_KEY);
  return new Set(saved[HISTORY_KEY] || []);
}

async function rememberDownloaded(key) {
  if (!key) return;
  const keys = await getDownloadedKeys();
  keys.add(key);
  await chrome.storage.local.set({ [HISTORY_KEY]: Array.from(keys) });
}

function waitForDownload(downloadId) {
  return new Promise((resolve, reject) => {
    const listener = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === "complete") {
        chrome.downloads.onChanged.removeListener(listener);
        resolve();
      } else if (delta.state.current === "interrupted") {
        chrome.downloads.onChanged.removeListener(listener);
        reject(new Error(delta.error?.current || "下载被中断"));
      }
    };
    chrome.downloads.onChanged.addListener(listener);
  });
}

function detectExtension(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.(png|jpe?g|webp|gif)$/i);
    return match ? match[1].toLowerCase().replace("jpeg", "jpg") : "png";
  } catch {
    return "png";
  }
}

function cleanName(value, fallback) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 60);
  return cleaned || fallback;
}

chrome.downloads.onCreated.addListener((item) => {
  if (
    armedNativeDownload?.state === "armed" &&
    Date.now() - armedNativeDownload.armedAt < 15000
  ) {
    armedNativeDownload.downloadId = item.id;
    armedNativeDownload.state = "downloading";
    return;
  }
  if (
    armedApiDownload?.state === "armed" &&
    Date.now() - armedApiDownload.armedAt < 15000 &&
    item.url === armedApiDownload.url
  ) {
    armedApiDownload.downloadId = item.id;
    armedApiDownload.state = "downloading";
  }
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (
    armedNativeDownload &&
    ["armed", "downloading"].includes(armedNativeDownload.state) &&
    Date.now() - armedNativeDownload.armedAt < 15000 &&
    (!armedNativeDownload.downloadId || armedNativeDownload.downloadId === item.id)
  ) {
    armedNativeDownload.downloadId = item.id;
    armedNativeDownload.state = "downloading";
    const extension = normalizedDownloadExtension(item);
    suggest({
      filename: `${armedNativeDownload.filenameBase}.${extension}`,
      conflictAction: "uniquify"
    });
    return;
  }
  if (
    armedApiDownload &&
    ["armed", "downloading"].includes(armedApiDownload.state) &&
    Date.now() - armedApiDownload.armedAt < 15000 &&
    item.url === armedApiDownload.url &&
    (!armedApiDownload.downloadId || armedApiDownload.downloadId === item.id)
  ) {
    armedApiDownload.downloadId = item.id;
    armedApiDownload.state = "downloading";
    suggest({
      filename: armedApiDownload.filename,
      conflictAction: "uniquify"
    });
    return;
  }
  suggest();
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;

  if (armedNativeDownload && delta.id === armedNativeDownload.downloadId) {
    if (delta.state.current === "complete") {
      armedNativeDownload.state = "complete";
      rememberDownloaded(armedNativeDownload.key);
    } else if (delta.state.current === "interrupted") {
      armedNativeDownload.state = "error";
      armedNativeDownload.error = delta.error?.current || "保存被中断";
    }
  }

  if (armedApiDownload && delta.id === armedApiDownload.downloadId) {
    if (delta.state.current === "complete" || delta.state.current === "interrupted") {
      armedApiDownload = null;
    }
  }
});

async function runJob(jobId, images, options) {
  const folder = cleanName(options.folder, "ChatGPT图片");
  const prefix = cleanName(options.prefix, "GPT图片");
  const width = Math.max(3, String(images.length).length);

  activeJobs.set(jobId, { state: "running", current: 0, total: images.length });

  for (let i = 0; i < images.length; i += 1) {
    const ext = detectExtension(images[i].url);
    const number = String(images[i].order || i + 1).padStart(width, "0");
    const filename = `${folder}/${prefix}_${number}.${ext}`;

    activeJobs.set(jobId, {
      state: "running",
      current: i + 1,
      total: images.length,
      filename
    });

    armedApiDownload = {
      url: images[i].url,
      filename,
      armedAt: Date.now(),
      state: "armed",
      downloadId: null
    };
    let downloadId;
    try {
      downloadId = await chrome.downloads.download({
        url: images[i].url,
        filename,
        conflictAction: "uniquify",
        saveAs: false
      });
      if (armedApiDownload) {
        armedApiDownload.downloadId ||= downloadId;
        armedApiDownload.state = "downloading";
      }
    } catch (error) {
      armedApiDownload = null;
      throw error;
    }
    await waitForDownload(downloadId);
    if (armedApiDownload?.downloadId === downloadId) armedApiDownload = null;
    await rememberDownloaded(images[i].key);
  }

  activeJobs.set(jobId, {
    state: "complete",
    current: images.length,
    total: images.length
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GPT_OPEN_MANAGER") {
    const targetTabId = message.tabId || sender.tab?.id;
    if (targetTabId) {
      chrome.storage.local.set({ managerTargetTabId: targetTabId });
    }
    openManagerWindow()
      .then((windowId) => sendResponse({ ok: true, windowId }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GPT_IMAGE_DOWNLOAD") {
    const jobId = crypto.randomUUID();
    runJob(jobId, message.images || [], message.options || {}).catch((error) => {
      const old = activeJobs.get(jobId) || {};
      activeJobs.set(jobId, {
        ...old,
        state: "error",
        error: error?.message || String(error)
      });
    });
    sendResponse({ ok: true, jobId });
    return;
  }

  if (message?.type === "GPT_IMAGE_STATUS") {
    sendResponse({
      ok: true,
      job: activeJobs.get(message.jobId) || null
    });
    return;
  }

  if (message?.type === "GPT_IMAGE_FILTER_HISTORY") {
    getDownloadedKeys().then((downloadedKeys) => {
      const images = message.images || [];
      const pending = images.filter((image) => !downloadedKeys.has(image.key));
      sendResponse({
        ok: true,
        images: pending,
        items: images.map((image) => ({
          ...image,
          downloaded: downloadedKeys.has(image.key)
        })),
        downloadedCount: images.length - pending.length
      });
    });
    return true;
  }

  if (message?.type === "GPT_IMAGE_CLEAR_HISTORY") {
    chrome.storage.local.remove(HISTORY_KEY).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "GPT_NATIVE_DOWNLOAD_ARM") {
    if (
      armedNativeDownload?.state === "armed" &&
      Date.now() - armedNativeDownload.armedAt >= 15000
    ) {
      armedNativeDownload = null;
    }
    if (armedNativeDownload && ["armed", "downloading"].includes(armedNativeDownload.state)) {
      sendResponse({ ok: false, error: "已有原图保存任务正在进行" });
      return;
    }
    const token = crypto.randomUUID();
    armedNativeDownload = {
      token,
      filenameBase: message.filenameBase,
      key: message.key,
      armedAt: Date.now(),
      state: "armed"
    };
    sendResponse({ ok: true, token });
    return;
  }

  if (message?.type === "GPT_NATIVE_DOWNLOAD_STATUS") {
    const job =
      armedNativeDownload?.token === message.token
        ? {
            state: armedNativeDownload.state,
            error: armedNativeDownload.error || null
          }
        : null;
    sendResponse({ ok: true, job });
  }
});
