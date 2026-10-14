// 会員制の画面と、会員台帳(members/{uid})の読み書き。
// Firebaseの各関数は index.html から受け取る。
import {
  PLANS, SIGNUP_OPEN, TRIAL_DAYS, SOON_DAYS, PAYMENT_PATH, LOGIN_DOMAIN,
  toAuthEmail, isValidLoginId, normalizeKana, isKanaName, trialExpiry,
  deriveState, formatDateJst, bankInfoMissing,
} from './membership.js';

export function createMembership({ auth, db, fs, authApi, ui }) {
  const { escapeHtml: esc } = ui;
  let member = null;
  let pendingSignup = null;
  let payment = null;

  const $ = (id) => document.getElementById(id);
  const yen = (n) => '¥' + n.toLocaleString('ja-JP');

  /* ---------- DOM ---------- */
  function injectDom() {
    if ($('memberGate')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div id="memberGate"><div class="mg-card">
        <div class="auth-logo">MUSCLE<span>LOG</span></div>
        <div id="mgBody"></div>
        <div class="mg-actions">
          <button type="button" class="btn btn-ghost" id="mgRecheck">状態を再確認</button>
          <button type="button" class="btn btn-ghost" id="mgLogout">ログアウト</button>
        </div>
      </div></div>

      <div class="modal-overlay" id="payModal"><div class="modal-box">
        <div class="modal-header"><h2>本契約・更新のお手続き</h2><button class="modal-close" data-close="payModal">×</button></div>
        <div id="payPanel"></div>
      </div></div>

      <div class="modal-overlay" id="signupModal"><div class="modal-box">
        <div class="modal-header"><h2>新規申込(${TRIAL_DAYS}日間無料)</h2><button class="modal-close" data-close="signupModal">×</button></div>
        <p class="mg-text">申込するとすぐにお試しで使えます。お試し期間が終わるまでに、本契約のお手続きをお願いします。</p>
        <form id="signupForm" autocomplete="off">
          <div class="field"><label for="suId">ログインID <span class="field-hint">半角英数字と _ - の4〜20字</span></label>
            <input type="text" id="suId" autocapitalize="none" autocomplete="username" required></div>
          <div class="field"><label for="suPw">パスワード <span class="field-hint">8文字以上</span></label>
            <input type="password" id="suPw" autocomplete="new-password" minlength="8" required></div>
          <div class="field"><label for="suName">お名前(カタカナ)</label>
            <input type="text" id="suName" placeholder="ヤマダ タロウ" required></div>
          <div class="field"><label for="suPlan">希望プラン</label>
            <select id="suPlan">
              <option value="half">${PLANS.half.label}(${yen(PLANS.half.price)})</option>
              <option value="year">${PLANS.year.label}(${yen(PLANS.year.price)})</option>
            </select></div>
          <div class="field"><label for="suPayer">振込名義 <span class="field-hint">お名前と違う場合のみ・カタカナ</span></label>
            <input type="text" id="suPayer"></div>
          <div class="field"><label for="suMail">連絡用メールアドレス <span class="field-hint">任意</span></label>
            <input type="email" id="suMail" autocomplete="email"></div>
          <label class="mg-check"><input type="checkbox" id="suAgree">
            <span><a href="terms.html" target="_blank" rel="noopener">利用規約</a>と<a href="privacy.html" target="_blank" rel="noopener">プライバシーポリシー</a>に同意します</span></label>
          <div class="mg-err" id="suErr"></div>
          <button type="submit" class="btn btn-primary">申込んで${TRIAL_DAYS}日間無料で始める</button>
        </form>
      </div></div>`);

    const bar = document.querySelector('#appScreen header.appbar');
    if (bar) bar.insertAdjacentHTML('afterend', '<div id="memberBanner"><span id="memberBannerText"></span><button type="button" id="memberBannerBtn">お手続き</button></div>');

    const sHead = document.querySelector('#settingsModal .modal-box .modal-header');
    if (sHead) sHead.insertAdjacentHTML('afterend', '<div class="member-info-box" id="memberInfoBox"></div>');

    if (SIGNUP_OPEN) {
      const form = $('loginForm');
      if (form) form.insertAdjacentHTML('beforeend',
        '<button type="button" id="openSignupLink" class="btn btn-ghost" style="margin-top:14px;">新規申込(7日間無料)</button>');
      const link = $('openSignupLink');
      if (link) link.addEventListener('click', () => ui.openModal('signupModal'));
    }

    $('mgRecheck').addEventListener('click', async () => { await wipeLocalCache(); location.reload(); });
    $('mgLogout').addEventListener('click', async () => {
      try { await authApi.signOut(auth); } catch (e) { /* 失敗しても再読み込みで戻る */ }
      await wipeLocalCache();
      location.reload();
    });
    $('memberBannerBtn').addEventListener('click', () => openPay());
    $('signupForm').addEventListener('submit', (e) => { e.preventDefault(); ui.guardedSubmit(e.currentTarget, signup); });
    document.querySelectorAll('#payModal [data-close], #signupModal [data-close]').forEach((b) =>
      b.addEventListener('click', () => ui.closeModal(b.dataset.close)));
  }

  // 閲覧できない状態になったとき、端末内のオフラインキャッシュを消す。
  // ※消したあとはこのページのFirestoreが使えなくなるので、再読み込みの直前にだけ呼ぶ
  async function wipeLocalCache() {
    if (!blockedNow) return;
    try { await fs.terminate(db); await fs.clearIndexedDbPersistence(db); } catch (e) { /* 他タブが開いている等 */ }
  }
  let blockedNow = false;

  // 振込先・連絡先(config/payment)。ログイン済みなら誰でも読める。画面で必要になったときに1回だけ読む
  async function loadPayment() {
    if (payment) return payment;
    try {
      const snap = await fs.getDoc(fs.doc(db, ...PAYMENT_PATH));
      payment = snap.exists() ? snap.data() : null;
    } catch (e) {
      console.error(e);
    }
    return payment;
  }

  /* ---------- 状態の確認(起動時に1回) ---------- */
  async function check(user) {
    injectDom();
    if (pendingSignup) { try { await pendingSignup; } catch (e) { /* 失敗時は下で「登録の続き」になる */ } }
    let snap;
    try {
      snap = await fs.getDoc(fs.doc(db, 'members', user.uid));
    } catch (err) {
      console.error(err);
      await showGate('error');
      return false;
    }
    member = snap.exists() ? snap.data() : null;
    const st = deriveState(member);
    if (st.allowed) {
      blockedNow = false;
      $('memberGate').classList.remove('active');
      renderBanner(st);
      renderInfo(st);
      return true;
    }
    blockedNow = true;
    $('memberBanner').classList.remove('active');
    await showGate(st.kind, st);
    return false;
  }

  async function showGate(kind, st) {
    const body = $('mgBody');
    const needsContact = kind !== 'expired';
    const info = needsContact ? await loadPayment() : null;
    const contact = !needsContact ? ''
      : info && info.contact
        ? `<div class="mg-meta"><b>運営への連絡先</b><br>${esc(info.contact).replace(/\n/g, '<br>')}</div>`
        : '<div class="mg-warn">【要入力】連絡先が未設定です(Firestore の config/payment の contact)</div>';
    $('memberGate').classList.add('active');
    $('mgRecheck').style.display = '';

    if (kind === 'error') {
      body.innerHTML = `<div class="mg-title">会員情報を確認できません</div>
        <p class="mg-text">通信状態をご確認のうえ、「状態を再確認」を押してください。改善しない場合は運営までご連絡ください。</p>${contact}`;
    } else if (kind === 'suspended') {
      body.innerHTML = `<div class="mg-title">ご利用を停止しています</div>
        <p class="mg-text">現在、このアカウントはご利用いただけません。心当たりがない場合や、再開のご希望は運営までご連絡ください。</p>${contact}`;
    } else if (kind === 'expired') {
      const trial = member && member.trial;
      body.innerHTML = `<div class="mg-title">${trial ? 'お試し期間が終了しました' : 'ご利用期限が切れました'}</div>
        <p class="mg-text">${formatDateJst(member.expiresAt)}までご利用いただきました。お手続きが確認できると、記録はそのまま続きからご利用いただけます(記録は期限から180日間お預かりします)。</p>
        <div id="gatePay"></div>`;
      renderPayPanel($('gatePay'), async () => { await reloadMember(); const s = deriveState(member); await showGate(s.kind, s); });
    } else if (kind === 'none') {
      const email = (auth.currentUser && auth.currentUser.email) || '';
      if (email.endsWith('@' + LOGIN_DOMAIN)) {
        body.innerHTML = `<div class="mg-title">登録を完了してください</div>
          <p class="mg-text">お申込みの登録が途中で止まっています。内容を入力して、${TRIAL_DAYS}日間無料のお試しを始めましょう。</p>
          <div id="gateResume"></div>`;
        renderResume($('gateResume'), email.split('@')[0]);
      } else {
        body.innerHTML = `<div class="mg-title">会員情報が見つかりません</div>
          <p class="mg-text">このアカウントは会員として登録されていません。お手数ですが運営までご連絡ください。</p>${contact}`;
      }
    }
  }

  async function reloadMember() {
    const snap = await fs.getDoc(fs.doc(db, 'members', auth.currentUser.uid));
    member = snap.exists() ? snap.data() : null;
  }

  /* ---------- 振込のご案内 ---------- */
  function openPay() {
    const draw = () => renderPayPanel($('payPanel'), async () => {
      await reloadMember();
      const s = deriveState(member);
      renderBanner(s);
      renderInfo(s);
      draw();
    });
    draw();
    ui.openModal('payModal');
  }

  async function renderPayPanel(el, onDone) {
    el.innerHTML = '<p class="mg-text">読み込み中…</p>';
    const info = await loadPayment();
    let plan = (member && (member.renewPlan || member.plan)) || 'half';
    const waiting = !!(member && member.renewRequestedAt);
    const payer = (member && (member.payerName || member.nameKana)) || '';
    const bank = bankInfoMissing(info)
      ? '<div class="mg-warn">【要入力】振込先を表示できません。運営までご連絡ください。</div>'
      : `<div class="mg-meta"><b>振込先</b><br>${esc(info.bankName)} ${esc(info.branch)}<br>${esc(info.accountType)} ${esc(info.accountNumber)}<br>口座名義:${esc(info.accountHolder)}</div>`;
    el.innerHTML = `
      <div class="mg-plans">
        ${Object.entries(PLANS).map(([k, p]) =>
          `<button type="button" class="mg-plan${k === plan ? ' active' : ''}" data-plan="${k}">${p.label}<b>${yen(p.price)}</b></button>`).join('')}
      </div>
      ${bank}
      <p class="mg-text">${payer ? `振込名義は <b style="color:var(--text)">${esc(payer)}</b> でお願いします。` : '振込名義は、お申込みのお名前でお願いします。'}振込手数料はご負担ください。入金を確認でき次第、運営が手続きします(確認までお時間をいただくことがあります)。</p>
      ${waiting
        ? `<div class="mg-ok">振込の連絡を受け付けました(${formatDateJst(member.renewRequestedAt)})。入金の確認をお待ちください。</div>`
        : '<button type="button" class="btn btn-primary" id="payDoneBtn">振込しました(確認を依頼)</button>'}
      <div class="mg-err" id="payErr"></div>`;
    el.querySelectorAll('.mg-plan').forEach((b) => b.addEventListener('click', () => {
      plan = b.dataset.plan;
      el.querySelectorAll('.mg-plan').forEach((x) => x.classList.toggle('active', x === b));
    }));
    const done = el.querySelector('#payDoneBtn');
    if (done) done.addEventListener('click', async () => {
      done.disabled = true;
      try {
        await fs.updateDoc(fs.doc(db, 'members', auth.currentUser.uid), { renewPlan: plan, renewRequestedAt: fs.serverTimestamp() });
        ui.showToast('振込の連絡を受け付けました');
        await onDone();
      } catch (err) {
        console.error(err);
        el.querySelector('#payErr').textContent = '送信できませんでした。通信状態をご確認ください。';
        done.disabled = false;
      }
    });
  }

  /* ---------- バナー・設定の会員情報 ---------- */
  function renderBanner(st) {
    const box = $('memberBanner');
    let text = '';
    if (st.awaitingPayment && st.kind !== 'special') text = '振込の確認中です。確認でき次第、期限を更新します。';
    else if (st.kind === 'trial') text = `お試し期間 あと${st.daysLeft}日(${formatDateJst(st.expiresAt)}まで)`;
    else if (st.kind === 'active' && st.daysLeft <= SOON_DAYS) text = `ご利用期限まで あと${st.daysLeft}日(${formatDateJst(st.expiresAt)})`;
    box.classList.toggle('active', !!text);
    $('memberBannerText').textContent = text;
    $('memberBannerBtn').style.display = st.awaitingPayment ? 'none' : '';
    $('memberBannerBtn').textContent = st.kind === 'trial' ? '本契約はこちら' : '更新はこちら';
  }

  function renderInfo(st) {
    const box = $('memberInfoBox');
    if (!box || !member) return;
    const label = { special: '特別会員', trial: 'お試し中', active: '会員' }[st.kind] || '';
    const planName = member.plan && PLANS[member.plan] ? PLANS[member.plan].label : '-';
    box.innerHTML = `<label>会員情報</label><div class="mg-meta">
      区分:<b>${label}</b>${member.memberNo ? `(会員番号 ${esc(member.memberNo)})` : ''}<br>
      ${st.kind === 'special' ? '' : `期限:<b>${formatDateJst(st.expiresAt)}</b>(あと${st.daysLeft}日)<br>`}
      ${member.loginId ? `ログインID:${esc(member.loginId)}<br>` : ''}
      ${st.kind === 'special' ? '' : `プラン:${planName}`}</div>
      ${st.kind === 'special' ? '' : '<button type="button" class="btn btn-ghost" id="memberInfoPayBtn">本契約・更新のお手続き</button>'}`;
    const b = $('memberInfoPayBtn');
    if (b) b.addEventListener('click', () => { ui.closeModal('settingsModal'); openPay(); });
  }

  /* ---------- 申込 ---------- */
  function readCommon(prefix, errEl) {
    const nameKana = normalizeKana($(prefix + 'Name').value);
    const payerRaw = normalizeKana($(prefix + 'Payer').value);
    if (!isKanaName(nameKana) || nameKana.length > 40) { errEl.textContent = 'お名前は全角カタカナで入力してください(例:ヤマダ タロウ)'; return null; }
    if (payerRaw && (!isKanaName(payerRaw) || payerRaw.length > 40)) { errEl.textContent = '振込名義は全角カタカナで入力してください'; return null; }
    const mail = ($(prefix + 'Mail').value || '').trim();
    if (mail && (mail.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail))) { errEl.textContent = 'メールアドレスの形式が正しくありません'; return null; }
    return { nameKana, payerName: payerRaw === nameKana ? '' : payerRaw, contactEmail: mail, plan: $(prefix + 'Plan').value };
  }

  function memberDoc(loginId, c) {
    return {
      loginId, nameKana: c.nameKana, payerName: c.payerName, plan: c.plan, contactEmail: c.contactEmail,
      status: 'active', special: false, trial: true, memberNo: null,
      expiresAt: fs.Timestamp.fromDate(trialExpiry()),
      createdAt: fs.serverTimestamp(), approvedAt: null, renewPlan: null, renewRequestedAt: null,
    };
  }

  async function signup() {
    const err = $('suErr');
    err.textContent = '';
    const id = $('suId').value.trim().toLowerCase();
    const pw = $('suPw').value;
    if (!isValidLoginId(id)) { err.textContent = 'ログインIDは半角英数字と _ - の4〜20字で入力してください'; return; }
    if (pw.length < 8) { err.textContent = 'パスワードは8文字以上にしてください'; return; }
    const c = readCommon('su', err);
    if (!c) return;
    if (!$('suAgree').checked) { err.textContent = '利用規約とプライバシーポリシーへの同意が必要です'; return; }
    pendingSignup = (async () => {
      const cred = await authApi.createUserWithEmailAndPassword(auth, toAuthEmail(id), pw);
      await fs.setDoc(fs.doc(db, 'members', cred.user.uid), memberDoc(id, c));
    })();
    try {
      await pendingSignup;
      ui.closeModal('signupModal');
      $('signupForm').reset();
    } catch (e) {
      console.error(e);
      if (e.code === 'auth/email-already-in-use') err.textContent = 'このIDはすでに使われています。別のIDにしてください';
      else if (e.code === 'auth/weak-password') err.textContent = 'パスワードが簡単すぎます。別のパスワードにしてください';
      else if (e.code === 'auth/network-request-failed') err.textContent = '通信に失敗しました。通信状態をご確認ください';
      else err.textContent = '申込を完了できませんでした。もう一度お試しください';
    } finally {
      pendingSignup = null;
    }
    // 成功時はonAuthStateChangedの確認が走る。台帳の保存だけ失敗した場合は「登録の続き」画面になる
  }

  // 登録が途中で止まっている人向け(Authはあるが台帳が無い)
  function renderResume(el, loginId) {
    el.innerHTML = `<form id="resumeForm">
      <div class="field"><label>お名前(カタカナ)</label><input type="text" id="rsName" placeholder="ヤマダ タロウ" required></div>
      <div class="field"><label>希望プラン</label><select id="rsPlan">
        <option value="half">${PLANS.half.label}(${yen(PLANS.half.price)})</option>
        <option value="year">${PLANS.year.label}(${yen(PLANS.year.price)})</option></select></div>
      <div class="field"><label>振込名義 <span class="field-hint">お名前と違う場合のみ</span></label><input type="text" id="rsPayer"></div>
      <div class="field"><label>連絡用メールアドレス <span class="field-hint">任意</span></label><input type="email" id="rsMail"></div>
      <div class="mg-err" id="rsErr"></div>
      <button type="submit" class="btn btn-primary">登録を完了する</button></form>`;
    el.querySelector('#resumeForm').addEventListener('submit', (e) => {
      e.preventDefault();
      ui.guardedSubmit(e.currentTarget, async () => {
        const errEl = el.querySelector('#rsErr');
        errEl.textContent = '';
        const c = readCommon('rs', errEl);
        if (!c) return;
        try {
          await fs.setDoc(fs.doc(db, 'members', auth.currentUser.uid), memberDoc(loginId, c));
          location.reload();
        } catch (er) {
          console.error(er);
          errEl.textContent = '登録できませんでした。もう一度お試しください';
        }
      });
    });
  }

  function authorLabel() {
    if (member && member.memberNo) return member.memberNo;
    return member && member.trial ? 'お試し会員' : '会員';
  }

  return { check, authorLabel };
}
