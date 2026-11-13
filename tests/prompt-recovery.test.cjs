const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'workflow.js'), 'utf8');
test('首次发送失败前已保存全部批次；恢复等待期间不重复发送', async () => {
  const rows = new Map(); let sends = 0, id = 0;
  const plan = { productFiles: [{ name: '产品.png' }], batches: [0, 1].map(index => ({ index, references: [], expected: 1, numberStart: index + 1, numberEnd: index + 1 })) };
  const ctx = vm.createContext({
    $: selector => ({ value: selector === '#prompt-tab' ? '12' : '产品' }),
    DB: { get: async (store, key) => rows.get(`${store}:${key}`), put: async (store, row) => rows.set(`${store}:${row.id}`, structuredClone(row)), all: async () => [] },
    Core: { uuid: () => String(++id) }, state: { prompts: [] }, nowName: () => '任务', buildPromptBatchPlan: () => plan,
    saveBatchAssets: async (product, batch) => rows.set(`assets:${batch.id}`, { saved: true }),
    setStageOneButton() {}, log() {}, messageTab: async (tab, message) => {
      if (message.type === 'GPT_AUTOMATION_SEND') { sends++; return { ok: false, error: '发送未确认' }; }
      return { messages: [] };
    }, waitForPromptReply: async () => { throw new Error('等待中断'); }, fileDataUrl() {}
  });
  vm.runInContext(source.slice(source.indexOf('function orderedPromptAssets'), source.indexOf('async function waitForPromptReply')) + source.slice(source.indexOf('async function runStageOne'), source.indexOf('async function importLocalPrompts')), ctx);
  await assert.rejects(ctx.runStageOne(), /发送未确认/);
  assert.equal([...rows.keys()].filter(key => key.startsWith('assets:')).length, 2);
  assert.equal(rows.get('settings:prompt-run').plan.batches.length, 2);
  await assert.rejects(ctx.runStageOne(true), /等待中断/);
  assert.equal(sends, 1);
});
test('数据库随机 UUID 顺序不改变产品和参考图顺序，旧素材拒绝猜测顺序', () => {
  const ctx = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('function orderedPromptAssets'), source.indexOf('async function waitForPromptReply')), ctx);
  const sorted = ctx.orderedPromptAssets([{ id: 'a', uploadOrder: 2 }, { id: 'z', uploadOrder: 0 }, { id: 'b', uploadOrder: 1 }]);
  assert.deepEqual(Array.from(sorted, item => item.id), ['z', 'b', 'a']);
  assert.throws(() => ctx.orderedPromptAssets([{ id: 'legacy' }]), /缺少可靠的图片顺序/);
});
