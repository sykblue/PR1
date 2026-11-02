"use strict";

(() => {
  const database = "hairline-photo-handoff", store = "photos", lifetime = 5 * 60 * 1000;
  function transaction(work) {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error("Temporary photo storage unavailable")); return; }
      const opening = window.indexedDB.open(database, 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore(store);
      opening.onerror = () => reject(opening.error);
      opening.onblocked = () => reject(new Error("Temporary photo storage blocked"));
      opening.onsuccess = () => {
        const db = opening.result;
        db.onversionchange = () => db.close();
        const tx = db.transaction(store, "readwrite");
        let result;
        tx.oncomplete = () => { db.close(); resolve(result); };
        tx.onabort = tx.onerror = () => { db.close(); reject(tx.error || new Error("Photo transfer failed")); };
        try { work(tx.objectStore(store), (value) => { result = value; }); }
        catch (error) { tx.abort(); reject(error); }
      };
    });
  }
  const clear = () => transaction((photos) => photos.clear());
  const remove = (token) => transaction((photos) => photos.delete(token));
  async function put(file, owner) {
    if (!(file instanceof Blob) || !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error("Unsupported photo");
    const token = window.crypto.randomUUID();
    await transaction((photos) => {
      photos.clear();
      photos.put({ file, owner, createdAt: Date.now() }, token);
    });
    return token;
  }
  async function take(token, owner) {
    if (!/^[a-f0-9-]{36}$/.test(token || "")) return null;
    return transaction((photos, finish) => {
      const request = photos.get(token);
      request.onsuccess = () => {
        const value = request.result;
        photos.delete(token);
        if (value && value.owner === owner && Date.now() - value.createdAt >= 0 &&
          Date.now() - value.createdAt < lifetime && value.file instanceof Blob) finish(value.file);
        else finish(null);
      };
    });
  }
  const prune = () => transaction((photos) => {
    const request = photos.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const age = Date.now() - cursor.value.createdAt;
      if (!Number.isFinite(age) || age < 0 || age >= lifetime) cursor.delete();
      cursor.continue();
    };
  });
  window.HairlinePhotoHandoff = { put, take, remove, clear };
  // Initial authentication announces the current account; only later changes clear pending photos.
  window.HairlineAuth.ready.then(() => {
    prune().catch(() => {});
    document.addEventListener("auth-changed", () => { clear().catch(() => {}); });
  }).catch(() => {});
})();

