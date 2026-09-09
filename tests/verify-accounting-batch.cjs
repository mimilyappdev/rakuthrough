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
  const start = html.indexOf(`function ${name}(`);
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
  'txFiscalYear',
  'isValidIsoDate',
  'txStatus',
  'csvStatusLabel',
  'hasReceivableHistory',
  'csvSettlementDate',
  'csvCell',
  'isRecognizedIncome',
  'isPaidIncome',
  'isRecognizedExpense',
  'getMonthlyRegistrationSummary',
  'getReceivablesAtYearEnd',
  'getAccountingReview',
  'calcPL',
  'renderAccountingReview',
  'updateCloseYearAvailability',
];
const accountingSource = `function fmt(n) { return '¥' + Math.round(n).toLocaleString(); }\n`
  + [statusConst[0], ...functionNames.map(extractFunction)].join('\n') + `
this.__accounting = {
  txFiscalYear,
  txStatus,
  csvStatusLabel,
  hasReceivableHistory,
  csvSettlementDate,
  csvCell,
  isRecognizedIncome,
  isPaidIncome,
  isRecognizedExpense,
  getMonthlyRegistrationSummary,
  getReceivablesAtYearEnd,
  getAccountingReview,
  calcPL,
  renderAccountingReview,
  updateCloseYearAvailability,
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
assert.match(html, /const st\s*=\s*csvStatusLabel\(t\)/, 'CSV export must use the reviewed status label mapping');
assert.match(html, /const sd\s*=\s*csvSettlementDate\(t\)/, 'CSV export must use the receivable-only settlement date mapping');
assert.match(html, /\['日付', '種別', '摘要',[\s\S]*?'入金日'/, 'CSV must include a settlement-date column');
assert.match(html, /\]\.map\(csvCell\)\.join\(','\)/, 'CSV rows must escape every cell through the shared helper');
assert.doesNotMatch(html, /wasReceivable\s*:/, 'transaction writes must stay within the existing Firestore schema');
assert.match(html, /売掛の入金日を補う/, 'edit UI must allow explicit correction of older receivable settlements');
assert.match(html, /type === 'income' \? '日付（売った日）' : '日付（使った日）'/, 'edit form must distinguish the sale date from an expense date');
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

console.log('PASS: RakuThrough accounting batch checks');
