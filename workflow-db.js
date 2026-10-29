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
  root.WorkflowDB = { open, put, get, all, remove, STORES };
})(globalThis);
