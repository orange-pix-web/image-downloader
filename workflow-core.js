(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WorkflowCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const safe = (value, fallback = "未命名") => String(value || fallback)
    .replace(/[\\/:*?"<>|#[\]]/g, "-").replace(/\s+/g, " ").trim() || fallback;

  function uuid() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 3 | 8)).toString(16);
    });
  }

  function setFileGeneratedStatus(text, done) {
    const original = String(text ?? '');
    const bom = original.startsWith('\uFEFF') ? '\uFEFF' : '';
    let body = original.slice(bom.length);
    const newline = body.includes('\r\n') ? '\r\n' : '\n';
    // 仅处理文件开头首个非空行的状态标记，正文中的相同文字保持原样。
    body = body.replace(/^(?:[ \t]*\r?\n)*[ \t]*(?:#{1,6}[ \t]*)?已生图[ \t]*(?:\r?\n|$)/, '');
    return bom + (done ? `已生图${newline}` : '') + body;
  }

  function parseNumberedPrompts(text) {
    const source = String(text || "").trim();
    if (!source) return [];
    const bracketMarker = /(?:^|\n)\s*(?:#{1,6}\s*)?【\s*(?:第\s*\d{1,4}\s*张\s*[｜|]\s*)?(?:生图\s*)?提示词\s*(\d{1,4})(?:\s*[｜|]\s*[^】\n]*)?\s*】\s*/g;
    const numberedMarker = /(?:^|\n)\s*(?:#{1,4}\s*)?(?:提示词\s*)?(\d{1,4})\s*[.、:：)）-]\s*/g;
    const bracketHits = [...source.matchAll(bracketMarker)];
    const hits = bracketHits.length ? bracketHits : [...source.matchAll(numberedMarker)];
    if (!hits.length) return [{ number: "1", text: source }];
    return hits.map((hit, index) => ({
      number: hit[1],
      text: source.slice(hit.index + hit[0].length, hits[index + 1]?.index ?? source.length)
        .trim()
        .replace(/^```(?:text|markdown)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim()
    })).filter(item => item.text);
  }

  function renumber(items, start = 1, pad = 0) {
    const first = Math.max(0, Number(start) || 1);
    return items.map((item, index) => ({
      ...item,
      number: String(first + index).padStart(Math.max(0, Number(pad) || 0), "0")
    }));
  }

  function move(items, from, to) {
    const copy = items.slice();
    if (from < 0 || to < 0 || from >= copy.length || to >= copy.length || from === to) return copy;
    const [item] = copy.splice(from, 1);
    copy.splice(to, 0, item);
    return copy;
  }

  function batchReferences(items, batchSize) {
    const size = Math.max(1, Number(batchSize) || 1);
    if (!items.length) return [[]];
    const batches = [];
    for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
    return batches;
  }

  function groupPromptsByProduct(prompts, groupSize = 10) {
    const size = Math.max(1, Number(groupSize) || 10);
    const products = new Map();
    for (const prompt of prompts || []) {
      if (!products.has(prompt.productId)) products.set(prompt.productId, []);
      products.get(prompt.productId).push(prompt);
    }
    const groups = [];
    for (const [productId, items] of products) {
      for (let index = 0; index < items.length; index += size) groups.push({ productId, prompts: items.slice(index, index + size) });
    }
    return groups;
  }

  function stripStyleDescriptions(text) {
    const parts = String(text || '').split(/(?<=[。！？!?])|\n+/).map(part => part.trim()).filter(Boolean);
    const styleOnly = part => (
      /^(?:整体|画面整体|最终画面|成片|视觉呈现).*(?:风格|质感|氛围|效果)/.test(part) ||
      /^(?:整体采用|采用).*(?:风格|视觉|质感)/.test(part) ||
      /^(?:高清|超清|8K).*(?:摄影|质感|风格|效果)/i.test(part)
    );
    return parts.filter(part => !styleOnly(part)).join('').trim();
  }

  function generationAssets(assets, promptOrPrompts, includeReferences = false) {
    const prompts = Array.isArray(promptOrPrompts) ? promptOrPrompts : [promptOrPrompts];
    const byId = new Map((assets || []).map(asset => [asset.id, asset]));
    const linked = prompts.flatMap(prompt => prompt?.assetIds || []).map(id => byId.get(id)).filter(Boolean);
    const product = linked.find(asset => asset.kind === 'product');
    const references = [];
    const seen = new Set();
    for (const asset of linked) {
      if (asset.kind !== 'reference' || seen.has(asset.id)) continue;
      seen.add(asset.id); references.push(asset);
    }
    return [...(product ? [product] : []), ...(includeReferences ? references : [])];
  }

  function generationPrompt(text, customStyle = '', stripOriginalStyle = true, includeSingleOutputConstraint = true) {
    let clean = (stripOriginalStyle ? stripStyleDescriptions(text) : String(text || '').trim()).trim();
    if (!includeSingleOutputConstraint) {
      clean = clean
        .replace(/(?:只输出|本次只生成|只生成)\s*(?:这一张|一张)[^。！？!?]*(?:主图|成图|图片)[^。！？!?]*[。！？!?]?/g, '')
        .replace(/输出约束：\s*本次只生成一张[^。！？!?]*[。！？!?]?\s*(?:只呈现一个设计方案[；;，,、]?)?/g, '')
        .trim();
    }
    clean = clean.replace(/“\s+/g, '“').replace(/\s+”/g, '”');
    const style = String(customStyle || '').trim();
    const styled = style ? `${clean}\n\n统一风格要求：${style}` : clean;
    if (!styled) return '';
    return includeSingleOutputConstraint
      ? `${styled}\n\n输出约束：本次只生成一张完整的 1:1 正方形成图，只呈现一个设计方案；禁止九宫格、宫格图、拼图、分镜、联系表、多画面或多版式并排。`
      : styled;
  }

  function generationBatchPrompt(prompts, customStyle = '', stripOriginalStyle = true, includeReferences = false) {
    const items = (prompts || []).slice(0, 10);
    if (!items.length) return '';
    const count = items.length;
    if (count === 1) {
      const imageRule = includeReferences ? '第1张上传图片是产品外观依据，其余图片只作为本条提示词的视觉参考。' : '本次只上传1张产品图，商品包装以此图为准。';
      return `${imageRule}\n\n【提示词${items[0].number || '01'}】\n${generationPrompt(items[0].text, customStyle, stripOriginalStyle)}`;
    }
    const body = items.map((prompt, index) => {
      const number = String(index + 1).padStart(2, '0');
      return `【第${number}张｜提示词${prompt.number || number}】\n${generationPrompt(prompt.text, customStyle, stripOriginalStyle, false)}`;
    }).join('\n\n');
    const imageRule = includeReferences
      ? `本次上传图片的第1张是必须保持包装一致的产品图；后续图片依次是第01张到第${String(count).padStart(2, '0')}张提示词各自关联的视觉参考，只学习对应参考的构图、配色和信息层级，不得把参考图中的原商品当作主体。`
      : '本次只上传同一张产品图，不包含视觉参考图。';
    return `${imageRule}\n\n请严格按照下面 ${count} 套提示词生成 ${count} 张相互独立的 1:1 正方形图片。每套提示词只对应一张成图，并按第01张到第${String(count).padStart(2, '0')}张的顺序分别生成到同一个结果画廊。不要九宫格，不要拼图，不要把多套方案合成在一张图中，不要遗漏，也不要只生成第一张。\n\n${body}`;
  }

  function vaultPaths(product, batch, prompt) {
    const p = safe(product.name, product.id);
    const b = safe(batch.name, batch.id);
    const n = safe(prompt.number, "1");
    const base = `AI图片工作流/产品/${p}`;
    return {
      product: `${base}/${p}.md`,
      batch: `${base}/批次/${b}.md`,
      prompt: `${base}/批次/${b}/提示词/${n}-${prompt.id}.md`,
      assets: `${base}/批次/${b}/素材`,
      outputs: `${base}/批次/${b}/成图`
    };
  }

  function frontmatter(fields) {
    const rows = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value ?? "")}`);
    return `---\n${rows.join("\n")}\n---`;
  }

  function promptMarkdown({ product, batch, prompt, assets = [], generations = [] }) {
    const paths = vaultPaths(product, batch, prompt);
    const productTitle = safe(product.name, product.id);
    const batchTitle = safe(batch.name, batch.id);
    const images = assets.map(a => `![[${safe(a.fileName, a.id)}]]`).join("\n");
    const outputs = generations.map(g => `![[${safe(g.fileName, g.id)}]]`).join("\n");
    return `${frontmatter({ type: "ai-image-prompt", uuid: prompt.id, product_uuid: product.id, batch_uuid: batch.id, number: prompt.number, status: prompt.status || "ready" })}\n# 提示词 ${prompt.number}\n\n产品：[[${productTitle}]]\n\n批次：[[${batchTitle}]]\n\n## 提示词\n\n${prompt.text}\n\n## 关联素材\n\n${images || "暂无"}\n\n## 生成结果\n\n${outputs || "暂无"}\n\n反向链接：[[${batchTitle}]] · [[${productTitle}]]\n`;
  }

  return { uuid, safe, setFileGeneratedStatus, parseNumberedPrompts, renumber, move, batchReferences, groupPromptsByProduct, stripStyleDescriptions, generationAssets, generationPrompt, generationBatchPrompt, vaultPaths, promptMarkdown };
});
