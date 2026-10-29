const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const start = source.indexOf('function chatGptAssistantMessages');
const end = source.indexOf('function chatGptEditorText');

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
