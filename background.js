const activeJobs = new Map();
const HISTORY_KEY = "downloadedImageKeys";
let armedNativeDownload = null;

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
    suggest({
      filename: armedNativeDownload.filename,
      conflictAction: "uniquify"
    });
    return;
  }
  suggest();
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!armedNativeDownload || delta.id !== armedNativeDownload.downloadId || !delta.state) return;
  if (delta.state.current === "complete") {
    armedNativeDownload.state = "complete";
    rememberDownloaded(armedNativeDownload.key);
  } else if (delta.state.current === "interrupted") {
    armedNativeDownload.state = "error";
    armedNativeDownload.error = delta.error?.current || "保存被中断";
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

    const downloadId = await chrome.downloads.download({
      url: images[i].url,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    });
    await waitForDownload(downloadId);
    await rememberDownloaded(images[i].key);
  }

  activeJobs.set(jobId, {
    state: "complete",
    current: images.length,
    total: images.length
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
    if (armedNativeDownload && ["armed", "downloading"].includes(armedNativeDownload.state)) {
      sendResponse({ ok: false, error: "已有原图保存任务正在进行" });
      return;
    }
    const token = crypto.randomUUID();
    armedNativeDownload = {
      token,
      filename: message.filename,
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
