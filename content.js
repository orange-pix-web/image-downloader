function canonicalImageKey(rawUrl) {
  try {
    const url = new URL(rawUrl, location.href);
    if (url.protocol === "blob:") return url.href;
    const identityParameters = ["id", "file_id", "fileId", "asset_id", "assetId", "key"];
    for (const name of identityParameters) {
      const value = url.searchParams.get(name);
      if (value) return `${name}:${decodeURIComponent(value)}`;
    }
    const embeddedUrl = url.searchParams.get("url");
    if (embeddedUrl) return `url:${canonicalImageKey(decodeURIComponent(embeddedUrl))}`;
    const fileId = decodeURIComponent(url.pathname).match(/(?:file|asset)[-_][a-z0-9_-]+/i)?.[0];
    if (fileId) return fileId;

    // 保留区分不同图片的未知参数，只删除签名、有效期和显示尺寸等易变参数。
    // 新版轮播可能让所有图片共用同一路径，仅通过查询参数区分，不能只按 pathname 去重。
    const volatileParameters = new Set([
      "sig", "signature", "token", "auth", "expires", "expiry", "exp",
      "x-oss-signature", "x-oss-expires", "x-amz-signature", "x-amz-expires",
      "w", "width", "h", "height", "q", "quality", "format", "fit", "crop"
    ]);
    for (const name of Array.from(url.searchParams.keys())) {
      if (volatileParameters.has(name.toLowerCase()) || name.toLowerCase().startsWith("x-amz-")) {
        url.searchParams.delete(name);
      }
    }
    url.hash = "";
    return url.href;
  } catch {
    return rawUrl;
  }
}

function chatGptImageOwner(img) {
  // 用户标记可能在内层附件节点，必须沿全部祖先检查，不能只看最近一层。
  for (let node = img; node && node !== document.body; node = node.parentElement) {
    if (node.getAttribute('data-message-author-role') === 'user' ||
        node.getAttribute('data-turn') === 'user') return 'user';
  }
  if (img.closest('[data-message-author-role="assistant"], [data-turn="assistant"]')) return 'assistant';
  const message = img.closest('article, [data-testid^="conversation-turn-"]');
  if (message?.querySelector('[data-message-author-role="user"], [data-turn="user"]') &&
      !message.querySelector('[data-message-author-role="assistant"], [data-turn="assistant"]')) return 'user';
  return 'unknown';
}

function isChatGptGeneratedImage(img) {
  if (chatGptImageOwner(img) === 'user') return false;
  const explicitResult = img.closest(
    '[data-testid="generated-image-gallery"], [data-testid="image-generation-result"], .group\\/imagegen-image'
  );
  if (explicitResult) return true;
  // alt 文案和图片尺寸不能证明图片是生成结果；未知区域必须有生图容器依据。
  if (chatGptImageOwner(img) !== 'assistant') return false;
  const url = img.currentSrc || img.src || '';
  return Boolean(img.closest('[id^="image-"]')) ||
    /\/backend-api\/(?:estuary\/content|files\/.*\/content)/i.test(url) ||
    /^(?:blob:)/i.test(url) || /(?:generated|生成的?图像|生成的?图片)/i.test(img.alt || '');
}

function getChatGptGeneratedImages() {
  const images = [];
  const seen = new Set();

  // 新版 ChatGPT 画廊：以消息 ID + “显示生成的图像 N”作为稳定身份。
  // blob URL 及主图节点会随选中状态变化，不适合作为画廊数量和顺序的唯一依据。
  const galleries = Array.from(document.querySelectorAll('[data-testid="generated-image-gallery"]'));
  for (let galleryIndex = 0; galleryIndex < galleries.length; galleryIndex += 1) {
    const gallery = galleries[galleryIndex];
    if (chatGptImageOwner(gallery) === 'user') continue;
    const messageIds = gallery.closest('[data-chatgpt-search-message-ids]')
      ?.getAttribute('data-chatgpt-search-message-ids')
      ?.trim()
      ?.split(/\s+/);
    const messageId = messageIds?.[0] || `gallery-${galleryIndex}`;
    // ChatGPT 会在不同版本里改变 aria-label，甚至暂时不渲染按钮；
    // 不能因为按钮选择器失效就把整组生成图判定为 0 张。
    const thumbnailButtons = Array.from(
      gallery.querySelectorAll(
        'button[aria-label^="显示生成的图像"], button[aria-label^="Show generated image"]'
      )
    );
    const galleryUrls = new Set();
    const thumbnailImages = thumbnailButtons.length
      ? thumbnailButtons.map((button) => button.querySelector('img')).filter(Boolean)
      : Array.from(gallery.querySelectorAll('img')).filter((img) => {
        const url = img.currentSrc || img.src;
        return Boolean(url && !url.startsWith('data:image/'));
      });

    for (let buttonIndex = 0; buttonIndex < thumbnailImages.length; buttonIndex += 1) {
      const img = thumbnailImages[buttonIndex];
      if (!isChatGptGeneratedImage(img)) continue;
      const url = img?.currentSrc || img?.src;
      if (!url) continue;
      const urlKey = canonicalImageKey(url);
      if (!thumbnailButtons.length && galleryUrls.has(urlKey)) continue;
      galleryUrls.add(urlKey);
      const button = img.closest('button');
      const label = button?.getAttribute('aria-label') || "";
      const number = Number(label.match(/(\d+)\s*$/)?.[1]) || galleryUrls.size;
      const key = `gallery:${messageId}:${number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      seen.add(urlKey);
      images.push({
        url,
        key,
        order: images.length + 1,
        platform: "chatgpt",
        downloadMethod: url.startsWith("blob:") ? "page-blob" : "url"
      });
    }
  }

  const candidates = Array.from(
    document.querySelectorAll(
      '[id^="image-"] img[src*="/backend-api/estuary/content"],' +
      '.group\\/imagegen-image img,' +
      '[data-testid="generated-image-gallery"] img,' +
      '[data-testid="image-generation-result"] img,' +
      '[data-message-author-role="assistant"] img,' +
      '[data-turn="assistant"] img,' +
      'main img[src*="/backend-api/estuary/content"], main img[src*="/backend-api/files/"],' +
      'img[alt*="Generated"], img[alt*="generated"], img[alt*="生成"]'
    )
  );

  for (const img of candidates) {
    // 新版画廊已由其带编号的缩略图按钮精确收集，跳过主图及重复缩略图。
    if (img.closest('[data-testid="generated-image-gallery"]')) continue;
    if (!isChatGptGeneratedImage(img)) continue;
    const url = img.currentSrc || img.src;
    if (!url) continue;

    // 只收集助手生成区域，排除用户自己上传的参考图。
    const turn = img.closest('[data-message-author-role], [data-turn]');
    const isUserTurn =
      turn?.getAttribute("data-message-author-role") === "user" ||
      turn?.getAttribute("data-turn") === "user";
    if (isUserTurn) continue;

    // 排除头像和小图标，但保留轮播导航缩略图；未选中的生成结果可能只以约 60px 缩略图存在。
    const renderedWidth = img.getBoundingClientRect().width;
    const renderedHeight = img.getBoundingClientRect().height;
    const sourceWidth = img.naturalWidth || 0;
    const sourceHeight = img.naturalHeight || 0;
    const isGeneratedContainer = Boolean(
      img.closest('[id^="image-"], .group\\/imagegen-image, [data-testid="image-generation-result"]')
    );
    if (
      !isGeneratedContainer &&
      Math.max(renderedWidth, renderedHeight) < 48 &&
      Math.max(sourceWidth, sourceHeight) < 128
    ) continue;

    const key = canonicalImageKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    images.push({
      url,
      key,
      order: images.length + 1,
      platform: "chatgpt",
      downloadMethod: url.startsWith("blob:") ? "page-blob" : "url"
    });
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

function libraryRows() {
  const primary = Array.from(document.querySelectorAll('[data-page-table-row-item="true"]'));
  if (primary.length) return primary;
  return Array.from(document.querySelectorAll('[data-page-table-selectable-row="true"], [role="row"]'))
    .filter((row) => row.querySelector('img') && /\.(png|jpe?g|webp|gif)\b/i.test(row.textContent || ''));
}

function libraryFilename(row) {
  const labelled = Array.from(row.querySelectorAll('button[aria-label], [aria-label]'))
    .map((node) => node.getAttribute('aria-label') || '')
    .find((label) => /\.(png|jpe?g|webp|gif)$/i.test(label.trim()));
  if (labelled) return labelled.trim();
  const extension = row.querySelector('[data-file-name-extension="true"]');
  if (extension) {
    const button = extension.closest('button');
    const combined = (button?.textContent || '').replace(/\s+/g, '').trim();
    if (/\.(png|jpe?g|webp|gif)$/i.test(combined)) return combined;
  }
  const textMatch = (row.textContent || '').match(/([^\n]+?\.(?:png|jpe?g|webp|gif))\b/i);
  return textMatch?.[1]?.trim() || '';
}

function libraryFileId(row) {
  return row.querySelector('[data-page-table-selection-id]')?.getAttribute('data-page-table-selection-id') ||
    row.getAttribute('data-page-table-selection-id') ||
    row.querySelector('[data-testid^="file-row-actions-"]')?.getAttribute('data-testid')?.replace('file-row-actions-', '') ||
    row.querySelector('[data-testid^="artifact-checkbox-bridge-"]')?.getAttribute('data-testid')?.replace('artifact-checkbox-bridge-', '') ||
    `filename:${libraryFilename(row)}`;
}

function libraryTimestamp(filename, modifiedText) {
  const match = filename.match(/(?:19|20)(\d{2})(\d{2})(\d{2})[-_](\d{2})(\d{2})(\d{2})/);
  if (match) {
    const [, yy, month, day, hour, minute, second] = match;
    return new Date(Number(`20${yy}`), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).getTime();
  }
  const shortMatch = filename.match(/(?:^|[^\d])(\d{2})(\d{2})[-_](\d{2})(\d{2})(\d{2})(?:[^\d]|$)/);
  if (shortMatch) {
    const [, month, day, hour, minute, second] = shortMatch;
    return new Date(new Date().getFullYear(), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).getTime();
  }
  const time = modifiedText.match(/^(\d{1,2}):(\d{2})$/);
  if (time) {
    const date = new Date();
    date.setHours(Number(time[1]), Number(time[2]), 0, 0);
    return date.getTime();
  }
  return null;
}

function getLibraryImages() {
  const rows = libraryRows();
  return rows.map((row, index) => {
    const thumbnail = row.querySelector('img');
    const id = libraryFileId(row);
    const filename = libraryFilename(row);
    if (!filename || !thumbnail || !id) return null;
    const cells = Array.from(row.querySelectorAll('[role="gridcell"]'));
    const modifiedText = cells.find((cell) =>
      cell.classList.contains('text-token-text-secondary') &&
      !cell.hasAttribute('data-page-table-row-actions')
    )?.textContent?.trim() || '';
    return {
      key: `library:${id}`,
      libraryId: id,
      filename,
      url: thumbnail.currentSrc || thumbnail.src || '',
      modifiedText,
      modifiedAt: libraryTimestamp(filename, modifiedText),
      order: index + 1,
      platform: 'chatgpt-library',
      downloadMethod: 'library-menu'
    };
  }).filter(Boolean);
}

function libraryScrollContainer() {
  const row = libraryRows()[0];
  let node = row?.parentElement;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 40) return node;
    node = node.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

async function scanAllLibraryImages() {
  const scroller = libraryScrollContainer();
  const originalTop = scroller.scrollTop;
  const collected = new Map();
  let stableRounds = 0;
  let previousSize = 0;
  scroller.scrollTop = 0;
  showLibraryFloatingStatus({ state: 'running', action: 'scan', current: 0, total: 0, filename: '正在扫描资料库列表…' });
  await sleep(400);
  for (let round = 0; round < 300 && stableRounds < 4; round += 1) {
    // 仅读取列表元数据；不点击文件名或图片，不触发任何预览窗口。
    for (const item of getLibraryImages()) collected.set(item.key, {
      key: item.key,
      libraryId: item.libraryId,
      filename: item.filename,
      modifiedText: item.modifiedText,
      modifiedAt: item.modifiedAt,
      order: item.order,
      platform: item.platform,
      downloadMethod: 'library-menu'
    });
    showLibraryFloatingStatus({ state: 'running', action: 'scan', current: collected.size, total: 0, filename: `已发现 ${collected.size} 个文件` });
    const before = scroller.scrollTop;
    scroller.scrollTop = Math.min(scroller.scrollHeight, before + Math.max(420, scroller.clientHeight * 0.8));
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(350);
    const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8;
    stableRounds = atEnd && collected.size === previousSize ? stableRounds + 1 : 0;
    previousSize = collected.size;
  }
  scroller.scrollTop = originalTop;
  scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
  await sleep(250);
  return Array.from(collected.values()).map((item, index) => ({ ...item, order: index + 1 }));
}

function currentLibraryMetadata() {
  return getLibraryImages().map((item) => ({
    key: item.key, libraryId: item.libraryId, filename: item.filename,
    modifiedText: item.modifiedText, modifiedAt: item.modifiedAt,
    platform: item.platform, downloadMethod: 'library-menu'
  }));
}

async function scrollLibraryNextPage() {
  const scroller = libraryScrollContainer();
  const before = scroller.scrollTop;
  const beforeHeight = scroller.scrollHeight;
  scroller.scrollTop = Math.min(scroller.scrollHeight, before + Math.max(420, scroller.clientHeight * 0.82));
  scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
  await sleep(450);
  return {
    moved: scroller.scrollTop > before || scroller.scrollHeight > beforeHeight,
    atEnd: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8
  };
}

async function findLibraryRow(libraryId) {
  const direct = () => libraryRows()
    .find((candidate) => libraryFileId(candidate) === libraryId);
  let row = direct();
  if (row) return row;
  const scroller = libraryScrollContainer();
  scroller.scrollTop = 0;
  for (let round = 0; round < 300; round += 1) {
    await sleep(180);
    row = direct();
    if (row) return row;
    const before = scroller.scrollTop;
    scroller.scrollTop = Math.min(scroller.scrollHeight, before + Math.max(380, scroller.clientHeight * 0.75));
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    if (scroller.scrollTop === before) break;
  }
  return null;
}

function visibleMenuItem(text) {
  const candidates = document.querySelectorAll(
    '[role="menuitem"], [role="menu"] button, [data-radix-menu-content] [data-radix-collection-item], [data-state="open"][role="menu"] [tabindex]'
  );
  return Array.from(candidates).find((item) => {
    const label = (item.getAttribute('aria-label') || item.textContent || '').replace(/\s+/g, ' ').trim();
    return item.getClientRects().length > 0 && (label === text || label.startsWith(`${text} `));
  });
}

function triggerNativeClick(button) {
  const options = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 };
  button.dispatchEvent(new PointerEvent('pointerdown', { ...options, pointerType: 'mouse', isPrimary: true }));
  button.dispatchEvent(new MouseEvent('mousedown', options));
  button.dispatchEvent(new PointerEvent('pointerup', { ...options, pointerType: 'mouse', isPrimary: true, buttons: 0 }));
  button.dispatchEvent(new MouseEvent('mouseup', { ...options, buttons: 0 }));
  button.dispatchEvent(new MouseEvent('click', { ...options, buttons: 0 }));
}

async function openLibraryMenu(libraryId) {
  const row = await findLibraryRow(libraryId);
  const iconButton = row?.querySelector('svg use[href$="#623957"]')?.closest('button');
  const button = row?.querySelector(
    '[data-page-table-row-actions="true"] button, [data-testid^="file-row-actions-"] button, button[aria-haspopup="menu"], button[aria-label*="操作菜单"]'
  ) || iconButton;
  if (!button) throw new Error('资料库列表已变化，请重新扫描');
  row.scrollIntoView({ block: 'center', inline: 'nearest' });
  await sleep(180);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    await sleep(100);
    button.focus({ preventScroll: true });
    triggerNativeClick(button);
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      if (visibleMenuItem('下载') || visibleMenuItem('删除')) return;
      await sleep(100);
    }
  }
  throw new Error('无法打开图片操作菜单；请确认资料库页面位于前台且未被其他弹窗遮挡');
}

const libraryPageSelection = new Set();
const libraryItemCache = new Map();
let libraryDecorateTimer = null;

function visibleLibraryItems() {
  return getLibraryImages().filter((item) => {
    const row = libraryRows()
      .find((candidate) => libraryFileId(candidate) === item.libraryId);
    const rect = row?.getBoundingClientRect();
    return rect && rect.bottom > 0 && rect.top < window.innerHeight;
  });
}

function nativeRowSelectionButton(row) {
  return row.querySelector('[data-testid^="artifact-checkbox-bridge-"]') ||
    row.querySelector('input[type="checkbox"]') ||
    row.querySelector('[data-page-table-selectable-row="true"]');
}

async function setNativeRowSelected(row, selected) {
  const selectable = row.querySelector('[data-page-table-selectable-row="true"]') || row.querySelector('[role="row"]');
  const isSelected = selectable?.getAttribute('aria-selected') === 'true';
  if (isSelected === selected) return true;
  const control = nativeRowSelectionButton(row);
  if (!control) return false;
  triggerNativeClick(control);
  const id = libraryFileId(row);
  const deadline = Date.now() + 1800;
  while (Date.now() < deadline) {
    await sleep(80);
    const currentRow = libraryRows()
      .find((candidate) => libraryFileId(candidate) === id);
    const currentSelectable = currentRow?.querySelector('[data-page-table-selectable-row="true"]') || currentRow?.querySelector('[role="row"]');
    if ((currentSelectable?.getAttribute('aria-selected') === 'true') === selected) return true;
  }
  return false;
}

async function decorateLibraryPage() {
  const images = getLibraryImages();
  if (!images.length) return;
  for (const item of images) libraryItemCache.set(item.key, item);
  const history = await chrome.runtime.sendMessage({ type: 'GPT_IMAGE_FILTER_HISTORY', images });
  const downloaded = new Set((history?.items || []).filter((item) => item.downloaded).map((item) => item.key));
  for (const item of images) {
    const row = libraryRows()
      .find((candidate) => libraryFileId(candidate) === item.libraryId);
    if (!row) continue;
    row.dataset.gptLibraryKey = item.key;
    row.querySelector('.gpt-library-checkbox')?.remove();
    let badge = row.querySelector('.gpt-downloaded-badge');
    if (downloaded.has(item.key) && !badge) {
      badge = document.createElement('span');
      badge.className = 'gpt-downloaded-badge';
      badge.textContent = '已下载';
      Object.assign(badge.style, { marginLeft: '6px', padding: '2px 6px', borderRadius: '10px', background: '#d9f5eb', color: '#08745b', fontSize: '11px', whiteSpace: 'nowrap' });
      row.querySelector('button[aria-label]')?.parentElement?.appendChild(badge);
    }
  }
  let toolbar = document.querySelector('#gpt-library-toolbar');
  if (!toolbar) {
    toolbar = document.createElement('div');
    toolbar.id = 'gpt-library-toolbar';
    Object.assign(toolbar.style, { position: 'fixed', left: '50%', bottom: '22px', transform: 'translateX(-50%)', zIndex: '2147483646', display: 'flex', gap: '8px', alignItems: 'center', padding: '9px 12px', borderRadius: '12px', background: '#16211e', color: 'white', boxShadow: '0 6px 24px rgba(0,0,0,.28)', font: '13px Microsoft YaHei,sans-serif' });
    toolbar.innerHTML = '<span data-count>调用原生选择</span><button data-select-downloaded>选择当前屏幕已下载</button><button data-clear>取消当前选择</button>';
    for (const button of toolbar.querySelectorAll('button')) Object.assign(button.style, { border: '0', borderRadius: '7px', padding: '7px 9px', cursor: 'pointer' });
    toolbar.querySelector('[data-select-downloaded]').addEventListener('click', async () => {
      const visible = visibleLibraryItems();
      const result = await chrome.runtime.sendMessage({ type: 'GPT_IMAGE_FILTER_HISTORY', images: visible });
      const downloaded = new Set((result?.items || []).filter((item) => item.downloaded).map((item) => item.key));
      let selectedCount = 0;
      for (const item of visible) {
        if (!downloaded.has(item.key)) continue;
        const row = libraryRows()
          .find((candidate) => libraryFileId(candidate) === item.libraryId);
        if (row && await setNativeRowSelected(row, true)) selectedCount += 1;
      }
      toolbar.querySelector('[data-count]').textContent = `原生选中 ${selectedCount} 张`;
    });
    toolbar.querySelector('[data-clear]').addEventListener('click', async () => {
      const ids = libraryRows()
        .filter((row) => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < window.innerHeight;
        }).map(libraryFileId).filter(Boolean);
      for (const id of ids) {
        const row = libraryRows()
          .find((candidate) => libraryFileId(candidate) === id);
        if (row) await setNativeRowSelected(row, false);
      }
      toolbar.querySelector('[data-count]').textContent = '调用原生选择';
    });
    document.body.appendChild(toolbar);
  }
  updateLibraryToolbar();
}

function updateLibraryToolbar() {
  const toolbar = document.querySelector('#gpt-library-toolbar');
  if (toolbar && !toolbar.querySelector('[data-count]').textContent.startsWith('原生选中')) {
    toolbar.querySelector('[data-count]').textContent = '调用原生选择';
  }
}

function showLibraryFloatingStatus(status) {
  let panel = document.querySelector('#gpt-library-job-panel');
  if (!panel) {
    panel = document.createElement('aside');
    panel.id = 'gpt-library-job-panel';
    Object.assign(panel.style, {
      position: 'fixed', right: '18px', top: '86px', zIndex: '2147483647', width: '286px',
      padding: '14px', borderRadius: '13px', background: '#fff', color: '#17201d',
      border: '1px solid rgba(0,0,0,.14)', boxShadow: '0 10px 35px rgba(0,0,0,.24)',
      font: '13px Microsoft YaHei,system-ui,sans-serif'
    });
    panel.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center"><strong>资料库自动处理</strong><button data-close title="关闭" style="border:0;background:transparent;font-size:20px;cursor:pointer">×</button></div><div data-state style="margin-top:9px"></div><div style="height:7px;background:#e6ece9;border-radius:5px;margin-top:10px;overflow:hidden"><i data-progress style="display:block;height:100%;width:0;background:#0c9974;transition:width .2s"></i></div><div data-file style="margin-top:8px;color:#65716c;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>';
    panel.querySelector('[data-close]').addEventListener('click', () => panel.remove());
    document.body.appendChild(panel);
  }
  const verbs = { scan: '扫描', delete: '删除', download: '下载', 'download-delete': '下载并删除' };
  const verb = verbs[status.action] || '处理';
  const state = panel.querySelector('[data-state]');
  const progress = panel.querySelector('[data-progress]');
  const file = panel.querySelector('[data-file]');
  if (status.state === 'running') {
    state.textContent = status.total
      ? `正在${verb} ${status.current || 0} / ${status.total}`
      : status.action === 'scan'
        ? `正在扫描，已发现 ${status.current || 0} 个文件`
        : `正在持续${verb}，已处理 ${status.current || 0} 张`;
    progress.style.width = `${status.total ? Math.round((status.current || 0) / status.total * 100) : 0}%`;
    file.textContent = status.filename || '正在准备任务…';
  } else if (status.state === 'complete') {
    state.textContent = `完成：已${verb} ${status.total || 0} 张图片`;
    progress.style.width = '100%';
    file.textContent = '任务已完成，可关闭此面板。';
  } else {
    state.textContent = `${verb}失败`;
    progress.style.background = '#c9362b';
    file.textContent = status.error || '未知错误';
  }
}

const libraryObserver = new MutationObserver(() => {
  clearTimeout(libraryDecorateTimer);
  libraryDecorateTimer = setTimeout(decorateLibraryPage, 250);
});
libraryObserver.observe(document.documentElement, { childList: true, subtree: true });
setTimeout(decorateLibraryPage, 500);

async function actOnLibraryImage(libraryId, action) {
  // 资料库下载始终走行尾“…”菜单的原生下载，不打开文件/图片预览。
  await openLibraryMenu(libraryId);
  const label = action === 'delete' ? '删除' : '下载';
  const item = visibleMenuItem(label);
  if (!item) throw new Error(`操作菜单中找不到“${label}”`);
  item.click();
  if (action !== 'delete') return;
  const dialogDeadline = Date.now() + 12000;
  let dialog = null;
  while (Date.now() < dialogDeadline) {
    dialog = Array.from(document.querySelectorAll('[role="alertdialog"], [role="dialog"]'))
      .find((node) => node.getClientRects().length > 0 && /删除文件/.test(node.textContent || ''));
    if (dialog) break;
    await sleep(100);
  }
  if (!dialog) throw new Error('未找到删除确认窗口');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const buttons = Array.from(dialog.querySelectorAll('button'));
    const enabled = buttons.filter((button) => !button.disabled && button.getClientRects().length > 0);
    const confirmButton = enabled.reverse().find((button) => {
      const label = (button.getAttribute('aria-label') || button.textContent || '').replace(/\s+/g, '').trim();
      return /删除|移至最近删除|确认/.test(label) && !/取消|关闭/.test(label);
    }) || enabled.find((button) => {
      const label = (button.getAttribute('aria-label') || button.textContent || '').replace(/\s+/g, '').trim();
      return label && !/取消|关闭/.test(label);
    });
    if (!confirmButton) throw new Error('删除确认按钮不可用');
    confirmButton.scrollIntoView({ block: 'center', inline: 'center' });
    confirmButton.focus({ preventScroll: true });
    triggerNativeClick(confirmButton);
    const closeDeadline = Date.now() + 8000;
    while (Date.now() < closeDeadline) {
      const dialogClosed = !document.contains(dialog) || dialog.getClientRects().length === 0;
      const rowGone = !libraryRows()
        .some((candidate) => libraryFileId(candidate) === libraryId);
      if (dialogClosed || rowGone) {
        await sleep(300);
        return;
      }
      await sleep(120);
    }
  }
  throw new Error('已点击删除确认，但网页未完成删除；任务已停止以避免状态误判');
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

async function pageBlobToDataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`读取页面图片失败：HTTP ${response.status}`);
  const blob = await response.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ dataUrl: reader.result, mime: blob.type || "image/png" });
    reader.onerror = () => reject(reader.error || new Error("转换页面图片失败"));
    reader.readAsDataURL(blob);
  });
}

function chatGptPromptEditor() {
  const selectors = [
    '#prompt-textarea[contenteditable="true"]', '#prompt-textarea textarea',
    'textarea#prompt-textarea', '[data-type="unified-composer"] [contenteditable="true"]',
    'form [contenteditable="true"].ProseMirror',
    'main [contenteditable="true"][role="textbox"]',
    'textarea[name="prompt-textarea"]', 'textarea[placeholder*="消息"]',
    'textarea[placeholder*="Message"]'
  ];
  for (const selector of selectors) {
    const editor = Array.from(document.querySelectorAll(selector)).find((node) =>
      node.isConnected && node.getClientRects().length && !node.disabled &&
      node.getAttribute('aria-disabled') !== 'true'
    );
    if (editor) return editor;
  }
  return null;
}

function chatGptUploadInput() {
  const uploads = Array.from(document.querySelectorAll('input[type="file"]'));
  return (
    document.querySelector('#upload-files') ||
    uploads.find((input) => /image|png|jpe?g|webp/i.test(input.accept || "")) ||
    uploads[0] ||
    null
  );
}

async function waitForChatGptComposer() {
  let upload = chatGptUploadInput();
  let editor = chatGptPromptEditor();

  // 部分 ChatGPT 页面只有展开附件菜单后才会把隐藏的 file input 挂到 DOM。
  if (!upload) {
    const attachButton = Array.from(document.querySelectorAll('button')).find((button) => {
      const label = `${button.getAttribute('aria-label') || ""} ${button.title || ""} ${button.getAttribute('data-testid') || ""}`;
      return /attach|attachment|upload|add files|添加附件|添加文件|上传文件|composer-plus|plus-btn/i.test(label);
    });
    attachButton?.click();
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (!upload || !editor)) {
    await sleep(200);
    upload = chatGptUploadInput();
    editor = chatGptPromptEditor();
  }
  return { upload, editor };
}

function chatGptSubmitButton(editor) {
  const composer = editor?.closest('form') || editor?.closest('[data-type="unified-composer"]') || document;
  const selectors = [
    '#composer-submit-button',
    'button[data-testid="send-button"]',
    'button[data-testid="composer-submit-button"]',
    'button[aria-label*="发送"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="提交"]'
  ];
  for (const selector of selectors) {
    const button = composer.querySelector(selector) || document.querySelector(selector);
    if (button) return button;
  }
  return null;
}

function chatGptSubmitReady(button) {
  if (!button) return false;
  const testId = button.getAttribute("data-testid") || "";
  const label = button.getAttribute("aria-label") || "";
  return (
    !button.disabled &&
    button.getAttribute("aria-disabled") !== "true" &&
    testId !== "stop-button" &&
    !/停止|stop/i.test(label)
  );
}

function chatGptGenerating() {
  const stop = document.querySelector(
    'button[data-testid="stop-button"], #composer-submit-button[data-testid="stop-button"], ' +
    'button[aria-label*="停止"], button[aria-label*="Stop"]'
  );
  return Boolean(
    stop ||
    document.querySelector('[data-message-author-role="assistant"] [data-streaming="true"]') ||
    document.querySelector('[data-message-author-role="assistant"][data-streaming="true"]')
  );
}

function chatGptEditorText(editor) {
  return editor instanceof HTMLTextAreaElement
    ? editor.value
    : editor.innerText || editor.textContent || "";
}

function normalizedPromptText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function fillChatGptPrompt(editor, prompt) {
  const expected = normalizedPromptText(prompt);
  if (!expected) throw new Error("提示词内容为空，已阻止发送附件");

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    editor = chatGptPromptEditor();
    if (!editor) {
      await sleep(200);
      continue;
    }
    editor.focus();
    if (editor instanceof HTMLTextAreaElement) {
      setTextareaValue(editor, prompt);
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("insertText", false, prompt);
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: prompt
      }));
    }

    await sleep(250);
    const actual = normalizedPromptText(chatGptEditorText(editor));
    if (editor.isConnected && actual === expected) return;
    await sleep(250);
  }
  throw new Error("提示词未能写入输入框，已阻止只发送图片；请刷新 ChatGPT 页面后重试");
}

async function uploadAndSend(images, prompt) {
  if (!images.length) throw new Error("没有收到待上传图片");
  const composer = await waitForChatGptComposer();
  const upload = composer.upload;
  let editor = composer.editor;
  if (!upload && !editor) throw new Error("找不到上传控件和提示词输入框，请确认已进入可发送消息的 ChatGPT 对话页");
  if (!upload) throw new Error("找不到上传控件，请确认当前 GPT 支持图片附件，并尝试手动点一次输入框旁的“添加附件”按钮");
  if (!editor) throw new Error("找不到提示词输入框，请确认页面已加载完成且当前对话可发送消息");

  const files = await Promise.all(images.map((image) => dataUrlToFile(image.dataUrl, image.name, image.type)));
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  upload.files = transfer.files;
  upload.dispatchEvent(new Event("change", { bubbles: true }));

  // 先写文字再等发送按钮，避免新版空输入框始终禁用发送造成死锁。
  // 等待期间每次重新定位；附件处理触发重绘或清空文字时重新补全提示词。
  let submit = null;
  const expectedPrompt = normalizedPromptText(prompt);
  if (!expectedPrompt) throw new Error("提示词内容为空，已阻止发送附件");
  await sleep(1000);
  let readySince = 0;
  const readyDeadline = Date.now() + 120000;
  while (Date.now() < readyDeadline) {
    editor = chatGptPromptEditor();
    if (!editor) {
      readySince = 0;
      await sleep(250);
      continue;
    }
    if (normalizedPromptText(chatGptEditorText(editor)) !== expectedPrompt) {
      readySince = 0;
      await fillChatGptPrompt(editor, prompt);
      continue;
    }
    submit = chatGptSubmitButton(editor);
    const composerRoot = editor.closest('form') || editor.closest('[data-type="unified-composer"]') || editor.parentElement;
    const uploading = composerRoot?.querySelector('[role="progressbar"], [aria-busy="true"], [data-testid*="uploading"]');
    if (chatGptSubmitReady(submit) && !uploading && !chatGptGenerating()) {
      readySince ||= Date.now();
      if (Date.now() - readySince >= 1500) break;
    } else readySince = 0;
    await sleep(500);
  }
  if (!readySince || Date.now() >= readyDeadline || !chatGptSubmitReady(submit)) {
    throw new Error("等待附件上传或发送按钮就绪超时");
  }
  const finalEditor = chatGptPromptEditor();
  if (!finalEditor || !finalEditor.isConnected) {
    throw new Error("点击发送前输入框被页面替换，已阻止只发送图片");
  }
  const finalPrompt = normalizedPromptText(chatGptEditorText(finalEditor));
  if (finalPrompt !== expectedPrompt) {
    throw new Error("点击发送前未检测到完整提示词，已阻止只发送图片");
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

async function uploadAndSendDoubao(images, prompt) {
  if (!images.length) throw new Error("没有收到待上传图片");
  const uploads = Array.from(document.querySelectorAll('input[type="file"][multiple]'));
  const upload =
    uploads.find((input) => /\.(png|jpe?g|webp)/i.test(input.accept || "")) ||
    uploads[0];
  const editor =
    document.querySelector('.tiptap.ProseMirror[contenteditable="true"]') ||
    document.querySelector('textarea[placeholder="发消息..."]');
  if (!upload || !editor) throw new Error("找不到豆包上传控件或提示词输入框");

  const files = await Promise.all(images.map((image) => dataUrlToFile(image.dataUrl, image.name, image.type)));
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  upload.files = transfer.files;
  upload.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(2200 + Math.max(0, files.length - 1) * 500);

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
    const libraryImages = getLibraryImages();
    const images = libraryImages.length ? libraryImages : getGeneratedImages();
    sendResponse({ ok: true, count: images.length, images });
    return;
  }

  if (message?.type === 'GPT_LIBRARY_SCAN_ALL') {
    scanAllLibraryImages()
      .then((images) => sendResponse({ ok: true, count: images.length, images }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'GPT_LIBRARY_VISIBLE_SCAN') {
    sendResponse({ ok: true, images: currentLibraryMetadata() });
    return;
  }

  if (message?.type === 'GPT_LIBRARY_SCROLL_NEXT') {
    scrollLibraryNextPage()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'GPT_LIBRARY_PANEL_STATUS') {
    showLibraryFloatingStatus(message);
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === 'GPT_LIBRARY_ACTION') {
    actOnLibraryImage(message.libraryId, message.action)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GPT_AUTOMATION_STATE") {
    const images = getGeneratedImages();
    sendResponse({
      ok: true,
      images,
      platform: location.hostname === "www.doubao.com" ? "doubao" : "chatgpt",
      generating: location.hostname === "www.doubao.com"
        ? doubaoGenerating()
        : chatGptGenerating()
    });
    return;
  }

  if (message?.type === "GPT_AUTOMATION_SEND") {
    const sender = location.hostname === "www.doubao.com"
      ? uploadAndSendDoubao
      : uploadAndSend;
    const images = message.images || (message.image ? [message.image] : []);
    sender(images, message.prompt)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GPT_CHATGPT_BLOB_DATA") {
    const current = getChatGptGeneratedImages().find((image) => image.key === message.key);
    const url = current?.url || message.url;
    if (!url?.startsWith("blob:")) {
      sendResponse({ ok: false, error: "目标不是可读取的页面 Blob 图片" });
      return;
    }
    pageBlobToDataUrl(url)
      .then((result) => sendResponse({ ok: true, ...result }))
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
