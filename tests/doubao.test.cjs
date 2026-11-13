const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'content.js'), 'utf8');
const context = vm.createContext({ URL, document: { querySelectorAll: () => [] } });
vm.runInContext(source.slice(source.indexOf('function doubaoImageKey'), source.indexOf('function getGeneratedImages')), context);
function image(url, { user = false, assistant = true, pending = false, loaded = true } = {}) {
  return { src: url, complete: loaded, naturalWidth: loaded ? 1024 : 0,
    closest(selector) {
      if (selector.includes('send_message')) return user ? {} : null;
      if (selector.includes('receive_message')) return assistant ? {} : null;
      if (selector.includes('data-finished')) return pending ? {} : null;
      return null;
    }
  };
}
test('新版豆包不依赖哈希类名识别成图，并按资源去重', () => {
  context.document.querySelectorAll = () => [image('https://a.byteimg.com/rc_gen_image/abc?size=1'), image('https://b.byteimg.com/rc_gen_image/abc?size=2'), image('https://aka.doubaocdn.com/s/result')];
  assert.equal(context.getDoubaoGeneratedImages().length, 2);
});
test('排除用户参考图、头像、占位图和未完成图片', () => {
  context.document.querySelectorAll = () => [
    image('https://a.byteimg.com/rc_gen_image/user', { user: true }),
    image('https://aka.doubaocdn.com/s/avatar', { assistant: false }),
    image('data:image/svg+xml;base64,placeholder'),
    image('https://a.byteimg.com/rc_gen_image/pending', { pending: true }),
    image('https://a.byteimg.com/rc_gen_image/loading', { loaded: false }),
    image('https://a.byteimg.com/avatar.png')
  ];
  assert.equal(context.getDoubaoGeneratedImages().length, 0);
});
test('豆包提示词回复读取正文分块和稳定消息 ID，排除操作栏及隐藏回复', () => {
  const reply = { isConnected: true, getClientRects: () => [1],
    querySelector: () => ({ getAttribute: () => 'message-123' }),
    getAttribute: () => null,
    querySelectorAll: () => [{ innerText: '【生图提示词01】\n正文一' }, { textContent: '【生图提示词02】\n正文二' }]
  };
  context.document.querySelectorAll = () => [reply, { ...reply, getClientRects: () => [] }];
  vm.runInContext(source.slice(source.indexOf('function doubaoAssistantMessages'), source.indexOf('function doubaoGenerating')), context);
  const messages = context.doubaoAssistantMessages();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].key, 'message-123');
  assert.equal(messages[0].text, '【生图提示词01】\n正文一\n\n【生图提示词02】\n正文二');
});
