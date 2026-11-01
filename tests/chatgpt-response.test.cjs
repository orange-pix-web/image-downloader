const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const start = source.indexOf('function chatGptAssistantMessages');
const end = source.indexOf('function chatGptEditorText');

test('发送准备忽略不可见上传进度和旧消息生成标记，保留真实上传与按钮限制', () => {
  const button = { isConnected: true, getClientRects: () => [1] };
  let count = 1, enabled = true;
  const progress = { isConnected: true, getClientRects: () => [] };
  const root = { querySelectorAll: selector => {
    assert.doesNotMatch(selector, /aria-busy/);
    return [progress];
  } };
  const editor = { closest: () => root };
  const context = vm.createContext({
    chatGptSubmitButton: () => button,
    chatGptSubmitReady: () => enabled,
    chatGptAttachmentCount: () => count,
    chatGptGenerating: () => { throw Error('不能以旧消息生成标记阻止发送'); }
  });
  vm.runInContext(source.slice(source.indexOf('function chatGptSendReadiness'), source.indexOf('function chatGptGenerating')), context);
  assert.equal(context.chatGptSendReadiness(editor, 1).ready, true);
  progress.getClientRects = () => [1];
  assert.equal(context.chatGptSendReadiness(editor, 1).ready, false);
  progress.getClientRects = () => [];
  count = 0;
  assert.equal(context.chatGptSendReadiness(editor, 1).ready, false);
  count = 1; enabled = false;
  assert.equal(context.chatGptSendReadiness(editor, 1).ready, false);
});

test('读取新版 ChatGPT data-conversation-role 回复结构', () => {
  const reply = {
    isConnected: true,
    innerText: 'ChatGPT 说：\n\n【生图提示词01】\n完整提示词',
    textContent: '',
    dataset: {},
    getClientRects: () => [1],
    getAttribute: name => name === 'data-chatgpt-search-message-ids' ? 'message-uuid' : null
  };
  const heading = { parentElement: reply };
  const document = { querySelectorAll: selector => selector === '[data-conversation-role="assistant"]' ? [heading] : [] };
  const context = vm.createContext({ document, Set, Array });
  vm.runInContext(source.slice(start, end), context);
  const result = context.chatGptAssistantMessages();
  assert.equal(result.length, 1);
  assert.equal(result[0].key, 'message-uuid');
  assert.equal(result[0].text, '【生图提示词01】\n完整提示词');
});
