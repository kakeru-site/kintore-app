// 会員制まわりの定数と、画面に依存しない計算(Firebaseには触らない)

export const LOGIN_DOMAIN = 'login.muscle-log.invalid';
export const TRIAL_DAYS = 7;
export const SOON_DAYS = 30;

// 新規申込の受付。募集ページの公開(フェーズ3)まではfalseのままにする
export const SIGNUP_OPEN = false;

export const PLANS = {
  half: { label: '半年プラン', months: 6, price: 8000 },
  year: { label: '年間プラン', months: 12, price: 12000 },
};

// 【要入力】公開前に必ず埋める。ここが空のままだと画面に警告が出る
export const BANK_INFO = {
  bankName: '',
  branch: '',
  accountType: '',
  accountNumber: '',
  accountHolder: '',
};
export const CONTACT_INFO = '';

const JST_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function toAuthEmail(input) {
  const v = String(input || '').trim();
  if (v.includes('@')) return v;
  return `${v.toLowerCase()}@${LOGIN_DOMAIN}`;
}

export function isValidLoginId(id) {
  return /^[a-z0-9_-]{4,20}$/.test(id);
}

// ひらがな→カタカナ、半角カナ→全角、空白を半角1つに
export function normalizeKana(str) {
  let s = String(str || '').normalize('NFKC');
  s = s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  s = s.replace(/[\s　]+/g, ' ').trim();
  return s;
}

export function isKanaName(s) {
  return /^[ァ-ヶー]+( [ァ-ヶー]+)*$/.test(s);
}

function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === 'function') return v.toMillis();
  return null;
}

// 日本時間での年月日
function jstYmd(ms) {
  const d = new Date(ms + JST_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
}

// 日本時間のその日の23:59:59.999
function endOfDayJst(y, m, d) {
  return new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - JST_MS);
}

// baseのn か月後(日本時間)。存在しない日付は月末に丸める
export function addMonthsJst(base, n) {
  const { y, m, d } = jstYmd(toMs(base));
  const total = m + n;
  const ty = y + Math.floor(total / 12);
  const tm = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return endOfDayJst(ty, tm, Math.min(d, last));
}

// お試しの期限:申込日の7日後の23:59:59(日本時間)
export function trialExpiry(now = Date.now()) {
  const { y, m, d } = jstYmd(toMs(now));
  return endOfDayJst(y, m, d + TRIAL_DAYS);
}

// 更新後の期限 = max(現在の期限, 入金確認日) に、プランの月数を足す
export function computeNewExpiry(currentExpiry, confirmDate, plan) {
  const months = PLANS[plan] && PLANS[plan].months;
  if (!months) throw new Error('unknown plan: ' + plan);
  const cur = toMs(currentExpiry);
  const conf = toMs(confirmDate);
  const base = cur != null && cur > conf ? cur : conf;
  return addMonthsJst(base, months);
}

// 会員ドキュメント(無ければnull)と現在時刻から、画面に出す状態を決める
// kind: none / suspended / expired / trial / active / special
export function deriveState(member, now = Date.now()) {
  if (!member) return { kind: 'none', allowed: false };
  const exp = toMs(member.expiresAt);
  const awaitingPayment = !!member.renewRequestedAt;
  const base = { awaitingPayment, expiresAt: exp, daysLeft: null };
  if (member.status === 'suspended') return { ...base, kind: 'suspended', allowed: false };
  if (member.status !== 'active') return { ...base, kind: 'suspended', allowed: false };
  if (member.special === true) return { ...base, kind: 'special', allowed: true };
  if (exp == null || now >= exp) return { ...base, kind: 'expired', allowed: false };
  const daysLeft = Math.ceil((exp - now) / DAY_MS);
  return { ...base, kind: member.trial ? 'trial' : 'active', allowed: true, daysLeft };
}

export function formatDateJst(v) {
  const ms = toMs(v);
  if (ms == null) return '';
  const { y, m, d } = jstYmd(ms);
  return `${y}年${m + 1}月${d}日`;
}

export function bankInfoMissing() {
  return Object.values(BANK_INFO).some((v) => !v);
}
