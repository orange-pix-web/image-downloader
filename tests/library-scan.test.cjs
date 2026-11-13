const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const core = require('../workflow-core.js');
test('豆包反推文件按正文标题识别，普通说明文件不误收录', () => {
  assert.equal(core.isPromptLibraryFile('羔羊益生液/牧德旺/豆包反推/豆包反推1-27.md', '【生图提示词01｜方案】正文'), true);
  assert.equal(core.isPromptLibraryFile('说明.md', '项目说明，计划整理提示词'), false);
  assert.equal(core.isPromptLibraryFile('提示词.md', '独立提示词正文'), true);
  assert.equal(core.isPromptLibraryFile('图片.png', '【生图提示词01】正文'), false);
});
