// 「みんなの記録」:会員が見せたい記録を載せて、ほかの会員が見られる掲示板。
// 画面・Firestore の読み書き・投稿内容の組み立てをここにまとめる(Firebaseの関数は index.html から受け取る)。

export const NICK_MIN = 2;
export const NICK_MAX = 12;
export const COMMENT_MAX = 200;
export const PAGE_SIZE = 15;
export const CACHE_MS = 5 * 60 * 1000;
export const MENU_MAX_ITEMS = 12;
// 特別会員(期限なし)の「掲載期限」。ルールの timestamp.date(2100, 1, 1) と同じ値にする
export const SPECIAL_UNTIL_MS = Date.UTC(2100, 0, 1);
export const RESERVED_NICKS = ['せいや', '運営', '運営者', '管理者', 'admin', 'administrator', 'musclelog', 'muscle'];
export const BIG3_LIFTS = [
  { key: 'squat', short: 'SQ', label: 'スクワット' },
  { key: 'bench', short: 'BP', label: 'ベンチプレス' },
  { key: 'deadlift', short: 'DL', label: 'デッドリフト' },
];
const CAT_LABEL = { max: 'MAX挑戦', heavy: '高重量', medium: '中重量' };
const REPORT_REASONS = ['不適切な内容', '個人情報が含まれている', '迷惑・宣伝', 'その他'];

/* ---------- 画面に依存しない部分(テストしやすいように分けてある) ---------- */

export function normalizeNickname(raw) {
  return String(raw || '').normalize('NFKC').replace(/\s+/g, '');
}
export function nicknameKey(raw) {
  return normalizeNickname(raw).toLowerCase();
}
export function validateNickname(raw, isAdmin) {
  const n = normalizeNickname(raw);
  if (n.length < NICK_MIN || n.length > NICK_MAX) return { ok: false, msg: `${NICK_MIN}〜${NICK_MAX}文字で入力してください` };
  if (!/^[A-Za-z0-9_\-ぁ-ゖァ-ヺー一-鿿々]+$/.test(n)) {
    return { ok: false, msg: '使える文字は、ひらがな・カタカナ・漢字・英数字・「_」「-」です' };
  }
  if (!isAdmin && RESERVED_NICKS.includes(n.toLowerCase())) return { ok: false, msg: 'このニックネームは使えません' };
  return { ok: true, nickname: n, key: n.toLowerCase() };
}

function toMs(ts) {
  if (!ts) return null;
  if (typeof ts === 'number') return ts;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts instanceof Date) return ts.getTime();
  return null;
}

// 期限切れの会員の投稿は見せない(掲載期限 authorActiveUntil が過ぎたもの)
export function isPostVisible(post, nowMs = Date.now()) {
  const until = toMs(post.authorActiveUntil);
  return until !== null && until > nowMs;
}

const pad2 = (n) => String(n).padStart(2, '0');
export function formatPostTime(ts, nowMs = Date.now()) {
  const ms = toMs(ts);
  if (ms === null) return { abs: 'たった今', rel: '' };
  const d = new Date(ms);
  const abs = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const diff = Math.max(0, nowMs - ms);
  const min = Math.floor(diff / 60000);
  let rel;
  if (min < 1) rel = 'たった今';
  else if (min < 60) rel = `${min}分前`;
  else if (min < 60 * 24) rel = `${Math.floor(min / 60)}時間前`;
  else rel = `${Math.floor(min / 1440)}日前`;
  return { abs, rel };
}

// 載せた時点の体重:体重記録のうち、今日以前でいちばん新しいもの(weightEntries は新しい順でも古い順でも可)
export function latestBodyWeight(weightEntries, today) {
  const list = (weightEntries || []).filter(e => e && e.date <= today && Number(e.weight) > 0);
  if (!list.length) return null;
  const e = list.reduce((a, b) => (b.date > a.date ? b : a));
  return { weight: Number(e.weight), date: e.date };
}

// BIG3:各種目の自己ベスト(重量が最大の記録。同じ重量なら新しい日付)
export function composeBig3Snapshot(entries) {
  const lifts = {};
  let count = 0;
  BIG3_LIFTS.forEach(({ key }) => {
    const mine = (entries || []).filter(e => e.liftKey === key && Number(e.weight) > 0);
    if (!mine.length) { lifts[key] = null; return; }
    const best = mine.reduce((a, b) => {
      const wa = Number(a.weight), wb = Number(b.weight);
      return wb > wa || (wb === wa && b.date > a.date) ? b : a;
    });
    lifts[key] = { weight: Number(best.weight), date: best.date };
    count++;
  });
  const all = BIG3_LIFTS.every(({ key }) => lifts[key]);
  const total = all ? BIG3_LIFTS.reduce((s, { key }) => s + lifts[key].weight, 0) : null;
  return { ok: count > 0, lifts, total };
}

// メニュー:その日の記録(筋トレは各セット、有酸素は合計の文字)
export function composeMenuSnapshot(logs, date, h) {
  const dayLogs = (logs || [])
    .filter(l => l.date === date && !h.isGripLog(l) && (h.isCardioLog(l) || (l.sets || []).length))
    .sort((a, b) => h.recordedAtMs(a) - h.recordedAtMs(b));
  const items = dayLogs.slice(0, MENU_MAX_ITEMS).map(l => {
    if (h.isCardioLog(l)) {
      return { name: String(l.exerciseName || ''), bodyPart: '有酸素', category: null, sets: [], text: String(h.formatLogSummary(l) || '').split(' ／ ')[0].slice(0, 80) };
    }
    return {
      name: String(l.exerciseName || ''), bodyPart: String(l.bodyPart || ''), category: h.logCategory(l),
      sets: l.sets.slice(0, 10).map(s => ({ weight: Number(s.weight) || 0, reps: Number(s.reps) || 0, drop: !!s.drop })), text: '',
    };
  });
  const volume = dayLogs.filter(l => !h.isCardioLog(l)).reduce((s, l) => s + h.setsVolume(l.sets), 0);
  return { ok: items.length > 0, date, items, volume, omitted: Math.max(0, dayLogs.length - items.length) };
}

/* ---------- ランキング・ライバル(v2) ---------- */
export const MAX_RIVALS = 10;
export const RANK_SHOW = 10;     // 画面に出す件数
export const RANK_FETCH = 15;    // 期限切れの会員を除くぶん、多めに読む
export const RANK_SORTS = [
  { key: 'total', label: '合計', field: 'total', unit: 'kg', dec: 0 },
  { key: 'ratio', label: '体重比', field: 'ratio', unit: '倍', dec: 2 },
  { key: 'squat', label: 'SQ', field: 'squat', unit: 'kg', dec: 0 },
  { key: 'bench', label: 'BP', field: 'bench', unit: 'kg', dec: 0 },
  { key: 'deadlift', label: 'DL', field: 'deadlift', unit: 'kg', dec: 0 },
];

// 公開プロフィールの中身。体重は「体重も公開する」をオンにした人だけ(オフなら体重比も出さない)
export function composePublicProfile(big3Snap, bw, showWeight) {
  const L = (big3Snap && big3Snap.lifts) || {};
  const w = (k) => (L[k] ? L[k].weight : null);
  const total = big3Snap && big3Snap.total ? big3Snap.total : null;
  const useW = !!showWeight && bw && Number(bw.weight) > 0;
  return {
    squat: w('squat'), bench: w('bench'), deadlift: w('deadlift'), total,
    bodyWeight: useW ? Number(bw.weight) : null,
    ratio: useW && total ? Math.round((total / Number(bw.weight)) * 100) / 100 : null,
    showWeight: !!showWeight,
  };
}
// 前回と同じ内容なら書き込まないための目印
export function profileSignature(p, extra) {
  return JSON.stringify([p.squat, p.bench, p.deadlift, p.total, p.bodyWeight, p.ratio, p.showWeight, extra || '']);
}
export function rankValue(p, sortKey) {
  const v = p ? p[sortKey] : null;
  return typeof v === 'number' && v > 0 ? v : null;
}
// 相手 − 自分(どちらかが無い項目は null)
export function diffVsMe(rival, mine) {
  const d = {};
  ['total', 'squat', 'bench', 'deadlift', 'ratio'].forEach(k => {
    const a = rankValue(rival, k), b = rankValue(mine, k);
    d[k] = a !== null && b !== null ? Math.round((a - b) * 100) / 100 : null;
  });
  return d;
}

// ニックネームから、アイコンの色を決める
export function avatarHue(nick) {
  let h = 0;
  for (const ch of String(nick)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

/* ---------- 画面とFirestore ---------- */

export function createCommunity({ auth, db, fs, ui, getState, getMember, adminUid }) {
  const esc = ui.escapeHtml;
  const $ = (id) => document.getElementById(id);
  const fmtNum = (v) => Number(v).toLocaleString('ja-JP', { maximumFractionDigits: 1 });
  const isAdmin = () => !!(adminUid && auth.currentUser && auth.currentUser.uid === adminUid);

  let me = null;            // { nickname, activeUntil }
  let meLoaded = false;
  let feed = { posts: [], cursor: null, done: false, loading: false, loadedAt: 0, filter: 'all', error: false, showHidden: 0 };
  let draft = null;         // 投稿画面の状態
  let injected = false;
  let reportTarget = null;
  let editTarget = null;

  const untilTimestamp = () => {
    const m = getMember();
    if (!m) return null;
    return m.special === true ? fs.Timestamp.fromMillis(SPECIAL_UNTIL_MS) : (m.expiresAt || null);
  };

  /* ----- DOM(モーダル)を作る ----- */
  function injectDom() {
    if (injected) return;
    injected = true;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-overlay" id="cmNickModal"><div class="modal-box">
        <div class="modal-header"><h2>ニックネームを決めよう</h2><button class="modal-close" data-close="cmNickModal" aria-label="閉じる">×</button></div>
        <p class="cm-lead">「みんなの記録」に載せるときに表示される名前です。<b>本名やログインIDは出ません。</b></p>
        <form id="cmNickForm" autocomplete="off">
          <div class="field"><label for="cmNickInput">ニックネーム <span class="field-hint">${NICK_MIN}〜${NICK_MAX}文字・あとから変更できません</span></label>
            <input type="text" id="cmNickInput" maxlength="${NICK_MAX + 4}" placeholder="例:ベンチ太郎" required></div>
          <div class="cm-consent">
            <b>載せると、こう見えます</b>
            <ul>
              <li>載せた記録(BIG3・メニュー)と、そのときの<b>体重</b>(出さない選択もできます)</li>
              <li>載せた日時と、ひとこと</li>
              <li>すべての会員が見られます。いつでも自分で削除できます</li>
            </ul>
          </div>
          <label class="mg-check"><input type="checkbox" id="cmNickAgree"><span>上の内容を理解しました</span></label>
          <div class="mg-err" id="cmNickErr"></div>
          <button type="submit" class="btn btn-primary">決定する</button>
        </form>
      </div></div>

      <div class="modal-overlay" id="cmShareModal"><div class="modal-box">
        <div class="modal-header"><h2>みんなに見せる</h2><button class="modal-close" data-close="cmShareModal" aria-label="閉じる">×</button></div>
        <div id="cmShareBody"></div>
      </div></div>

      <div class="modal-overlay" id="cmEditModal"><div class="modal-box">
        <div class="modal-header"><h2>ひとことを編集</h2><button class="modal-close" data-close="cmEditModal" aria-label="閉じる">×</button></div>
        <form id="cmEditForm">
          <div class="field"><textarea id="cmEditText" rows="4" maxlength="${COMMENT_MAX}"></textarea><div class="cm-count" id="cmEditCount"></div></div>
          <button type="submit" class="btn btn-primary">保存</button>
        </form>
      </div></div>

      <div class="modal-overlay" id="cmPublicModal"><div class="modal-box">
        <div class="modal-header"><h2>公開プロフィール</h2><button class="modal-close" data-close="cmPublicModal" aria-label="閉じる">×</button></div>
        <div id="cmPublicBody"></div>
      </div></div>

      <div class="modal-overlay" id="cmRivalModal"><div class="modal-box">
        <div class="modal-header"><h2 id="cmRivalTitle">プロフィール</h2><button class="modal-close" data-close="cmRivalModal" aria-label="閉じる">×</button></div>
        <div id="cmRivalBody"></div>
      </div></div>

      <div class="modal-overlay" id="cmReportModal"><div class="modal-box">
        <div class="modal-header"><h2>この投稿を通報</h2><button class="modal-close" data-close="cmReportModal" aria-label="閉じる">×</button></div>
        <p class="cm-lead">運営が内容を確認します。通報したことは、投稿した人には伝わりません。</p>
        <form id="cmReportForm">
          <div class="field"><label for="cmReportReason">理由</label>
            <select id="cmReportReason">${REPORT_REASONS.map(r => `<option>${r}</option>`).join('')}</select></div>
          <button type="submit" class="btn btn-primary">通報する</button>
        </form>
      </div></div>`);

    document.querySelectorAll('#cmNickModal [data-close], #cmShareModal [data-close], #cmEditModal [data-close], #cmReportModal [data-close], #cmPublicModal [data-close], #cmRivalModal [data-close]')
      .forEach(b => b.addEventListener('click', () => ui.closeModal(b.dataset.close)));
    $('cmNickForm').addEventListener('submit', (e) => { e.preventDefault(); ui.guardedSubmit(e.currentTarget, registerNickname); });
    $('cmEditForm').addEventListener('submit', (e) => { e.preventDefault(); ui.guardedSubmit(e.currentTarget, saveEdit); });
    $('cmReportForm').addEventListener('submit', (e) => { e.preventDefault(); ui.guardedSubmit(e.currentTarget, sendReport); });
    $('cmEditText').addEventListener('input', () => { $('cmEditCount').textContent = `${$('cmEditText').value.length}/${COMMENT_MAX}`; });

    const body = $('communityBody');
    if (body) body.addEventListener('click', onBodyClick);
  }

  /* ----- プロフィール(ニックネーム) ----- */
  async function ensureProfile() {
    if (meLoaded) return me;
    try {
      const snap = await fs.getDoc(fs.doc(db, 'profiles', auth.currentUser.uid));
      me = snap.exists() ? snap.data() : null;
      meLoaded = true;
    } catch (e) { console.error(e); }
    return me;
  }

  function openNickModal(afterNick) {
    injectDom();
    draft = afterNick ? { afterNick } : null;
    $('cmNickInput').value = '';
    $('cmNickAgree').checked = false;
    $('cmNickErr').textContent = '';
    ui.openModal('cmNickModal');
  }

  async function registerNickname() {
    const err = $('cmNickErr');
    err.textContent = '';
    const v = validateNickname($('cmNickInput').value, isAdmin());
    if (!v.ok) { err.textContent = v.msg; return; }
    if (!$('cmNickAgree').checked) { err.textContent = '内容を確認して、チェックを入れてください'; return; }
    const until = untilTimestamp();
    if (!until) { err.textContent = '会員情報を確認できません。もう一度お試しください'; return; }
    try {
      const taken = await fs.getDoc(fs.doc(db, 'nicknames', v.key));
      if (taken.exists()) { err.textContent = 'そのニックネームは、すでに使われています'; return; }
      const uid = auth.currentUser.uid;
      const batch = fs.writeBatch(db);
      batch.set(fs.doc(db, 'nicknames', v.key), { uid, createdAt: fs.serverTimestamp() });
      batch.set(fs.doc(db, 'profiles', uid), { nickname: v.nickname, nicknameKey: v.key, activeUntil: until, createdAt: fs.serverTimestamp() });
      await batch.commit();
      me = { nickname: v.nickname, nicknameKey: v.key, activeUntil: until };
      meLoaded = true;
      ui.closeModal('cmNickModal');
      ui.showToast(`「${v.nickname}」で登録しました`);
      if (pendingPublic) { pendingPublic = false; openPublicModal(); }
      else if (draft && draft.afterNick) { const d = draft; draft = null; openShare(d.afterNick); }
      renderCommunity();
    } catch (e) {
      console.error(e);
      err.textContent = e.code === 'permission-denied'
        ? 'そのニックネームは使えません。別の名前にしてください'
        : '登録できませんでした。通信状態をご確認ください';
    }
  }

  // 会員の期限が変わったら(更新・延長)、プロフィールと自分の投稿の掲載期限をそろえる。期限切れの人の投稿を見せないための仕組み
  async function onMemberReady(member) {
    try {
      const uid = auth.currentUser && auth.currentUser.uid;
      if (!uid || !member) return;
      const until = member.special === true ? fs.Timestamp.fromMillis(SPECIAL_UNTIL_MS) : member.expiresAt;
      const target = toMs(until);
      if (target === null) return;
      const key = `ml_cm_until_${uid}`;
      let cached = null;
      try { cached = localStorage.getItem(key); } catch (e) { /* 使えなくても動く */ }
      if (cached === String(target)) return;
      const snap = await fs.getDoc(fs.doc(db, 'profiles', uid));
      if (snap.exists() && toMs(snap.data().activeUntil) !== target) {
        const batch = fs.writeBatch(db);
        batch.update(fs.doc(db, 'profiles', uid), { activeUntil: until });
        const mine = await fs.getDocs(fs.query(fs.collection(db, 'feed'), fs.where('authorUid', '==', uid), fs.limit(100)));
        mine.docs.forEach(d => batch.update(d.ref, { authorActiveUntil: until }));
        await batch.commit();
      }
      try { localStorage.setItem(key, String(target)); } catch (e) { /* 同上 */ }
    } catch (e) { console.warn('掲載期限の同期に失敗しました', e); }
  }

  /* ----- フィード ----- */
  async function loadFeed(reset) {
    if (feed.loading) return;
    feed.loading = true;
    feed.error = false;
    if (reset) { feed.posts = []; feed.cursor = null; feed.done = false; }
    renderCommunity();
    try {
      const cons = [fs.orderBy('createdAt', 'desc')];
      if (feed.cursor) cons.push(fs.startAfter(feed.cursor));
      cons.push(fs.limit(PAGE_SIZE));
      const snap = await fs.getDocs(fs.query(fs.collection(db, 'feed'), ...cons));
      snap.docs.forEach(d => feed.posts.push({ id: d.id, ...d.data() }));
      if (snap.docs.length) feed.cursor = snap.docs[snap.docs.length - 1];
      feed.done = snap.docs.length < PAGE_SIZE;
      feed.loadedAt = Date.now();
    } catch (e) {
      console.error(e);
      feed.error = true;
    }
    feed.loading = false;
    renderCommunity();
  }

  function onShow() {
    injectDom();
    ensureProfile().then(renderCommunity);
    ensurePublic().then(renderCommunity);
    ensureRivals().then(renderCommunity);
    if (rank.open) { if (rank.mode === 'rank') loadRanking(false); else loadRivals(false); }
    if (!feed.posts.length || Date.now() - feed.loadedAt > CACHE_MS) loadFeed(true);
    else renderCommunity();
  }

  function reset() {
    me = null; meLoaded = false; draft = null;
    feed = { posts: [], cursor: null, done: false, loading: false, loadedAt: 0, filter: 'all', error: false, showHidden: 0 };
    pub = { loaded: false, enabled: false, showWeight: false };
    rivals = { loaded: false, uids: [] };
    rank.cache = {}; rank.loading = false; rank.error = false;
    rivalList = { rows: [], at: 0, loading: false };
    rivalView = null; pendingPublic = false;
    clearTimeout(syncTimer);
    const body = $('communityBody');
    if (body) body.innerHTML = '';
  }

  /* ----- 投稿カード ----- */
  function weightHtml(p) {
    if (!(Number(p.bodyWeight) > 0)) return '';
    return `<span class="cm-chip">体重 ${fmtNum(p.bodyWeight)}kg</span>`;
  }

  function big3BodyHtml(p) {
    const b = p.big3 || {};
    const cols = BIG3_LIFTS.map(({ key, short }) => {
      const l = b.lifts ? b.lifts[key] : null;
      return `<div class="cm-lift${l ? '' : ' none'}"><span class="cm-lift-name">${short}</span><b>${l ? fmtNum(l.weight) : '--'}</b><small>${l ? esc(String(l.date).slice(2).replace(/-/g, '/')) : '記録なし'}</small></div>`;
    }).join('');
    const bw = Number(p.bodyWeight) > 0 ? Number(p.bodyWeight) : null;
    const ratio = b.total && bw ? (b.total / bw) : null;
    const total = b.total ? `<div class="cm-total">合計 <b>${fmtNum(b.total)}</b>kg${ratio ? `<span class="cm-chip accent">体重比 ${ratio.toFixed(2)}倍</span>` : ''}</div>` : '';
    return `<div class="cm-big3">${cols}</div>${total}`;
  }

  function menuBodyHtml(p, expanded) {
    const m = p.menu || {};
    const items = Array.isArray(m.items) ? m.items : [];
    const limit = expanded ? items.length : 4;
    const rows = items.slice(0, limit).map(it => {
      if (it.text) {
        return `<div class="cm-ex"><div class="cm-ex-name">${esc(it.name)}<span class="cat-badge">有酸素</span></div><div class="cm-ex-text">${esc(it.text)}</div></div>`;
      }
      const sets = (Array.isArray(it.sets) ? it.sets : []).map(s =>
        `<span class="cm-set${s.drop ? ' drop' : ''}">${s.drop ? '↓ ' : ''}${esc(String(s.weight))}kg×${esc(String(s.reps))}</span>`).join('');
      const cat = it.category && CAT_LABEL[it.category] ? `<span class="cat-badge" data-cat="${esc(it.category)}">${CAT_LABEL[it.category]}</span>` : '';
      return `<div class="cm-ex"><div class="cm-ex-name">${esc(it.name)}${cat}</div><div class="cm-sets">${sets}</div></div>`;
    }).join('');
    const more = items.length > limit
      ? `<button type="button" class="cm-expand" data-act="expand" data-id="${esc(p.id)}">ほか${items.length - limit}種目を見る</button>` : '';
    const vol = Number(m.volume) > 0 ? `・ボリューム ${fmtNum(m.volume)}` : '';
    return `<div class="cm-menu-head">${esc(m.date || '')}のメニュー${vol}</div>${rows}${more}`;
  }

  const expandedIds = new Set();

  function postHtml(p, preview) {
    const t = formatPostTime(p.createdAt);
    const nick = p.nickname || '会員';
    const mine = auth.currentUser && p.authorUid === auth.currentUser.uid;
    const adminBadge = adminUid && p.authorUid === adminUid ? '<span class="cm-badge">運営</span>' : '';
    const typeLabel = p.type === 'big3' ? 'BIG3' : 'メニュー';
    const body = p.type === 'big3' ? big3BodyHtml(p) : menuBodyHtml(p, expandedIds.has(p.id) || preview);
    const comment = String(p.comment || '').trim();
    let actions = '';
    if (!preview) {
      if (mine) actions = `<button type="button" data-act="edit" data-id="${esc(p.id)}">編集</button><button type="button" data-act="delete" data-id="${esc(p.id)}">削除</button>`;
      else actions = `<button type="button" data-act="report" data-id="${esc(p.id)}">通報</button>${isAdmin() ? `<button type="button" data-act="delete" data-id="${esc(p.id)}">削除(運営)</button>` : ''}`;
    }
    return `<article class="cm-post${preview ? ' preview' : ''}" data-id="${esc(p.id || '')}">
      <header class="cm-post-head">
        <span class="cm-avatar" style="--h:${avatarHue(nick)}">${esc(Array.from(nick)[0] || '?')}</span>
        <div class="cm-who"><b>${esc(nick)}</b>${adminBadge}<small>${esc(t.abs)}${t.rel ? `・${t.rel}` : ''}</small></div>
        <span class="cm-type" data-type="${esc(p.type)}">${typeLabel}</span>
      </header>
      <div class="cm-body">${body}</div>
      ${weightHtml(p) ? `<div class="cm-meta">${weightHtml(p)}</div>` : ''}
      ${comment ? `<p class="cm-comment"><span>💬</span>${esc(comment)}</p>` : ''}
      ${actions ? `<footer class="cm-actions">${actions}</footer>` : ''}
    </article>`;
  }

  function renderCommunity() {
    const body = $('communityBody');
    if (!body) return;
    const now = Date.now();
    const visibleAll = feed.posts.filter(p => isPostVisible(p, now));
    const shown = visibleAll.filter(p => feed.filter === 'all' || p.type === feed.filter);
    const seg = ['all', 'big3', 'menu'].map(k =>
      `<button type="button" data-act="filter" data-filter="${k}" class="${feed.filter === k ? 'active' : ''}">${{ all: 'すべて', big3: 'BIG3', menu: 'メニュー' }[k]}</button>`).join('');
    let list;
    if (feed.loading && !feed.posts.length) {
      list = '<div class="cm-skel"></div><div class="cm-skel"></div><div class="cm-skel s"></div>';
    } else if (feed.error && !feed.posts.length) {
      list = `<div class="cm-empty">読み込めませんでした。<br>通信状態をご確認ください。<button type="button" class="btn btn-ghost" data-act="refresh">もう一度読み込む</button></div>`;
    } else if (!shown.length) {
      list = `<div class="cm-empty">${feed.filter === 'all' ? 'まだ投稿がありません。<br>最初の1件を、載せてみましょう。' : 'この種類の投稿は、まだありません。'}
        <button type="button" class="btn btn-primary" data-act="compose">＋ 載せる</button></div>`;
    } else {
      list = shown.map(p => postHtml(p, false)).join('');
    }
    const more = !feed.done && feed.posts.length
      ? `<button type="button" class="cm-more" data-act="more">${feed.loading ? '読み込み中…' : 'さらに表示'}</button>` : '';
    body.innerHTML = `
      <div class="cm-top">
        <div><div class="cm-title">みんなの記録</div><div class="cm-sub">会員が載せた、BIG3とメニュー${me ? `<span class="cm-me">あなた: ${esc(me.nickname)}</span>` : ''}</div></div>
        <button type="button" class="btn btn-primary btn-sm cm-compose" data-act="compose">＋ 載せる</button>
      </div>
      ${rankCardHtml()}
      <div class="cm-section-label">みんなの投稿</div>
      <div class="ga-seg cm-seg" role="tablist" aria-label="種類で絞り込む">${seg}</div>
      <div class="cm-list">${list}</div>
      ${more}
      <div class="cm-foot"><button type="button" class="cm-refresh" data-act="refresh">↻ 更新</button></div>`;
  }

  function onBodyClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    if (act === 'filter') { feed.filter = btn.dataset.filter; renderCommunity(); }
    else if (act === 'refresh') loadFeed(true);
    else if (act === 'more') loadFeed(false);
    else if (act === 'compose') openShare({});
    else if (act === 'expand') { expandedIds.add(id); renderCommunity(); }
    else if (act === 'delete') confirmDelete(id);
    else if (act === 'edit') openEdit(id);
    else if (act === 'report') openReport(id);
    else if (act === 'rank-toggle') {
      rank.open = !rank.open; lsSet('ml_cm_rank_open', rank.open ? '1' : '0');
      renderCommunity();
      if (rank.open) { if (rank.mode === 'rank') loadRanking(false); else loadRivals(false); }
    }
    else if (act === 'rank-mode') { rank.mode = btn.dataset.mode; renderCommunity(); if (rank.mode === 'rank') loadRanking(false); else loadRivals(false); }
    else if (act === 'rank-sort') { rank.sort = btn.dataset.sort; renderCommunity(); loadRanking(false); }
    else if (act === 'rank-refresh') { if (rank.mode === 'rank') loadRanking(true); else loadRivals(true); }
    else if (act === 'rank-open') openRival(btn.dataset.uid);
    else if (act === 'rival-star') { e.stopPropagation(); toggleRival(btn.dataset.uid); }
    else if (act === 'public-open') openPublicModal();
  }


  /* ===== ランキング・ライバル(v2) ===== */
  let pub = { loaded: false, enabled: false, showWeight: false };    // 自分の公開プロフィール
  let rivals = { loaded: false, uids: [] };                          // 自分のライバル(自分だけが読める設定)
  const rank = { open: true, mode: 'rank', sort: 'total', cache: {}, loading: false, error: false };
  let rivalList = { rows: [], at: 0, loading: false };
  let rivalView = null;
  let syncTimer = null;
  let pendingPublic = false;

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* 使えなくても動く */ } };
  const myUid = () => (auth.currentUser ? auth.currentUser.uid : null);
  rank.open = lsGet('ml_cm_rank_open') !== '0';

  function saveFlag() { const u = myUid(); if (u) lsSet(`ml_cm_pub_${u}`, JSON.stringify({ enabled: pub.enabled, showWeight: pub.showWeight })); }
  function readFlag() { const u = myUid(); if (!u) return null; try { return JSON.parse(lsGet(`ml_cm_pub_${u}`) || 'null'); } catch (e) { return null; } }

  async function ensurePublic() {
    if (pub.loaded || !myUid()) return pub;
    try {
      const snap = await fs.getDoc(fs.doc(db, 'publicProfiles', myUid()));
      pub.enabled = snap.exists();
      pub.showWeight = snap.exists() ? !!snap.data().showWeight : false;
      pub.loaded = true;
      saveFlag();
    } catch (e) { console.error(e); }
    return pub;
  }

  async function ensureRivals() {
    if (rivals.loaded || !myUid()) return rivals;
    try {
      const snap = await fs.getDoc(fs.doc(db, 'users', myUid(), 'settings', 'rivals'));
      rivals.uids = snap.exists() && Array.isArray(snap.data().uids) ? snap.data().uids.slice(0, MAX_RIVALS) : [];
      rivals.loaded = true;
    } catch (e) { console.error(e); }
    return rivals;
  }

  function myProfileNow(showWeight) {
    const st = state();
    const snap = composeBig3Snapshot(st.big3ManualEntries);
    const bw = latestBodyWeight(st.weightEntries, st.todayStr());
    return { snap, bw, profile: composePublicProfile(snap, bw, showWeight) };
  }

  function invalidateRank() { rank.cache = {}; rivalList.at = 0; }

  // 公開プロフィールを、いまのBIG3・体重に合わせて書き込む(前回と同じ内容なら書かない)
  async function syncPublicProfile(force) {
    const uid = myUid();
    if (!uid) return;
    await ensureProfile();
    if (!me) return;
    if (!pub.loaded) { const f = readFlag(); if (f) { pub.enabled = !!f.enabled; pub.showWeight = !!f.showWeight; } }
    if (!pub.enabled) return;
    const until = untilTimestamp();
    if (!until) return;
    const { snap, profile } = myProfileNow(pub.showWeight);
    if (!snap.ok) return;   // BIG3の記録が1件も無いときは、書き換えない
    const sig = profileSignature(profile, `${me.nickname}|${toMs(until)}`);
    const key = `ml_cm_pubsig_${uid}`;
    if (!force && lsGet(key) === sig) return;
    await fs.setDoc(fs.doc(db, 'publicProfiles', uid), {
      nickname: me.nickname, ...profile, activeUntil: until, updatedAt: fs.serverTimestamp(),
    });
    lsSet(key, sig);
    invalidateRank();
  }

  // BIG3や体重が変わったら、公開中の人だけ、少し待ってから自動で更新する
  function onDataChanged() {
    const f = pub.loaded ? { enabled: pub.enabled } : readFlag();
    if (!f || !f.enabled) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { syncPublicProfile(false).catch(e => console.warn('公開プロフィールの更新に失敗しました', e)); }, 2500);
  }

  async function setPublic(enabled, showWeight) {
    const uid = myUid();
    if (!uid) return;
    await ensureProfile();
    if (enabled && !me) { pendingPublic = true; ui.closeModal('cmPublicModal'); openNickModal(null); return; }
    try {
      if (enabled) {
        const { snap } = myProfileNow(showWeight);
        if (!snap.ok) { ui.showToast('BIG3タブで記録を追加すると、公開できます'); renderPublicModal(); return; }
        pub.enabled = true; pub.showWeight = !!showWeight; pub.loaded = true; saveFlag();
        await syncPublicProfile(true);
        ui.showToast('公開プロフィールをオンにしました');
      } else {
        await fs.deleteDoc(fs.doc(db, 'publicProfiles', uid));
        pub.enabled = false; pub.showWeight = false; pub.loaded = true; saveFlag();
        lsSet(`ml_cm_pubsig_${uid}`, '');
        invalidateRank();
        ui.showToast('公開プロフィールをオフにしました');
      }
    } catch (e) {
      console.error(e);
      ui.showToast('設定を変更できませんでした。通信状態をご確認ください');
      pub.loaded = false; await ensurePublic();
    }
    renderPublicModal();
    renderCommunity();
    if (rank.open && rank.mode === 'rank') loadRanking(true);
  }

  async function openPublicModal() {
    injectDom();
    await ensureProfile();
    // ニックネームが未登録なら、先に決めてもらう(登録後、そのまま公開設定が開く)
    if (!me) { pendingPublic = true; openNickModal(null); return; }
    ui.openModal('cmPublicModal');
    renderPublicModal();
    ensurePublic().then(renderPublicModal);
  }

  function renderPublicModal() {
    const body = $('cmPublicBody');
    if (!body) return;
    const { snap, bw, profile } = myProfileNow(pub.showWeight);
    const mock = Object.assign({ nickname: me ? me.nickname : '(ニックネーム未登録)', uid: myUid() }, profile);
    const hasData = snap.ok;
    body.innerHTML = `
      <p class="cm-lead">ランキングとライバル一覧に、あなたの<b>BIG3の自己ベスト</b>が載ります。記録を追加・更新すると、<b>自動で更新</b>されます。</p>
      <div class="cm-label">こう載ります</div>
      <div class="cm-rank-list single">${hasData ? rankRowHtml(mock, 0, { preview: true, label: '–' }) : '<div class="cm-empty small">BIG3の記録がありません。BIG3タブで記録を追加すると、公開できます。</div>'}</div>
      <label class="cm-switch"><input type="checkbox" id="cmPubOn" ${pub.enabled ? 'checked' : ''} ${hasData || pub.enabled ? '' : 'disabled'}>
        <span class="cm-switch-ui"></span>
        <span class="cm-switch-text">公開プロフィールをオンにする<small>${pub.enabled ? '公開中です' : 'オフのあいだは、ランキングに載りません'}</small></span></label>
      <label class="cm-switch"><input type="checkbox" id="cmPubWeight" ${pub.showWeight ? 'checked' : ''} ${bw ? '' : 'disabled'}>
        <span class="cm-switch-ui"></span>
        <span class="cm-switch-text">体重も公開する<small>${bw ? `${fmtNum(bw.weight)}kg を載せ、「体重比」ランキングにも参加します` : '体重の記録がありません'}</small></span></label>
      <div class="cm-consent" style="margin-top:14px;">
        <b>公開される項目</b>
        <ul>
          <li>ニックネーム、SQ・BP・DLの自己ベストと合計、更新した日時</li>
          <li>「体重も公開する」をオンにしたときだけ、体重と体重比</li>
          <li>本名・ログインID・メールアドレスは、出ません</li>
        </ul>
        <p class="cm-note" style="margin:8px 0 0;">オフにすると、ランキングからすぐに削除されます。数字は、あなたが入力した記録の自己申告です。</p>
      </div>`;
    const on = $('cmPubOn'), wt = $('cmPubWeight');
    if (on) on.addEventListener('change', () => setPublic(on.checked, pub.showWeight));
    if (wt) wt.addEventListener('change', () => {
      if (pub.enabled) setPublic(true, wt.checked);
      else { pub.showWeight = wt.checked; renderPublicModal(); }
    });
  }

  /* ----- ランキング ----- */
  const rankDef = () => RANK_SORTS.find(x => x.key === rank.sort) || RANK_SORTS[0];

  async function loadRanking(force) {
    const def = rankDef();
    const c = rank.cache[def.key];
    if (!force && c && Date.now() - c.at < CACHE_MS) { renderCommunity(); return; }
    if (rank.loading) return;
    rank.loading = true; rank.error = false;
    renderCommunity();
    try {
      const snap = await fs.getDocs(fs.query(fs.collection(db, 'publicProfiles'),
        fs.where(def.field, '>', 0), fs.orderBy(def.field, 'desc'), fs.limit(RANK_FETCH)));
      rank.cache[def.key] = { at: Date.now(), rows: snap.docs.map(d => ({ uid: d.id, ...d.data() })) };
    } catch (e) { console.error(e); rank.error = true; }
    rank.loading = false;
    renderCommunity();
  }

  function visibleRank() {
    const c = rank.cache[rank.sort];
    if (!c) return null;
    const now = Date.now();
    return c.rows.filter(r => isPostVisible({ authorActiveUntil: r.activeUntil }, now)).slice(0, RANK_SHOW);
  }

  const liftNum = (v) => (typeof v === 'number' && v > 0 ? fmtNum(v) : '--');
  const fmtMetric = (v, def) => (def.dec === 2 ? Number(v).toFixed(2) : fmtNum(v));

  function rankRowHtml(r, idx, opts) {
    const o = opts || {};
    const def = rankDef();
    const nick = r.nickname || '会員';
    const mine = r.uid === myUid();
    const isRival = rivals.uids.includes(r.uid);
    const v = rankValue(r, def.key);
    const sub = `SQ ${liftNum(r.squat)}・BP ${liftNum(r.bench)}・DL ${liftNum(r.deadlift)}`
      + (def.key === 'ratio' && r.total ? `・合計 ${fmtNum(r.total)}` : '')
      + (Number(r.bodyWeight) > 0 && def.key !== 'ratio' ? `・${fmtNum(r.bodyWeight)}kg` : '');
    const no = o.label ? `<span class="cm-rank-no out">${esc(o.label)}</span>`
      : `<span class="cm-rank-no${idx < 3 ? ` m${idx + 1}` : ''}">${idx + 1}</span>`;
    const star = (mine || o.preview) ? '' : `<button type="button" class="cm-star${isRival ? ' on' : ''}" data-act="rival-star" data-uid="${esc(r.uid)}" aria-label="${isRival ? 'ライバルから外す' : 'ライバルに登録'}">${isRival ? '★' : '☆'}</button>`;
    const attrs = (o.preview || o.noOpen) ? '' : ` data-act="rank-open" data-uid="${esc(r.uid)}"`;
    return `<div class="cm-rrow${mine ? ' mine' : ''}"${attrs}>
      ${no}
      <span class="cm-avatar sm" style="--h:${avatarHue(nick)}">${esc(Array.from(nick)[0] || '?')}</span>
      <div class="cm-rmain"><b>${esc(nick)}${mine ? '<span class="cm-you">あなた</span>' : ''}</b><small>${esc(sub)}</small></div>
      <div class="cm-rval">${v === null ? '--' : fmtMetric(v, def)}<small>${def.unit}</small></div>
      ${star}
    </div>`;
  }

  function rankCardHtml() {
    const chev = `<span class="cm-rank-chev${rank.open ? ' open' : ''}">›</span>`;
    const head = `<button type="button" class="cm-rank-head" data-act="rank-toggle" aria-expanded="${rank.open}"><span>🏆 BIG3ランキング</span>${chev}</button>`;
    if (!rank.open) return `<section class="cm-rank collapsed">${head}</section>`;
    const modeSeg = `<div class="ga-seg cm-seg sm" role="tablist" aria-label="表示">
        <button type="button" data-act="rank-mode" data-mode="rank" class="${rank.mode === 'rank' ? 'active' : ''}">ランキング</button>
        <button type="button" data-act="rank-mode" data-mode="rivals" class="${rank.mode === 'rivals' ? 'active' : ''}">ライバル${rivals.uids.length ? ` ${rivals.uids.length}` : ''}</button>
      </div>`;
    const chips = rank.mode === 'rank'
      ? `<div class="cm-chips">${RANK_SORTS.map(x => `<button type="button" data-act="rank-sort" data-sort="${x.key}" class="${rank.sort === x.key ? 'active' : ''}">${x.label}</button>`).join('')}</div>` : '';
    let list;
    if (rank.mode === 'rank') {
      const rows = visibleRank();
      if (!rows && rank.loading) list = '<div class="cm-skel s"></div>';
      else if (rank.error && !rows) list = '<div class="cm-empty small">読み込めませんでした。<button type="button" class="cm-refresh" data-act="rank-refresh">もう一度</button></div>';
      else if (!rows || !rows.length) list = `<div class="cm-empty small">${rank.sort === 'ratio' ? '体重も公開している人が、まだいません。' : 'まだ、ランキングに載っている人がいません。'}</div>`;
      else {
        list = rows.map((r, i) => rankRowHtml(r, i)).join('');
        if (pub.enabled && !rows.some(r => r.uid === myUid())) {
          const { snap, profile } = myProfileNow(pub.showWeight);
          if (snap.ok && rankValue(profile, rank.sort) !== null) {
            list += rankRowHtml(Object.assign({ uid: myUid(), nickname: me ? me.nickname : '' }, profile), 0, { label: '圏外' });
          }
        }
      }
    } else {
      if (rivalList.loading && !rivalList.rows.length) list = '<div class="cm-skel s"></div>';
      else if (!rivals.uids.length) list = '<div class="cm-empty small">まだ、ライバルがいません。<br>ランキングの ☆ を押すと、ここに並びます。</div>';
      else list = rivalList.rows.map(rr => rivalRowHtml(rr)).join('');
    }
    const joined = pub.enabled;
    const foot = joined
      ? `<div class="cm-rank-foot"><span>公開プロフィール: <b>オン</b>${pub.showWeight ? '（体重も公開）' : ''}</span><button type="button" data-act="public-open">設定</button></div>`
      : `<div class="cm-rank-join"><div><b>あなたも参加しませんか?</b><small>BIG3の自己ベストが、自動でランキングに載ります。体重は、出さない選択もできます。</small></div><button type="button" class="btn btn-primary btn-sm" data-act="public-open">参加する</button></div>`;
    return `<section class="cm-rank">${head}${modeSeg}${chips}<div class="cm-rank-list">${list}</div>${foot}</section>`;
  }

  /* ----- ライバル ----- */
  async function toggleRival(uid2) {
    await ensureRivals();
    const has = rivals.uids.includes(uid2);
    if (!has && rivals.uids.length >= MAX_RIVALS) { ui.showToast(`ライバルは${MAX_RIVALS}人までです`); return; }
    const next = has ? rivals.uids.filter(x => x !== uid2) : [...rivals.uids, uid2];
    try {
      await fs.setDoc(fs.doc(db, 'users', myUid(), 'settings', 'rivals'), { uids: next, updatedAt: fs.serverTimestamp() });
      rivals.uids = next;
      rivalList.at = 0;
      ui.showToast(has ? 'ライバルから外しました' : 'ライバルに登録しました');
    } catch (e) { console.error(e); ui.showToast('変更できませんでした'); }
    renderCommunity();
    if (rivalView) renderRival();
    if (rank.open && rank.mode === 'rivals') loadRivals(true);
  }

  async function loadRivals(force) {
    await ensureRivals();
    if (!force && rivalList.at && Date.now() - rivalList.at < CACHE_MS) { renderCommunity(); return; }
    if (!rivals.uids.length) { rivalList = { rows: [], at: Date.now(), loading: false }; renderCommunity(); return; }
    rivalList.loading = true;
    renderCommunity();
    const rows = await Promise.all(rivals.uids.map(async (u) => {
      try {
        const snap = await fs.getDoc(fs.doc(db, 'publicProfiles', u));
        return { uid: u, profile: snap.exists() ? { uid: u, ...snap.data() } : null };
      } catch (e) { return { uid: u, profile: null }; }
    }));
    rivalList = { rows, at: Date.now(), loading: false };
    renderCommunity();
  }

  function diffChip(diff, unit) {
    if (diff === null) return '<span class="cm-muted">--</span>';
    if (diff === 0) return '<span class="ga-chip flat">±0</span>';
    // 相手が上なら「あと◯」(追いかける側)、自分が上なら「+◯」(リード)
    return diff > 0 ? `<span class="ga-chip down">あと ${fmtNum(diff)}${unit}</span>` : `<span class="ga-chip up">+${fmtNum(Math.abs(diff))}${unit}</span>`;
  }

  function rivalRowHtml(rr) {
    const pr = rr.profile;
    const now = Date.now();
    if (!pr || !isPostVisible({ authorActiveUntil: pr.activeUntil }, now)) {
      return `<div class="cm-rrow off"><span class="cm-rank-no out">–</span><span class="cm-avatar sm" style="--h:0">?</span>
        <div class="cm-rmain"><b>公開をやめた会員</b><small>ランキングから外れています</small></div>
        <button type="button" class="cm-star on" data-act="rival-star" data-uid="${esc(rr.uid)}" aria-label="ライバルから外す">★</button></div>`;
    }
    const mine = myProfileNow(true).profile;
    const d = diffVsMe(pr, mine);
    const nick = pr.nickname || '会員';
    return `<div class="cm-rrow" data-act="rank-open" data-uid="${esc(rr.uid)}">
      <span class="cm-avatar sm" style="--h:${avatarHue(nick)}">${esc(Array.from(nick)[0] || '?')}</span>
      <div class="cm-rmain"><b>${esc(nick)}</b><small>SQ ${liftNum(pr.squat)}・BP ${liftNum(pr.bench)}・DL ${liftNum(pr.deadlift)}${Number(pr.bodyWeight) > 0 ? `・${fmtNum(pr.bodyWeight)}kg` : ''}</small></div>
      <div class="cm-rval">${pr.total ? fmtNum(pr.total) : '--'}<small>kg</small><span class="cm-rdiff">${d.total === null ? '' : diffChip(d.total, 'kg')}</span></div>
      <button type="button" class="cm-star on" data-act="rival-star" data-uid="${esc(rr.uid)}" aria-label="ライバルから外す">★</button>
    </div>`;
  }

  async function openRival(uid2) {
    injectDom();
    const cached = Object.values(rank.cache).flatMap(c => c.rows).find(r => r.uid === uid2)
      || (rivalList.rows.find(r => r.uid === uid2) || {}).profile || null;
    rivalView = { uid: uid2, profile: cached, posts: null };
    ui.openModal('cmRivalModal');
    renderRival();
    try {
      if (!cached) {
        const snap = await fs.getDoc(fs.doc(db, 'publicProfiles', uid2));
        rivalView.profile = snap.exists() ? { uid: uid2, ...snap.data() } : null;
      }
      const ps = await fs.getDocs(fs.query(fs.collection(db, 'feed'), fs.where('authorUid', '==', uid2), fs.limit(8)));
      const now = Date.now();
      rivalView.posts = ps.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(p => isPostVisible(p, now))
        .sort((a, b) => (toMs(b.createdAt) || 0) - (toMs(a.createdAt) || 0)).slice(0, 5);
    } catch (e) { console.error(e); if (rivalView) rivalView.posts = []; }
    renderRival();
  }

  function postSummaryHtml(p) {
    const t = formatPostTime(p.createdAt);
    let text = '';
    if (p.type === 'big3') text = p.big3 && p.big3.total ? `BIG3 合計 ${fmtNum(p.big3.total)}kg` : 'BIG3';
    else {
      const names = ((p.menu && p.menu.items) || []).slice(0, 3).map(i => i.name).join('・');
      text = `メニュー ${names}${p.menu && p.menu.items && p.menu.items.length > 3 ? ' ほか' : ''}`;
    }
    const c = String(p.comment || '').trim();
    return `<div class="cm-mini"><div class="cm-mini-top"><b>${esc(text)}</b><small>${esc(t.abs.slice(5))}</small></div>${c ? `<div class="cm-mini-c">💬 ${esc(c.slice(0, 60))}${c.length > 60 ? '…' : ''}</div>` : ''}</div>`;
  }

  function renderRival() {
    const body = $('cmRivalBody');
    if (!body || !rivalView) return;
    const pr = rivalView.profile;
    if (!pr) { $('cmRivalTitle').textContent = 'プロフィール'; body.innerHTML = '<div class="cm-empty small">この会員は、公開プロフィールをオフにしました。</div>'; return; }
    const nick = pr.nickname || '会員';
    $('cmRivalTitle').textContent = nick;
    const isRival = rivals.uids.includes(rivalView.uid);
    const mineSelf = rivalView.uid === myUid();
    const upd = formatPostTime(pr.updatedAt);
    const L = [['SQ', 'squat'], ['BP', 'bench'], ['DL', 'deadlift']];
    const grid = L.map(([n, k]) => `<div class="cm-lift${pr[k] ? '' : ' none'}"><span class="cm-lift-name">${n}</span><b>${liftNum(pr[k])}</b><small>${pr[k] ? 'kg' : '記録なし'}</small></div>`).join('');
    const total = pr.total ? `<div class="cm-total">合計 <b>${fmtNum(pr.total)}</b>kg${pr.ratio ? `<span class="cm-chip accent">体重比 ${Number(pr.ratio).toFixed(2)}倍</span>` : ''}</div>` : '';
    const weight = Number(pr.bodyWeight) > 0 ? `<div class="cm-meta" style="justify-content:center;"><span class="cm-chip">体重 ${fmtNum(pr.bodyWeight)}kg</span></div>` : '';
    let cmp = '';
    if (!mineSelf) {
      const mine = myProfileNow(true).profile;
      const d = diffVsMe(pr, mine);
      const rows = [['合計', 'total', 'kg'], ['SQ', 'squat', 'kg'], ['BP', 'bench', 'kg'], ['DL', 'deadlift', 'kg']].map(([n, k, u]) =>
        `<div class="cm-cmp-row"><span>${n}</span><span>${rankValue(mine, k) !== null ? fmtNum(mine[k]) : '--'}</span><span>${rankValue(pr, k) !== null ? fmtNum(pr[k]) : '--'}</span><span>${diffChip(d[k], u)}</span></div>`).join('');
      cmp = `<div class="cm-label">あなたとの差</div>
        <div class="cm-cmp"><div class="cm-cmp-row head"><span></span><span>あなた</span><span>${esc(nick)}</span><span></span></div>${rows}</div>`;
    }
    const posts = rivalView.posts === null ? '<div class="cm-skel s"></div>'
      : (rivalView.posts.length ? rivalView.posts.map(postSummaryHtml).join('') : '<div class="cm-muted" style="padding:8px 0;">投稿は、まだありません</div>');
    body.innerHTML = `
      <div class="cm-rhead"><span class="cm-avatar lg" style="--h:${avatarHue(nick)}">${esc(Array.from(nick)[0] || '?')}</span>
        <div><b>${esc(nick)}</b><small>${esc(upd.rel || '')}${upd.rel ? 'に更新' : ''}</small></div>
        ${mineSelf ? '' : `<button type="button" class="cm-star big${isRival ? ' on' : ''}" data-rstar="1" aria-label="${isRival ? 'ライバルから外す' : 'ライバルに登録'}">${isRival ? '★ 登録済み' : '☆ ライバルに登録'}</button>`}</div>
      <div class="cm-big3">${grid}</div>${total}${weight}
      ${cmp}
      <div class="cm-label">最近の投稿</div>${posts}`;
    const sb = body.querySelector('[data-rstar]');
    if (sb) sb.addEventListener('click', () => toggleRival(rivalView.uid));
  }

  /* ----- 投稿する ----- */
  function state() { return getState(); }

  function recentMenuDates() {
    const st = state();
    const set = new Set();
    st.workoutLogs.forEach(l => { if (!st.helpers.isGripLog(l) && (st.helpers.isCardioLog(l) || (l.sets || []).length)) set.add(l.date); });
    return [...set].sort().reverse().slice(0, 8);
  }

  async function openShare(opts) {
    injectDom();
    await ensureProfile();
    if (!me) { openNickModal(opts); return; }
    const st = state();
    const today = st.todayStr();
    const dates = recentMenuDates();
    draft = {
      type: opts.type || (st.big3ManualEntries.length ? 'big3' : 'menu'),
      date: opts.date || dates[0] || today,
      withWeight: true,
      comment: '',
    };
    ui.openModal('cmShareModal');
    renderShare();
  }

  function buildDraftPost() {
    const st = state();
    const today = st.todayStr();
    const bw = latestBodyWeight(st.weightEntries, today);
    const base = {
      id: '', type: draft.type, authorUid: auth.currentUser.uid, nickname: me.nickname,
      createdAt: null, comment: draft.comment,
      bodyWeight: draft.withWeight && bw ? bw.weight : null,
      bodyWeightDate: draft.withWeight && bw ? bw.date : null,
      big3: null, menu: null,
    };
    let ok = false, empty = '';
    if (draft.type === 'big3') {
      const s = composeBig3Snapshot(st.big3ManualEntries);
      base.big3 = { lifts: s.lifts, total: s.total };
      ok = s.ok;
      empty = 'BIG3の記録がまだありません。BIG3タブで記録を追加すると、載せられます。';
    } else {
      const s = composeMenuSnapshot(st.workoutLogs, draft.date, st.helpers);
      base.menu = { date: s.date, items: s.items, volume: s.volume };
      ok = s.ok;
      empty = 'この日のメニューの記録がありません。';
    }
    return { post: base, ok, empty, bw };
  }

  function renderShare() {
    const body = $('cmShareBody');
    if (!body || !draft) return;
    const st = state();
    const { post, ok, empty, bw } = buildDraftPost();
    const dates = recentMenuDates();
    const dateChips = draft.type === 'menu' ? `
      <div class="cm-label">どの日のメニュー?</div>
      <div class="cm-datechips">${dates.length
        ? dates.map(d => `<button type="button" data-date="${esc(d)}" class="${d === draft.date ? 'active' : ''}">${esc(d.slice(5).replace('-', '/'))}${d === st.todayStr() ? '（今日）' : ''}</button>`).join('')
        : '<span class="cm-muted">記録のある日がありません</span>'}</div>` : '';
    body.innerHTML = `
      <div class="ga-seg cm-seg" role="tablist" aria-label="載せる内容">
        <button type="button" data-type="big3" class="${draft.type === 'big3' ? 'active' : ''}">BIG3の自己ベスト</button>
        <button type="button" data-type="menu" class="${draft.type === 'menu' ? 'active' : ''}">メニュー</button>
      </div>
      ${dateChips}
      <div class="cm-label">こう載ります</div>
      <div id="cmPreview"></div>
      <label class="cm-switch"><input type="checkbox" id="cmWithWeight" ${draft.withWeight && bw ? 'checked' : ''} ${bw ? '' : 'disabled'}>
        <span class="cm-switch-ui"></span>
        <span class="cm-switch-text">体重を載せる${bw ? `<small>${fmtNum(bw.weight)}kg（${esc(bw.date)}の記録）</small>` : '<small>体重の記録がありません</small>'}</span></label>
      <div class="cm-label">ひとこと <span class="cm-muted">ポイントや感想（任意）</span></div>
      <div class="field" style="margin-bottom:0;"><textarea id="cmComment" rows="3" maxlength="${COMMENT_MAX}" placeholder="例:引き癖を直したら、挙がるようになりました">${esc(draft.comment)}</textarea></div>
      <div class="cm-count" id="cmCount">${draft.comment.length}/${COMMENT_MAX}</div>
      <p class="cm-note">載せると、すべての会員が見られます。あとから、自分で削除できます。載せた日時は自動で記録されます。</p>
      <button type="button" class="btn btn-primary" id="cmPostBtn" ${ok ? '' : 'disabled'}>みんなに載せる</button>`;
    body.querySelectorAll('.cm-seg button').forEach(b => b.addEventListener('click', () => { draft.type = b.dataset.type; renderShare(); }));
    body.querySelectorAll('.cm-datechips button').forEach(b => b.addEventListener('click', () => { draft.date = b.dataset.date; renderShare(); }));
    const sw = $('cmWithWeight');
    if (sw) sw.addEventListener('change', () => { draft.withWeight = sw.checked; renderShare(); });
    const ta = $('cmComment');
    // 入力中は、プレビューの部分だけを描き直す(入力欄やボタンを作り直すと、カーソルが飛んだり、押したボタンが消えたりするため)
    ta.addEventListener('input', () => {
      draft.comment = ta.value;
      $('cmCount').textContent = `${ta.value.length}/${COMMENT_MAX}`;
      renderPreview();
    });
    $('cmPostBtn').addEventListener('click', submitPost);
    renderPreview();
  }

  function renderPreview() {
    const box = $('cmPreview');
    if (!box || !draft) return;
    const { post, ok, empty } = buildDraftPost();
    box.innerHTML = ok ? postHtml(post, true) : `<div class="cm-empty small">${esc(empty)}</div>`;
  }

  async function submitPost() {
    const btn = $('cmPostBtn');
    if (!btn || btn.disabled) return;
    const { post, ok } = buildDraftPost();
    const until = untilTimestamp();
    if (!ok || !until) return;
    btn.disabled = true;
    try {
      const data = {
        type: post.type, authorUid: post.authorUid, nickname: me.nickname,
        createdAt: fs.serverTimestamp(), authorActiveUntil: until,
        bodyWeight: post.bodyWeight, bodyWeightDate: post.bodyWeightDate,
        comment: String(draft.comment || '').trim().slice(0, COMMENT_MAX),
        big3: post.big3, menu: post.menu,
      };
      await fs.addDoc(fs.collection(db, 'feed'), data);
      ui.closeModal('cmShareModal');
      ui.showToast('みんなに載せました');
      draft = null;
      feed.loadedAt = 0; // いま載せた投稿が見えるように、開き直したときに読み込み直す
      const nav = document.querySelector('.tab-btn[data-section="community"]');
      if (nav && !nav.classList.contains('active')) nav.click(); else loadFeed(true);
    } catch (e) {
      console.error(e);
      ui.showToast('載せられませんでした。通信状態をご確認ください');
      btn.disabled = false;
    }
  }

  /* ----- 削除・編集・通報 ----- */
  function findPost(id) { return feed.posts.find(p => p.id === id); }

  function confirmDelete(id) {
    ui.askConfirm('この投稿を削除しますか?（みんなから見えなくなります）', async () => {
      try {
        await fs.deleteDoc(fs.doc(db, 'feed', id));
        feed.posts = feed.posts.filter(p => p.id !== id);
        ui.showToast('削除しました');
        renderCommunity();
      } catch (e) { console.error(e); ui.showToast('削除できませんでした'); }
    });
  }

  function openEdit(id) {
    const p = findPost(id);
    if (!p) return;
    editTarget = id;
    $('cmEditText').value = p.comment || '';
    $('cmEditCount').textContent = `${$('cmEditText').value.length}/${COMMENT_MAX}`;
    ui.openModal('cmEditModal');
  }
  async function saveEdit() {
    const p = findPost(editTarget);
    if (!p) return;
    const comment = $('cmEditText').value.trim().slice(0, COMMENT_MAX);
    try {
      await fs.updateDoc(fs.doc(db, 'feed', editTarget), { comment });
      p.comment = comment;
      ui.closeModal('cmEditModal');
      ui.showToast('ひとことを更新しました');
      renderCommunity();
    } catch (e) { console.error(e); ui.showToast('更新できませんでした'); }
  }

  function openReport(id) {
    reportTarget = id;
    ui.openModal('cmReportModal');
  }
  async function sendReport() {
    const p = findPost(reportTarget);
    if (!p) return;
    const uid = auth.currentUser.uid;
    try {
      await fs.setDoc(fs.doc(db, 'reports', `${reportTarget}_${uid}`), {
        postId: reportTarget, postAuthorUid: p.authorUid, reporterUid: uid,
        reason: $('cmReportReason').value, createdAt: fs.serverTimestamp(),
      });
      ui.closeModal('cmReportModal');
      ui.showToast('通報しました。ありがとうございます');
    } catch (e) {
      console.error(e);
      ui.showToast(e.code === 'permission-denied' ? 'この投稿は、すでに通報済みです' : '通報できませんでした');
    }
  }

  return { onShow, onMemberReady, onDataChanged, openShare, reset };
}
