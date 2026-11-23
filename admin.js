// 管理画面(オーナー専用)。権限は Firestore ルール側(isAdmin = UID一致)で守る。ここの判定は表示用
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, orderBy, limit,
  runTransaction, writeBatch, serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { PLANS, SOON_DAYS, deriveState, computeNewExpiry, formatDateJst, toAuthEmail } from "./membership.js";

const ADMIN_UID = "sLq6Uam7LdTBMAUonX2Tk3hHejl2";
const firebaseConfig = {
  apiKey: "AIzaSyCX0_RS20799DgzbeT-IQdwwwcdHlA1vSM",
  authDomain: "muscle-log-f9d37.firebaseapp.com",
  projectId: "muscle-log-f9d37",
  storageBucket: "muscle-log-f9d37.firebasestorage.app",
  messagingSenderId: "988087018690",
  appId: "1:988087018690:web:16bdedc26042d63221875b",
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const DAY = 86400000, JST = 9 * 3600000;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : typeof v === 'number' ? v : null);
const todayJst = () => new Date(Date.now() + JST).toISOString().slice(0, 10);
// 日付入力(YYYY-MM-DD)を、その日の日本時間 12:00 のミリ秒に
const dateInputMs = (s) => Date.parse(s + 'T12:00:00+09:00');
const endOfDayJstMs = (s) => Date.parse(s + 'T23:59:59.999+09:00');

let members = [];
let logs = [];
let reports = [];
let tab = 'pending';
let filter = { q: '', kind: 'all' };

function toast(msg) {
  const t = $('adToast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------- 画面の出し分け ---------- */
function show(which) {
  $('adGate').hidden = which !== 'gate';
  $('adLogin').hidden = which !== 'login';
  $('adApp').hidden = which !== 'app';
}

onAuthStateChanged(auth, async (user) => {
  if (!user) { show('login'); return; }
  if (user.uid !== ADMIN_UID) {
    show('gate');
    $('adGate').innerHTML = '<div>この画面は管理者専用です。<br><button id="adOut" class="ad-btn" style="margin-top:12px">ログアウト</button></div>';
    $('adOut').onclick = () => signOut(auth);
    return;
  }
  show('app');
  await loadAll();
});

$('adLoginBtn').onclick = async () => {
  const err = $('adLoginErr');
  err.textContent = '';
  try {
    await signInWithEmailAndPassword(auth, toAuthEmail($('adId').value), $('adPw').value);
  } catch (e) {
    err.textContent = 'ログインできませんでした';
  }
};
$('adReload').onclick = () => loadAll();

/* ---------- 読み込み ---------- */
async function loadAll() {
  try {
    const [m, l, r] = await Promise.all([
      getDocs(collection(db, 'members')),
      getDocs(query(collection(db, 'membershipLogs'), orderBy('at', 'desc'), limit(100))),
      getDocs(query(collection(db, 'reports'), limit(100))),
    ]);
    members = m.docs.map((d) => ({ uid: d.id, ...d.data() }));
    logs = l.docs.map((d) => ({ id: d.id, ...d.data() }));
    reports = r.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    $('adBody').innerHTML = `<div class="ad-empty">読み込めませんでした(${esc(e.code || e.message)})<br>ルールの反映を確認してください</div>`;
    return;
  }
  render();
}

function stateOf(m) { return deriveState(m, Date.now()); }
const KIND_LABEL = { active: '会員', trial: 'お試し', special: '特別会員', expired: '期限切れ', suspended: '停止中', none: '-' };

function renderSummary() {
  const c = { active: 0, trial: 0, special: 0, expired: 0, suspended: 0, soon: 0, wait: 0 };
  members.forEach((m) => {
    const s = stateOf(m);
    c[s.kind]++;
    if (m.renewRequestedAt) c.wait++;
    if (s.kind === 'active' && s.daysLeft != null && s.daysLeft <= SOON_DAYS) c.soon++;
  });
  const tile = (n, label, hot) => `<div class="ad-tile${hot && n ? ' hot' : ''}"><b>${n}</b><span>${label}</span></div>`;
  $('adSummary').innerHTML =
    tile(members.length, '全員') + tile(c.active, '有料会員') + tile(c.trial, 'お試し中') + tile(c.special, '特別会員') +
    tile(c.expired, '期限切れ') + tile(c.suspended, '停止中') + tile(c.soon, `${SOON_DAYS}日以内に期限`, true) + tile(c.wait, '承認待ち', true);
  const pn = $('adPendingN'); pn.textContent = c.wait; pn.hidden = !c.wait;
  const rn = $('adReportN'); rn.textContent = reportGroups().length; rn.hidden = !reportGroups().length;
}

function render() {
  renderSummary();
  document.querySelectorAll('#adTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const body = $('adBody');
  if (tab === 'pending') body.innerHTML = pendingHtml();
  else if (tab === 'members') body.innerHTML = membersHtml();
  else if (tab === 'logs') body.innerHTML = logsHtml();
  else { body.innerHTML = '<div class="ad-empty">読み込み中…</div>'; renderReports(); }
}
$('adTabs').onclick = (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  tab = b.dataset.tab;
  render();
};

/* ---------- 会員の行 ---------- */
function memberRow(m, withApprove) {
  const s = stateOf(m);
  const pill = `<span class="ad-pill ${s.kind}">${KIND_LABEL[s.kind]}</span>`;
  const wait = m.renewRequestedAt ? '<span class="ad-pill wait">振込申告あり</span>' : '';
  const exp = s.kind === 'special' ? '期限なし' : (m.expiresAt ? `期限 ${formatDateJst(m.expiresAt)}` : '期限なし');
  const planTxt = m.renewPlan ? `希望:${PLANS[m.renewPlan] ? PLANS[m.renewPlan].label : esc(m.renewPlan)}` : (PLANS[m.plan] ? PLANS[m.plan].label : '');
  return `<div class="ad-row" data-uid="${esc(m.uid)}">
    <div class="ad-row-top">
      <div><div class="ad-name">${esc(m.nameKana || '(名前なし)')} <span class="ad-sub">${esc(m.memberNo || '')}</span></div>
        <div class="ad-sub">ID:${esc(m.loginId || '-')} ・ 振込名義:${esc(m.payerName || m.nameKana || '-')}</div>
        <div class="ad-sub">${esc(exp)} ・ ${esc(planTxt)}${m.contactEmail ? ' ・ ' + esc(m.contactEmail) : ''}</div></div>
      <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">${pill}${wait}</div>
    </div>
    <div class="ad-actions">
      <button class="ad-btn sm primary" data-act="approve">${withApprove ? '入金を確認して承認' : (m.memberNo ? '更新' : '承認')}</button>
      <button class="ad-btn sm" data-act="adjust">期限を調整</button>
      ${m.status === 'suspended' ? '<button class="ad-btn sm" data-act="resume">停止を解除</button>' : '<button class="ad-btn sm warn" data-act="suspend">停止</button>'}
      <button class="ad-btn sm" data-act="special">${m.special ? '特別会員を外す' : '特別会員にする'}</button>
    </div></div>`;
}

function pendingHtml() {
  const list = members.filter((m) => m.renewRequestedAt)
    .sort((a, b) => ms(a.renewRequestedAt) - ms(b.renewRequestedAt));
  if (!list.length) return '<div class="ad-empty">承認待ちはありません</div>';
  return list.map((m) => memberRow(m, true)).join('');
}

function membersHtml() {
  const q = filter.q.trim().toLowerCase();
  const list = members.filter((m) => {
    const k = stateOf(m).kind;
    if (filter.kind !== 'all' && k !== filter.kind) return false;
    if (!q) return true;
    return [m.nameKana, m.loginId, m.memberNo, m.payerName, m.contactEmail].some((v) => String(v || '').toLowerCase().includes(q));
  }).sort((a, b) => (ms(b.createdAt) || 0) - (ms(a.createdAt) || 0));
  const opts = Object.entries(KIND_LABEL).filter(([k]) => k !== 'none')
    .map(([k, v]) => `<option value="${k}"${filter.kind === k ? ' selected' : ''}>${v}</option>`).join('');
  return `<div class="ad-tools"><input id="adQ" placeholder="名前・ID・会員番号で検索" value="${esc(filter.q)}">
    <select id="adKind"><option value="all">すべて</option>${opts}</select></div>
    <div id="adMemberList">${list.length ? list.map((m) => memberRow(m, false)).join('') : '<div class="ad-empty">該当なし</div>'}</div>
    <div class="ad-actions"><button class="ad-btn" id="adAddSpecial">+ 特別会員を追加(既存ユーザー用)</button></div>`;
}

document.addEventListener('input', (e) => {
  if (e.target.id === 'adQ') {
    filter.q = e.target.value;
    render();
    const q = $('adQ'); // 再描画で外れたフォーカスを戻す
    q.focus(); q.setSelectionRange(q.value.length, q.value.length);
  }
});
document.addEventListener('change', (e) => { if (e.target.id === 'adKind') { filter.kind = e.target.value; render(); } });

/* ---------- 履歴 ---------- */
const ACTION_LABEL = { approve: '承認', renew: '更新', adjust: '期限調整', suspend: '停止', resume: '停止解除', special: '特別会員', special_off: '特別会員を解除', post_delete: '投稿を削除', add_special: '特別会員を追加' };
function logsHtml() {
  if (!logs.length) return '<div class="ad-empty">履歴はまだありません</div>';
  return logs.map((l) => {
    const at = ms(l.at);
    const date = at ? formatDateJst(at) + ' ' + new Date(at + JST).toISOString().slice(11, 16) : '';
    const plan = l.plan && PLANS[l.plan] ? PLANS[l.plan].label : '';
    const range = l.toExpiry ? `${l.fromExpiry ? formatDateJst(l.fromExpiry) : '-'} → ${formatDateJst(l.toExpiry)}` : '';
    return `<div class="ad-row"><div class="ad-row-top"><div class="ad-name">${esc(ACTION_LABEL[l.action] || l.action)} <span class="ad-sub">${esc(l.nameKana || '')} ${esc(l.memberNo || '')}</span></div><div class="ad-sub">${esc(date)}</div></div>
      <div class="ad-sub">${esc([plan, range, l.confirmDate ? '入金確認日 ' + l.confirmDate : '', l.note].filter(Boolean).join(' ・ '))}</div></div>`;
  }).join('');
}

/* ---------- モーダル ---------- */
function openModal(html) { $('adModalCard').innerHTML = html; $('adModal').hidden = false; }
function closeModal() { $('adModal').hidden = true; $('adModalCard').innerHTML = ''; }
$('adModal').addEventListener('click', (e) => { if (e.target === $('adModal')) closeModal(); });

async function writeLog(extra) {
  await setDoc(doc(collection(db, 'membershipLogs')), { ...extra, at: serverTimestamp(), by: ADMIN_UID });
}
function logBase(m) { return { uid: m.uid, memberNo: m.memberNo || null, loginId: m.loginId || '', nameKana: m.nameKana || '' }; }

/* 承認・更新:期限 = max(今の期限, 入金確認日) + プラン月数。会員番号は初回だけ採番 */
function openApprove(m) {
  const plan0 = m.renewPlan || m.plan || 'half';
  const cur = m.trial ? null : ms(m.expiresAt);
  openModal(`<h2>${m.memberNo ? '更新' : '承認'}:${esc(m.nameKana)}</h2>
    <div class="ad-field"><label>プラン</label><select id="apPlan">${Object.entries(PLANS).map(([k, p]) => `<option value="${k}"${k === plan0 ? ' selected' : ''}>${p.label}(${p.price.toLocaleString()}円)</option>`).join('')}</select></div>
    <div class="ad-field"><label>入金確認日</label><input id="apDate" type="date" value="${todayJst()}"></div>
    <div class="ad-preview" id="apPreview"></div>
    <div class="ad-modal-actions"><button class="ad-btn" id="apCancel">キャンセル</button><button class="ad-btn primary" id="apOk">確定する</button></div>`);
  const calc = () => {
    const d = $('apDate').value;
    if (!d) return null;
    return computeNewExpiry(cur, dateInputMs(d), $('apPlan').value);
  };
  const upd = () => {
    const n = calc();
    $('apPreview').innerHTML = n
      ? `現在の期限:${cur ? formatDateJst(cur) : (m.trial ? 'お試し(入金確認日から開始)' : 'なし')}<br>新しい期限:<b>${formatDateJst(n)}</b>${m.memberNo ? '' : '<br>会員番号:承認時に自動で付きます'}`
      : '入金確認日を選んでください';
    $('apOk').disabled = !n;
  };
  $('apPlan').onchange = upd; $('apDate').oninput = upd; upd();
  $('apCancel').onclick = closeModal;
  $('apOk').onclick = async () => {
    const btn = $('apOk');
    btn.disabled = true;
    try {
      const plan = $('apPlan').value, dateStr = $('apDate').value;
      const newExp = computeNewExpiry(cur, dateInputMs(dateStr), plan);
      let memberNo = m.memberNo || null;
      await runTransaction(db, async (tx) => {
        const mref = doc(db, 'members', m.uid);
        if (!memberNo) {
          const cref = doc(db, 'counters', 'members');
          const cs = await tx.get(cref);
          const next = (cs.exists() && cs.data().next) || 1;
          memberNo = 'M' + String(next).padStart(4, '0');
          tx.set(cref, { next: next + 1 });
        }
        tx.update(mref, {
          status: 'active', trial: false, plan, memberNo, expiresAt: Timestamp.fromDate(newExp),
          approvedAt: serverTimestamp(), renewPlan: null, renewRequestedAt: null,
        });
        tx.set(doc(collection(db, 'membershipLogs')), {
          ...logBase({ ...m, memberNo }), action: m.memberNo ? 'renew' : 'approve', plan,
          fromExpiry: cur != null ? Timestamp.fromMillis(cur) : null, toExpiry: Timestamp.fromDate(newExp),
          confirmDate: dateStr, note: '', at: serverTimestamp(), by: ADMIN_UID,
        });
      });
      closeModal(); toast('承認しました'); await loadAll();
    } catch (e) {
      btn.disabled = false; toast('失敗しました:' + (e.code || e.message));
    }
  };
}

function openAdjust(m) {
  const cur = ms(m.expiresAt);
  const val = cur ? new Date(cur + JST).toISOString().slice(0, 10) : todayJst();
  openModal(`<h2>期限を調整:${esc(m.nameKana)}</h2>
    <div class="ad-field"><label>新しい期限(その日の終わりまで)</label><input id="ajDate" type="date" value="${val}"></div>
    <div class="ad-field"><label>理由(履歴に残ります)</label><input id="ajNote" maxlength="80" placeholder="例:お詫びで1か月延長"></div>
    <div class="ad-modal-actions"><button class="ad-btn" id="ajCancel">キャンセル</button><button class="ad-btn primary" id="ajOk">変更する</button></div>`);
  $('ajCancel').onclick = closeModal;
  $('ajOk').onclick = async () => {
    const d = $('ajDate').value;
    if (!d) return;
    const to = endOfDayJstMs(d);
    try {
      await updateDoc(doc(db, 'members', m.uid), { expiresAt: Timestamp.fromMillis(to) });
      await writeLog({ ...logBase(m), action: 'adjust', fromExpiry: cur != null ? Timestamp.fromMillis(cur) : null, toExpiry: Timestamp.fromMillis(to), note: $('ajNote').value.trim().slice(0, 80) });
      closeModal(); toast('変更しました'); await loadAll();
    } catch (e) { toast('失敗しました:' + (e.code || e.message)); }
  };
}

function confirmModal(title, text, okLabel, onOk, danger) {
  openModal(`<h2>${esc(title)}</h2><p class="ad-dim">${esc(text)}</p>
    <div class="ad-modal-actions"><button class="ad-btn" id="cfCancel">やめる</button><button class="ad-btn ${danger ? 'danger' : 'primary'}" id="cfOk">${esc(okLabel)}</button></div>`);
  $('cfCancel').onclick = closeModal;
  $('cfOk').onclick = async () => {
    $('cfOk').disabled = true;
    try { await onOk(); closeModal(); await loadAll(); } catch (e) { $('cfOk').disabled = false; toast('失敗しました:' + (e.code || e.message)); }
  };
}

async function setStatus(m, status) {
  await updateDoc(doc(db, 'members', m.uid), { status });
  await writeLog({ ...logBase(m), action: status === 'suspended' ? 'suspend' : 'resume', note: '' });
  toast(status === 'suspended' ? '停止しました' : '解除しました');
}
async function toggleSpecial(m) {
  const on = !m.special;
  await updateDoc(doc(db, 'members', m.uid), { special: on });
  await writeLog({ ...logBase(m), action: on ? 'special' : 'special_off', note: '' });
  toast('変更しました');
}

function openAddSpecial() {
  openModal(`<h2>特別会員を追加</h2>
    <p class="ad-dim">すでにFirebase Authenticationにいるユーザー用です。UIDはFirebaseコンソールの「Authentication」で確認できます。</p>
    <div class="ad-field"><label>UID</label><input id="spUid"></div>
    <div class="ad-field"><label>ログインID(メールアドレスでも可)</label><input id="spId" autocapitalize="none"></div>
    <div class="ad-field"><label>名前(カタカナ)</label><input id="spName"></div>
    <div class="ad-err" id="spErr"></div>
    <div class="ad-modal-actions"><button class="ad-btn" id="spCancel">キャンセル</button><button class="ad-btn primary" id="spOk">追加する</button></div>`);
  $('spCancel').onclick = closeModal;
  $('spOk').onclick = async () => {
    const uid = $('spUid').value.trim(), id = $('spId').value.trim(), name = $('spName').value.trim();
    if (!uid || !id || !name) { $('spErr').textContent = 'すべて入力してください'; return; }
    if (members.some((m) => m.uid === uid)) { $('spErr').textContent = 'すでに登録されています'; return; }
    try {
      await setDoc(doc(db, 'members', uid), {
        loginId: id, nameKana: name, payerName: '', plan: 'year', contactEmail: '', status: 'active', special: true, trial: false,
        memberNo: null, expiresAt: Timestamp.fromDate(new Date(Date.UTC(2100, 0, 1))), createdAt: serverTimestamp(),
        approvedAt: serverTimestamp(), renewPlan: null, renewRequestedAt: null,
      });
      await writeLog({ uid, memberNo: null, loginId: id, nameKana: name, action: 'add_special', note: '' });
      closeModal(); toast('追加しました'); await loadAll();
    } catch (e) { $('spErr').textContent = '失敗しました:' + (e.code || e.message); }
  };
}

/* ---------- 通報 ---------- */
function reportGroups() {
  const g = new Map();
  reports.forEach((r) => {
    const x = g.get(r.postId) || { postId: r.postId, authorUid: r.postAuthorUid, items: [] };
    x.items.push(r);
    g.set(r.postId, x);
  });
  return [...g.values()].sort((a, b) => b.items.length - a.items.length);
}

async function renderReports() {
  const groups = reportGroups();
  if (!groups.length) { $('adBody').innerHTML = '<div class="ad-empty">通報はありません</div>'; return; }
  const posts = await Promise.all(groups.map((g) => getDoc(doc(db, 'feed', g.postId)).catch(() => null)));
  if (tab !== 'reports') return;
  $('adBody').innerHTML = groups.map((g, i) => {
    const snap = posts[i];
    const p = snap && snap.exists() ? snap.data() : null;
    const reasons = [...new Set(g.items.map((r) => r.reason))].map(esc).join('・');
    const body = p
      ? `<div class="ad-post"><b>${esc(p.nickname || '')}</b>(${esc(p.type || '')})\n${esc(p.comment || '(コメントなし)')}</div>`
      : '<div class="ad-sub">この投稿はすでに削除されています</div>';
    return `<div class="ad-row" data-post="${esc(g.postId)}"><div class="ad-row-top"><div class="ad-name">${g.items.length}件の通報</div><div class="ad-sub">${reasons}</div></div>${body}
      <div class="ad-actions">${p ? '<button class="ad-btn sm danger" data-ract="delete">投稿を削除</button>' : ''}<button class="ad-btn sm" data-ract="dismiss">問題なし(通報を消す)</button></div></div>`;
  }).join('');
}

async function removeReports(postId) {
  const b = writeBatch(db);
  reports.filter((r) => r.postId === postId).forEach((r) => b.delete(doc(db, 'reports', r.id)));
  await b.commit();
}

/* ---------- クリック ---------- */
document.addEventListener('click', (e) => {
  if (e.target.id === 'adAddSpecial') { openAddSpecial(); return; }
  const rb = e.target.closest('[data-ract]');
  if (rb) {
    const postId = rb.closest('[data-post]').dataset.post;
    if (rb.dataset.ract === 'delete') {
      confirmModal('投稿を削除しますか?', '削除すると元に戻せません。この投稿への通報も消えます。', '削除する', async () => {
        await deleteDoc(doc(db, 'feed', postId));
        await removeReports(postId);
        await writeLog({ uid: (reports.find((r) => r.postId === postId) || {}).postAuthorUid || '', memberNo: null, loginId: '', nameKana: '', action: 'post_delete', note: postId });
        toast('削除しました');
      }, true);
    } else {
      confirmModal('通報を消しますか?', '投稿はそのまま残ります。', '消す', async () => { await removeReports(postId); toast('消しました'); });
    }
    return;
  }
  const ab = e.target.closest('[data-act]');
  if (!ab) return;
  const m = members.find((x) => x.uid === ab.closest('[data-uid]').dataset.uid);
  if (!m) return;
  const act = ab.dataset.act;
  if (act === 'approve') openApprove(m);
  else if (act === 'adjust') openAdjust(m);
  else if (act === 'suspend') confirmModal('停止しますか?', `${m.nameKana} さんはアプリを使えなくなります(データは残ります)。`, '停止する', () => setStatus(m, 'suspended'), true);
  else if (act === 'resume') confirmModal('停止を解除しますか?', `${m.nameKana} さんが再びアプリを使えるようになります。`, '解除する', () => setStatus(m, 'active'));
  else if (act === 'special') confirmModal(m.special ? '特別会員を外しますか?' : '特別会員にしますか?', m.special ? '期限の判定が通常どおりになります。' : '期限なしで使えるようになります。', 'OK', () => toggleSpecial(m));
});
