// Stripe Webhook の「契約種別・月額の支払い回数・改定前契約者の据え置き」を、偽のStripe/Firestoreで確かめる
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const store = {};
const INC = Symbol('increment');
const DEL = Symbol('delete');
function applyMerge(prev, data) {
  const next = { ...(prev || {}) };
  for (const [k, v] of Object.entries(data)) {
    if (v && v[INC]) next[k] = (Number(next[k]) || 0) + v[INC];
    else if (v === DEL) delete next[k];
    else next[k] = v;
  }
  return next;
}
function docRef(p) {
  return {
    path: p,
    async get() { return { exists: p in store, data: () => store[p] }; },
    async set(data, opts) { store[p] = opts?.merge ? applyMerge(store[p], data) : applyMerge({}, data); },
    async create(data) {
      if (p in store) { const e = new Error('already exists'); e.code = 6; throw e; }
      store[p] = applyMerge({}, data);
    },
    collection: (name) => ({ doc: (id) => docRef(`${p}/${name}/${id}`) }),
  };
}
const db = { doc: docRef, collection: (name) => ({ doc: (id) => docRef(`${name}/${id}`) }) };

const subscriptions = {};
const fakeStripe = {
  webhooks: { constructEvent: (body) => body },
  subscriptions: { retrieve: async (id) => subscriptions[id] },
  customers: { retrieve: async () => ({ metadata: {} }) },
  checkout: { sessions: { retrieve: async () => ({}) } },
};
const mocks = {
  'firebase-functions/v2/https': {
    onCall: (_, fn) => fn,
    onRequest: (_, fn) => fn,
    HttpsError: class extends Error {},
  },
  'firebase-functions/params': { defineSecret: () => ({ value: () => 'secret' }) },
  'firebase-admin/app': { initializeApp: () => {} },
  'firebase-admin/firestore': {
    getFirestore: () => db,
    FieldValue: { serverTimestamp: () => 'ts', increment: (n) => ({ [INC]: n }), delete: () => DEL },
    Timestamp: { fromMillis: (ms) => ms },
  },
  stripe: () => fakeStripe,
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request in mocks) return mocks[request];
  return originalLoad.call(this, request, ...rest);
};
// stripe は関数の中で require されるので、差し替えは最後まで残す
const fns = require(path.resolve(__dirname, '..', 'functions', 'index.js'));

const MONTHLY = 'price_1TeFGWRXW1evPVMUHPTm6XpL';
const YEARLY = 'price_1TeFJLRXW1evPVMUM7vJgskA';
let eventSeq = 0;
async function payInvoice({ uid, subId, priceId, invoiceId, amount = 550 }) {
  subscriptions[subId] = {
    id: subId, customer: 'cus_1', metadata: { app: 'rakuthrough', firebaseUid: uid },
    items: { data: [{ price: { id: priceId }, current_period_end: 1800000000 }] },
  };
  const req = {
    rawBody: { id: `evt_${++eventSeq}`, type: 'invoice.payment_succeeded',
      data: { object: { id: invoiceId, subscription: subId, amount_paid: amount } } },
    headers: {},
  };
  let status;
  await fns.stripeWebhook(req, { status: (s) => ({ send: () => { status = s; } }) });
  assert.equal(status, 200);
}
const billing = (uid) => store[`users/${uid}/billing/rakuthrough`];

(async () => {
  // 新規の月額：支払いごとに数え、同じ請求書の再送は数えない
  for (let i = 1; i <= 7; i += 1) await payInvoice({ uid: 'u1', subId: 'sub1', priceId: MONTHLY, invoiceId: `in_u1_${i}` });
  await payInvoice({ uid: 'u1', subId: 'sub1', priceId: MONTHLY, invoiceId: 'in_u1_7' });
  assert.equal(billing('u1').paidMonths, 7, 'monthly payments must be counted once per invoice');
  assert.equal(billing('u1').billingInterval, 'monthly');
  assert.equal(billing('u1').taxAccessGrandfathered, undefined, 'new subscribers are not grandfathered');

  // 0円の請求書は数えない
  await payInvoice({ uid: 'u2', subId: 'sub2', priceId: MONTHLY, invoiceId: 'in_u2_0', amount: 0 });
  assert.equal(billing('u2').paidMonths, undefined, 'zero-amount invoices must not count');

  // 改定前からの月額契約者（契約種別が未保存のpro）は据え置き
  store['users/u3/billing/rakuthrough'] = { plan: 'pro', subscriptionStatus: 'active' };
  await payInvoice({ uid: 'u3', subId: 'sub3', priceId: MONTHLY, invoiceId: 'in_u3_1' });
  assert.equal(billing('u3').taxAccessGrandfathered, true, 'pre-change subscribers must keep access');
  assert.equal(billing('u3').paidMonths, 1);

  // 年額は回数を数えず、契約種別だけ保存
  await payInvoice({ uid: 'u4', subId: 'sub4', priceId: YEARLY, invoiceId: 'in_u4_1', amount: 3980 });
  assert.equal(billing('u4').billingInterval, 'yearly');
  assert.equal(billing('u4').paidMonths, undefined);

  // 収支出力のみ（販売終了）は新しいCheckoutを作れない
  await assert.rejects(
    fns.createCheckoutSession({ auth: { uid: 'u5' }, data: { priceId: 'price_1TeFKpRXW1evPVMU5QSgaMur' } }),
    'discontinued export-only price must be rejected',
  );

  // テスト専用の口は本番の価格を受け付けず、本番の課金情報にも書かない
  const before = JSON.stringify(store);
  subscriptions.subT = { id: 'subT', customer: 'cus_1', metadata: { app: 'rakuthrough', firebaseUid: 'u9' },
    items: { data: [{ price: { id: MONTHLY }, current_period_end: 1800000000 }] } };
  await fns.stripeWebhookTest({ rawBody: { id: 'evt_test_1', type: 'invoice.payment_succeeded',
    data: { object: { id: 'in_t1', subscription: 'subT', amount_paid: 550 } } }, headers: {} },
  { status: () => ({ send: () => {} }) });
  assert.equal(store['users/u9/billing/rakuthrough'], undefined, 'test endpoint must not write production billing');
  assert.equal(store['users/u9/billing/rakuthrough_test'], undefined, 'test endpoint ignores live prices');
  assert.ok(JSON.stringify(store).length >= before.length);

  console.log('PASS: RakuThrough webhook paid-months checks');
})().catch((e) => { console.error(e); process.exit(1); });
