const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const htmlPath = path.resolve(__dirname, '..', 'app', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// HTML内のモジュール全体を、importを除いた状態で構文解析する。
const moduleMatch = html.match(/<script type="module">([\s\S]*?)<\/script>/);
assert.ok(moduleMatch, 'module script should exist');
const withoutImports = moduleMatch[1].replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];\s*/g, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
assert.doesNotThrow(() => new AsyncFunction(withoutImports), 'module JavaScript should parse');

// 実装した会計関数をHTMLからそのまま評価する。UIやFirebaseは実行しない。
function extractFunction(name) {
  const asyncStart = html.indexOf(`async function ${name}(`);
  const syncStart = html.indexOf(`function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : syncStart;
  assert.ok(start >= 0, `${name} should exist`);
  const braceStart = html.indexOf('{', start);
  let depth = 0;
  for (let index = braceStart; index < html.length; index += 1) {
    if (html[index] === '{') depth += 1;
    if (html[index] === '}') depth -= 1;
    if (depth === 0) return html.slice(start, index + 1);
  }
  throw new Error(`${name} closing brace was not found`);
}

const statusConst = html.match(/const ACCOUNTING_STATUSES = new Set\([^\n]+/);
assert.ok(statusConst, 'accounting statuses should exist');
const functionNames = [
  'escapeHtml',
  'inlineJsArg',
  'safeHexColor',
  'txFiscalYear',
  'isValidIsoDate',
  'txStatus',
  'csvStatusLabel',
  'hasReceivableHistory',
  'csvSettlementDate',
  'csvCell',
  'resolveUserPlan',
  'isRecognizedIncome',
  'isPaidIncome',
  'isRecognizedExpense',
  'getMonthlyRegistrationSummary',
  'getReceivablesAtYearEnd',
  'getAccountingReview',
  'calcPL',
  'renderAccountingReview',
  'updateCloseYearAvailability',
  'txCard',
  'txWithholdingTax',
  'calcWithholdingTotal',
  'receiptLines',
  'journalRows',
  'straightLineRate',
  'smallAssetLimit',
  'isSmallAssetSpecial',
  'depreciationForYear',
  'resolveTaxAccess',
];
const accountingSource = `function fmt(n) { return '¥' + Math.round(n).toLocaleString(); }\nconst TAX_ACCESS_MONTHLY_PAYMENTS = 7;\n`
  + [statusConst[0], ...functionNames.map(extractFunction)].join('\n') + `
this.__accounting = {
  escapeHtml,
  inlineJsArg,
  safeHexColor,
  txFiscalYear,
  txStatus,
  csvStatusLabel,
  hasReceivableHistory,
  csvSettlementDate,
  csvCell,
  resolveUserPlan,
  isRecognizedIncome,
  isPaidIncome,
  isRecognizedExpense,
  getMonthlyRegistrationSummary,
  getReceivablesAtYearEnd,
  getAccountingReview,
  calcPL,
  renderAccountingReview,
  updateCloseYearAvailability,
  txCard,
  txWithholdingTax,
  calcWithholdingTotal,
  receiptLines,
  journalRows,
  straightLineRate,
  smallAssetLimit,
  isSmallAssetSpecial,
  depreciationForYear,
  resolveTaxAccess,
};`;

const elements = {
  'accounting-review': { style: {}, textContent: '' },
  'close-year-status': { textContent: '' },
  'close-year-btn': { textContent: '', disabled: false, style: {} },
};
const context = {
  allTransactions: [],
  inventoryDataMap: {},
  prorationSettings: {},
  capitalData: {},
  categories: [],
  currentMonth: new Date('2026-09-01T00:00:00Z'),
  window: {},
  document: { getElementById: id => elements[id] || null },
  location: { href: 'http://127.0.0.1/' },
  setInterval: () => 0,
  setTimeout: () => 0,
  clearTimeout: () => {},
  confirm: () => false,
  console,
  Date,
  Math,
  Number,
  Set,
  Map,
  URL,
  URLSearchParams,
};
vm.createContext(context);
vm.runInContext(accountingSource, context);
const api = context.__accounting;

function setFixture(transactions, { inventory = {}, proration = {} } = {}) {
  context.allTransactions = transactions;
  context.inventoryDataMap = inventory;
  context.prorationSettings = proration;
}

setFixture([]);
assert.equal(api.calcPL(2026).accountingProfit, 0, 'zero transactions must produce zero profit');

assert.equal(api.escapeHtml(`<script>"'&</script>`), '&lt;script&gt;&quot;&#39;&amp;&lt;/script&gt;', 'HTML special characters must be escaped');
assert.equal(api.inlineJsArg(`x');alert(1)//`), '&quot;x&#39;);alert(1)//&quot;', 'inline handler arguments must stay inside a quoted JavaScript string');
assert.equal(api.safeHexColor('#12aBcF'), '#12aBcF', 'valid six-digit colors must be preserved');
assert.equal(api.safeHexColor('red;position:fixed'), '#6b7280', 'unsafe style values must fall back to a fixed color');
context.categories = [{ id: 'hostile', emoji: '<img src=x onerror=alert(1)>', color: 'red;position:fixed' }];
const hostileCard = api.txCard({
  id: `tx');alert(1)//`, type: 'income', status: 'settled', categoryId: 'hostile',
  desc: '<script>alert(1)</script>', date: '2026-09-11"><img src=x>', categoryName: '売上&A', amount: 1000,
});
assert.doesNotMatch(hostileCard, /<script>|<img src=x/, 'transaction cards must not render stored HTML');
assert.match(hostileCard, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'transaction descriptions must remain visible as text');
assert.match(hostileCard, /background:#3730a3/, 'invalid category colors must use the safe fallback');
assert.match(hostileCard, /openEditModal\(&quot;tx&#39;\);alert\(1\)\/\/&quot;\)/, 'transaction ids must not break inline handlers');
context.categories = [];

assert.equal(api.csvStatusLabel({ status: 'pending' }), '売掛');
assert.equal(api.csvStatusLabel({ status: 'settled' }), '入金済');
assert.equal(api.csvStatusLabel({ status: 'canceled' }), '取消');
assert.equal(api.csvStatusLabel({ status: 'refunded' }), '返金');
assert.equal(api.csvStatusLabel({ status: 'mystery' }), '要確認');
assert.equal(api.csvStatusLabel({}), '要確認');
assert.equal(api.csvSettlementDate({ type: 'income', status: 'settled', date: '2026-01-10' }), '', 'ordinary paid sales must not get a settlement date');
assert.equal(api.csvSettlementDate({ type: 'income', status: 'settled', date: '2026-01-10', settledAt: '2026-01-15' }), '2026-01-15', 'settled receivables must export the settlement date');
assert.equal(api.csvSettlementDate({ type: 'income', status: 'settled', date: '2026-01-10', settledAt: 'invalid' }), '未登録', 'invalid receivable settlement dates must stay explicit');
assert.equal(api.csvSettlementDate({ type: 'income', status: 'pending', date: '2026-01-10', settledAt: '2026-01-15' }), '', 'unpaid receivables must not export a settlement date');
assert.equal(api.csvCell('東京,大阪'), '"東京,大阪"', 'commas must remain inside one quoted cell');
assert.equal(api.csvCell('彼は"はい"と言った'), '"彼は""はい""と言った"', 'double quotes must be escaped');
assert.equal(api.csvCell('1行目\n2行目'), '"1行目\n2行目"', 'line breaks must remain inside one quoted cell');
assert.equal(api.csvCell('=SUM(A1:A2)'), '"\'=SUM(A1:A2)"', 'formula-like text must be neutralized');
assert.equal(api.csvCell('  @cmd'), '"\'  @cmd"', 'formula-like text after whitespace must be neutralized');
assert.equal(api.csvCell(null), '""', 'null values must export as blank cells');
assert.equal(api.csvCell(12000), '12000', 'numeric amounts must remain numeric CSV values');
const planNow = new Date('2026-09-13T00:00:00Z');
assert.equal(api.resolveUserPlan({ plan: 'pro' }, { plan: 'free' }, planNow), 'pro', 'app billing must override legacy billing');
assert.equal(api.resolveUserPlan({ plan: 'free' }, { plan: 'pro' }, planNow), 'free', 'app billing free state must override legacy paid state');
assert.equal(api.resolveUserPlan(null, { plan: 'export' }, planNow), 'export', 'legacy billing must remain available as a fallback');
assert.equal(api.resolveUserPlan({ plan: 'pro', planExpiry: '2026-09-12T23:59:59Z' }, null, planNow), 'free', 'expired pro access must resolve to free');
assert.equal(api.resolveUserPlan({ plan: 'export', planExpiry: '2026-09-12T23:59:59Z' }, null, planNow), 'free', 'expired export access must resolve to free');
assert.equal(api.resolveUserPlan({ plan: 'lifetime', planExpiry: '2020-01-01T00:00:00Z' }, null, planNow), 'lifetime', 'lifetime access must not expire');
assert.equal(api.resolveUserPlan(null, null, planNow), 'free', 'missing billing data must resolve to free');
const loadUserPlanSource = extractFunction('loadUserPlan');
assert.match(loadUserPlanSource, /'billing', 'rakuthrough'/, 'plan loading must read the RakuThrough billing document');
assert.doesNotMatch(loadUserPlanSource, /\bsetDoc\s*\(/, 'login-time plan loading must not write billing data');
const saveCapitalSource = html.match(/window\.saveCapital\s*=\s*async[\s\S]*?(?=window\.saveProration)/)?.[0] || '';
assert.match(saveCapitalSource, /await softLockCheck\(year\)/, 'capital edits must respect the existing closed-year check');
assert.match(saveCapitalSource, /\}, \{ merge: true \}\);/, 'capital saves must merge with existing year data');
assert.match(saveCapitalSource, /capitalData\[year\]\s*=\s*\{\s*\.\.\.capitalData\[year\]/, 'local capital state must preserve existing year fields');
assert.match(html, /const st\s*=\s*csvStatusLabel\(t\)/, 'CSV export must use the reviewed status label mapping');
assert.match(html, /const sd\s*=\s*csvSettlementDate\(t\)/, 'CSV export must use the receivable-only settlement date mapping');
assert.match(html, /\['日付', '種別', '摘要',[\s\S]*?'入金日'/, 'CSV must include a settlement-date column');
assert.match(html, /\]\.map\(csvCell\)\.join\(','\)/, 'CSV rows must escape every cell through the shared helper');
assert.doesNotMatch(html, /wasReceivable\s*:/, 'transaction writes must stay within the existing Firestore schema');
assert.match(html, /売掛の入金日を補う/, 'edit UI must allow explicit correction of older receivable settlements');
assert.match(html, /type === 'income' \? '日付（売った日）' : '日付（使った日）'/, 'edit form must distinguish the sale date from an expense date');
assert.match(html, /escapeHtml\(cat\.name\)/, 'category names must be escaped in rendered HTML');
assert.match(html, /escapeHtml\(a\.name\)/, 'asset names must be escaped in rendered HTML');
assert.match(html, /review\.reasons\.map\(escapeHtml\)/, 'print review text must be escaped');
assert.doesNotMatch(html, /await\s+migrateTransactions\(\)/, 'login must not automatically rewrite legacy transaction data');

setFixture([
  { id: 'paid', type: 'income', amount: 100000, status: 'settled', date: '2026-01-10', fiscalYear: 2026 },
  { id: 'ar', type: 'income', amount: 50000, status: 'pending', date: '2026-02-10', fiscalYear: 2026 },
  { id: 'cancel', type: 'income', amount: 30000, status: 'canceled', date: '2026-03-10', fiscalYear: 2026 },
]);
assert.equal(api.calcPL(2026).revenue, 150000, 'P/L revenue must include paid and receivable sales');
assert.equal(context.allTransactions.filter(api.isPaidIncome).reduce((s, tx) => s + tx.amount, 0), 100000, 'cash view must include paid income only');

setFixture([
  { id: 'cross-month', type: 'income', amount: 100000, status: 'settled', date: '2026-12-20', settledAt: '2027-01-10', fiscalYear: 2026 },
]);
assert.equal(api.getMonthlyRegistrationSummary(2026, 11).paidIncome, 100000, 'monthly card must use the sale registration month');
assert.equal(api.getMonthlyRegistrationSummary(2027, 0).paidIncome, 0, 'monthly card must not claim to be an actual settlement-month view');

setFixture([
  { id: 'sale', type: 'income', amount: 100000, status: 'settled', date: '2026-12-20', settledAt: '2027-01-10', fiscalYear: 2026 },
]);
assert.equal(api.getReceivablesAtYearEnd(2026, '2027-02-01').amount, 100000, 'next-year settlement must remain in prior year-end receivables');
assert.equal(api.getReceivablesAtYearEnd(2027, '2028-02-01').amount, 0, 'settled receivable must not remain after settlement year');
assert.equal(api.calcPL(2027).revenue, 0, 'settlement must not create a second sale');

setFixture([
  { id: 'refund-income', type: 'income', amount: 40000, status: 'refunded', date: '2026-04-01', fiscalYear: 2026 },
  { id: 'refund-expense', type: 'expense', amount: 5000, status: 'refunded', date: '2026-04-02', fiscalYear: 2026 },
  { id: 'unknown', type: 'income', amount: 7000, status: 'mystery', date: '2026-04-03', fiscalYear: 2026 },
]);
const refundPL = api.calcPL(2026);
const refundReview = api.getAccountingReview(2026, '2026-09-07');
assert.equal(refundPL.revenue, 0, 'refunded and unknown income must not be treated as settled revenue');
assert.equal(refundPL.totalExpense, 0, 'refunded expense must not be treated as settled expense');
assert.equal(refundReview.count, 3, 'refund and unknown states must remain visible for review');
assert.equal(refundReview.incomeAmount, 47000);
assert.equal(refundReview.expenseAmount, 5000);
api.renderAccountingReview(2026);
assert.equal(elements['accounting-review'].style.display, 'block', 'review notice must be visible on screen');
assert.match(elements['accounting-review'].textContent, /要確認 3件/);
api.updateCloseYearAvailability(2026);
assert.equal(elements['close-year-btn'].disabled, true, 'year close must be disabled while review items remain');
assert.match(elements['close-year-status'].textContent, /自動締め・翌年繰越は現在停止中/);

setFixture([
  { id: 'past-refund', type: 'income', amount: 100000, status: 'refunded', date: '2025-12-20', fiscalYear: 2025 },
  { id: 'past-unknown', type: 'income', amount: 20000, status: 'mystery', date: '2025-11-10', fiscalYear: 2025 },
]);
const carriedReview = api.getAccountingReview(2026, '2027-02-01');
assert.equal(carriedReview.count, 2, 'unresolved prior-year refund and unknown status must reach the later-year review');

setFixture([
  { id: 'bad-date-order', type: 'income', amount: 30000, status: 'settled', date: '2026-06-10', settledAt: '2026-06-01', fiscalYear: 2026 },
]);
assert.ok(api.getAccountingReview(2026, '2027-02-01').reasons.some(reason => reason.includes('売上日より前')), 'settlement before sale date must be marked for review');

setFixture([
  { id: 'old', type: 'income', amount: 20000, status: 'settled', date: '2025-06-01', fiscalYear: 2025 },
]);
assert.equal(api.getAccountingReview(2025, '2026-09-07').count, 0, 'ordinary paid sales without settledAt must not be mistaken for receivables');

setFixture([
  { id: 'expense', type: 'expense', amount: 10000, status: 'settled', date: '2026-05-01', fiscalYear: 2026, categoryId: 'comm', categoryName: '通信費' },
], { proration: { comm: 50 } });
assert.equal(api.calcPL(2026).totalExpense, 5000, 'proration must use the business-use percentage');

setFixture([
  { id: 'purchase', type: 'expense', amount: 30000, status: 'settled', date: '2026-05-02', fiscalYear: 2026, categoryId: 'custom', categoryName: '仕入高' },
], { inventory: { 2026: { openingStock: 10000, purchases: 30000, closingStock: 5000 } } });
assert.equal(api.calcPL(2026).cogs, 35000, 'inventory COGS formula must remain intact');
assert.ok(api.getAccountingReview(2026, '2026-09-07').reasons.some(reason => reason.includes('二重計上')), 'inventory and purchase expense overlap must be flagged');

setFixture([
  { id: 'withholding', type: 'income', amount: 100000, receivedAmount: 89790, withholdingTax: 10210, isWithholding: true, status: 'settled', date: '2026-06-01', fiscalYear: 2026 },
]);
assert.equal(api.calcPL(2026).revenue, 100000, 'withholding must not replace gross sales with take-home amount');

const closeFunction = html.match(/window\.closeFiscalYear = \(\) => \{[\s\S]*?\n\};/);
assert.ok(closeFunction, 'disabled close function should exist');
assert.match(closeFunction[0], /自動締め・翌年繰越は現在停止中/);
assert.doesNotMatch(closeFunction[0], /setDoc|getDoc|updateDoc|addDoc|deleteDoc/, 'disabled close function must not call Firestore');
assert.match(html, /id="close-year-btn"[^>]*disabled/, 'year close button must be disabled in initial HTML');
assert.doesNotMatch(html, /const blueDeduction = 650000/, 'automatic 650,000 yen deduction must be removed');

// ===== 2026-11-08 申告前修正（A/B案）=====
const plain = value => JSON.parse(JSON.stringify(value));

// 源泉徴収税額の年間合計：取消・返金・他年度は含めない
setFixture([
  { id: 'w1', type: 'income', amount: 100000, withholdingTax: 10210, isWithholding: true, status: 'settled', date: '2026-06-01', fiscalYear: 2026 },
  { id: 'w2', type: 'income', amount: 50000, withholdingTax: 5105, isWithholding: true, status: 'pending', date: '2026-07-01', fiscalYear: 2026 },
  { id: 'w3', type: 'income', amount: 50000, withholdingTax: 5105, isWithholding: true, status: 'canceled', date: '2026-07-02', fiscalYear: 2026 },
  { id: 'w4', type: 'income', amount: 50000, withholdingTax: 5105, isWithholding: true, status: 'settled', date: '2025-07-02', fiscalYear: 2025 },
]);
assert.equal(api.calcWithholdingTotal(2026), 15315, 'withholding total must include settled and receivable income of the year only');

// 売掛→入金：売上行（売掛金/売上高）と入金行（事業主貸/売掛金）を分ける。旧データで借方が上書きされていても復元する
assert.deepEqual(plain(api.journalRows({ type: 'income', amount: 30000, status: 'settled', date: '2026-12-20', settledAt: '2027-01-10', walletType: 'personal', debit: { account: '事業主貸' }, credit: { account: '売上高' } }).map(r => [r.date, r.kind, r.debit, r.credit, r.amount])),
  [['2026-12-20', '売上', '売掛金', '売上高', 30000], ['2027-01-10', '入金', '事業主貸', '売掛金', 30000]],
  'settled receivable must produce separate sale and settlement journal rows');
assert.equal(api.journalRows({ type: 'income', amount: 30000, status: 'settled', date: '2026-12-20', settledAt: '2027-01-10', walletType: 'business' })[1].debit, '普通預金', 'business wallet settlement must debit the bank account');

// 事業口座＋源泉：受取額（普通預金）と源泉税（事業主貸）に分ける
assert.deepEqual(plain(api.journalRows({ type: 'income', amount: 100000, withholdingTax: 10210, isWithholding: true, status: 'settled', date: '2026-06-01', walletType: 'business' }).map(r => [r.debit, r.credit, r.amount])),
  [['普通預金', '売上高', 89790], ['事業主貸', '売上高', 10210]], 'withholding on business account must split received amount and tax');

// 通常の経費は保存済みの仕訳をそのまま出す
assert.deepEqual(plain(api.journalRows({ type: 'expense', amount: 5000, status: 'settled', date: '2026-03-01', debit: { account: '通信費' }, credit: { account: '事業主借' } }).map(r => [r.debit, r.credit, r.amount])),
  [['通信費', '事業主借', 5000]], 'expense rows must keep the stored journal entry');

// 減価償却：償却率・取得年の月割り・耐用年数経過後の停止・事業割合・少額特例
assert.equal(api.straightLineRate(4), 0.25);
assert.equal(api.straightLineRate(6), 0.167);
const pc = { price: 240000, date: '2026-10-15', years: 4, rate: 100, isSpecial: false };
assert.equal(api.depreciationForYear(pc, 2025), 0, 'no depreciation before acquisition');
assert.equal(api.depreciationForYear(pc, 2026), 15000, 'acquisition year must be prorated by months used (3/12)');
assert.equal(api.depreciationForYear(pc, 2027), 60000, 'full year after acquisition');
assert.equal(api.depreciationForYear(pc, 2030), 44999, 'final year must leave 1 yen memorandum value');
assert.equal(api.depreciationForYear(pc, 2031), 0, 'depreciation must stop after useful life');
let total = 0;
for (let y = 2026; y <= 2032; y += 1) total += api.depreciationForYear(pc, y);
assert.equal(total, 239999, 'total depreciation must equal price minus 1 yen');
assert.equal(api.depreciationForYear({ ...pc, rate: 70 }, 2027), 42000, 'business-use rate must apply to the yearly amount');
const special = { price: 150000, date: '2026-05-01', years: 4, rate: 80, isSpecial: true };
assert.equal(api.depreciationForYear(special, 2026), 120000, 'small asset special rule expenses all in the acquisition year');
assert.equal(api.depreciationForYear(special, 2027), 0, 'small asset special rule must not repeat in later years');

// 少額特例の上限：2026/4/1以後の取得は40万円未満、それより前は30万円未満
assert.equal(api.smallAssetLimit('2026-03-31'), 300000);
assert.equal(api.smallAssetLimit('2026-04-01'), 400000);
assert.equal(api.isSmallAssetSpecial(399999, '2026-04-01'), true);
assert.equal(api.isSmallAssetSpecial(400000, '2026-04-01'), false, 'exactly 400,000 yen is not eligible');
assert.equal(api.isSmallAssetSpecial(350000, '2026-03-15'), false, 'before April 2026 the limit is under 300,000 yen');
const beforeApril = { price: 350000, date: '2026-03-15', years: 4, rate: 100, isSpecial: true };
assert.equal(api.depreciationForYear(beforeApril, 2026), 72917, 'ineligible special flag must fall back to straight-line (87,500 x 10/12, rounded up)');
assert.equal(api.depreciationForYear({ ...beforeApril, date: '2026-04-01' }, 2026), 350000, 'eligible from April 2026');

// 印刷の家事按分欄：{カテゴリID: 割合} を参照する（name/ratio を読まない）
const printFunction = html.match(/window\.printSummary = \(\) => \{[\s\S]*?\n\};/);
assert.ok(printFunction, 'print function should exist');
assert.doesNotMatch(printFunction[0], /p\.ratio|Object\.values\(prorationSettings\)/, 'print proration must not read nonexistent name/ratio fields');
assert.match(printFunction[0], /Object\.entries\(prorationSettings\)/, 'print proration must read {categoryId: rate}');
assert.match(printFunction[0], /calcWithholdingTotal\(year\)/, 'print must show annual withholding total');

// 入金処理で売上時の借方を上書きしない
const settleFunction = html.match(/window\.confirmSettle = async \(\) => \{[\s\S]*?\n\};/);
assert.ok(settleFunction, 'settle function should exist');
assert.doesNotMatch(settleFunction[0], /debit:/, 'settlement must not overwrite the sale debit');

// ===== 2026-11-08 料金改定：申告機能は年額・買い切りはすぐ、月額は7回目の支払いから =====
assert.match(html, /const TAX_ACCESS_MONTHLY_PAYMENTS = 7;/, 'monthly threshold must be 7 payments');
assert.equal(api.resolveTaxAccess('free', {}), false);
assert.equal(api.resolveTaxAccess('export', {}), false, 'export-only plan keeps CSV via canExport but not the summary');
assert.equal(api.resolveTaxAccess('lifetime', {}), true);
assert.equal(api.resolveTaxAccess('pro', { billingInterval: 'yearly' }), true);
assert.equal(api.resolveTaxAccess('pro', {}), true, 'subscriptions from before the change (no interval saved) keep access');
assert.equal(api.resolveTaxAccess('pro', { billingInterval: 'monthly', paidMonths: 1 }), false);
assert.equal(api.resolveTaxAccess('pro', { billingInterval: 'monthly', paidMonths: 6 }), false, '6 payments are not enough');
assert.equal(api.resolveTaxAccess('pro', { billingInterval: 'monthly', paidMonths: 7 }), true, '7th payment unlocks');
assert.equal(api.resolveTaxAccess('pro', { billingInterval: 'monthly', paidMonths: 1, taxAccessGrandfathered: true }), true, 'grandfathered monthly keeps access');
assert.doesNotMatch(html, /startCheckout\('price_1TeFKpRXW1evPVMU5QSgaMur'\)/, 'export-only plan must not be sold anymore');

console.log('PASS: RakuThrough accounting batch checks');
