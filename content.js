function canonicalImageKey(rawUrl) {
  try {
    const url = new URL(rawUrl, location.href);
    return url.searchParams.get("id") || url.href;
  } catch {
    return rawUrl;
  }
}

function getGeneratedImages() {
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
    images.push({ url, key, order: images.length + 1 });
  }

  return images;
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
  launcher.title = "打开 GPT 自动生图任务管理器";
  launcher.textContent = "生图";

  const shell = document.createElement("section");
  shell.className = "shell";
  const bar = document.createElement("div");
  bar.className = "bar";
  const title = document.createElement("span");
  title.textContent = "GPT 自动生图";
  const close = document.createElement("button");
  close.type = "button";
  close.title = "折叠";
  close.textContent = "×";
  const frame = document.createElement("iframe");
  frame.title = "GPT 自动生图任务管理器";
  frame.src = chrome.runtime.getURL("dashboard.html?embedded=1");

  const setOpen = (open) => {
    shell.classList.toggle("open", open);
    launcher.style.display = open ? "none" : "block";
  };
  launcher.addEventListener("click", () => setOpen(true));
  close.addEventListener("click", () => setOpen(false));
  bar.append(title, close);
  shell.append(bar, frame);
  shadow.append(style, launcher, shell);
  document.documentElement.appendChild(host);

  host.openPanel = () => setOpen(true);
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
      generating:
        submit?.getAttribute("data-testid") === "stop-button" ||
        submit?.getAttribute("aria-label") === "停止回答"
    });
    return;
  }

  if (message?.type === "GPT_AUTOMATION_SEND") {
    uploadAndSend(message.image, message.prompt)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});
