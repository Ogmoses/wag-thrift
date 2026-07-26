// js/offline-queue.js
//
// Lets a field agent keep working with zero signal:
//   1. A customer they've searched for while online gets cached locally,
//      so it can still be found (clearly labeled as cached) with no signal.
//   2. A cash collection recorded with no signal gets queued locally
//      instead of failing outright, and syncs automatically the moment a
//      connection comes back — either in the background or via the
//      "Sync Now" button, whichever the phone/browser actually supports.
//
// Uses IndexedDB (not localStorage) because it handles larger amounts of
// structured data reliably and is the standard approach for this kind of
// offline queue.

const OFFLINE_DB_NAME = 'wag_offline';
const OFFLINE_DB_VERSION = 1;
const STORE_QUEUE = 'pending_collections';
const STORE_CUSTOMER_CACHE = 'customer_cache';

function _openOfflineDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    req.onupgradeneeded = () => {
      const dbx = req.result;
      if (!dbx.objectStoreNames.contains(STORE_QUEUE)) {
        dbx.createObjectStore(STORE_QUEUE, { keyPath: 'localId' });
      }
      if (!dbx.objectStoreNames.contains(STORE_CUSTOMER_CACHE)) {
        dbx.createObjectStore(STORE_CUSTOMER_CACHE, { keyPath: 'phone' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function _withStore(storeName, mode, fn) {
  const dbx = await _openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = dbx.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = fn(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

// ─── CUSTOMER CACHE — populated on every successful search while online,
// read as a fallback when a search fails due to no connection. ──────────

async function cacheCustomerLookup(phone, payload) {
  try {
    await _withStore(STORE_CUSTOMER_CACHE, 'readwrite', store => {
      store.put({ phone, payload, cachedAt: new Date().toISOString() });
    });
  } catch (e) {
    console.error('offline-queue: could not cache customer lookup', e);
  }
}

async function getCachedCustomerLookup(phone) {
  try {
    const dbx = await _openOfflineDB();
    return await new Promise((resolve, reject) => {
      const tx = dbx.transaction(STORE_CUSTOMER_CACHE, 'readonly');
      const req = tx.objectStore(STORE_CUSTOMER_CACHE).get(phone);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error('offline-queue: could not read cached customer lookup', e);
    return null;
  }
}

// ─── COLLECTION QUEUE — a deposit recorded with no signal sits here until
// it can be safely sent for real. ────────────────────────────────────────

async function queueCollection(record) {
  const localId = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const entry = { localId, ...record, queuedAt: new Date().toISOString(), attempts: 0, lastError: null };
  await _withStore(STORE_QUEUE, 'readwrite', store => { store.put(entry); });
  return entry;
}

async function getPendingCollections() {
  try {
    const dbx = await _openOfflineDB();
    return await new Promise((resolve, reject) => {
      const tx = dbx.transaction(STORE_QUEUE, 'readonly');
      const req = tx.objectStore(STORE_QUEUE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error('offline-queue: could not read pending collections', e);
    return [];
  }
}

async function getPendingCount() {
  const rows = await getPendingCollections();
  return rows.length;
}

async function removePendingCollection(localId) {
  await _withStore(STORE_QUEUE, 'readwrite', store => { store.delete(localId); });
}

async function markPendingCollectionFailed(localId, errorMessage) {
  const rows = await getPendingCollections();
  const row = rows.find(r => r.localId === localId);
  if (!row) return;
  row.attempts = (row.attempts || 0) + 1;
  row.lastError = errorMessage;
  await _withStore(STORE_QUEUE, 'readwrite', store => { store.put(row); });
}
