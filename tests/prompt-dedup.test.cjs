const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'workflow.js'), 'utf8');
test('正常及恢复保存使用固定条目 ID 和同一消息凭据，不同对话隔离；拒绝错页', async () => {
  const calls = [];
  const ctx = vm.createContext({ TextEncoder, crypto: webcrypto, Date, Uint8Array,
    DB: { all: async () => [], savePromptBatch: async (...args) => { calls.push(args); return { added: 1, duplicates: 0 }; } },
    containsProcessWords: () => false, log() {}
  });
  vm.runInContext(source.slice(source.indexOf('async function saveAcceptedPromptBatch'), source.indexOf('async function importLocalPrompts')), ctx);
  const batch = { id: 'batch', productId: 'product', numberStart: 1, batchIndex: 0 };
  const reply = { platform: 'doubao', conversationUrl: 'https://www.doubao.com/chat/a', latest: { key: 'message-1' } };
  await ctx.saveAcceptedPromptBatch(batch, [{ text: '正文' }], [], '正文', reply);
  await ctx.saveAcceptedPromptBatch(batch, [{ text: '正文' }], [], '正文', reply);
  assert.equal(calls[0][1][0].id, calls[1][1][0].id);
  assert.equal(calls[0][2].id, calls[1][2].id);
  assert.equal(calls[0][2].contentHash.length, 64);
  await assert.rejects(ctx.saveAcceptedPromptBatch({ ...batch, conversationUrl: 'other' }, [], [], '', reply), /不一致/);
  await assert.rejects(ctx.saveAcceptedPromptBatch(batch, [], [], '', {}), /缺少网页回复来源/);
});
