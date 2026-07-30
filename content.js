function canonicalImageKey(rawUrl) {
  try {
    const url = new URL(rawUrl, location.href);
    return url.searchParams.get("id") || url.href;
  } catch {
    return rawUrl;
  }
}

function getChatGptGeneratedImages() {
  const candidates = Array.from(
    document.querySelectorAll(
      '[id^="image-"] img[src*="/backend-api/estuary/content"],' +
      '.group\\/imagegen-image img[src*="/backend-api/estuary/content"]'
    )
  );

  const seen = new Set();
  const images = [];

  for (const img of candidates) {
    const url = img.currentSrc || img.src;
    if (!url) continue;

    // 只收集助手生成区域，排除用户自己上传的参考图。
    const turn = img.closest('[data-message-author-role], [data-turn]');
    const isUserTurn =
      turn?.getAttribute("data-message-author-role") === "user" ||
      turn?.getAttribute("data-turn") === "user";
    if (isUserTurn) continue;

    const key = canonicalImageKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    images.push({ url, key, order: images.length + 1, platform: "chatgpt", downloadMethod: "url" });
  }

  return images;
}

function doubaoImageKey(url) {
  try {
    const decoded = decodeURIComponent(url);
    const generated = decoded.match(/rc_gen_image\/([a-z0-9]+)/i);
    if (generated) return `doubao:generated:${generated[1]}`;
    const short = new URL(url).pathname.replace(/^\/+/, "");
    return `doubao:short:${short}`;
  } catch {
    return `doubao:${url}`;
  }
}

function getDoubaoGeneratedImages() {
  const selectors = [
    '.image-box-grid-EYaIcP[data-finished="true"] img.image-Q7dBqW[src*="rc_gen_image"]',
    'img.image-Q7dBqW[src^="https://aka.doubaocdn.com/s/"]'
  ];
  const candidates = Array.from(document.querySelectorAll(selectors.join(",")));
  const seen = new Set();
  const images = [];

  for (const img of candidates) {
    const url = img.currentSrc || img.src;
    if (!url || url.startsWith("data:image/")) continue;
    const key = doubaoImageKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    images.push({
      url,
      key,
      order: images.length + 1,
      platform: "doubao",
      // 短链和原生网格都只作为定位依据，下载统一走豆包预览窗口的“保存”。
      downloadMethod: "doubao-save"
    });
  }
  return images;
}

function getGeneratedImages() {
  return location.hostname === "www.doubao.com"
    ? getDoubaoGeneratedImages()
    : getChatGptGeneratedImages();
}

function mountAutomationPanel() {
  if (document.querySelector("#gpt-image-automation-panel-host")) return;

  const host = document.createElement("div");
  host.id = "gpt-image-automation-panel-host";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .launcher {
      position: fixed; right: 14px; top: 48%; z-index: 2147483646;
      width: 50px; height: 50px; border: 0; border-radius: 25px;
      background: #0c9974; color: #fff; font: 700 14px "Microsoft YaHei", sans-serif;
      box-shadow: 0 5px 22px rgba(0,0,0,.2); cursor: pointer;
    }
    .shell {
      position: fixed; top: 64px; right: 12px; bottom: 72px;
      width: min(380px, calc(100vw - 28px)); z-index: 2147483647;
      border: 1px solid rgba(0,0,0,.14); border-radius: 15px;
      background: #fff; box-shadow: 0 14px 45px rgba(0,0,0,.22);
      overflow: hidden; transform: translateX(calc(100% + 30px));
      opacity: 0; pointer-events: none;
      transition: transform .22s ease, opacity .18s ease;
    }
    .shell.open { transform: translateX(0); opacity: 1; pointer-events: auto; }
    .bar {
      height: 44px; display: flex; align-items: center; justify-content: space-between;
      padding: 0 9px 0 14px; background: #15211d; color: #fff;
      font: 700 14px "Microsoft YaHei", sans-serif; cursor: move; user-select: none;
    }
    .bar button {
      width: 30px; height: 30px; border: 0; border-radius: 7px;
      background: rgba(255,255,255,.12); color: #fff; font-size: 19px; cursor: pointer;
    }
    iframe { display: block; width: 100%; height: calc(100% - 44px); border: 0; background: #f3f6f5; }
    @media (max-width: 760px) {
      .shell { top: 52px; right: 6px; bottom: 66px; width: min(330px, calc(100vw - 12px)); }
      .launcher { right: 8px; }
    }
  `;

  const launcher = document.createElement("button");
  launcher.className = "launcher";
  launcher.type = "button";
  launcher.title = "打开 AI 自动生图任务管理器";
  launcher.textContent = "生图";

  const shell = document.createElement("section");
  shell.className = "shell";
  const bar = document.createElement("div");
  bar.className = "bar";
  const title = document.createElement("span");
  title.textContent = "AI 自动生图";
  const close = document.createElement("button");
  close.type = "button";
  close.title = "折叠";
  close.textContent = "×";
  const frame = document.createElement("iframe");
  frame.title = "GPT 自动生图任务管理器";
  frame.src = "about:blank";

  const openManager = () => chrome.runtime.sendMessage({ type: "GPT_OPEN_MANAGER" });
  const setOpen = (open) => {
    if (open) openManager();
    shell.classList.remove("open");
    launcher.style.display = "block";
  };
  launcher.addEventListener("click", openManager);
  close.addEventListener("click", () => setOpen(false));
  bar.append(title, close);
  shell.append(bar, frame);
  shadow.append(style, launcher, shell);
  document.documentElement.appendChild(host);

  host.openPanel = openManager;
}

mountAutomationPanel();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dataUrlToFile(dataUrl, filename, mimeType) {
  const blob = await fetch(dataUrl).then((response) => response.blob());
  return new File([blob], filename, { type: mimeType || blob.type || "image/png" });
}

async function uploadAndSend(image, prompt) {
  const upload = document.querySelector('#upload-files, input[type="file"][multiple]');
  const editor = document.querySelector('#prompt-textarea[contenteditable="true"]');
  if (!upload || !editor) throw new Error("找不到上传控件或提示词输入框");

  const file = await dataUrlToFile(image.dataUrl, image.name, image.type);
  const transfer = new DataTransfer();
  transfer.items.add(file);
  upload.files = transfer.files;
  upload.dispatchEvent(new Event("change", { bubbles: true }));

  // 等待网页读取附件并生成预览。
  await sleep(1800);
  editor.focus();
  document.execCommand("selectAll", false);
  document.execCommand("insertText", false, prompt);
  editor.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
    data: prompt
  }));

  let submit = null;
  const readyDeadline = Date.now() + 60000;
  while (Date.now() < readyDeadline) {
    submit = document.querySelector("#composer-submit-button");
    if (
      submit &&
      !submit.disabled &&
      submit.getAttribute("data-testid") !== "stop-button" &&
      submit.getAttribute("aria-label") !== "停止回答"
    ) break;
    await sleep(500);
  }
  if (
    !submit ||
    submit.disabled ||
    submit.getAttribute("data-testid") === "stop-button" ||
    submit.getAttribute("aria-label") === "停止回答"
  ) {
    throw new Error("等待附件上传或发送按钮就绪超时");
  }
  submit.click();
}

function setTextareaValue(textarea, value) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

async function uploadAndSendDoubao(image, prompt) {
  const uploads = Array.from(document.querySelectorAll('input[type="file"][multiple]'));
  const upload =
    uploads.find((input) => /\.(png|jpe?g|webp)/i.test(input.accept || "")) ||
    uploads[0];
  const editor =
    document.querySelector('.tiptap.ProseMirror[contenteditable="true"]') ||
    document.querySelector('textarea[placeholder="发消息..."]');
  if (!upload || !editor) throw new Error("找不到豆包上传控件或提示词输入框");

  const file = await dataUrlToFile(image.dataUrl, image.name, image.type);
  const transfer = new DataTransfer();
  transfer.items.add(file);
  upload.files = transfer.files;
  upload.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(2200);

  editor.focus();
  if (editor instanceof HTMLTextAreaElement) {
    setTextareaValue(editor, prompt);
  } else {
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, prompt);
  }
  await sleep(600);

  editor.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true
  }));
  editor.dispatchEvent(new KeyboardEvent("keyup", {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true
  }));
}

function doubaoGenerating() {
  return Boolean(
    document.querySelector('[data-streaming="true"]') ||
    document.querySelector('.image-box-grid-EYaIcP:not([data-finished="true"])')
  );
}

async function saveDoubaoImage(key) {
  // 关闭可能残留的旧预览。
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  await sleep(250);

  const target = getDoubaoGeneratedImages().find((image) => image.key === key);
  if (!target) throw new Error("找不到待保存的豆包生成图");
  const allImages = Array.from(
    document.querySelectorAll(
      'img.image-Q7dBqW[src*="rc_gen_image"],' +
      'img.image-Q7dBqW[src^="https://aka.doubaocdn.com/s/"]'
    )
  );
  const img = allImages.find((element) => doubaoImageKey(element.currentSrc || element.src) === key);
  if (!img) throw new Error("找不到豆包图片节点");
  (img.closest(".clickable-axeVcZ") || img).click();

  const deadline = Date.now() + 10000;
  let saveButton = null;
  while (Date.now() < deadline) {
    const preview = document.querySelector('[data-visible="true"] [data-marker-preview-image="true"]');
    if (preview) {
      saveButton = Array.from(
        preview.closest('[data-visible="true"]')?.querySelectorAll("button") || []
      ).find((button) => button.textContent.trim() === "保存");
      if (saveButton) break;
    }
    await sleep(200);
  }
  if (!saveButton) throw new Error("豆包预览已打开，但找不到“保存”按钮");
  saveButton.click();
  await sleep(1000);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GPT_PANEL_OPEN") {
    mountAutomationPanel();
    document.querySelector("#gpt-image-automation-panel-host")?.openPanel?.();
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "GPT_IMAGE_SCAN") {
    const images = getGeneratedImages();
    sendResponse({ ok: true, count: images.length, images });
    return;
  }

  if (message?.type === "GPT_AUTOMATION_STATE") {
    const images = getGeneratedImages();
    const submit = document.querySelector("#composer-submit-button");
    sendResponse({
      ok: true,
      images,
      platform: location.hostname === "www.doubao.com" ? "doubao" : "chatgpt",
      generating: location.hostname === "www.doubao.com"
        ? doubaoGenerating()
        : submit?.getAttribute("data-testid") === "stop-button" ||
          submit?.getAttribute("aria-label") === "停止回答"
    });
    return;
  }

  if (message?.type === "GPT_AUTOMATION_SEND") {
    const sender = location.hostname === "www.doubao.com"
      ? uploadAndSendDoubao
      : uploadAndSend;
    sender(message.image, message.prompt)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GPT_DOUBAO_SAVE") {
    saveDoubaoImage(message.key)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});
