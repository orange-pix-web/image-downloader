const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'workflow.js'), 'utf8');
test('消息数变化不能把上一批回复当作新批；本批完整编号且停止并稳定后才结束', async () => {
  let polls = 0; const logs = [];
  const ctx = vm.createContext({ Date, sleep: async () => {}, log: text => logs.push(text),
    Core: { parseNumberedPrompts: text => text === 'old' ? [{ number: '1' }] : text === 'new' ? [{ number: '2' }] : [] },
    messageTab: async () => { polls++; const text = polls <= 2 ? 'old' : 'new'; return { messages: [{ key: 'reply', text }], latest: { key: 'reply', text }, generating: polls === 3 }; }
  });
  vm.runInContext(source.slice(source.indexOf('async function waitForPromptReply'), source.indexOf('async function runStageOne')), ctx);
  assert.equal(await ctx.waitForPromptReply(1, { count: 0, latestKey: 'reply', latestText: 'old' }, { batchIndex: 1, expectedPrompts: 1, numberStart: 2, numberEnd: 2 }), 'new');
  assert.equal(polls, 8);
  assert.ok(logs.some(text => text.includes('网页生成中')));
  assert.ok(logs.some(text => text.includes('等待本批新回复')));
});
