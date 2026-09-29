const activeJobs = new Map();
const HISTORY_KEY = "downloadedImageKeys";
let armedNativeDownload = null;
let armedApiDownload = null;

async function openManagerWindow(targetTabId) {
  const dashboardBase = chrome.runtime.getURL("dashboard.html");
  const allTabs = await chrome.tabs.query({});
  const existing = allTabs.find((tab) => tab.url?.startsWith(dashboardBase));
  if (existing?.windowId) {
    await chrome.windows.update(existing.windowId, { focused: true });
    await chrome.tabs.update(existing.id, { active: true });
    // 管理器已打开时只聚焦窗口，不能被其他 AI 页面悄悄改绑。
    return { windowId: existing.windowId, reused: true };
  }
  if (targetTabId) await chrome.storage.local.set({ managerTargetTabId: targetTabId });
  const created = await chrome.windows.create({
    url: `${dashboardBase}?manager=1`,
    type: "popup",
    width: 480,
    height: 860,
    focused: true
  });
  return { windowId: created.id, reused: false };
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

async function waitForDownload(downloadId, timeoutMs = 120000) {
  const existing = await chrome.downloads.search({ id: downloadId });
  if (existing[0]?.state === "complete") return;
  if (existing[0]?.state === "interrupted") {
    throw new Error(existing[0].error || "下载被中断");
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
      reject(new Error("浏览器下载等待超时（120秒）"));
    }, timeoutMs);
    const finish = (callback) => {
      clearTimeout(timeout);
      chrome.downloads.onChanged.removeListener(listener);
      callback();
    };
    const listener = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === "complete") {
        finish(resolve);
      } else if (delta.state.current === "interrupted") {
        finish(() => reject(new Error(delta.error?.current || "下载被中断")));
      }
    };
    chrome.downloads.onChanged.addListener(listener);
    // 消除 search 与注册监听器之间的极短竞态窗口。
    chrome.downloads.search({ id: downloadId }).then((items) => {
      if (items[0]?.state === "complete") finish(resolve);
      else if (items[0]?.state === "interrupted") {
        finish(() => reject(new Error(items[0].error || "下载被中断")));
      }
    }).catch(() => {});
  });
}

function detectExtension(url) {
  try {
    const dataMime = String(url).match(/^data:image\/(png|jpe?g|webp|gif)/i);
    if (dataMime) return dataMime[1].toLowerCase().replace("jpeg", "jpg");
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

function cleanOriginalFilename(value, fallback) {
  const cleaned = String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 220);
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
      filename: armedNativeDownload.filename || `${armedNativeDownload.filenameBase}.${extension}`,
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
    await rememberDownloaded(images[i].historyKey || images[i].key);
  }

  activeJobs.set(jobId, {
    state: "complete",
    current: images.length,
    total: images.length
  });
}

async function runLibraryJob(jobId, tabId, items, action, options = {}) {
  activeJobs.set(jobId, { state: 'running', current: 0, total: items.length, action });
  chrome.tabs.sendMessage(tabId, { type: 'GPT_LIBRARY_PANEL_STATUS', jobId, state: 'running', current: 0, total: items.length, action }).catch(() => {});
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    activeJobs.set(jobId, { state: 'running', current: i + 1, total: items.length, action, filename: item.filename });
    chrome.tabs.sendMessage(tabId, { type: 'GPT_LIBRARY_PANEL_STATUS', jobId, state: 'running', current: i + 1, total: items.length, action, filename: item.filename }).catch(() => {});
    if (action === 'download' || action === 'download-delete') {
      const folder = cleanName(options.folder, 'ChatGPT资料库');
      const originalFilename = cleanOriginalFilename(item.filename, `资料库图片_${i + 1}.png`);
      armedNativeDownload = {
        token: crypto.randomUUID(),
        filenameBase: `${folder}/${originalFilename.replace(/\.[^.]+$/, '')}`,
        filename: `${folder}/${originalFilename}`,
        key: item.key, armedAt: Date.now(), state: 'armed', downloadId: null
      };
    }
    const result = await chrome.tabs.sendMessage(tabId, {
      type: 'GPT_LIBRARY_ACTION', libraryId: item.libraryId,
      action: action === 'download-delete' ? 'download' : action
    });
    if (!result?.ok) {
      armedNativeDownload = null;
      throw new Error(result?.error || `${action === 'delete' ? '删除' : '下载'}失败`);
    }
    if (action === 'download' || action === 'download-delete') {
      const deadline = Date.now() + 30000;
      while (armedNativeDownload && !['complete', 'error'].includes(armedNativeDownload.state) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (armedNativeDownload?.state === 'error') throw new Error(armedNativeDownload.error || '下载失败');
      if (armedNativeDownload && armedNativeDownload.state !== 'complete') throw new Error('等待浏览器下载超时');
      armedNativeDownload = null;
      if (action === 'download-delete') {
        await new Promise((resolve) => setTimeout(resolve, options.downloadDeleteWaitMs || 3000));
        const deleteResult = await chrome.tabs.sendMessage(tabId, {
          type: 'GPT_LIBRARY_ACTION', libraryId: item.libraryId, action: 'delete'
        });
        if (!deleteResult?.ok) throw new Error(deleteResult?.error || '下载成功，但自动删除失败');
        await new Promise((resolve) => setTimeout(resolve, options.deleteNextWaitMs || 2000));
      }
    }
  }
  activeJobs.set(jobId, { state: 'complete', current: items.length, total: items.length, action });
  chrome.tabs.sendMessage(tabId, { type: 'GPT_LIBRARY_PANEL_STATUS', jobId, state: 'complete', current: items.length, total: items.length, action }).catch(() => {});
}

async function runStreamingLibraryJob(jobId, tabId, action, options = {}) {
  const seen = new Set();
  let processed = 0;
  let emptyRounds = 0;
  activeJobs.set(jobId, { state: 'running', current: 0, total: 0, action });
  chrome.tabs.sendMessage(tabId, { type: 'GPT_LIBRARY_PANEL_STATUS', state: 'running', current: 0, total: 0, action, filename: '正在处理当前页面…' }).catch(() => {});
  while (emptyRounds < 3) {
    const page = await chrome.tabs.sendMessage(tabId, { type: 'GPT_LIBRARY_VISIBLE_SCAN' });
    if (!page?.ok) throw new Error(page?.error || '无法读取当前资料库页面');
    const fresh = (page.images || []).filter((item) => !seen.has(item.key));
    fresh.forEach((item) => seen.add(item.key));
    const downloadedKeys = await getDownloadedKeys();
    const pending = fresh.filter((item) => !downloadedKeys.has(item.key));
    for (const item of pending) {
      const processingNumber = processed + 1;
      activeJobs.set(jobId, { state: 'running', current: processed, total: 0, action, filename: item.filename });
      chrome.tabs.sendMessage(tabId, { type: 'GPT_LIBRARY_PANEL_STATUS', state: 'running', current: processed, total: 0, action, filename: `正在处理第 ${processingNumber} 张：${item.filename}` }).catch(() => {});
      const folder = cleanName(options.folder, 'ChatGPT资料库');
      const originalFilename = cleanOriginalFilename(item.filename, `资料库图片_${processingNumber}.png`);
      armedNativeDownload = {
        token: crypto.randomUUID(), filenameBase: `${folder}/${originalFilename.replace(/\.[^.]+$/, '')}`,
        filename: `${folder}/${originalFilename}`, key: item.key,
        armedAt: Date.now(), state: 'armed', downloadId: null
      };
      const result = await chrome.tabs.sendMessage(tabId, { type: 'GPT_LIBRARY_ACTION', libraryId: item.libraryId, action: 'download' });
      if (!result?.ok) { armedNativeDownload = null; throw new Error(result?.error || '原生下载失败'); }
      const deadline = Date.now() + 30000;
      while (armedNativeDownload && !['complete', 'error'].includes(armedNativeDownload.state) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (armedNativeDownload?.state === 'error') throw new Error(armedNativeDownload.error || '下载失败');
      if (armedNativeDownload && armedNativeDownload.state !== 'complete') throw new Error('等待浏览器下载超时');
      armedNativeDownload = null;
      if (action === 'download-delete') {
        // chrome.downloads 已明确报告 complete 后，再留出短暂时间让文件系统完成落盘。
        await new Promise((resolve) => setTimeout(resolve, options.downloadDeleteWaitMs || 3000));
        activeJobs.set(jobId, { state: 'running', current: processed, total: 0, action, filename: `下载已完成，正在删除：${item.filename}` });
        chrome.tabs.sendMessage(tabId, { type: 'GPT_LIBRARY_PANEL_STATUS', state: 'running', current: processed, total: 0, action, filename: `下载已完成，正在删除：${item.filename}` }).catch(() => {});
        const removed = await chrome.tabs.sendMessage(tabId, { type: 'GPT_LIBRARY_ACTION', libraryId: item.libraryId, action: 'delete' });
        if (!removed?.ok) throw new Error(removed?.error || '下载成功，但自动删除失败');
        // 删除函数已确认弹窗关闭或行消失；额外等待列表完成重排，再进入下一张。
        await new Promise((resolve) => setTimeout(resolve, options.deleteNextWaitMs || 2000));
      }
      processed += 1;
    }
    const scroll = await chrome.tabs.sendMessage(tabId, { type: 'GPT_LIBRARY_SCROLL_NEXT' });
    if (!scroll?.ok) throw new Error(scroll?.error || '资料库滚动失败');
    emptyRounds = fresh.length === 0 && scroll.atEnd ? emptyRounds + 1 : 0;
    if (!scroll.moved && fresh.length === 0) emptyRounds += 1;
  }
  activeJobs.set(jobId, { state: 'complete', current: processed, total: processed, action });
  chrome.tabs.sendMessage(tabId, { type: 'GPT_LIBRARY_PANEL_STATUS', state: 'complete', current: processed, total: processed, action }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GPT_OPEN_MANAGER") {
    const targetTabId = message.tabId || sender.tab?.id;
    openManagerWindow(targetTabId)
      .then((result) => sendResponse({ ok: true, ...result }))
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

  if (message?.type === 'GPT_LIBRARY_JOB') {
    const jobId = crypto.randomUUID();
    runLibraryJob(jobId, message.tabId, message.items || [], message.action, message.options).catch((error) => {
      const old = activeJobs.get(jobId) || {};
      activeJobs.set(jobId, { ...old, state: 'error', error: error?.message || String(error) });
      chrome.tabs.sendMessage(message.tabId, { type: 'GPT_LIBRARY_PANEL_STATUS', jobId, state: 'error', action: message.action, error: error?.message || String(error) }).catch(() => {});
    });
    sendResponse({ ok: true, jobId });
    return;
  }

  if (message?.type === 'GPT_LIBRARY_STREAM_JOB') {
    const jobId = crypto.randomUUID();
    runStreamingLibraryJob(jobId, message.tabId, message.action, message.options).catch((error) => {
      const old = activeJobs.get(jobId) || {};
      activeJobs.set(jobId, { ...old, state: 'error', error: error?.message || String(error) });
      chrome.tabs.sendMessage(message.tabId, { type: 'GPT_LIBRARY_PANEL_STATUS', state: 'error', action: message.action, error: error?.message || String(error) }).catch(() => {});
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
       const pending = images.filter((image) => !downloadedKeys.has(image.historyKey || image.key));
      sendResponse({
        ok: true,
        images: pending,
        items: images.map((image) => ({
          ...image,
          downloaded: downloadedKeys.has(image.historyKey || image.key)
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
