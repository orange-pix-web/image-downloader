// 独立 Grok 适配器，不参与生成图片扫描和下载。
const grokSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const grokVisible = node => node.isConnected && node.getClientRects().length > 0;
let grokUploadStatus = { stage: 'idle' };
function grokNormalizedText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function grokEditor() {
  const selectors = [
    '[contenteditable="true"][role="textbox"][aria-label="Ask Grok anything"]',
    '.query-bar [contenteditable="true"][role="textbox"]',
    '.query-bar textarea', 'main textarea', 'textarea[placeholder]',
    'main [contenteditable="true"][role="textbox"]'
  ];
  for (const selector of selectors) {
    const editor = [...document.querySelectorAll(selector)].find(node => grokVisible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true');
    if (editor) return editor;
  }
  return null;
}
function grokState() {
  const replies = [...document.querySelectorAll('[data-message-author-role="assistant"], [data-role="assistant"], [data-testid="assistant-message"], .message-bubble .response-content-markdown, .message-bubble .markdown')]
    .filter(grokVisible);
  return {
    ok: true,
    text: replies.at(-1)?.innerText?.trim() || '',
    generating: [...document.querySelectorAll('button')].some(button => grokVisible(button) && /stop|停止/i.test(`${button.getAttribute('aria-label') || ''} ${button.title || ''}`))
  };
}
function grokWrite(editor, prompt) {
  editor.focus();
  if (editor instanceof HTMLTextAreaElement) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, prompt);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    const range = document.createRange();
    range.selectNodeContents(editor);
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    document.execCommand('insertText', false, prompt);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
  }
}
function grokUploadInput() {
  const inputs = [...document.querySelectorAll('input[type="file"]')].filter(input => input.isConnected && !input.disabled);
  return inputs.find(input => input.name === 'files') || inputs.find(input => /image|png|jpe?g|webp/i.test(input.accept || '')) || inputs.find(input => input.multiple) || inputs[0];
}

async function grokWaitUploadInput() {
  let input = grokUploadInput();
  if (input) return input;
  const label = button => `${button.getAttribute('aria-label') || ''} ${button.title || ''} ${button.getAttribute('data-testid') || ''} ${button.textContent || ''}`;
  const attach = [...document.querySelectorAll('button')].find(button => grokVisible(button) && /attach|upload|add files|添加文件|添加附件|附件|上传/i.test(label(button)));
  attach?.click();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    input = grokUploadInput();
    if (input) return input;
    // 一些页面先展开附件菜单，再由“上传文件”菜单项挂载 file input。
    const menuItem = [...document.querySelectorAll('[role="menuitem"]')].find(item => grokVisible(item) && /upload|attach file|上传|添加文件/i.test(label(item)));
    if (menuItem) menuItem.click();
    await grokSleep(250);
  }
  return null;
}
async function grokSend(images, prompt) {
  grokUploadStatus = { stage: 'locating', expected: images.length };
  if (!images.length || !prompt.trim()) throw new Error('Grok 附件或提示词为空');
  if (grokState().generating) throw new Error('Grok 正在回复，请等待完成');
  const input = await grokWaitUploadInput();
  if (!input) throw new Error('未找到 Grok 文件上传控件；请手动展开附件菜单，再点击独立页面的“检查连接”，将诊断信息发来');
  if (!grokEditor()) throw new Error('未找到 Grok 提示词输入框，请确认已进入普通对话');
  if (images.length > 1 && !input.multiple) throw new Error('当前 Grok 上传控件不支持多附件，已停止');
  const transfer = new DataTransfer();
  for (const image of images) {
    const blob = await fetch(image.dataUrl).then(response => response.blob());
    transfer.items.add(new File([blob], image.name, { type: image.type || blob.type }));
  }
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  grokUploadStatus = { stage: 'attached', expected: images.length };
  await grokSleep(2000);
  const deadline = Date.now() + 120000;
  let readySince = 0;
  while (Date.now() < deadline) {
    const editor = grokEditor();
    if (!editor) { readySince = 0; await grokSleep(500); continue; }
    const text = editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText;
    if (grokNormalizedText(text) !== grokNormalizedText(prompt)) { grokWrite(editor, prompt); readySince = 0; await grokSleep(500); continue; }
    const root = editor.closest('.query-bar') || editor.closest('form') || editor.closest('[data-testid="composer"]') || editor.parentElement.parentElement;
    grokUploadStatus = { stage: 'waiting-submit', expected: images.length, attached: root.querySelectorAll('button[aria-label="移除此附件"], button[aria-label="Remove attachment"]').length };
    const submit = [...root.querySelectorAll('button')].find(button => grokVisible(button) &&
      (button.type === 'submit' || /^(send|submit|发送|提交)( message|消息)?$/i.test(button.getAttribute('aria-label') || '')));
    const busy = [...root.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(grokVisible);
    if (submit && !submit.disabled && submit.getAttribute('aria-disabled') !== 'true' && !busy) {
      readySince ||= Date.now();
      if (Date.now() - readySince >= 3000) {
        submit.click();
        grokUploadStatus = { stage: 'sent', expected: images.length };
        return;
      }
    } else readySince = 0;
    await grokSleep(500);
  }
  throw new Error('附件已添加，但等待 Grok 发送按钮超时，未发送；请查看 Grok 输入框，不要重复上传');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'GROK_UPLOAD_STATUS') { respond({ ok: true, ...grokUploadStatus }); return; }
  if (message?.type === 'GROK_DIAGNOSTICS') {
    respond({
      ok: true, editor: Boolean(grokEditor()), uploads: document.querySelectorAll('input[type="file"]').length, replies: grokState().text ? 1 : 0,
      inputs: [...document.querySelectorAll('input[type="file"]')].map(input => ({ accept: input.accept, multiple: input.multiple, disabled: input.disabled })),
      buttons: [...document.querySelectorAll('button, [role="menuitem"]')].filter(grokVisible).map(button => ({
        label: button.getAttribute('aria-label') || '', title: button.title || '', testId: button.getAttribute('data-testid') || '', text: (button.textContent || '').trim().slice(0,80)
      })).filter(button => /attach|upload|file|附件|上传|文件|添加|plus/i.test(`${button.label} ${button.title} ${button.testId} ${button.text}`)),
      frames: document.querySelectorAll('iframe').length
    });
    return;
  }
  if (message?.type === 'GROK_STATE') { respond(grokState()); return; }
  if (message?.type === 'GROK_SEND') {
    grokSend(message.images || [], message.prompt || '')
      .then(() => respond({ ok: true }))
      .catch(error => { grokUploadStatus = { stage: 'error', error: error.message }; respond({ ok: false, error: error.message }); });
    return true;
  }
});
