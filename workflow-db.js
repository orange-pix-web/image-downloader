(function (root) {
  const DB_NAME = "ai-image-workflow";
  const DB_VERSION = 1;
  const STORES = ["products", "batches", "assets", "prompts", "generations", "settings"];

  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of STORES) {
          if (db.objectStoreNames.contains(name)) continue;
          const store = db.createObjectStore(name, { keyPath: "id" });
          if (name !== "settings") {
            if (["batches", "assets", "prompts", "generations"].includes(name)) store.createIndex("batchId", "batchId");
            if (["batches", "assets", "prompts"].includes(name)) store.createIndex("productId", "productId");
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function tx(storeName, mode, run) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let result;
      try { result = run(store); } catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB 事务已取消"));
    });
  }

  const put = (store, value) => tx(store, "readwrite", objectStore => objectStore.put(value));
  const remove = (store, id) => tx(store, "readwrite", objectStore => objectStore.delete(id));
  async function get(store, id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }
  async function all(store, indexName, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const source = indexName ? db.transaction(store).objectStore(store).index(indexName) : db.transaction(store).objectStore(store);
      const request = indexName ? source.getAll(value) : source.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }
  async function savePromptBatch(batch, rows, source) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['prompts', 'batches', 'settings'], 'readwrite');
      const prompts = transaction.objectStore('prompts'), settings = transaction.objectStore('settings');
      let added = 0, duplicates = 0;
      const fail = message => { transaction.abort(); reject(new Error(message)); };
      const receipt = settings.get(source.id);
      receipt.onsuccess = () => {
        if (receipt.result && receipt.result.batchId !== batch.id) { fail('此网页回复已被其他批次读取，已阻止重复归属'); return; }
        const batchRequest = transaction.objectStore('batches').get(batch.id);
        batchRequest.onsuccess = () => {
        if (batchRequest.result?.replySource && batchRequest.result.replySource.id !== source.id) { fail('此批次已保存另一条回复，已阻止覆盖原来源'); return; }
        const request = prompts.getAll();
        request.onsuccess = () => {
          const existing = request.result;
          for (const row of rows) {
            const previous = existing.find(item => item.batchId === batch.id && item.number === row.number);
            if (previous) continue; // 保留已保存的 ID、人工编辑及关联，仅补齐缺失条目。
            const normalize = text => String(text || '').normalize('NFKC').replace(/\s+/g, '');
            const duplicate = existing.find(item => normalize(item.text) === normalize(row.text));
            if (duplicate) { row.duplicateOf = duplicate.id; row.status = 'needs-review'; duplicates++; }
            prompts.put(row); existing.push(row); added++;
          }
          settings.put({ ...source, batchId: batch.id, readAt: Date.now() });
          transaction.objectStore('batches').put({ ...batch, status: 'prompts-ready', replySource: source, updatedAt: Date.now() });
        };
        };
      };
      transaction.oncomplete = () => resolve({ added, duplicates });
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('批次保存已取消，未写入部分数据'));
    });
  }
  root.WorkflowDB = { open, put, get, all, remove, savePromptBatch, STORES };
})(globalThis);
