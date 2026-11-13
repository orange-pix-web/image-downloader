const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'workflow.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('const chatUrl'), source.indexOf('const containsProcessWords')) + '\nglobalThis.filters = { chatUrl, imageUrl };', context);
test('支持两平台生图地址，拒绝伪造域名', () => {
  const { chatUrl, imageUrl } = context.filters;
  assert.equal(imageUrl('https://www.doubao.com/chat/123'), true);
  assert.equal(chatUrl('https://www.doubao.com/chat/123'), false);
  assert.equal(imageUrl('https://chatgpt.com/c/123'), true);
  assert.equal(imageUrl('https://www.doubao.com.evil.com/chat/123'), false);
});
test('提示词和生图两个下拉列表都显示豆包', async () => {
  const ctx = vm.createContext({ chrome: { tabs: { query: async () => [
    { id: 1, url: 'https://chatgpt.com/c/1', title: 'GPT' },
    { id: 2, url: 'https://www.doubao.com/chat/2', title: '豆包' }
  ] } }, escapeHtml: value => value, log() {} });
  vm.runInContext(source.slice(source.indexOf('const chatUrl'), source.indexOf('const containsProcessWords')) +
    source.slice(source.indexOf('async function refreshTabs'), source.indexOf('function escapeHtml')), ctx);
  for (const id of ['prompt-tab', 'image-tab']) {
    const select = { id, value: '' };
    await ctx.refreshTabs(select);
    assert.match(select.innerHTML, /\[豆包\]/);
    assert.match(select.innerHTML, /\[ChatGPT\]/);
  }
});
