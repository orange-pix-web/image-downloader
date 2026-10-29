const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function adapter(replies, buttons = []) {
  const context = vm.createContext({
    document: { querySelectorAll: selector => selector === 'button' ? buttons : replies },
    chrome: { runtime: { onMessage: { addListener() {} } } }, setTimeout
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'grok.js'), 'utf8'), context);
  return context;
}
const visible = text => ({ innerText: text, isConnected: true, getClientRects: () => [1] });
test('富文本额外空行不影响完整提示词校验', () => {
  const context = adapter([]);
  assert.equal(context.grokNormalizedText('参考图要求\n\n\n产品说明\n'), context.grokNormalizedText('参考图要求\n产品说明'));
  assert.notEqual(context.grokNormalizedText('参考图要求'), context.grokNormalizedText('参考图要求 产品说明'));
});
test('Grok 读取最后一个可见回复，忽略断开的旧节点', () => {
  const old = { ...visible('旧回复'), isConnected: false };
  assert.equal(adapter([visible('第一条'), visible('新提示词'), old]).grokState().text, '新提示词');
});
test('停止按钮存在时报告生成中', () => {
  const button = { ...visible(''), getAttribute: () => 'Stop response', title: '' };
  assert.equal(adapter([], [button]).grokState().generating, true);
});
test('空附件或空提示词禁止发送', async () => {
  await assert.rejects(adapter([]).grokSend([], '要求'), /为空/);
  await assert.rejects(adapter([]).grokSend([{}], ' '), /为空/);
});
