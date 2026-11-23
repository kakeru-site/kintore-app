// 読み取り量を減らす「差分同期」と、そのための書き込みレイヤー(画面には依存しない)
//
// 対象は増え続ける4つのコレクションだけ(体重・記録・トレーニング時間・BIG3手動記録)。
// ・書き込み時に updatedAt を必ず付ける。削除は「消した印(tombstone)」を書く
// ・読み込みは「前回以降に変わった分だけ」を取得し、端末内(IndexedDB)の写しに反映する
// ・写しが無い / 30日たった / 手動の全再読み込み のときだけ全件を読む
// ・自分の書き込みは、通信を待たず写しにすぐ反映する(電波の悪い場所でも画面が動く)

export const SYNC_COLLECTIONS = ['bodyWeight', 'workoutLogs', 'trainingDuration', 'big3Manual'];
export const CACHE_VERSION = 1;
export const FULL_RESYNC_MS = 30 * 24 * 60 * 60 * 1000;
export const OVERLAP_MS = 2 * 60 * 1000;      // 時刻のずれ対策。少し前から読み直す
const POST_WRITE_SYNC_MS = 3000;

const NAMES = SYNC_COLLECTIONS.join('|');
const DOC_RE = new RegExp(`^users/([^/]+)/(${NAMES})/([^/]+)$`);
const COL_RE = new RegExp(`^users/([^/]+)/(${NAMES})$`);

const isTs = (v) => v && typeof v === 'object' && typeof v.toMillis === 'function' && typeof v.seconds === 'number';
const tsMs = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : null);

// Timestamp は保存できる形に直して、読み出すときに戻す
export function enc(v) {
  if (isTs(v)) return { __ts: [v.seconds, v.nanoseconds] };
  if (Array.isArray(v)) return v.map(enc);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = enc(v[k]); return o; }
  return v;
}
export function dec(v, TS) {
  if (Array.isArray(v)) return v.map((x) => dec(x, TS));
  if (v && typeof v === 'object') {
    if (Array.isArray(v.__ts)) return new TS(v.__ts[0], v.__ts[1]);
    const o = {}; for (const k of Object.keys(v)) o[k] = dec(v[k], TS); return o;
  }
  return v;
}

// IndexedDB が使えない環境(プライベートモード等)ではメモリだけで動く
export function createKv(name = 'muscle-log-sync') {
  const mem = new Map();
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    try {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => res(req && req.result);
      tx.onerror = () => rej(tx.error);
    });
  };
  return {
    async get(k) { try { return await run('readonly', (s) => s.get(k)); } catch (e) { return mem.get(k); } },
    async set(k, v) { mem.set(k, v); try { await run('readwrite', (s) => s.put(v, k)); } catch (e) { /* メモリだけで続ける */ } },
    async del(k) { mem.delete(k); try { await run('readwrite', (s) => s.delete(k)); } catch (e) { /* 同上 */ } },
  };
}

/* ---------- 1コレクション分の同期 ---------- */
export function createCollectionSync({ name, uid, fs, db, kv, stats, now = () => Date.now(), onError = () => {} }) {
  let docs = new Map();
  let watermark = 0, fullAt = 0, hadCache = false;
  let syncing = null, saveT = null, postT = null, stopped = false;
  const subs = new Set();
  const key = `${uid}:${name}`;
  const colRef = () => fs.collection(db, 'users', uid, name);
  const list = () => [...docs].map(([id, data]) => ({ id, data }));
  const emit = () => { const l = list(); subs.forEach((f) => f(l)); };

  async function load() {
    try {
      const raw = await kv.get(key);
      if (raw && raw.v === CACHE_VERSION && raw.docs) {
        docs = new Map(Object.entries(raw.docs).map(([i, d]) => [i, dec(d, fs.Timestamp)]));
        watermark = raw.watermark || 0; fullAt = raw.fullAt || 0;
        return true;
      }
    } catch (e) { /* 読めなければ全件を読む */ }
    return false;
  }
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      const o = {}; docs.forEach((d, i) => { o[i] = enc(d); });
      kv.set(key, { v: CACHE_VERSION, watermark, fullAt, docs: o }).catch(() => {});
    }, 400);
  }

  async function full() {
    const snap = await fs.getDocs(colRef());
    stats.reads += snap.docs.length;
    const next = new Map(); let wm = 0;
    snap.docs.forEach((d) => {
      const x = d.data(); const t = tsMs(x.updatedAt);
      if (t && t > wm) wm = t;
      if (x.deleted !== true) next.set(d.id, x);
    });
    docs = next; watermark = wm; fullAt = now();
    save(); emit();
  }

  async function delta() {
    const since = fs.Timestamp.fromMillis(Math.max(0, watermark - OVERLAP_MS));
    const snap = await fs.getDocs(fs.query(colRef(), fs.where('updatedAt', '>', since), fs.orderBy('updatedAt', 'asc')));
    stats.reads += snap.docs.length;
    let changed = false;
    snap.docs.forEach((d) => {
      const x = d.data(); const t = tsMs(x.updatedAt);
      if (t && t > watermark) watermark = t;
      if (x.deleted === true) { if (docs.delete(d.id)) changed = true; return; }
      const cur = docs.get(d.id);
      if (!cur || JSON.stringify(enc(cur)) !== JSON.stringify(enc(x))) { docs.set(d.id, x); changed = true; }
    });
    save();
    if (changed) emit();
  }

  // force: 'full' なら全件。ふだんは差分だけ
  function sync(force) {
    if (stopped) return Promise.resolve(false);
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        if (force === 'full' || !hadCache || now() - fullAt > FULL_RESYNC_MS) { await full(); hadCache = true; }
        else await delta();
        return true;
      } catch (e) { console.error(e); onError(e); return false; }
      finally { syncing = null; }
    })();
    return syncing;
  }

  return {
    name,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    async start() {
      stopped = false;
      hadCache = await load();
      if (hadCache) emit();
      return sync();
    },
    sync,
    resync() { return sync(); },
    scheduleSync() { clearTimeout(postT); postT = setTimeout(() => sync(), POST_WRITE_SYNC_MS); },
    get: (id) => docs.get(id),
    echoSet(id, data, merge) { docs.set(id, data); save(); emit(); },
    echoDelete(id) { if (docs.delete(id)) { save(); emit(); } },
    async clearCache() { docs = new Map(); watermark = 0; fullAt = 0; hadCache = false; await kv.del(key); },
    stop() { stopped = true; clearTimeout(saveT); clearTimeout(postT); subs.clear(); },
    snapshot: () => ({ count: docs.size, watermark, fullAt }),
  };
}

/* ---------- 4コレクションをまとめて扱う ---------- */
export function createSyncManager({ fs, db, uid, kv = createKv(), stats = { reads: 0 }, onError }) {
  const cols = {};
  SYNC_COLLECTIONS.forEach((n) => { cols[n] = createCollectionSync({ name: n, uid, fs, db, kv, stats, onError }); });
  let timer = null;
  const syncAll = (force) => Promise.all(SYNC_COLLECTIONS.map((n) => cols[n].sync(force)));
  return {
    uid, cols, stats,
    startAll() { return Promise.all(SYNC_COLLECTIONS.map((n) => cols[n].start())); },
    syncAll,
    async reloadAll() { await Promise.all(SYNC_COLLECTIONS.map((n) => cols[n].clearCache())); return syncAll('full'); },
    async clearCaches() { await Promise.all(SYNC_COLLECTIONS.map((n) => cols[n].clearCache())); },
    startTimer(ms = 10 * 60 * 1000) { clearInterval(timer); timer = setInterval(() => syncAll(), ms); },
    stop() { clearInterval(timer); SYNC_COLLECTIONS.forEach((n) => cols[n].stop()); },
  };
}

/* ---------- 書き込みレイヤー ----------
   同期モードがオフでも、対象コレクションへの書き込みは必ず updatedAt を付け、削除は tombstone にする。
   (あとで他の端末が同期モードを使っても、変更を取りこぼさないため) */
export function createWriteLayer({ fs, getCol }) {
  const MARK = new WeakMap();
  const serverTimestamp = () => { const s = fs.serverTimestamp(); MARK.set(s, { t: 'ts' }); return s; };
  const increment = (n) => { const s = fs.increment(n); MARK.set(s, { t: 'inc', n }); return s; };
  const arrayUnion = (...items) => { const s = fs.arrayUnion(...items); MARK.set(s, { t: 'arr', items }); return s; };

  // 写しに入れる形(サーバー時刻は今の時刻、increment/arrayUnion は計算済みの値)にする
  function materialize(data, cur) {
    const out = {};
    for (const [k, v] of Object.entries(data)) {
      const m = v && typeof v === 'object' ? MARK.get(v) : null;
      if (!m) out[k] = v;
      else if (m.t === 'ts') out[k] = fs.Timestamp.now();
      else if (m.t === 'inc') out[k] = (Number(cur && cur[k]) || 0) + m.n;
      else if (m.t === 'arr') {
        const base = Array.isArray(cur && cur[k]) ? cur[k] : [];
        const add = m.items.filter((it) => !base.some((b) => JSON.stringify(b) === JSON.stringify(it)));
        out[k] = base.concat(add);
      }
    }
    return out;
  }
  const parse = (ref) => { const m = ref && DOC_RE.exec(ref.path); return m ? { uid: m[1], name: m[2], id: m[3] } : null; };
  const colOf = (p) => (getCol ? getCol(p.uid, p.name) : null);

  // 書き込む内容と、写しへの反映を決める(batch と単発で共通)
  function plan(kind, ref, data, opts) {
    const p = parse(ref);
    if (!p) return null;
    const col = colOf(p);
    if (kind === 'delete') {
      if (col) col.echoDelete(p.id);
      return { p, col, write: { deleted: true, updatedAt: serverTimestamp() }, merge: false };
    }
    const merge = kind === 'update' || !!(opts && opts.merge);
    const write = { ...data, updatedAt: serverTimestamp() };
    if (merge) write.deleted = false;      // 消した印が付いた書類に書き足したら、生き返らせる
    if (col) {
      const cur = col.get(p.id);
      if (kind === 'update' && !cur) return { p, col, write, merge };
      col.echoSet(p.id, materialize(write, merge ? cur : null), merge);
    }
    return { p, col, write, merge };
  }

  async function single(kind, ref, data, opts) {
    const pl = plan(kind, ref, data, opts);
    if (!pl) {
      if (kind === 'delete') return fs.deleteDoc(ref);
      if (kind === 'update') return fs.updateDoc(ref, data);
      return fs.setDoc(ref, data, opts);
    }
    try {
      if (kind === 'update') await fs.updateDoc(ref, pl.write);
      else await fs.setDoc(ref, pl.write, kind === 'delete' ? undefined : (pl.merge ? { merge: true } : undefined));
    } catch (e) { if (pl.col) pl.col.resync(); throw e; }
    if (pl.col) pl.col.scheduleSync();
  }

  return {
    serverTimestamp, increment, arrayUnion,
    setDoc: (ref, data, opts) => single('set', ref, data, opts),
    updateDoc: (ref, data) => single('update', ref, data),
    deleteDoc: (ref) => single('delete', ref),
    addDoc(colRef, data) {
      if (!COL_RE.test(colRef.path)) return fs.addDoc(colRef, data);
      const ref = fs.doc(colRef);
      return single('set', ref, data).then(() => ref);
    },
    writeBatch(db) {
      const rb = fs.writeBatch(db);
      const touched = new Set();
      const op = (kind, ref, data, opts) => {
        const pl = plan(kind, ref, data, opts);
        if (!pl) {
          if (kind === 'delete') rb.delete(ref); else if (kind === 'update') rb.update(ref, data); else rb.set(ref, data, opts);
          return;
        }
        if (pl.col) touched.add(pl.col);
        if (kind === 'update') rb.update(ref, pl.write);
        else if (kind === 'delete') rb.set(ref, pl.write);
        else if (pl.merge) rb.set(ref, pl.write, { merge: true });
        else rb.set(ref, pl.write);
      };
      return {
        set(ref, data, opts) { op('set', ref, data, opts); return this; },
        update(ref, data) { op('update', ref, data); return this; },
        delete(ref) { op('delete', ref); return this; },
        async commit() {
          try { await rb.commit(); } catch (e) { touched.forEach((c) => c.resync()); throw e; }
          touched.forEach((c) => c.scheduleSync());
        },
      };
    },
  };
}
