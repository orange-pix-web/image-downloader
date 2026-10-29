const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'content.js'), 'utf8');
const body = {};
const context = vm.createContext({ URL, location: { href: 'https://chatgpt.com/c/test' }, document: { body } });
vm.runInContext(source.slice(0, source.indexOf('function doubaoImageKey')), context);

function image({ owner = 'unknown', gallery = false, alt = '', src = 'https://example.com/photo.png' } = {}) {
  const parent = { parentElement: body, getAttribute: (key) => key === 'data-message-author-role' ? owner : null };
  return {
    parentElement: parent, src, alt, getAttribute: () => null,
    closest: (selector) => {
      if (selector.includes('generated-image-gallery')) return gallery ? {} : null;
      if (selector.includes('assistant')) return owner === 'assistant' ? parent : null;
      return null;
    },
    getBoundingClientRect: () => ({ width: 512, height: 512 }), naturalWidth: 1024, naturalHeight: 1024
  };
}

test('用户上传图即使有生成字样或位于画廊也必须排除', () => {
  for (const gallery of [false, true]) {
    assert.equal(context.isChatGptGeneratedImage(image({ owner: 'user', gallery, alt: 'Generated image', src: 'blob:upload' })), false);
  }
});
test('未知区域的生成字样不能作为下载依据', () => {
  assert.equal(context.isChatGptGeneratedImage(image({ alt: '生成图片' })), false);
});
test('识别助手生成区的 Blob 和后端图片地址', () => {
  for (const src of ['blob:result', 'https://chatgpt.com/backend-api/estuary/content?id=file-1', 'https://chatgpt.com/backend-api/files/file-2/content']) {
    assert.equal(context.isChatGptGeneratedImage(image({ owner: 'assistant', src })), true);
  }
  assert.equal(context.isChatGptGeneratedImage(image({ owner: 'assistant' })), false);
});
test('识别新版 data-conversation-role 助手消息中的成图', () => {
  const message = { querySelector: (selector) => selector.includes('assistant') ? {} : null };
  const img = image({ src: 'blob:new-chatgpt-result' });
  img.closest = (selector) => selector.includes('data-chatgpt-search-message-ids') ? message : null;
  assert.equal(context.chatGptImageOwner(img), 'assistant');
  assert.equal(context.isChatGptGeneratedImage(img), true);
});
test('画廊没有旧版按钮时去重主图和缩略图，序号连续', () => {
  const images = ['file-1', 'file-1', 'file-2'].map((id) => image({ gallery: true, src: `https://chatgpt.com/backend-api/estuary/content?id=${id}` }));
  const gallery = {
    parentElement: body, getAttribute: () => null, closest: () => null,
    querySelectorAll: (selector) => selector === 'img' ? images : []
  };
  context.document.querySelectorAll = (selector) => selector === '[data-testid="generated-image-gallery"]' ? [gallery] : images;
  const result = context.getChatGptGeneratedImages();
  assert.equal(result.length, 2);
  assert.deepEqual(Array.from(result, (item) => item.key), ['gallery:gallery-0:1', 'gallery:gallery-0:2']);
});
test('新版十图画廊从大图同级侧栏读取全部缩略图', () => {
  const thumbnails = Array.from({ length: 10 }, (_, index) => {
    const img = image({ gallery: true, src: `blob:gallery-image-${index + 1}` });
    img.closest = (selector) => selector.includes('aria-label') ? ({ getAttribute: () => `显示生成的图像 ${index + 1}` }) : (selector.includes('generated-image-gallery') ? {} : null);
    return { querySelector: () => img };
  });
  const scope = { parentElement: body, getAttribute: () => null, querySelectorAll: (selector) => selector.includes('aria-label') ? thumbnails : [] };
  const gallery = {
    parentElement: scope, getAttribute: () => null, closest: () => null,
    querySelectorAll: () => []
  };
  context.document.querySelectorAll = (selector) => selector === '[data-testid="generated-image-gallery"]' ? [gallery] : [];
  const result = context.getChatGptGeneratedImages();
  assert.equal(result.length, 10);
  assert.deepEqual(Array.from(result, item => item.key), Array.from({ length: 10 }, (_, index) => `gallery:gallery-0:${index + 1}`));
});
test('新版十图画廊允许缩略图位于大图祖先的更高层', () => {
  const thumbnails = Array.from({ length: 10 }, (_, index) => {
    const img = image({ src: `blob:nested-gallery-${index + 1}` });
    img.closest = (selector) => selector.includes('aria-label') ? ({ getAttribute: () => `显示生成的图像 ${index + 1}` }) : null;
    return { querySelector: () => img };
  });
  const outer = { parentElement: body, getAttribute: () => null, querySelectorAll: (selector) => selector.includes('aria-label') ? thumbnails : [] };
  const inner = { parentElement: outer, getAttribute: () => null, querySelectorAll: () => [] };
  const gallery = { parentElement: inner, getAttribute: () => null, closest: () => null, querySelectorAll: () => [] };
  context.document.querySelectorAll = (selector) => selector === '[data-testid="generated-image-gallery"]' ? [gallery] : [];
  assert.equal(context.getChatGptGeneratedImages().length, 10);
});
