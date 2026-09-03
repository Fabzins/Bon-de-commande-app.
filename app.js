/* ==========================================================================
   Bons de Commande — logique application (stockage 100% local / localStorage)
   ========================================================================== */

/* ---------- Stockage ---------- */
const DB = {
  suppliers: 'bc_suppliers',
  headers:   'bc_headers',
  products:  'bc_products',
  orders:    'bc_orders',
  deliveryAddresses: 'bc_delivery_addresses',
  stamps: 'bc_stamps',
  signatureTitles: 'bc_signature_titles',
};

function load(key) {
  try { return JSON.parse(localStorage.getItem(key)) || []; }
  catch (e) { return []; }
}
function save(key, data) {
  const before = load(key);
  const normalized = (Array.isArray(data) ? data : []).map(item => {
    if (!item || typeof item !== 'object') return item;
    return item.id != null ? item : { ...item, id: uid() };
  });
  // Une modification locale reçoit une version monotone. Cela permet de
  // comparer une version locale à une version reçue depuis l'autre appareil
  // sans écraser silencieusement une modification plus récente.
  const beforeMap = new Map((Array.isArray(before) ? before : []).filter(x => x?.id != null).map(x => [String(x.id), x]));
  const stamped = normalized.map(item => {
    if (!item || typeof item !== 'object' || item.id == null) return item;
    const prev = beforeMap.get(String(item.id));
    if (recordSignature(prev) !== recordSignature(item)) {
      return { ...item, _syncUpdatedAt: nextCloudClock(), _syncDeviceId: getCloudDeviceId() };
    }
    return item;
  });
  localStorage.setItem(key, JSON.stringify(stamped));
  markCloudChanges(key, before, stamped);
  queueFolderSync();
  queueCloudSync();
}

/* ---------- Stockage local Android : dossier choisi par l'utilisateur ---------- */
const STORAGE_DB_KEYS = Object.values(DB);
const STORAGE_FILE = 'bon-de-commande-data.json';
let storageFolderHandle = null;
let folderSyncTimer = null;
let folderSyncBusy = false;

function snapshotLocalData() {
  const data = {};
  STORAGE_DB_KEYS.forEach(key => { data[key] = load(key); });
  return { version: 1, app: 'Bons de Commande', updatedAt: new Date().toISOString(), data };
}

async function getStoredFolderHandle() {
  try {
    return await new Promise((resolve, reject) => {
      const req = indexedDB.open('bc-app-storage', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('handles');
      req.onsuccess = () => {
        const db = req.result; const tx = db.transaction('handles', 'readonly');
        const get = tx.objectStore('handles').get('storageFolder');
        get.onsuccess = () => { db.close(); resolve(get.result || null); };
        get.onerror = () => { db.close(); resolve(null); };
      };
      req.onerror = () => reject(req.error);
    });
  } catch (_) { return null; }
}

async function storeFolderHandle(handle) {
  try {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('bc-app-storage', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('handles');
      req.onsuccess = () => {
        const db = req.result; const tx = db.transaction('handles', 'readwrite');
        tx.objectStore('handles').put(handle, 'storageFolder');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
      req.onerror = () => reject(req.error);
    });
  } catch (_) {}
}

async function ensureFolderPermission(handle, request = false) {
  if (!handle) return false;
  try {
    let p = await handle.queryPermission({ mode: 'readwrite' });
    if (p !== 'granted' && request) p = await handle.requestPermission({ mode: 'readwrite' });
    return p === 'granted';
  } catch (_) { return false; }
}

async function writeFolderData() {
  if (!storageFolderHandle || folderSyncBusy) return;
  if (!(await ensureFolderPermission(storageFolderHandle))) return;
  folderSyncBusy = true;
  try {
    const fileHandle = await storageFolderHandle.getFileHandle(STORAGE_FILE, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(snapshotLocalData(), null, 2));
    await writable.close();
    localStorage.setItem('bc_storage_folder_name', storageFolderHandle.name || 'Dossier choisi');
    updateStorageButton();
  } catch (_) {
    toast('Impossible d’écrire dans le dossier de stockage.');
  } finally { folderSyncBusy = false; }
}

function queueFolderSync() {
  if (!storageFolderHandle) return;
  clearTimeout(folderSyncTimer);
  folderSyncTimer = setTimeout(() => writeFolderData(), 300);
}

async function restoreFromFolderIfAvailable(handle) {
  try {
    if (!(await ensureFolderPermission(handle))) return false;
    const fh = await handle.getFileHandle(STORAGE_FILE);
    const file = await fh.getFile();
    const parsed = JSON.parse(await file.text());
    if (!parsed?.data || typeof parsed.data !== 'object') return false;
    STORAGE_DB_KEYS.forEach(key => {
      if (Object.prototype.hasOwnProperty.call(parsed.data, key)) localStorage.setItem(key, JSON.stringify(parsed.data[key] || []));
    });
    return true;
  } catch (_) { return false; }
}

function updateStorageButton() {
  const btn = document.getElementById('storageBtn');
  if (!btn) return;
  const name = localStorage.getItem('bc_storage_folder_name');
  btn.textContent = name ? 'Stockage ✓' : 'Stockage';
  btn.title = name ? `Dossier : ${name}` : 'Choisir le dossier de stockage';
}

function openStorageModal() {
  const supported = 'showDirectoryPicker' in window;
  const current = localStorage.getItem('bc_storage_folder_name');
  openModal('Stockage local', `
    <div class="card__subtitle" style="margin-bottom:16px">Les données restent sur cet appareil. Vous pouvez choisir un dossier visible sur le téléphone pour conserver automatiquement une copie des données de l’application.</div>
    <div class="field"><label>Dossier de stockage</label><div class="input-like" style="padding:10px 12px;border:1px solid var(--paper-line);border-radius:8px;background:var(--paper)" id="storageFolderLabel">${escapeHtml(current || 'Aucun dossier sélectionné')}</div></div>
    ${supported ? '' : '<div class="notice">Ce navigateur ne permet pas de sélectionner un dossier directement. Le stockage interne de l’application reste disponible.</div>'}
    <div class="modal__actions">
      <button type="button" class="btn btn-ghost" data-close-modal>Fermer</button>
      ${supported ? '<button type="button" class="btn btn-primary" id="chooseStorageFolder">Choisir un dossier</button>' : ''}
      ${current ? '<button type="button" class="btn btn-ghost" id="backupStorageNow">Sauvegarder maintenant</button>' : ''}
    </div>`, modal => {
      modal.querySelector('#chooseStorageFolder')?.addEventListener('click', async () => {
        try {
          const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'bc-storage' });
          storageFolderHandle = handle;
          await storeFolderHandle(handle);
          await writeFolderData();
          closeModal();
          toast(`Stockage configuré : ${handle.name}`);
          updateStorageButton();
        } catch (e) {
          if (e?.name !== 'AbortError') toast('Sélection du dossier annulée ou refusée.');
        }
      });
      modal.querySelector('#backupStorageNow')?.addEventListener('click', async () => {
        await writeFolderData(); closeModal(); toast('Données sauvegardées dans le dossier.');
      });
    });
}

async function initLocalStorageFolder() {
  updateStorageButton();
  if (!('showDirectoryPicker' in window)) return;
  storageFolderHandle = await getStoredFolderHandle();
  if (!storageFolderHandle) return;
  const restored = await restoreFromFolderIfAvailable(storageFolderHandle);
  updateStorageButton();
  if (restored) toast('Données restaurées depuis le dossier de stockage.');
}

/* ==========================================================================
   SYNCHRONISATION CLOUD (Firebase, optionnelle)
   Permet de retrouver les mêmes données sur plusieurs appareils (téléphone,
   PC...). Nécessite une connexion internet et un projet Firebase gratuit
   configuré par l'utilisateur (voir bouton « Synchronisation »).
   ========================================================================== */
const CLOUD_SYNC_CONFIG_KEY = 'bc_cloud_sync_config';
const CLOUD_PENDING_KEY = 'bc_cloud_pending_v3';
const CLOUD_DEVICE_KEY = 'bc_cloud_device_id';
const CLOUD_CLOCK_KEY = 'bc_cloud_logical_clock';
const FIREBASE_SDK_VERSION = '10.13.2';
const CLOUD_SCHEMA_VERSION = 3;

// Projet Firebase de l'application. La configuration Web Firebase n'est pas
// une clé privée ; la sécurité des données repose sur Authentication +
// les règles Firestore. Le code d'équipe reste utilisé comme identifiant
// de l'espace de travail partagé entre Android et PC.
const DEFAULT_FIREBASE_CONFIG = {
  apiKey: "AIzaSyAu6ZBROVcvb1v_M_LqHLDtQWBs53_A-dA",
  authDomain: "bon-de-commande-36c47.firebaseapp.com",
  projectId: "bon-de-commande-36c47",
  storageBucket: "bon-de-commande-36c47.firebasestorage.app",
  messagingSenderId: "476598629619",
  appId: "1:476598629619:web:b6d267e901f943060ab386"
};

let cloudSync = { status: 'off', error: null, lastSyncedAt: null };
let fbApp = null, fbDb = null, fbUnsubscribers = [];
let cloudPushTimer = null;
let applyingRemoteSnapshot = false;
let firebaseScriptsPromise = null;
let cloudInitialSyncDone = false;

function getCloudSyncConfig() {
  try { return JSON.parse(localStorage.getItem(CLOUD_SYNC_CONFIG_KEY)) || null; }
  catch (_) { return null; }
}
function saveCloudSyncConfig(cfg) { localStorage.setItem(CLOUD_SYNC_CONFIG_KEY, JSON.stringify(cfg)); }
function clearCloudSyncConfig() { localStorage.removeItem(CLOUD_SYNC_CONFIG_KEY); }

function getCloudDeviceId() {
  let id = localStorage.getItem(CLOUD_DEVICE_KEY);
  if (!id) {
    id = 'dev_' + uid();
    localStorage.setItem(CLOUD_DEVICE_KEY, id);
  }
  return id;
}

function getCloudClock() {
  const n = Number(localStorage.getItem(CLOUD_CLOCK_KEY) || 0);
  return Number.isFinite(n) ? n : 0;
}
function nextCloudClock(remoteTime = 0) {
  const next = Math.max(Date.now(), getCloudClock() + 1, Number(remoteTime) || 0);
  localStorage.setItem(CLOUD_CLOCK_KEY, String(next));
  return next;
}
function observeCloudClock(remoteTime) {
  if (Number.isFinite(Number(remoteTime))) nextCloudClock(Number(remoteTime));
}

function getCloudPending() {
  try { return JSON.parse(localStorage.getItem(CLOUD_PENDING_KEY)) || {}; }
  catch (_) { return {}; }
}
function saveCloudPending(pending) { localStorage.setItem(CLOUD_PENDING_KEY, JSON.stringify(pending)); }
function pendingKey(collection, id) { return `${collection}::${id}`; }

function recordSignature(item) {
  try { return JSON.stringify(item); } catch (_) { return String(item); }
}

/*
 * Chaque modification locale est placée dans une petite file persistante.
 * Contrairement à l'ancienne V19, une synchronisation distante ne peut donc
 * pas écraser une modification locale qui attend encore son envoi.
 */
function markCloudChanges(key, before, after) {
  if (applyingRemoteSnapshot) return;
  const pending = getCloudPending();
  const oldMap = new Map((Array.isArray(before) ? before : []).filter(x => x?.id != null).map(x => [String(x.id), x]));
  const newMap = new Map((Array.isArray(after) ? after : []).filter(x => x?.id != null).map(x => [String(x.id), x]));
  const ids = new Set([...oldMap.keys(), ...newMap.keys()]);

  ids.forEach(id => {
    const oldItem = oldMap.get(id);
    const newItem = newMap.get(id);
    if (recordSignature(oldItem) === recordSignature(newItem)) return;
    const pk = pendingKey(key, id);
    pending[pk] = {
      collection: key,
      id,
      deleted: !newItem,
      data: newItem || null,
      deviceId: getCloudDeviceId()
    };
  });
  saveCloudPending(pending);
}

function loadFirebaseScripts() {
  if (firebaseScriptsPromise) return firebaseScriptsPromise;
  const urls = [
    `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app-compat.js`,
    `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-auth-compat.js`,
    `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-firestore-compat.js`,
  ];
  firebaseScriptsPromise = urls.reduce((p, url) => p.then(() => new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${url}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Impossible de charger le SDK Firebase (vérifiez la connexion internet).'));
    document.head.appendChild(s);
  })), Promise.resolve());
  return firebaseScriptsPromise;
}

function updateSyncButton() {
  const btn = document.getElementById('syncBtn');
  if (!btn) return;
  const cfg = getCloudSyncConfig();
  if (!cfg || !cfg.enabled) { btn.textContent = 'Synchronisation'; btn.title = 'Non configurée'; return; }
  const labels = { off: 'Synchro ⏸', loading: 'Synchro…', connected: 'Synchro ✓', error: 'Synchro ⚠' };
  btn.textContent = labels[cloudSync.status] || 'Synchronisation';
  btn.title = cloudSync.status === 'error' ? ('Erreur : ' + (cloudSync.error || '')) :
    cloudSync.lastSyncedAt ? ('Dernière synchro : ' + new Date(cloudSync.lastSyncedAt).toLocaleTimeString('fr-FR')) : '';
}

function applyRemoteRecord(collection, remote) {
  if (!remote || remote.id == null) return false;
  const id = String(remote.id);
  const remoteVersion = Number(remote._syncUpdatedAt || 0);
  const remoteDevice = String(remote._syncDeviceId || remote._deviceId || 'remote');
  observeCloudClock(remoteVersion);

  const pending = getCloudPending();
  const pk = pendingKey(collection, id);
  // Une modification locale non encore confirmée par le cloud reste prioritaire.
  if (pending[pk]) return false;

  const current = load(collection);
  const idx = current.findIndex(x => x && String(x.id) === id);
  const local = idx === -1 ? null : current[idx];
  const localVersion = Number(local?._syncUpdatedAt || 0);
  const localDevice = String(local?._syncDeviceId || '');

  // Le dernier changement logique gagne. En cas d'égalité, le deviceId
  // fournit un ordre déterministe. Si le local est plus récent, on le remet
  // en file d'envoi plutôt que de l'écraser.
  if (local && (localVersion > remoteVersion || (localVersion === remoteVersion && localDevice && localDevice > remoteDevice))) {
    const pendingNow = getCloudPending();
    pendingNow[pk] = { collection, id, deleted: false, data: local, deviceId: getCloudDeviceId(), queuedAt: Date.now() };
    saveCloudPending(pendingNow);
    queueCloudSync();
    return false;
  }

  let changed = false;
  applyingRemoteSnapshot = true;
  try {
    if (remote._deleted) {
      if (idx !== -1) { current.splice(idx, 1); changed = true; }
    } else {
      const clean = { ...remote };
      delete clean._deleted;
      delete clean._deviceId;
      delete clean._serverUpdatedAt;
      if (idx === -1) { current.push(clean); changed = true; }
      else if (recordSignature(current[idx]) !== recordSignature(clean)) { current[idx] = clean; changed = true; }
    }
    if (changed) localStorage.setItem(collection, JSON.stringify(current));
  } finally { applyingRemoteSnapshot = false; }
  if (changed) queueFolderSync();
  return changed;
}

async function migrateLegacyWorkspace(docRef) {
  const snap = await docRef.get();
  if (!snap.exists) return;
  const root = snap.data() || {};
  if (Number(root.schemaVersion || 1) >= CLOUD_SCHEMA_VERSION) return;
  const legacy = root.data || {};
  let batch = fbDb.batch();
  let writes = 0;
  for (const key of STORAGE_DB_KEYS) {
    const arr = Array.isArray(legacy[key]) ? legacy[key] : [];
    for (const item of arr) {
      if (!item || item.id == null) continue;
      const ref = docRef.collection(key).doc(String(item.id));
      batch.set(ref, {
        ...item,
        _deleted: false,
        _syncUpdatedAt: Number(item._syncUpdatedAt || Date.now()),
        _syncDeviceId: String(item._syncDeviceId || 'legacy-v1'),
        _deviceId: 'legacy-v1',
        _migratedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: false });
      writes++;
      if (writes >= 450) {
        await batch.commit();
        batch = fbDb.batch();
        writes = 0;
      }
    }
  }
  if (writes) await batch.commit();
  await docRef.set({ schemaVersion: CLOUD_SCHEMA_VERSION, migratedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
}


function subscribeCloudCollection(docRef, key) {
  return docRef.collection(key).onSnapshot((snap) => {
    let changed = false;
    const remoteIds = new Set();

    snap.docChanges().forEach(change => {
      const id = String(change.doc.id);
      remoteIds.add(id);
      if (change.type === 'added' || change.type === 'modified' || change.type === 'removed') {
        const data = change.doc.data() || {};
        const remote = { ...data, id };
        if (change.type === 'removed') remote._deleted = true;
        changed = applyRemoteRecord(key, remote) || changed;
      }
    });

    // Sur la première photo (et lors d'une reconnexion), les éléments locaux
    // absents du cloud doivent être envoyés. Cela évite un second .get()
    // complet de chaque collection et économise des lectures Firestore.
    const pending = getCloudPending();
    const local = load(key);
    local.forEach(item => {
      if (!item?.id) return;
      const id = String(item.id);
      const pk = pendingKey(key, id);
      if (!remoteIds.has(id) && !pending[pk]) {
        pending[pk] = {
          collection: key, id, deleted: false, data: item,
          deviceId: getCloudDeviceId(), queuedAt: Date.now()
        };
      }
    });
    saveCloudPending(pending);
    if (Object.keys(pending).length) queueCloudSync();

    cloudSync.status = 'connected';
    cloudSync.error = null;
    cloudSync.lastSyncedAt = Date.now();
    updateSyncButton();
    if (changed && cloudInitialSyncDone) {
      toast('Données mises à jour depuis un autre appareil.');
      navigate(state.view, state.view === 'order-form' ? { orderId: state.orderDraft?.id || null } : {});
    }
  }, (err) => {
    cloudSync.status = 'error';
    cloudSync.error = err.message || String(err);
    updateSyncButton();
  });
}

async function startCloudSync() {
  const cfg = getCloudSyncConfig();
  if (!cfg || !cfg.enabled || !cfg.firebaseConfig || !cfg.syncCode) return;
  cloudSync.status = 'loading'; cloudSync.error = null; updateSyncButton();
  try {
    await loadFirebaseScripts();
    if (!fbApp) fbApp = firebase.apps?.length ? firebase.app() : firebase.initializeApp(cfg.firebaseConfig);
    if (!firebase.auth().currentUser) await firebase.auth().signInAnonymously();
    fbDb = firebase.firestore();
    const docRef = fbDb.collection('workspaces').doc(cfg.syncCode);

    await migrateLegacyWorkspace(docRef);
    await docRef.set({ schemaVersion: CLOUD_SCHEMA_VERSION, lastAppVersion: 'V20' }, { merge: true });
    fbUnsubscribers.forEach(fn => { try { fn(); } catch (_) {} });
    fbUnsubscribers = STORAGE_DB_KEYS.map(key => subscribeCloudCollection(docRef, key));
    cloudInitialSyncDone = true;
    await pushCloudSyncNow();
  } catch (err) {
    cloudSync.status = 'error'; cloudSync.error = err.message || String(err); updateSyncButton();
  }
}

function stopCloudSync() {
  clearTimeout(cloudPushTimer);
  fbUnsubscribers.forEach(fn => { try { fn(); } catch (_) {} });
  fbUnsubscribers = [];
  cloudInitialSyncDone = false;
  cloudSync = { status: 'off', error: null, lastSyncedAt: null };
  updateSyncButton();
}

async function pushCloudSyncNow() {
  const cfg = getCloudSyncConfig();
  if (!cfg || !cfg.enabled || !fbDb) return;
  const pending = getCloudPending();
  const entries = Object.values(pending);
  if (!entries.length) {
    cloudSync.status = 'connected'; cloudSync.lastSyncedAt = Date.now(); updateSyncButton();
    return;
  }
  try {
    const workspaceRef = fbDb.collection('workspaces').doc(cfg.syncCode);
    const captured = entries.map(p => ({ ...p, data: p.deleted ? null : (p.data || load(p.collection).find(x => String(x.id) === String(p.id)) || null) }));
    const writes = captured.filter(p => p.deleted || p.data);

    // Firestore limite un batch à 500 écritures. 450 laisse une marge pour les métadonnées.
    for (let i = 0; i < writes.length; i += 450) {
      const batch = fbDb.batch();
      writes.slice(i, i + 450).forEach(p => {
        const ref = workspaceRef.collection(p.collection).doc(String(p.id));
        if (p.deleted) {
          batch.set(ref, {
            id: String(p.id),
            _deleted: true,
            _syncUpdatedAt: Number(p.data?._syncUpdatedAt || p.queuedAt || Date.now()),
            _syncDeviceId: String(p.deviceId || getCloudDeviceId()),
            _deviceId: getCloudDeviceId(),
            _serverUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        } else {
          batch.set(ref, {
            ...p.data,
            id: String(p.id),
            _deleted: false,
            _syncUpdatedAt: Number(p.data?._syncUpdatedAt || p.queuedAt || Date.now()),
            _syncDeviceId: String(p.data?._syncDeviceId || p.deviceId || getCloudDeviceId()),
            _deviceId: getCloudDeviceId(),
            _serverUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
          }, { merge: false });
        }
      });
      await batch.commit();
    }

    const latest = getCloudPending();
    writes.forEach(p => {
      const pk = pendingKey(p.collection, p.id);
      const current = latest[pk];
      const currentData = current?.deleted ? null : current?.data;
      if (current && current.deleted === p.deleted && recordSignature(currentData) === recordSignature(p.data)) delete latest[pk];
    });
    saveCloudPending(latest);
    cloudSync.status = 'connected'; cloudSync.error = null; cloudSync.lastSyncedAt = Date.now(); updateSyncButton();
  } catch (err) {
    cloudSync.status = 'error'; cloudSync.error = err.message || String(err); updateSyncButton();
  }
}

function queueCloudSync() {
  const cfg = getCloudSyncConfig();
  if (!cfg || !cfg.enabled || applyingRemoteSnapshot) return;
  clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(() => pushCloudSyncNow(), 900);
}

function parseFirebaseConfigInput(raw) {
  if (!raw) throw new Error('Le champ est vide.');
  // Normalise les guillemets typographiques (autocorrection du clavier/navigateur)
  const text = raw.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
  const kwIdx = text.search(/firebaseConfig/i);
  const braceStart = text.indexOf('{', kwIdx >= 0 ? kwIdx : 0);
  if (braceStart === -1) throw new Error("Aucune accolade ouvrante « { » trouvée.");
  let depth = 0, end = -1;
  for (let i = braceStart; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error("Accolade fermante « } » manquante : le collage semble incomplet.");
  const objLiteral = text.slice(braceStart, end + 1);
  let obj;
  try {
    // Le bloc collé est du JavaScript valide (pas du JSON strict : clés non guillemetées,
    // virgule finale possible) -> on l'évalue comme un objet plutôt que de le forcer en JSON.
    // eslint-disable-next-line no-new-func
    obj = new Function('return (' + objLiteral + ')')();
  } catch (e) {
    throw new Error('Le bloc collé ne ressemble pas à un objet JavaScript valide.');
  }
  if (!obj || typeof obj !== 'object' || !obj.apiKey || !obj.projectId) {
    throw new Error("Il manque au moins « apiKey » ou « projectId » dans le bloc collé.");
  }
  return obj;
}

function openSyncModal() {
  const cfg = getCloudSyncConfig();
  const configured = !!(cfg && cfg.enabled);
  openModal('Synchronisation entre appareils', configured ? `
    <div class="card__subtitle" style="margin-bottom:16px">Synchronisation active. Utilisez le même code d'équipe sur tous vos appareils pour qu'ils partagent les mêmes données.</div>
    <div class="field"><label>Code d'équipe actuel</label><div class="input-like" style="padding:10px 12px;border:1px solid var(--paper-line);border-radius:8px;background:var(--paper);font-family:var(--font-mono)">${escapeHtml(cfg.syncCode)}</div></div>
    <div class="field"><label>État</label><div class="input-like" style="padding:10px 12px;border:1px solid var(--paper-line);border-radius:8px;background:var(--paper)">${
      cloudSync.status === 'connected' ? '✓ Connecté' : cloudSync.status === 'error' ? ('⚠ Erreur : ' + escapeHtml(cloudSync.error || '')) : cloudSync.status === 'loading' ? 'Connexion…' : 'Inactif'
    }</div></div>
    <div class="modal__actions">
      <button type="button" class="btn btn-ghost" data-close-modal>Fermer</button>
      <button type="button" class="btn btn-ghost" id="syncNowBtn">Forcer une synchro</button>
      <button type="button" class="btn btn-danger" id="disableSyncBtn">Désactiver</button>
    </div>
  ` : `
    <div class="card__subtitle" style="margin-bottom:16px">Firebase est déjà configuré dans cette version. Il suffit de choisir le même code de synchronisation sur ton Android et ton PC. Les données locales restent disponibles même si Firebase ou Internet est indisponible.</div>
    <div class="field"><label>Projet Firebase</label><div class="input-like" style="padding:10px 12px;border:1px solid var(--paper-line);border-radius:8px;background:var(--paper);font-family:var(--font-mono)">${escapeHtml(DEFAULT_FIREBASE_CONFIG.projectId)}</div></div>
    <div class="field"><label>Code de synchronisation</label><input id="syncCodeInput" type="text" placeholder="Ex. BDC-FABRICE-2026" autocomplete="off"><small>Utilise EXACTEMENT le même code sur Android et sur PC. Choisis un code suffisamment difficile à deviner et ne le partage pas.</small></div>
    <div class="modal__actions">
      <button type="button" class="btn btn-ghost" data-close-modal>Annuler</button>
      <button type="button" class="btn btn-primary" id="enableSyncBtn">Activer la synchronisation</button>
    </div>
  `, (modal) => {
    modal.querySelector('#enableSyncBtn')?.addEventListener('click', async () => {
      const code = modal.querySelector('#syncCodeInput').value.trim();
      if (!code) { toast('Merci de renseigner un code de synchronisation.'); return; }
      saveCloudSyncConfig({ firebaseConfig: DEFAULT_FIREBASE_CONFIG, syncCode: code, enabled: true });
      closeModal();
      toast('Synchronisation activée, connexion en cours…');
      await startCloudSync();
    });
    modal.querySelector('#syncNowBtn')?.addEventListener('click', async () => {
      await pushCloudSyncNow();
      toast('Synchronisation forcée.');
    });
    modal.querySelector('#disableSyncBtn')?.addEventListener('click', () => {
      if (!confirm('Désactiver la synchronisation sur cet appareil ? Vos données locales restent intactes.')) return;
      stopCloudSync();
      clearCloudSyncConfig();
      closeModal();
      updateSyncButton();
      toast('Synchronisation désactivée.');
    });
  });
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function fmtMoney(n) {
  return (Number(n) || 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// Variante pour le PDF : jsPDF (police helvetica standard) ne supporte pas le séparateur
// unicode utilisé par toLocaleString('fr-FR'), on formate donc manuellement avec un espace normal.
function fmtMoneyPdf(n) {
  n = Number(n) || 0;
  const neg = n < 0; n = Math.abs(n);
  const [intPart, dec] = n.toFixed(2).split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (neg ? '-' : '') + grouped + ',' + dec;
}
function fmtQuantity(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return '0';
  return value.toLocaleString('fr-FR', { maximumFractionDigits: 3, useGrouping: true });
}
function fmtQuantityPdf(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return '0';
  const raw = value.toLocaleString('fr-FR', { maximumFractionDigits: 3, useGrouping: true });
  return raw.replace(/[\u202F\u00A0]/g, ' ');
}
function parseQuantity(value) {
  const normalized = String(value ?? '').replace(/\s/g, '').replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}
function ensureSignatureTitles() {
  // Les titres sont une bibliothèque de titres réutilisables, mais aucun titre
  // n'est considéré comme "par défaut". Le lien réel se fait sur l'émetteur.
  return load(DB.signatureTitles);
}
function getHeaderSignatureTitle(header, titles = ensureSignatureTitles()) {
  if (!header?.signatureTitleId) return null;
  return titles.find(t => t.id === header.signatureTitleId) || null;
}

function getHeaderSignatureStamp(header, stamps = load(DB.stamps)) {
  if (!header?.signatureStampId) return null;
  return stamps.find(s => s.id === header.signatureStampId) || null;
}

function getOrderSignatureTitle(order, header, titles = ensureSignatureTitles()) {
  if (order?.signatureTitleId) {
    return titles.find(t => t.id === order.signatureTitleId) || null;
  }
  return getHeaderSignatureTitle(header, titles);
}

function getOrderSignatureStamp(order, header, stamps = load(DB.stamps)) {
  if (order?.signatureStampId) {
    return stamps.find(s => s.id === order.signatureStampId) || null;
  }
  return getHeaderSignatureStamp(header, stamps);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Etat ---------- */
let state = {
  view: 'dashboard',
  orderDraft: null,   // bon en cours de création/édition
  historyFilter: '',
  historyEmitterFilter: '',
};

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------- Modal ---------- */
function openModal(title, bodyHtml, mountFn) {
  const overlay = document.getElementById('modalOverlay');
  const modal = document.getElementById('modal');
  modal.innerHTML = `
    <div class="modal__head">
      <h3 class="modal__title">${title}</h3>
      <button class="modal__close" data-close-modal aria-label="Fermer">&times;</button>
    </div>
    <div class="modal__body">${bodyHtml}</div>
  `;
  overlay.classList.add('show');
  if (mountFn) mountFn(modal);
}
function closeModal() {
  document.getElementById('modalOverlay').classList.remove('show');
}
document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'modalOverlay' || e.target.closest('[data-close-modal]')) closeModal();
});

/* ==========================================================================
   NAVIGATION
   ========================================================================== */
const VIEW_TITLES = {
  dashboard: 'Tableau de bord',
  'order-form': 'Nouveau bon de commande',
  history: 'Historique des bons',
  suppliers: 'Fournisseurs',
  products: 'Produits',
  'delivery-addresses': 'Adresses de livraison',
  headers: 'Émetteur',
};

function navigate(view, params = {}) {
  state.view = view;
  document.getElementById('viewTitle').textContent =
    params.title || VIEW_TITLES[view] || '';
  document.querySelectorAll('.nav__link').forEach((btn) =>
    btn.classList.toggle('active', btn.dataset.view === view)
  );
  document.getElementById('nav').classList.remove('open');

  if (view === 'dashboard') renderDashboard();
  if (view === 'order-form') renderOrderForm(params.orderId || null);
  if (view === 'history') renderHistory();
  if (view === 'suppliers') renderSuppliers();
  if (view === 'products') renderProducts();
  if (view === 'delivery-addresses') renderDeliveryAddresses();
  if (view === 'headers') renderHeaders();
}

document.querySelectorAll('.nav__link').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.view === 'order-form') state.orderDraft = null; // repart d'un bon vierge
    navigate(btn.dataset.view);
  });
});
document.getElementById('menuToggle').addEventListener('click', () => {
  document.getElementById('nav').classList.toggle('open');
});

/* ==========================================================================
   DASHBOARD
   ========================================================================== */
function renderDashboard() {
  const suppliers = load(DB.suppliers);
  const orders = load(DB.orders);
  const products = load(DB.products);
  const total = orders.reduce((s, o) => s + (o.total || 0), 0);
  const recent = [...orders].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);

  const view = document.getElementById('view');
  view.innerHTML = `
    <div class="stat-row">
      <div class="stat"><div class="stat__label">Bons émis</div><div class="stat__value">${orders.length}</div></div>
      <div class="stat"><div class="stat__label">Fournisseurs</div><div class="stat__value">${suppliers.length}</div></div>
      <div class="stat"><div class="stat__label">Produits au catalogue</div><div class="stat__value">${products.length}</div></div>
      <div class="stat"><div class="stat__label">Montant total commandé</div><div class="stat__value">${fmtMoney(total)}</div></div>
    </div>

    <div class="card">
      <div class="card__head">
        <div>
          <h2 class="card__title">Derniers bons de commande</h2>
          <div class="card__subtitle">Les 6 bons les plus récents, tous fournisseurs confondus</div>
        </div>
        <button class="btn btn-brass" id="goNewOrder">+ Nouveau bon</button>
      </div>
      ${recent.length ? renderOrdersTable(recent, suppliers) : emptyState('Aucun bon pour le moment', 'Créez votre premier bon de commande pour le voir apparaître ici.')}
    </div>
  `;
  document.getElementById('goNewOrder').addEventListener('click', () => { state.orderDraft = null; navigate('order-form'); });
  bindOrdersTableActions();

  if (suppliers.length === 0) {
    toast('Astuce : commencez par ajouter un fournisseur.');
  }
}

function emptyState(title, sub) {
  return `<div class="empty">
    <svg viewBox="0 0 24 24"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-2 14H7v-2h10v2zm0-4H7v-2h10v2zm-3-4H7V7h7v2z"/></svg>
    <div class="empty__title">${title}</div>
    <div>${sub}</div>
  </div>`;
}

function renderOrdersTable(orders, suppliers) {
  const supplierName = (id) => suppliers.find((s) => s.id === id)?.name || '—';
  return `<div class="table-wrap"><table>
    <thead><tr><th>N° du bon</th><th>Date</th><th>Fournisseur</th><th class="text-right">Total</th><th></th></tr></thead>
    <tbody>
      ${orders.map((o) => `
        <tr>
          <td class="num">N° ${escapeHtml(String(o.number).padStart(4, '0'))}</td>
          <td>${fmtDate(o.date)}</td>
          <td>${escapeHtml(supplierName(o.supplierId))}</td>
          <td class="text-right num">${fmtMoney(o.total)}</td>
          <td class="row-actions">
            <button class="btn btn-ghost btn-sm" data-open-order="${o.id}">Ouvrir</button>
            <button class="btn btn-ghost btn-sm" data-export-order="${o.id}">PDF</button>
          </td>
        </tr>`).join('')}
    </tbody>
  </table></div>`;
}

function bindOrdersTableActions() {
  document.querySelectorAll('[data-open-order]').forEach((b) =>
    b.addEventListener('click', () => navigate('order-form', { orderId: b.dataset.openOrder }))
  );
  document.querySelectorAll('[data-export-order]').forEach((b) =>
    b.addEventListener('click', () => exportOrderPdf(b.dataset.exportOrder))
  );
}

/* ==========================================================================
   FOURNISSEURS
   ========================================================================== */
function generateSupplierCode(name, existing) {
  const base = (name || 'FRS').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'FRS';
  let code = base, n = 1;
  while (existing.some((s) => s.code === code)) { n++; code = base + n; }
  return code;
}

function renderSuppliers() {
  const suppliers = load(DB.suppliers);
  const view = document.getElementById('view');
  view.innerHTML = `
    <div class="card">
      <div class="card__head">
        <div>
          <h2 class="card__title">Fournisseurs</h2>
          <div class="card__subtitle">Le code de chaque fournisseur sert à générer le numéro de ses bons</div>
        </div>
        <button class="btn btn-brass" id="addSupplier">+ Ajouter un fournisseur</button>
      </div>
      ${suppliers.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Code</th><th>Fournisseur</th><th>Contact</th><th>Prochain n°</th><th></th></tr></thead>
        <tbody>
          ${suppliers.map((s) => `
            <tr>
              <td><span class="chip-code">${escapeHtml(s.code)}</span></td>
              <td><strong>${escapeHtml(s.name)}</strong><div class="text-muted" style="font-size:12px">${escapeHtml(s.address || '')}</div></td>
              <td>${escapeHtml(s.phone || '—')}<div class="text-muted" style="font-size:12px">${escapeHtml(s.email || '')}</div></td>
              <td class="num">${String(s.nextSeq).padStart(4, '0')}</td>
              <td class="row-actions">
                <button class="btn btn-ghost btn-sm" data-edit-supplier="${s.id}">Modifier</button>
                <button class="btn btn-danger btn-sm" data-del-supplier="${s.id}">Supprimer</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table></div>` : emptyState('Aucun fournisseur', 'Ajoutez un fournisseur pour pouvoir créer des bons de commande.')}
    </div>
  `;
  document.getElementById('addSupplier').addEventListener('click', () => openSupplierModal());
  document.querySelectorAll('[data-edit-supplier]').forEach((b) =>
    b.addEventListener('click', () => openSupplierModal(b.dataset.editSupplier))
  );
  document.querySelectorAll('[data-del-supplier]').forEach((b) =>
    b.addEventListener('click', () => {
      const orders = load(DB.orders);
      if (orders.some((o) => o.supplierId === b.dataset.delSupplier)) {
        toast('Impossible : des bons existent pour ce fournisseur.');
        return;
      }
      if (confirm('Supprimer ce fournisseur ?')) {
        save(DB.suppliers, load(DB.suppliers).filter((s) => s.id !== b.dataset.delSupplier));
        renderSuppliers();
        toast('Fournisseur supprimé.');
      }
    })
  );
}

function openSupplierModal(id) {
  const suppliers = load(DB.suppliers);
  const existing = id ? suppliers.find((s) => s.id === id) : null;
  openModal(existing ? 'Modifier le fournisseur' : 'Nouveau fournisseur', `
    <form id="supplierForm">
      <div class="field"><label>Nom du fournisseur *</label><input name="name" required value="${escapeHtml(existing?.name || '')}"></div>
      <div class="field-row">
        <div class="field"><label>Code (numérotation)</label><input name="code" maxlength="8" value="${escapeHtml(existing?.code || '')}"><small>Laisser vide pour génération automatique</small></div>
        <div class="field"><label>Téléphone</label><input name="phone" value="${escapeHtml(existing?.phone || '')}"></div>
      </div>
      <div class="field"><label>Adresse</label><input name="address" value="${escapeHtml(existing?.address || '')}"></div>
      <div class="field-row">
        <div class="field"><label>Email</label><input name="email" type="email" value="${escapeHtml(existing?.email || '')}"></div>
        <div class="field"><label>ICE / Identifiant fiscal</label><input name="taxId" value="${escapeHtml(existing?.taxId || '')}"></div>
      </div>
      <div class="modal__actions">
        <button type="button" class="btn btn-ghost" data-close-modal>Annuler</button>
        <button type="submit" class="btn btn-primary">${existing ? 'Enregistrer' : 'Ajouter'}</button>
      </div>
    </form>
  `, (modal) => {
    modal.querySelector('#supplierForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const name = fd.get('name').trim();
      if (!name) return;
      const list = load(DB.suppliers);
      let code = fd.get('code').trim().toUpperCase();
      if (existing) {
        const idx = list.findIndex((s) => s.id === existing.id);
        if (!code) code = existing.code;
        else if (list.some((s) => s.code === code && s.id !== existing.id)) { toast('Ce code existe déjà.'); return; }
        list[idx] = { ...existing, name, code, phone: fd.get('phone'), address: fd.get('address'), email: fd.get('email'), taxId: fd.get('taxId') };
      } else {
        if (!code) code = generateSupplierCode(name, list);
        else if (list.some((s) => s.code === code)) { toast('Ce code existe déjà.'); return; }
        list.push({ id: uid(), name, code, phone: fd.get('phone'), address: fd.get('address'), email: fd.get('email'), taxId: fd.get('taxId'), nextSeq: 1 });
      }
      save(DB.suppliers, list);
      closeModal();
      renderSuppliers();
      toast(existing ? 'Fournisseur modifié.' : 'Fournisseur ajouté.');
    });
  });
}

/* ==========================================================================
   PRODUITS
   ========================================================================== */
function renderProducts() {
  const products = load(DB.products);
  const view = document.getElementById('view');
  view.innerHTML = `
    <div class="card">
      <div class="card__head">
        <div>
          <h2 class="card__title">Catalogue produits</h2>
          <div class="card__subtitle">Ces produits sont proposés lors de la création d'un bon de commande</div>
        </div>
        <button class="btn btn-brass" id="addProduct">+ Ajouter un produit</button>
      </div>
      ${products.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Désignation</th><th>Référence</th><th>Unité</th><th class="text-right">Prix unitaire</th><th></th></tr></thead>
        <tbody>
          ${products.map((p) => `
            <tr>
              <td><strong>${escapeHtml(p.name)}</strong></td>
              <td>${escapeHtml(p.reference || '—')}</td>
              <td>${escapeHtml(p.unit || '—')}</td>
              <td class="text-right num">${fmtMoney(p.price)}</td>
              <td class="row-actions">
                <button class="btn btn-ghost btn-sm" data-edit-product="${p.id}">Modifier</button>
                <button class="btn btn-danger btn-sm" data-del-product="${p.id}">Supprimer</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table></div>` : emptyState('Aucun produit', 'Ajoutez vos produits pour les retrouver rapidement dans vos bons.')}
    </div>
  `;
  document.getElementById('addProduct').addEventListener('click', () => openProductModal());
  document.querySelectorAll('[data-edit-product]').forEach((b) =>
    b.addEventListener('click', () => openProductModal(b.dataset.editProduct))
  );
  document.querySelectorAll('[data-del-product]').forEach((b) =>
    b.addEventListener('click', () => {
      if (confirm('Supprimer ce produit du catalogue ?')) {
        save(DB.products, load(DB.products).filter((p) => p.id !== b.dataset.delProduct));
        renderProducts();
        toast('Produit supprimé.');
      }
    })
  );
}

function openProductModal(id) {
  const products = load(DB.products);
  const existing = id ? products.find((p) => p.id === id) : null;
  openModal(existing ? 'Modifier le produit' : 'Nouveau produit', `
    <form id="productForm">
      <div class="field"><label>Désignation *</label><input name="name" required value="${escapeHtml(existing?.name || '')}"></div>
      <div class="field-row">
        <div class="field"><label>Référence</label><input name="reference" value="${escapeHtml(existing?.reference || '')}"></div>
        <div class="field"><label>Unité</label><input name="unit" placeholder="pièce, kg, carton…" value="${escapeHtml(existing?.unit || '')}"></div>
      </div>
      <div class="field"><label>Prix unitaire *</label><input name="price" type="number" step="0.01" min="0" required value="${existing?.price ?? ''}"></div>
      <div class="modal__actions">
        <button type="button" class="btn btn-ghost" data-close-modal>Annuler</button>
        <button type="submit" class="btn btn-primary">${existing ? 'Enregistrer' : 'Ajouter'}</button>
      </div>
    </form>
  `, (modal) => {
    modal.querySelector('#productForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const name = fd.get('name').trim();
      const price = parseFloat(fd.get('price'));
      if (!name || isNaN(price)) return;
      const list = load(DB.products);
      if (existing) {
        const idx = list.findIndex((p) => p.id === existing.id);
        list[idx] = { ...existing, name, reference: fd.get('reference'), unit: fd.get('unit'), price };
      } else {
        list.push({ id: uid(), name, reference: fd.get('reference'), unit: fd.get('unit'), price });
      }
      save(DB.products, list);
      closeModal();
      renderProducts();
      toast(existing ? 'Produit modifié.' : 'Produit ajouté.');
    });
  });
}

/* ==========================================================================
   ADRESSES DE LIVRAISON
   ========================================================================== */
function renderDeliveryAddresses() {
  const addresses = load(DB.deliveryAddresses);
  const view = document.getElementById('view');
  view.innerHTML = `
    <div class="card">
      <div class="card__head">
        <div>
          <h2 class="card__title">Adresses de livraison</h2>
          <div class="card__subtitle">Ces adresses sont proposées lors de la création d'un bon de commande</div>
        </div>
        <button class="btn btn-brass" id="addAddress">+ Ajouter une adresse</button>
      </div>
      ${addresses.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Libellé</th><th>Adresse</th><th></th></tr></thead>
        <tbody>
          ${addresses.map((a) => `
            <tr>
              <td><strong>${escapeHtml(a.name)}</strong></td>
              <td>${escapeHtml(a.address)}</td>
              <td class="row-actions">
                <button class="btn btn-ghost btn-sm" data-edit-address="${a.id}">Modifier</button>
                <button class="btn btn-danger btn-sm" data-del-address="${a.id}">Supprimer</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table></div>` : emptyState('Aucune adresse', 'Ajoutez vos adresses de livraison pour les retrouver rapidement dans vos bons.')}
    </div>
  `;
  document.getElementById('addAddress').addEventListener('click', () => openDeliveryAddressModal());
  document.querySelectorAll('[data-edit-address]').forEach((b) =>
    b.addEventListener('click', () => openDeliveryAddressModal(b.dataset.editAddress))
  );
  document.querySelectorAll('[data-del-address]').forEach((b) =>
    b.addEventListener('click', () => {
      if (confirm('Supprimer cette adresse de livraison ?')) {
        save(DB.deliveryAddresses, load(DB.deliveryAddresses).filter((a) => a.id !== b.dataset.delAddress));
        renderDeliveryAddresses();
        toast('Adresse supprimée.');
      }
    })
  );
}

function openDeliveryAddressModal(id) {
  const addresses = load(DB.deliveryAddresses);
  const existing = id ? addresses.find((a) => a.id === id) : null;
  openModal(existing ? "Modifier l'adresse" : 'Nouvelle adresse de livraison', `
    <form id="addressForm">
      <div class="field"><label>Libellé *</label><input name="name" required placeholder="Ex : Station AKONABOE" value="${escapeHtml(existing?.name || '')}"></div>
      <div class="field"><label>Adresse complète *</label><input name="address" required value="${escapeHtml(existing?.address || '')}"></div>
      <div class="modal__actions">
        <button type="button" class="btn btn-ghost" data-close-modal>Annuler</button>
        <button type="submit" class="btn btn-primary">${existing ? 'Enregistrer' : 'Ajouter'}</button>
      </div>
    </form>
  `, (modal) => {
    modal.querySelector('#addressForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const name = fd.get('name').trim();
      const address = fd.get('address').trim();
      if (!name || !address) return;
      const list = load(DB.deliveryAddresses);
      if (existing) {
        const idx = list.findIndex((a) => a.id === existing.id);
        list[idx] = { ...existing, name, address };
      } else {
        list.push({ id: uid(), name, address });
      }
      save(DB.deliveryAddresses, list);
      closeModal();
      renderDeliveryAddresses();
      toast(existing ? 'Adresse modifiée.' : 'Adresse ajoutée.');
    });
  });
}

/* ==========================================================================
   GESTION DES TITRES DE SIGNATURE
   ========================================================================== */
function renderSignatureTitlesSection() {
  const titles = load(DB.signatureTitles);
  return `<div class="card"><div class="card__head"><div><h2 class="card__title">Titres de signature</h2><div class="card__subtitle">Bibliothèque de titres (ex. LE GERANT, LE DIRECTEUR) à associer aux émetteurs.</div></div><button class="btn btn-brass" id="addSignatureTitle">+ Ajouter un titre</button></div>
    ${titles.length ? `<div class="table-wrap"><table><thead><tr><th>Titre</th><th></th></tr></thead><tbody>${titles.map(t => `<tr><td><strong>${escapeHtml(t.name)}</strong></td><td class="row-actions"><button class="btn btn-ghost btn-sm" data-edit-title="${t.id}">Modifier</button><button class="btn btn-danger btn-sm" data-del-title="${t.id}">Supprimer</button></td></tr>`).join('')}</tbody></table></div>` : emptyState('Aucun titre', 'Ajoutez un titre de signature à associer à vos émetteurs.')}
  </div>`;
}

/* ==========================================================================
   ENTÊTES / ÉMETTEUR
   ========================================================================== */
function renderHeaders() {
  const headers = load(DB.headers);
  const titles = load(DB.signatureTitles);
  const stamps = load(DB.stamps);
  const view = document.getElementById('view');

  view.innerHTML = `
    <div class="card">
      <div class="card__head">
        <div>
          <h2 class="card__title">Émetteurs</h2>
          <div class="card__subtitle">Chaque émetteur possède ses propres informations d’entête, son titre de signature et son cachet.</div>
        </div>
        <button type="button" class="btn btn-brass" id="addHeader">+ Ajouter un émetteur</button>
      </div>
      ${headers.length ? `<div class="header-picker">
        ${headers.map(h => {
          const title = getHeaderSignatureTitle(h, titles);
          const stamp = getHeaderSignatureStamp(h, stamps);
          return `<div class="pick-card">
            <div class="pick-card__name">${escapeHtml(h.name)}</div>
            <div class="pick-card__meta">${escapeHtml(h.address || '')}</div>
            <div class="pick-card__meta">${escapeHtml(h.phone || '')} ${h.email ? '· ' + escapeHtml(h.email) : ''}</div>
            <div class="pick-card__meta">${h.rccm ? 'RCCM ' + escapeHtml(h.rccm) : ''} ${h.ifu ? '· IFU ' + escapeHtml(h.ifu) : ''}</div>
            <div class="pick-card__signature"><span>Titre : <strong>${escapeHtml(title?.name || 'Aucun')}</strong></span><span>Cachet : <strong>${escapeHtml(stamp?.name || 'Aucun')}</strong></span></div>
            <div class="row-actions" style="margin-top:10px"><button class="btn btn-ghost btn-sm" data-edit-header="${h.id}">Modifier</button><button class="btn btn-danger btn-sm" data-del-header="${h.id}">Supprimer</button></div>
          </div>`;
        }).join('')}
      </div>` : emptyState('Aucun émetteur', "Cliquez sur « + Ajouter un émetteur » pour créer votre première entête et lui associer ses éléments de signature.")}
    </div>
    ${renderSignatureTitlesSection()}
    ${renderStampsSection()}
  `;

  document.getElementById('addHeader')?.addEventListener('click', () => openHeaderModal());
  document.querySelectorAll('[data-edit-header]').forEach(b => b.addEventListener('click', () => openHeaderModal(b.dataset.editHeader)));
  document.querySelectorAll('[data-del-header]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.delHeader;
    const orders = load(DB.orders);
    if (orders.some(o => o.headerId === id)) { toast('Impossible : des bons utilisent cet émetteur.'); return; }
    if (confirm('Supprimer cet émetteur ?')) {
      save(DB.headers, load(DB.headers).filter(h => h.id !== id));
      renderHeaders();
      toast('Émetteur supprimé.');
    }
  }));

  document.getElementById('addSignatureTitle')?.addEventListener('click', () => openSignatureTitleModal());
  document.querySelectorAll('[data-edit-title]').forEach(b => b.addEventListener('click', () => openSignatureTitleModal(b.dataset.editTitle)));
  document.querySelectorAll('[data-del-title]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.delTitle;
    const inUse = load(DB.headers).some(h => h.signatureTitleId === id) || load(DB.orders).some(o => o.signatureTitleId === id);
    const msg = inUse ? 'Ce titre est utilisé par au moins un émetteur ou un bon. Le supprimer quand même ?' : 'Supprimer ce titre de signature ?';
    if (confirm(msg)) {
      save(DB.signatureTitles, load(DB.signatureTitles).filter(t => t.id !== id));
      renderHeaders();
      toast('Titre supprimé.');
    }
  }));

  document.getElementById('addStamp')?.addEventListener('click', () => openStampModal());
  document.querySelectorAll('[data-edit-stamp]').forEach(b => b.addEventListener('click', () => openStampModal(b.dataset.editStamp)));
  document.querySelectorAll('[data-del-stamp]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.delStamp;
    const inUse = load(DB.headers).some(h => h.signatureStampId === id) || load(DB.orders).some(o => o.signatureStampId === id);
    const msg = inUse ? 'Ce cachet est utilisé par au moins un émetteur ou un bon. Le supprimer quand même ?' : 'Supprimer ce cachet ?';
    if (confirm(msg)) {
      save(DB.stamps, load(DB.stamps).filter(x => x.id !== id));
      renderHeaders();
      toast('Cachet supprimé.');
    }
  }));
}

function openHeaderModal(id) {
  const headers = load(DB.headers);
  const titles = load(DB.signatureTitles);
  const stamps = load(DB.stamps);
  const existing = id ? headers.find(h => h.id === id) : null;
  const selectedTitleId = existing?.signatureTitleId || '';
  const selectedStampId = existing?.signatureStampId || '';

  openModal(existing ? "Modifier l’émetteur" : 'Ajouter un émetteur', `
    <form id="headerForm">
      <div class="card" style="margin:0 0 14px;padding:16px">
        <div class="card__head" style="margin-bottom:12px">
          <div><h3 class="card__title" style="font-size:16px">1. Ajouter entête</h3><div class="card__subtitle">Informations qui apparaîtront en haut du bon.</div></div>
        </div>
        <div class="field"><label>Raison sociale *</label><input name="name" required value="${escapeHtml(existing?.name || '')}"></div>
        <div class="field"><label>Adresse</label><input name="address" value="${escapeHtml(existing?.address || '')}"></div>
        <div class="field-row"><div class="field"><label>Téléphone</label><input name="phone" value="${escapeHtml(existing?.phone || '')}"></div><div class="field"><label>Email</label><input name="email" type="email" value="${escapeHtml(existing?.email || '')}"></div></div>
        <div class="field-row"><div class="field"><label>RCCM</label><input name="rccm" placeholder="RB/COT/22 B" value="${escapeHtml(existing?.rccm || '')}"></div><div class="field"><label>IFU</label><input name="ifu" placeholder="320 221 438 195 7" value="${escapeHtml(existing?.ifu || '')}"></div></div>
        <div class="field"><label>Logo (optionnel)</label><input name="logo" type="file" accept="image/*"></div>
      </div>

      <div class="card" style="margin:0 0 14px;padding:16px">
        <div class="card__head" style="margin-bottom:12px">
          <div><h3 class="card__title" style="font-size:16px">2. Ajouter titre de signature</h3><div class="card__subtitle">Le titre choisi sera propre à cet émetteur. Aucun titre par défaut.</div></div>
        </div>
        <div class="field"><label>Titre de signature</label>
          <div style="display:flex;gap:8px;align-items:center">
            <select name="signatureTitleId" id="headerSignatureTitle" style="flex:1"><option value="">— Aucun titre —</option>${titles.map(t => `<option value="${t.id}" ${t.id === selectedTitleId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}</select>
            <button type="button" class="btn btn-ghost btn-sm" id="newTitleInline">+ Ajouter</button>
          </div>
        </div>
        <div id="newTitleBox" style="display:none;margin-top:8px">
          <div class="field"><label>Nouveau titre</label><div style="display:flex;gap:8px"><input id="newTitleName" maxlength="80" placeholder="LE GERANT"><button type="button" class="btn btn-primary btn-sm" id="saveNewTitle">Ajouter</button></div></div>
        </div>
      </div>

      <div class="card" style="margin:0 0 14px;padding:16px">
        <div class="card__head" style="margin-bottom:12px">
          <div><h3 class="card__title" style="font-size:16px">3. Ajouter cachet de signature</h3><div class="card__subtitle">Le cachet choisi sera propre à cet émetteur et s’affichera sous son titre de signature.</div></div>
        </div>
        <div class="field"><label>Cachet de signature</label>
          <div style="display:flex;gap:8px;align-items:center">
            <select name="signatureStampId" id="headerSignatureStamp" style="flex:1"><option value="">— Aucun cachet —</option>${stamps.map(st => `<option value="${st.id}" ${st.id === selectedStampId ? 'selected' : ''}>${escapeHtml(st.name)}</option>`).join('')}</select>
            <button type="button" class="btn btn-ghost btn-sm" id="newStampInline">+ Ajouter</button>
          </div>
        </div>
        <div id="newStampBox" style="display:none;margin-top:8px">
          <div class="field"><label>Nom du cachet</label><input id="newStampName" maxlength="80" placeholder="Cachet société"></div>
          <div class="field"><label>Image du cachet</label><input id="newStampImage" type="file" accept="image/*"></div>
          <button type="button" class="btn btn-primary btn-sm" id="saveNewStamp">Ajouter le cachet</button>
        </div>
      </div>

      <div class="modal__actions"><button type="button" class="btn btn-ghost" data-close-modal>Annuler</button><button type="submit" class="btn btn-primary">${existing ? 'Enregistrer' : 'Ajouter l’émetteur'}</button></div>
    </form>
  `, modal => {
    const titleSelect = modal.querySelector('#headerSignatureTitle');
    const stampSelect = modal.querySelector('#headerSignatureStamp');

    modal.querySelector('#newTitleInline')?.addEventListener('click', () => {
      const box = modal.querySelector('#newTitleBox');
      box.style.display = box.style.display === 'none' ? 'block' : 'none';
      if (box.style.display !== 'none') modal.querySelector('#newTitleName')?.focus();
    });
    modal.querySelector('#saveNewTitle')?.addEventListener('click', () => {
      const name = String(modal.querySelector('#newTitleName')?.value || '').trim();
      if (!name) { toast('Saisissez le titre de signature.'); return; }
      const list = load(DB.signatureTitles);
      const item = { id: uid(), name };
      list.push(item); save(DB.signatureTitles, list);
      const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; titleSelect.appendChild(option); titleSelect.value = item.id;
      modal.querySelector('#newTitleName').value = ''; modal.querySelector('#newTitleBox').style.display = 'none';
      toast('Titre ajouté et associé à cet émetteur.');
    });

    modal.querySelector('#newStampInline')?.addEventListener('click', () => {
      const box = modal.querySelector('#newStampBox');
      box.style.display = box.style.display === 'none' ? 'block' : 'none';
      if (box.style.display !== 'none') modal.querySelector('#newStampName')?.focus();
    });
    modal.querySelector('#saveNewStamp')?.addEventListener('click', () => {
      const name = String(modal.querySelector('#newStampName')?.value || '').trim();
      const file = modal.querySelector('#newStampImage')?.files?.[0];
      if (!name || !file) { toast('Saisissez le nom et sélectionnez l’image du cachet.'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const list = load(DB.stamps);
        const item = { id: uid(), name, image: reader.result };
        list.push(item); save(DB.stamps, list);
        const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; stampSelect.appendChild(option); stampSelect.value = item.id;
        modal.querySelector('#newStampName').value = ''; modal.querySelector('#newStampImage').value = ''; modal.querySelector('#newStampBox').style.display = 'none';
        toast('Cachet ajouté et associé à cet émetteur.');
      };
      reader.readAsDataURL(file);
    });

    modal.querySelector('#headerForm').addEventListener('submit', e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const name = String(fd.get('name') || '').trim();
      if (!name) return;
      const signatureTitleId = String(fd.get('signatureTitleId') || '') || null;
      const signatureStampId = String(fd.get('signatureStampId') || '') || null;
      const currentTitles = load(DB.signatureTitles), currentStamps = load(DB.stamps);
      const title = currentTitles.find(t => t.id === signatureTitleId);
      const file = fd.get('logo');
      const finish = logoDataUrl => {
        const list = load(DB.headers);
        const payload = { name, address: String(fd.get('address') || '').trim(), phone: String(fd.get('phone') || '').trim(), email: String(fd.get('email') || '').trim(), rccm: String(fd.get('rccm') || '').trim(), ifu: String(fd.get('ifu') || '').trim(), signatureTitleId, signataireTitle: title?.name || '', signatureStampId, logo: logoDataUrl ?? existing?.logo ?? null };
        if (existing) { const idx = list.findIndex(h => h.id === existing.id); list[idx] = { ...existing, ...payload }; }
        else list.push({ id: uid(), ...payload });
        save(DB.headers, list); closeModal(); renderHeaders(); toast(existing ? 'Émetteur modifié.' : 'Émetteur ajouté.');
      };
      if (file && file.size > 0) { const reader = new FileReader(); reader.onload = () => finish(reader.result); reader.readAsDataURL(file); } else finish(null);
    });
  });
}

function openSignatureTitleModal(id) {
  const titles = ensureSignatureTitles(), existing = id ? titles.find(t => t.id === id) : null;
  openModal(existing ? 'Modifier le titre de signature' : 'Nouveau titre de signature', `
    <form id="signatureTitleForm"><div class="field"><label>Titre *</label><input name="name" required maxlength="80" placeholder="LE GERANT" value="${escapeHtml(existing?.name || '')}"></div><div class="modal__actions"><button type="button" class="btn btn-ghost" data-close-modal>Annuler</button><button type="submit" class="btn btn-primary">${existing ? 'Enregistrer' : 'Ajouter'}</button></div></form>
  `, modal => {
    modal.querySelector('#signatureTitleForm').addEventListener('submit', e => {
      e.preventDefault(); const fd = new FormData(e.target), name = String(fd.get('name') || '').trim(); if (!name) return; const list = load(DB.signatureTitles);
      const payload = { name };
      if (existing) { const idx = list.findIndex(t => t.id === existing.id); list[idx] = { ...existing, ...payload }; } else list.push({ id: uid(), ...payload });
      save(DB.signatureTitles, list); closeModal(); renderHeaders(); toast(existing ? 'Titre modifié.' : 'Titre ajouté.');
    });
  });
}

/* ==========================================================================
   NOUVEAU / ÉDITION BON DE COMMANDE
   ========================================================================== */
function blankDraft() {
  return { id: null, number: null, supplierId: '', headerId: '', signatureTitleId: '', signatureStampId: '', date: todayISO(), livraisonAdresse: '', items: [], payments: [{method:'Avoir',reference:'',amount:''},{method:'Transfert Mobile Money',reference:'',amount:''},{method:'Versement bancaire',reference:'',amount:''},{method:'Virement bancaire',reference:'',amount:''}], notes: '' };
}

function normalizeOrderNumber(value) {
  const raw = String(value ?? '').trim().replace(/\s/g, '');
  if (!raw) return '';
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 9999) return null;
  return String(n).padStart(4, '0');
}

function getNextOrderNumber(supplierId, orders = load(DB.orders), suppliers = load(DB.suppliers)) {
  if (!supplierId) return null;
  const supplier = suppliers.find((s) => s.id === supplierId);
  const supplierNextSeq = supplier ? (Number(supplier.nextSeq) || 1) : 1;
  const maxSupplierNumber = orders.reduce((max, order) => {
    if (order.supplierId !== supplierId) return max;
    const n = parseInt(String(order.number ?? '').replace(/\D/g, ''), 10);
    return Number.isFinite(n) ? Math.max(max, n) : max;
  }, 0);
  const next = Math.max(supplierNextSeq, maxSupplierNumber + 1);
  return next <= 9999 ? String(next).padStart(4, '0') : null;
}

function buildOrderNumber(supplierId) {
  return getNextOrderNumber(supplierId);
}

function renderOrderForm(orderId) {
  const suppliers = load(DB.suppliers);
  const headers = load(DB.headers);
  const products = load(DB.products);
  const signatureTitles = ensureSignatureTitles();
  const signatureStamps = load(DB.stamps);

  if (orderId) {
    const existing = load(DB.orders).find((o) => o.id === orderId);
    if (existing) state.orderDraft = JSON.parse(JSON.stringify(existing));
  }
  if (!state.orderDraft) state.orderDraft = blankDraft();
  const draft = state.orderDraft;
  const isEditing = !!draft.id;

  document.getElementById('viewTitle').textContent = isEditing ? `Bon ${draft.number}` : 'Nouveau bon de commande';

  const view = document.getElementById('view');

  if (!suppliers.length) {
    view.innerHTML = `<div class="card">${emptyState('Ajoutez d\'abord un fournisseur', 'Un bon de commande doit être rattaché à un fournisseur.')}
      <div style="text-align:center"><button class="btn btn-brass" id="goSuppliers">Aller aux fournisseurs</button></div></div>`;
    document.getElementById('goSuppliers').addEventListener('click', () => navigate('suppliers'));
    return;
  }

  const supplier = suppliers.find((s) => s.id === draft.supplierId);
  const ordersForNumbering = load(DB.orders);
  const previewNumber = draft.number || getNextOrderNumber(draft.supplierId, ordersForNumbering, suppliers);
  const selectedHeader = headers.find(h => h.id === draft.headerId);
  const selectedTitle = getOrderSignatureTitle(draft, selectedHeader, signatureTitles);
  const selectedStamp = getOrderSignatureStamp(draft, selectedHeader, signatureStamps);
  const selectedTitleId = draft.signatureTitleId || selectedTitle?.id || '';
  const selectedStampId = draft.signatureStampId || selectedStamp?.id || '';
  const total = draft.items.reduce((s, it) => s + it.qty * it.unitPrice, 0);
  draft.payments=(draft.payments||[]).map(p=>({...p,amount:Number(p.amount)||0}));

  view.innerHTML = `
    <div class="number-badge">
      <div class="number-badge__stamp"><svg viewBox="0 0 24 24"><path d="M12 2 2 7l10 5 10-5-10-5zm0 7L2 4v13l10 5 10-5V4l-10 5z"/></svg></div>
      <div style="flex:1">
        <div class="number-badge__label">Numéro du bon</div>
        ${isEditing ? `<div class="number-badge__value">N° ${String(previewNumber).padStart(4, '0')}</div>` : `
          <div class="field" style="margin:0;max-width:220px">
            <input id="orderNumberInput" type="text" inputmode="numeric" maxlength="4" value="${escapeHtml(draft.number ? String(draft.number).padStart(4, '0') : '')}" placeholder="${escapeHtml(String(previewNumber || '—'))}" aria-label="Numéro du bon">
            <small>Saisissez 25 → 0025, 325 → 0325. Laissez vide pour utiliser automatiquement le prochain numéro : <strong>${escapeHtml(String(previewNumber || 'Aucun numéro disponible'))}</strong>.</small>
          </div>`}
      </div>
    </div>

    <div class="card">
      <div class="card__head"><h2 class="card__title">1. Fournisseur & entête</h2></div>
      <div class="field-row">
        <div class="field">
          <label>Fournisseur *</label>
          <select id="supplierSelect" ${isEditing ? 'disabled' : ''}>
            <option value="">— Sélectionner —</option>
            ${suppliers.map((s) => `<option value="${s.id}" ${s.id === draft.supplierId ? 'selected' : ''}>${escapeHtml(s.name)} (${s.code})</option>`).join('')}
          </select>
          ${isEditing ? '<small>Le fournisseur ne peut plus être changé une fois le bon créé.</small>' : ''}
        </div>
        <div class="field">
          <label>Date du bon</label>
          <input type="date" id="orderDate" value="${draft.date}">
        </div>
      </div>
      <div class="field">
        <label>Entête / émetteur *</label>
        ${headers.length ? `<select id="headerSelect">
            <option value="">— Sélectionner —</option>
            ${headers.map((h) => `<option value="${h.id}" ${h.id === draft.headerId ? 'selected' : ''}>${escapeHtml(h.name)}</option>`).join('')}
          </select>` : `<div class="text-muted">Aucune entête enregistrée. <a href="#" id="goHeadersLink">Ajouter une entête</a>.</div>`}
      </div>
      <div class="signature-choice-box">
        <div class="signature-choice-box__head">
          <div><strong>Signature du bon</strong><small>Le titre et le cachet propres à l'émetteur sélectionné sont rappelés automatiquement. Vous pouvez toutefois les modifier pour ce bon si nécessaire.</small></div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Titre de signature <span class="text-muted">(lié à l’émetteur)</span></label>
            <select id="orderSignatureTitle">
              <option value="">— Aucun titre —</option>
              ${signatureTitles.map(t => `<option value="${t.id}" ${t.id === selectedTitleId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Cachet de signature</label>
            <select id="orderSignatureStamp">
              <option value="">— Aucun cachet —</option>
              ${signatureStamps.map(st => `<option value="${st.id}" ${st.id === selectedStampId ? 'selected' : ''}>${escapeHtml(st.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="signature-choice-box__preview">
          <span>Titre : <strong id="signatureTitlePreview">${escapeHtml(selectedTitle?.name || 'Aucun')}</strong></span>
          <span>Cachet : <strong id="signatureStampPreview">${escapeHtml(selectedStamp?.name || 'Aucun')}</strong></span>
        </div>
      </div>
      <div class="field">
        <label>Adresse de livraison</label>
        ${load(DB.deliveryAddresses).length ? `<select id="livraisonSelect">
            <option value="">— Aucune adresse —</option>
            ${load(DB.deliveryAddresses).map((a) => `<option value="${a.id}" ${a.address === draft.livraisonAdresse ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}
          </select>` : `<div class="text-muted">Aucune adresse enregistrée. <a href="#" id="goAddressesLink">Ajouter une adresse</a>.</div>`}
      </div>
    </div>

    <div class="card">
      <div class="card__head"><h2 class="card__title">2. Produits</h2></div>
      ${products.length ? `
        <div class="add-line-row">
          <div class="field" style="margin:0"><label>Produit</label>
            <select id="productSelect">${products.map((p) => `<option value="${p.id}">${escapeHtml(p.name)} — ${fmtMoney(p.price)}</option>`).join('')}</select>
          </div>
          <div class="field" style="margin:0"><label>Quantité</label><input type="number" id="qtyInput" min="1" value="1"></div>
          <div class="field" style="margin:0"><label>Prix unitaire</label><input type="number" id="priceInput" min="0" step="0.01"></div>
          <button class="btn btn-primary" id="addLineBtn">Ajouter</button>
        </div>
      ` : `<div class="text-muted">Aucun produit au catalogue. <a href="#" id="goProductsLink">Ajouter un produit</a>.</div>`}

      <div class="table-wrap" style="margin-top:16px">
        <table class="line-items">
          <thead><tr><th>Désignation</th><th style="width:90px">Quantité</th><th style="width:100px">Unité</th><th style="width:130px">P. U. (FCFA)</th><th class="text-right" style="width:110px">Montant</th><th></th></tr></thead>
          <tbody id="lineItemsBody">
            ${draft.items.length ? draft.items.map((it) => renderLineRow(it)).join('') : `<tr><td colspan="6" class="text-muted" style="text-align:center;padding:20px">Aucun produit ajouté</td></tr>`}
          </tbody>
        </table>
      </div>

      <div class="total-box"><div class="total-box__inner">
        <div class="total-box__label">Total du bon</div>
        <div class="total-box__value" id="orderTotal">${fmtMoney(total)}</div>
      </div></div>
    </div>

    <div class="card">
      <div class="card__head"><h2 class="card__title">3. Paiement</h2></div><div class="table-wrap"><table class="payment-editor"><thead><tr><th>Moyen</th><th>Référence</th><th class="text-right">Montant (FCFA)</th></tr></thead><tbody>${(draft.payments||[]).map((p,i)=>`<tr><td>${escapeHtml(p.method)}</td><td><input class="payment-ref" data-payment-index="${i}" value="${escapeHtml(p.reference||'')}" placeholder="Référence"></td><td><input class="payment-amount text-right" type="number" min="0" step="0.01" data-payment-index="${i}" value="${p.amount??''}"></td></tr>`).join('')}<tr class="payment-total"><td colspan="2"><strong>TOTAL PAIEMENT</strong></td><td class="text-right num" id="paymentTotal">${fmtMoney((draft.payments||[]).reduce((a,p)=>a+(Number(p.amount)||0),0))}</td></tr></tbody></table></div><div class="payment-balance"><span>Reliquat sur paiement</span><strong id="paymentBalance">${fmtMoney((draft.payments||[]).reduce((a,p)=>a+(Number(p.amount)||0),0)-total)}</strong></div>
    </div>

    <div class="card"><div class="card__head"><h2 class="card__title">4. Notes (optionnel)</h2></div>
      <textarea id="orderNotes" placeholder="Conditions de livraison, remarques…">${escapeHtml(draft.notes || '')}</textarea>
    </div>

    <div class="modal__actions" style="justify-content:flex-start">
      <button class="btn btn-primary" id="saveDraftBtn">Enregistrer</button>
      <button class="btn btn-brass" id="previewPdfBtn">Aperçu</button>
      ${isEditing ? '<button class="btn btn-ghost" id="cancelEditBtn">Nouveau bon vierge</button>' : ''}
    </div>
  `;

  // Sync qty/price defaults when product selected
  const productSelect = document.getElementById('productSelect');
  const priceInput = document.getElementById('priceInput');
  function syncPriceFromCatalog() {
    const p = products.find((p) => p.id === productSelect.value);
    if (p && priceInput) priceInput.value = p.price;
  }
  if (productSelect) { syncPriceFromCatalog(); productSelect.addEventListener('change', syncPriceFromCatalog); }

  document.getElementById('orderNumberInput')?.addEventListener('input', (e) => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 4);
    e.target.value = digits;
    if (digits) {
      const normalized = normalizeOrderNumber(digits);
      if (normalized) draft.number = normalized;
    } else {
      draft.number = null;
    }
  });
  document.getElementById('orderNumberInput')?.addEventListener('blur', (e) => {
    if (!e.target.value.trim()) { draft.number = null; return; }
    const normalized = normalizeOrderNumber(e.target.value);
    if (normalized) { e.target.value = normalized; draft.number = normalized; }
  });

  document.getElementById('supplierSelect')?.addEventListener('change', (e) => {
    draft.supplierId = e.target.value;
    renderOrderForm();
  });
  document.getElementById('orderDate')?.addEventListener('change', (e) => { draft.date = e.target.value; });
  document.getElementById('headerSelect')?.addEventListener('change', (e) => {
    draft.headerId = e.target.value;
    const h = headers.find(x => x.id === draft.headerId);
    // Lorsqu'un émetteur est choisi, ses paramètres de signature deviennent
    // automatiquement ceux du bon : titre + cachet associés à cet émetteur.
    const t = getHeaderSignatureTitle(h, signatureTitles);
    const st = getHeaderSignatureStamp(h, signatureStamps);
    draft.signatureTitleId = t?.id || '';
    draft.signatureStampId = st?.id || '';
    renderOrderForm();
  });
  document.getElementById('orderSignatureTitle')?.addEventListener('change', (e) => {
    draft.signatureTitleId = e.target.value;
    const t = signatureTitles.find(x => x.id === e.target.value);
    const preview = document.getElementById('signatureTitlePreview');
    if (preview) preview.textContent = t?.name || 'Aucun';
  });
  document.getElementById('orderSignatureStamp')?.addEventListener('change', (e) => {
    draft.signatureStampId = e.target.value;
    const st = signatureStamps.find(x => x.id === e.target.value);
    const preview = document.getElementById('signatureStampPreview');
    if (preview) preview.textContent = st?.name || 'Aucun';
  });
  document.getElementById('livraisonSelect')?.addEventListener('change', (e) => {
    const a = load(DB.deliveryAddresses).find((x) => x.id === e.target.value);
    draft.livraisonAdresse = a ? a.address : '';
  });
  document.getElementById('goAddressesLink')?.addEventListener('click', (e) => { e.preventDefault(); navigate('delivery-addresses'); });
  document.getElementById('orderNotes')?.addEventListener('input', (e) => { draft.notes = e.target.value; });
  document.getElementById('goHeadersLink')?.addEventListener('click', (e) => { e.preventDefault(); navigate('headers'); });
  document.getElementById('goProductsLink')?.addEventListener('click', (e) => { e.preventDefault(); navigate('products'); });

  document.getElementById('addLineBtn')?.addEventListener('click', () => {
    const p = products.find((p) => p.id === productSelect.value);
    const qty = parseFloat(document.getElementById('qtyInput').value) || 1;
    const unitPrice = parseFloat(priceInput.value);
    if (!p || isNaN(unitPrice)) return;
    draft.items.push({ lineId: uid(), productId: p.id, name: p.name, unit: p.unit || '', qty, unitPrice });
    renderOrderForm();
  });

  document.querySelectorAll('[data-remove-line]').forEach((b) =>
    b.addEventListener('click', () => {
      draft.items = draft.items.filter((it) => it.lineId !== b.dataset.removeLine);
      renderOrderForm();
    })
  );
  document.querySelectorAll('.line-qty, .line-unit, .line-price').forEach((input) =>
    input.addEventListener('input', (e) => {
      const line = draft.items.find((it) => it.lineId === e.target.dataset.lineId);
      if (!line) return;
      if (e.target.classList.contains('line-qty')) line.qty = parseQuantity(e.target.value);
      else if(e.target.classList.contains('line-unit')) line.unit=e.target.value;
      else line.unitPrice = parseFloat(e.target.value) || 0;
      const t = draft.items.reduce((s, it) => s + it.qty * it.unitPrice, 0);
      document.getElementById('orderTotal').textContent = fmtMoney(t);
      const rowTotal = document.getElementById('rowtotal-' + line.lineId);
      if (rowTotal) rowTotal.textContent = fmtMoney(line.qty * line.unitPrice);
    })
  );

  document.querySelectorAll('.line-qty').forEach((input) => {
    input.addEventListener('blur', (e) => {
      const line = draft.items.find((it) => it.lineId === e.target.dataset.lineId);
      if (line) e.target.value = fmtQuantity(line.qty);
    });
  });

  const refreshPaymentTotals=()=>{const paid=(draft.payments||[]).reduce((a,p)=>a+(Number(p.amount)||0),0);document.getElementById('paymentTotal').textContent=fmtMoney(paid);document.getElementById('paymentBalance').textContent=fmtMoney(paid-draft.items.reduce((a,it)=>a+it.qty*it.unitPrice,0));};
  document.querySelectorAll('.payment-ref').forEach(e=>e.addEventListener('input',ev=>draft.payments[ev.target.dataset.paymentIndex].reference=ev.target.value));
  document.querySelectorAll('.payment-amount').forEach(e=>e.addEventListener('input',ev=>{draft.payments[ev.target.dataset.paymentIndex].amount=ev.target.value;refreshPaymentTotals();}));
  document.getElementById('saveDraftBtn').addEventListener('click', () => persistOrder(true));
  document.getElementById('previewPdfBtn').addEventListener('click', () => previewOrderPdf());
  document.getElementById('cancelEditBtn')?.addEventListener('click', () => { state.orderDraft = null; navigate('order-form'); });
}

function renderLineRow(it) {
  return `<tr><td>${escapeHtml(it.name)}</td><td><input class="line-qty" type="text" inputmode="decimal" data-line-id="${it.lineId}" value="${fmtQuantity(it.qty)}" aria-label="Quantité"></td><td><input class="line-unit" type="text" data-line-id="${it.lineId}" value="${escapeHtml(it.unit||'')}" placeholder="pièce, kg…"></td><td><input class="line-price" type="number" min="0" step="0.01" data-line-id="${it.lineId}" value="${it.unitPrice}"></td><td class="text-right num" id="rowtotal-${it.lineId}">${fmtMoney(it.qty * it.unitPrice)}</td><td><button class="btn btn-danger btn-sm" data-remove-line="${it.lineId}">&times;</button></td></tr>`;
}

function validateOrder(draft) {
  if (!draft.supplierId) { toast('Sélectionnez un fournisseur.'); return false; }
  if (!draft.headerId) { toast("Sélectionnez une entête (émetteur)."); return false; }
  if (!draft.items.length) { toast('Ajoutez au moins un produit.'); return false; }
  return true;
}

function persistOrder(alsoExport) {
  const draft = state.orderDraft;
  if (!validateOrder(draft)) return;

  const suppliers = load(DB.suppliers);
  const orders = load(DB.orders);
  const total = draft.items.reduce((s, it) => s + it.qty * it.unitPrice, 0);

  if (!draft.id) {
    const numberInput = document.getElementById('orderNumberInput');
    const requestedNumber = numberInput ? numberInput.value.trim() : String(draft.number || '').trim();
    const normalizedNumber = normalizeOrderNumber(requestedNumber);
    if (requestedNumber && !normalizedNumber) {
      toast('Le numéro du bon doit être compris entre 0001 et 9999.');
      numberInput?.focus();
      return;
    }
    const nextAutomaticNumber = getNextOrderNumber(draft.supplierId, orders, suppliers);
    if (!normalizedNumber && !nextAutomaticNumber) {
      toast('La numérotation automatique a atteint 9999. Saisissez un numéro disponible entre 0001 et 9999.');
      numberInput?.focus();
      return;
    }
    draft.number = normalizedNumber || nextAutomaticNumber;
    const duplicate = orders.some(o => o.supplierId === draft.supplierId && normalizeOrderNumber(o.number) === draft.number);
    if (duplicate) {
      toast(`Le numéro ${draft.number} est déjà utilisé. Choisissez un autre numéro.`);
      numberInput?.focus();
      return;
    }
    draft.id = uid();
    draft.createdAt = Date.now();
    const supplier = suppliers.find((s) => s.id === draft.supplierId);
    if (supplier) supplier.nextSeq = Math.max(Number(supplier.nextSeq) || 1, parseInt(draft.number, 10) + 1);
    save(DB.suppliers, suppliers);
    orders.push({ ...draft, total });
  } else {
    const idx = orders.findIndex((o) => o.id === draft.id);
    orders[idx] = { ...orders[idx], ...draft, total, updatedAt: Date.now() };
  }
  save(DB.orders, orders);
  toast(alsoExport ? 'Bon enregistré, génération du PDF…' : 'Bon enregistré.');

  if (alsoExport) {
    exportOrderPdf(draft.id);
  } else {
    navigate('order-form', { orderId: draft.id });
  }
}

/* ==========================================================================
   HISTORIQUE
   ========================================================================== */
function renderHistory() {
  const suppliers = load(DB.suppliers);
  const headers = load(DB.headers);
  let orders = load(DB.orders).sort((a, b) => b.createdAt - a.createdAt);
  const view = document.getElementById('view');

  const filterHtml = `
    <div class="filter-row">
      <select id="supplierFilter">
        <option value="">Tous les fournisseurs</option>
        ${suppliers.map((s) => `<option value="${s.id}" ${state.historyFilter === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
      </select>
      <select id="emitterFilter">
        <option value="">Tous les émetteurs</option>
        ${headers.map((h) => `<option value="${h.id}" ${state.historyEmitterFilter === h.id ? 'selected' : ''}>${escapeHtml(h.name)}</option>`).join('')}
      </select>
    </div>`;

  if (state.historyFilter) orders = orders.filter((o) => o.supplierId === state.historyFilter);
  if (state.historyEmitterFilter) orders = orders.filter((o) => o.headerId === state.historyEmitterFilter);

  view.innerHTML = `
    <div class="card">
      <div class="card__head">
        <div>
          <h2 class="card__title">Historique des bons</h2>
          <div class="card__subtitle">Filtrez par fournisseur ou par émetteur, consultez ou réexportez un bon en PDF</div>
        </div>
      </div>
      ${filterHtml}
      ${orders.length ? `<div class="table-wrap"><table>
        <thead><tr><th>N° du bon</th><th>Date</th><th>Fournisseur</th><th>Émetteur</th><th class="text-right">Total</th><th></th></tr></thead>
        <tbody>
          ${orders.map((o) => `
            <tr>
              <td class="num">N° ${escapeHtml(String(o.number).padStart(4, '0'))}</td>
              <td>${fmtDate(o.date)}</td>
              <td>${escapeHtml(suppliers.find((s) => s.id === o.supplierId)?.name || '—')}</td>
              <td>${escapeHtml(headers.find((h) => h.id === o.headerId)?.name || '—')}</td>
              <td class="text-right num">${fmtMoney(o.total)}</td>
              <td class="row-actions">
                <button class="btn btn-ghost btn-sm" data-open-order="${o.id}">Ouvrir</button>
                <button class="btn btn-ghost btn-sm" data-export-order="${o.id}">Réexporter PDF</button>
                <button class="btn btn-danger btn-sm" data-del-order="${o.id}">Supprimer</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table></div>` : emptyState('Aucun bon trouvé', 'Aucun bon de commande ne correspond à ces filtres.')}
    </div>
  `;

  document.getElementById('supplierFilter').addEventListener('change', (e) => {
    state.historyFilter = e.target.value;
    renderHistory();
  });
  document.getElementById('emitterFilter').addEventListener('change', (e) => {
    state.historyEmitterFilter = e.target.value;
    renderHistory();
  });
  bindOrdersTableActions();
  document.querySelectorAll('[data-del-order]').forEach((b) =>
    b.addEventListener('click', () => {
      if (confirm('Supprimer définitivement ce bon de l\'historique ?')) {
        save(DB.orders, load(DB.orders).filter((o) => o.id !== b.dataset.delOrder));
        renderHistory();
        toast('Bon supprimé.');
      }
    })
  );
}

/* ==========================================================================
   CONVERSION NOMBRE -> LETTRES (français)
   ========================================================================== */
function numberToFrenchWords(input) {
  const num = Math.round(Math.abs(Number(input) || 0));
  if (num === 0) return 'zéro';

  const units = ['', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix',
    'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];
  const tens = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante', 'soixante-dix', 'quatre-vingt', 'quatre-vingt-dix'];

  function convertTwoDigits(n) {
    if (n < 20) return units[n];
    const t = Math.floor(n / 10), u = n % 10;
    if (t === 7 || t === 9) return tens[t - 1] + '-' + units[10 + u];
    if (u === 0) return tens[t] + (t === 8 ? 's' : '');
    if (u === 1 && t !== 8) return tens[t] + ' et un';
    return tens[t] + '-' + units[u];
  }

  function convertHundreds(n) {
    let str = '';
    const h = Math.floor(n / 100), rest = n % 100;
    if (h > 0) str += (h > 1 ? units[h] + ' cent' : 'cent') + (h > 1 && rest === 0 ? 's' : '');
    if (rest > 0) str += (str ? ' ' : '') + convertTwoDigits(rest);
    return str;
  }

  function convertThousands(n) {
    if (n < 1000) return convertHundreds(n);
    const th = Math.floor(n / 1000), rest = n % 1000;
    let str = th === 1 ? 'mille' : convertHundreds(th) + ' mille';
    if (rest > 0) str += ' ' + convertHundreds(rest);
    return str;
  }

  function convertMillions(n) {
    if (n < 1e6) return convertThousands(n);
    const m = Math.floor(n / 1e6), rest = n % 1e6;
    let str = m === 1 ? 'un million' : convertHundreds(m) + ' millions';
    if (rest > 0) str += ' ' + convertThousands(rest);
    return str;
  }

  const result = num < 1e9 ? convertMillions(num) : String(num);
  return result.charAt(0).toUpperCase() + result.slice(1);
}

/* ==========================================================================
   EXPORT PDF
   ========================================================================== */
function buildOrderPdf(order) {
  const supplier = load(DB.suppliers).find((s) => s.id === order.supplierId);
  const header = load(DB.headers).find((h) => h.id === order.headerId);
  const INK = [30, 42, 56], INK_SOFT = [90, 100, 110], RUST = [179, 66, 59], LINE = [210, 214, 220];
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = 44;

  const hasLogo = !!header?.logo;
  if (hasLogo) { try { doc.addImage(header.logo, margin, y - 6, 54, 54); } catch (e) {} }
  const textX = hasLogo ? margin + 66 : margin;
  doc.setTextColor(...INK); doc.setFont('helvetica', 'bold'); doc.setFontSize(12.5);
  const nameStr = header?.name || 'Émetteur';
  let col2X = textX + 150;
  const parenIdx = nameStr.indexOf('(');
  if (parenIdx > -1) col2X = textX + doc.getTextWidth(nameStr.slice(0, parenIdx));
  doc.text(nameStr, textX, y + 8);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...INK_SOFT);
  let hy = y + 21;
  if (header?.rccm || header?.ifu) { if (header?.rccm) doc.text('RCCM ' + header.rccm, textX, hy); if (header?.ifu) doc.text('IFU ' + header.ifu, col2X, hy); hy += 12; }
  if (header?.phone || header?.address) { if (header?.phone) doc.text('Téléphone (' + header.phone + ')', textX, hy); if (header?.address) doc.text(header.address, col2X, hy); hy += 12; }
  if (header?.email) { doc.text('Email : ' + header.email, textX, hy); hy += 12; }
  const ruleY = Math.max(y + 40, hy + 6); doc.setDrawColor(...INK); doc.setLineWidth(1.4); doc.line(margin, ruleY, pageWidth - margin, ruleY);
  y = ruleY + 22; doc.setFont('helvetica', 'italic'); doc.setFontSize(9.5); doc.setTextColor(...INK_SOFT);
  const dateStr = 'Date : ' + fmtDate(order.date); const dateX = pageWidth - margin - doc.getTextWidth(dateStr); doc.text(dateStr, pageWidth - margin, y, { align: 'right' });
  y += 26; doc.setFont('helvetica', 'bold'); doc.setFontSize(19); doc.setTextColor(...INK); doc.text('BON DE COMMANDE', margin, y);
  const titleWidth = doc.getTextWidth('BON DE COMMANDE'); doc.setFontSize(13); doc.setTextColor(...INK_SOFT); doc.text('N°', margin + titleWidth + 14, y);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...RUST); doc.text(String(order.number).padStart(4,'0'), margin + titleWidth + 32, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...INK_SOFT); doc.text('A', dateX, y + 4, { align: 'left' });
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...INK); doc.text(supplier?.name || '—', pageWidth - margin, y + 22, { align: 'right' });
  y += 30;
  if (order.livraisonAdresse) { doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(...INK); const label = 'Adresse de livraison : '; const labelWidth = doc.getTextWidth(label); doc.text(label, margin, y); doc.setFont('helvetica', 'normal'); doc.setTextColor(...INK_SOFT); doc.text(order.livraisonAdresse, margin + labelWidth, y); y += 18; } else y += 4;
  const rows = order.items.map((it) => [it.name, fmtQuantityPdf(it.qty), it.unit || '', fmtMoneyPdf(it.unitPrice), fmtMoneyPdf(it.qty * it.unitPrice)]);
  doc.autoTable({ startY: y + 10, head: [['DESIGNATION', 'QUANTITE', 'UNITE', 'P. U. (FCFA)', 'MONTANT (FCFA)']], body: rows, margin: { left: margin, right: margin }, styles: { font: 'helvetica', fontSize: 9.5, textColor: INK, cellPadding: 8, lineColor: LINE, lineWidth: 0.7 }, headStyles: { fillColor: INK, textColor: [241, 239, 232], fontStyle: 'bold', halign: 'center' }, bodyStyles: { minCellHeight: 22 }, columnStyles: { 0: { halign: 'left' }, 1: { halign: 'center', cellWidth: 80 }, 2: { halign: 'right', cellWidth: 95 }, 3: { halign: 'right', cellWidth: 105 }, 4: { halign: 'right', cellWidth: 115 } }, foot: [['TOTAL', '', '', '', fmtMoneyPdf(order.total)],], footStyles: { fillColor: [255,255,255], textColor: INK, fontStyle: 'bold', lineColor: LINE, lineWidth: 0.7, halign: 'right' }, didParseCell: (data) => { if (data.section === 'foot') { if (data.column.index === 0) { data.cell.colSpan = 4; data.cell.styles.halign = 'right'; } else if (data.column.index === 4) data.cell.styles.halign = 'right'; } } });
  y = doc.lastAutoTable.finalY + 26;
  doc.setFont('helvetica','bold'); doc.setFontSize(9.5); doc.setTextColor(...INK); doc.text('PAIEMENT', margin, y);
  const payments=order.payments||[]; const paidTotal=payments.reduce((a,p)=>a+(Number(p.amount)||0),0);
  doc.autoTable({ startY: y + 6, head: [['MOYEN', 'REFERENCE', 'MONTANT']], body: [...payments.map((p) => [p.method, p.reference || '', p.amount ? fmtMoneyPdf(p.amount) : '']), ['TOTAL PAIEMENT', '', fmtMoneyPdf(paidTotal)]], margin: { left: margin, right: margin }, styles: { font: 'helvetica', fontSize: 9, textColor: INK, cellPadding: 7, lineColor: LINE, lineWidth: 0.7 }, headStyles: { fillColor: [237,239,242], textColor: INK, fontStyle: 'bold' }, columnStyles: { 0: { cellWidth: 150 }, 2: { cellWidth: 110, halign: 'right' } }, didParseCell: (data) => { if (data.section === 'body' && data.row.index === payments.length) { data.cell.styles.fontStyle = 'bold'; data.cell.styles.fillColor = [237,239,242]; if (data.column.index === 0) { data.cell.colSpan = 2; data.cell.styles.halign = 'left'; } } } });
  y=doc.lastAutoTable.finalY+18; doc.setFont('helvetica','bold'); doc.setFontSize(9.5); doc.setTextColor(...INK); doc.text('Reliquat sur paiement : '+fmtMoneyPdf(paidTotal-(Number(order.total)||0))+' FCFA',margin,y); y+=26;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...INK); const words = numberToFrenchWords(order.total) + ' francs CFA'; const line = 'Arrêté le bon de commande à la somme de : ' + words + '.'; const split = doc.splitTextToSize(line, pageWidth - margin * 2); doc.text(split, margin, y); y += split.length * 13 + 6;
  doc.setDrawColor(...LINE); const dotsY = y; doc.setLineDashPattern([1, 1.5], 0); doc.line(margin, dotsY, pageWidth - margin, dotsY); doc.setLineDashPattern([], 0);
  if (order.notes) { y += 22; doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...INK); doc.text('Notes', margin, y); doc.setFont('helvetica', 'normal'); doc.setTextColor(...INK_SOFT); const splitNotes = doc.splitTextToSize(order.notes, pageWidth - margin * 2); doc.text(splitNotes, margin, y + 13); y += 13 + splitNotes.length * 12; }
  const signatureTitles = ensureSignatureTitles(); const stamps = load(DB.stamps); const signatureTitle = getOrderSignatureTitle(order, header, signatureTitles); const stamp = getOrderSignatureStamp(order, header, stamps);
  const sigY = Math.max(y + 40, doc.internal.pageSize.getHeight() - 105); doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...INK); if (signatureTitle?.name) doc.text(signatureTitle.name, pageWidth - margin, sigY, { align: 'right' }); if (stamp?.image) { try { doc.addImage(stamp.image, pageWidth - margin - 90, sigY + 8, 90, 55); } catch (e) {} }
  return doc;
}

function exportOrderPdf(orderId) {
  const order = load(DB.orders).find((o) => o.id === orderId);
  if (!order) return;
  const doc = buildOrderPdf(order);
  doc.save(String(order.number).replace(/[^A-Za-z0-9\-]/g, '_') + '.pdf');
  toast('PDF généré : ' + order.number);
}

function previewOrderPdf() {
  const draft = JSON.parse(JSON.stringify(state.orderDraft || {}));
  if (!validateOrder(draft)) return;
  if (!draft.number) {
    const n = getNextOrderNumber(draft.supplierId, load(DB.orders), load(DB.suppliers));
    if (n) draft.number = n;
  }
  draft.total = draft.items.reduce((s, it) => s + it.qty * it.unitPrice, 0);
  const doc = buildOrderPdf(draft);
  const blobUrl = doc.output('bloburl');
  // Chrome pour Android ne sait pas afficher un PDF dans une <iframe> : on l'ouvre
  // donc dans un nouvel onglet via un lien simulé (plus fiable qu'un window.open,
  // moins susceptible d'être bloqué comme pop-up par le navigateur).
  const a = document.createElement('a');
  a.href = blobUrl;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  let opened = true;
  try { a.click(); } catch (e) { opened = false; }
  document.body.removeChild(a);
  if (!opened) {
    toast("Aperçu impossible à ouvrir : utilisez « Enregistrer » pour télécharger le PDF directement.");
  }
}

/* ==========================================================================
   GESTION DES CACHETS
   ========================================================================== */
function renderStampsSection() {
  const stamps = load(DB.stamps);
  return `<div class="card"><div class="card__head"><div><h2 class="card__title">Cachets de signature</h2><div class="card__subtitle">Bibliothèque de cachets à associer aux émetteurs. Aucun cachet par défaut.</div></div><button class="btn btn-brass" id="addStamp">+ Ajouter un cachet</button></div>
    ${stamps.length ? `<div class="stamp-grid">${stamps.map(x => `<div class="stamp-card"><div class="stamp-card__preview"><img src="${x.image}" alt="Cachet ${escapeHtml(x.name)}"></div><div class="stamp-card__info"><strong>${escapeHtml(x.name)}</strong></div><div class="row-actions"><button class="btn btn-ghost btn-sm" data-edit-stamp="${x.id}">Modifier</button><button class="btn btn-danger btn-sm" data-del-stamp="${x.id}">Supprimer</button></div></div>`).join('')}</div>` : emptyState('Aucun cachet', 'Ajoutez une image de cachet pour l’afficher sous le titre de signature.')}
  </div>`;
}

function openStampModal(id) {
  const stamps = load(DB.stamps), existing = id ? stamps.find(x => x.id === id) : null;
  openModal(existing ? 'Modifier le cachet' : 'Ajouter un cachet', `
    <form id="stampForm"><div class="field"><label>Nom *</label><input name="name" required maxlength="80" placeholder="Cachet société" value="${escapeHtml(existing?.name || '')}"></div><div class="field"><label>Image ${existing ? '(laisser vide pour conserver l’image)' : '*'}</label><input name="image" type="file" accept="image/*" ${existing ? '' : 'required'}></div><div class="modal__actions"><button type="button" class="btn btn-ghost" data-close-modal>Annuler</button><button type="submit" class="btn btn-primary">${existing ? 'Enregistrer' : 'Ajouter'}</button></div></form>
  `, modal => {
    modal.querySelector('#stampForm').addEventListener('submit', e => {
      e.preventDefault(); const fd = new FormData(e.target), name = String(fd.get('name') || '').trim(); if (!name) return; const file = fd.get('image');
      const finish = imageDataUrl => {
        const list = load(DB.stamps);
        const payload = { name, image: imageDataUrl ?? existing?.image ?? null }; if (!payload.image) { toast('Sélectionnez une image de cachet.'); return; }
        if (existing) { const idx = list.findIndex(x => x.id === existing.id); list[idx] = { ...existing, ...payload }; } else list.push({ id: uid(), ...payload });
        save(DB.stamps, list); closeModal(); renderHeaders(); toast(existing ? 'Cachet modifié.' : 'Cachet ajouté.');
      };
      if (file && file.size > 0) { const reader = new FileReader(); reader.onload = () => finish(reader.result); reader.readAsDataURL(file); } else finish(null);
    });
  });
}


document.getElementById('storageBtn')?.addEventListener('click', openStorageModal);
updateStorageButton();

document.getElementById('syncBtn')?.addEventListener('click', openSyncModal);
updateSyncButton();

/* ==========================================================================
   PWA / ANDROID
   ========================================================================== */
let deferredInstallPrompt = null;
const installAppBtn = document.getElementById('installAppBtn');
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

function updateInstallButton() {
  if (!installAppBtn) return;
  installAppBtn.hidden = isStandalone() || !deferredInstallPrompt;
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallButton();
});

installAppBtn?.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  try { await deferredInstallPrompt.userChoice; } catch (e) {}
  deferredInstallPrompt = null;
  updateInstallButton();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  updateInstallButton();
  toast('Application installée sur cet appareil.');
});

updateInstallButton();

/* ==========================================================================
   INIT
   ========================================================================== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}

initLocalStorageFolder().finally(() => {
  navigate('dashboard');
  startCloudSync();
});
