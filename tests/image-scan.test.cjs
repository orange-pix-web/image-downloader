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
