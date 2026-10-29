const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../workflow-core.js');

test('文件首行生图标记保留正文、换行和 BOM，重复标记不叠加', () => {
  for (const marker of ['已生图', '# 已生图', '## 已生图']) {
    const original = `\uFEFF${marker}\r\n## 提示词01\r\n正文提到已生图。\r\n`;
    const cleared = core.setFileGeneratedStatus(original, false);
    assert.equal(cleared, '\uFEFF## 提示词01\r\n正文提到已生图。\r\n');
    const done = core.setFileGeneratedStatus(cleared, true);
    assert.equal(done, '\uFEFF已生图\r\n## 提示词01\r\n正文提到已生图。\r\n');
    assert.equal(core.setFileGeneratedStatus(done, true), done);
  }
  assert.equal(core.setFileGeneratedStatus('\n已生图\n正文', false), '正文');
  assert.equal(core.setFileGeneratedStatus('正文\n已生图', false), '正文\n已生图');
});

test('编号提示词支持中文和 Markdown 标记', () => {
  assert.deepEqual(core.parseNumberedPrompts('1、第一条\n\n### 提示词 2：第二条'), [
    { number: '1', text: '第一条' }, { number: '2', text: '第二条' }
  ]);
});

test('方括号提示词标题优先于正文中的 1:1 比例', () => {
  assert.deepEqual(core.parseNumberedPrompts('【生图提示词07】\n1:1正方形主图\n【生图提示词08】\n1:1另一张'), [
    { number: '07', text: '1:1正方形主图' }, { number: '08', text: '1:1另一张' }
  ]);
});

test('解析带 Markdown 标题和方案名的纯净反推提示词', () => {
  const source = `# 已生图\n\n## 【提示词01｜右瓶左鸽·红框三卡】\n\n\`\`\`text\n第一条完整提示词。\n\`\`\`\n\n## 【提示词02｜右瓶左绿签】\n\n\`\`\`text\n第二条完整提示词。\n\`\`\``;
  const result = core.parseNumberedPrompts(source);
  assert.deepEqual(result, [
    { number: '01', text: '第一条完整提示词。' },
    { number: '02', text: '第二条完整提示词。' }
  ]);
});

test('解析插件批量发送格式的第N张提示词标题', () => {
  const result = core.parseNumberedPrompts('批量说明\n\n【第01张｜提示词21】\n第一条。\n\n【第02张｜提示词22】\n第二条。');
  assert.deepEqual(result, [
    { number: '21', text: '第一条。' },
    { number: '22', text: '第二条。' }
  ]);
});

test('重排和重新编号不改变不可变 UUID', () => {
  const items = [{ id: 'uuid-a', number: '9' }, { id: 'uuid-b', number: '3' }];
  const result = core.renumber(core.move(items, 1, 0), 10, 3);
  assert.deepEqual(result.map(x => x.id), ['uuid-b', 'uuid-a']);
  assert.deepEqual(result.map(x => x.number), ['010', '011']);
});

test('大量参考图按上限拆批且保留原顺序', () => {
  const result = core.batchReferences(Array.from({ length: 23 }, (_, i) => i + 1), 9);
  assert.deepEqual(result.map(batch => batch.length), [9, 9, 5]);
  assert.deepEqual(result.flat(), Array.from({ length: 23 }, (_, i) => i + 1));
  assert.deepEqual(core.batchReferences([], 9), [[]]);
});

test('23 条同产品提示词按十张成图结构拆为 10 + 10 + 3', () => {
  const prompts = Array.from({ length: 23 }, (_, index) => ({ id: `p${index + 1}`, productId: 'product-a' }));
  const groups = core.groupPromptsByProduct(prompts, 10);
  assert.deepEqual(groups.map(group => group.prompts.length), [10, 10, 3]);
  assert.deepEqual(groups.flatMap(group => group.prompts.map(prompt => prompt.id)), prompts.map(prompt => prompt.id));
  const mixed = core.groupPromptsByProduct([...prompts.slice(0, 3), { id: 'other', productId: 'product-b' }], 10);
  assert.deepEqual(mixed.map(group => [group.productId, group.prompts.length]), [['product-a', 3], ['product-b', 1]]);
});

test('自定义风格只移除独立风格句，保留构图和产品信息', () => {
  const source = '1:1主图，右侧放产品，左侧放标题。背景为绿色草地。整体采用农业爆款海报风格，高清商业摄影。';
  const result = core.stripStyleDescriptions(source);
  assert.match(result, /右侧放产品/);
  assert.match(result, /背景为绿色草地/);
  assert.doesNotMatch(result, /农业爆款海报风格/);
});

test('第二阶段可选择仅产品图或产品图加关联参考图', () => {
  const prompt = { assetIds: ['product-1', 'reference-1'] };
  const assets = [
    { id: 'product-1', kind: 'product' },
    { id: 'reference-1', kind: 'reference' },
    { id: 'product-2', kind: 'product' }
  ];
  assert.deepEqual(core.generationAssets(assets, prompt).map(item => item.id), ['product-1']);
  assert.deepEqual(core.generationAssets(assets, prompt, true).map(item => item.id), ['product-1', 'reference-1']);
  const result = core.generationPrompt('产品居中。整体采用促销海报风格，高清商业摄影。', '低饱和自然摄影', true);
  assert.match(result, /^产品居中。\n\n统一风格要求：低饱和自然摄影/);
  assert.match(result, /只生成一张完整的 1:1 正方形成图/);
  assert.match(result, /禁止九宫格/);
});

test('十套提示词合成一次网页请求并要求同一画廊返回十张', () => {
  const prompts = Array.from({ length: 10 }, (_, index) => ({ number: String(index + 1).padStart(2, '0'), text: `产品构图${index + 1}。只输出这一张完整主图，不做拼图。` }));
  const result = core.generationBatchPrompt(prompts, '', false);
  assert.match(result, /生成 10 张相互独立/);
  assert.match(result, /同一个结果画廊/);
  assert.match(result, /【第01张｜提示词01】/);
  assert.match(result, /【第10张｜提示词10】/);
  assert.match(result, /不要只生成第一张/);
  assert.doesNotMatch(result, /只输出这一张|本次只生成一张/);
  const withReferences = core.generationBatchPrompt(prompts, '', false, true);
  assert.match(withReferences, /第1张是必须保持包装一致的产品图/);
  assert.match(withReferences, /后续图片依次是第01张到第10张提示词各自关联的视觉参考/);
});

test('Vault Markdown 包含 UUID、嵌入与双向链接', () => {
  const product = { id: 'product-uuid', name: '产品/A' };
  const batch = { id: 'batch-uuid', name: '秋季批次' };
  const prompt = { id: 'prompt-uuid', number: '07', text: '生成主图' };
  const md = core.promptMarkdown({ product, batch, prompt, assets: [{ id: 'asset', fileName: '产品.png' }] });
  assert.match(md, /uuid: "prompt-uuid"/);
  assert.match(md, /!\[\[产品.png\]\]/);
  assert.match(md, /\[\[产品-A\]\]/);
  assert.match(core.vaultPaths(product, batch, prompt).prompt, /07-prompt-uuid\.md$/);
});
