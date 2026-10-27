#!/usr/bin/env node
/**
 * Opt-in integration verification against Miniflare/workerd's real local D1 binding.
 * Run from any directory: node /absolute/path/worker/scripts/verify-d1-pickup.local.mjs --run-local
 * Requires the repository's already-installed Wrangler dependencies; never installs anything.
 * No Wrangler CLI, project config, backup, existing DB, production Worker or HTTP API is used.
 * Every run creates a NEW OS-temp directory; accepting an existing target is intentionally unsupported.
 * Exit 0: seven scenarios passed. Exit 1: stop immediately; retain DB/report for inspection.
 * This is DB/service integration coverage, not an HTTP authentication/permission test.
 * D1 binding reference: https://developers.cloudflare.com/workers/testing/miniflare/storage/d1/
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: node scripts/verify-d1-pickup.local.mjs --run-local\nCreates a fresh OS-temp D1 only; DB and report are retained. No target/config/DB arguments accepted.');
  process.exit(0);
}
assert.deepEqual(args, ['--run-local'], 'Only the explicit --run-local invocation is supported');
assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'Use Node.js 22 or later');
const workerDir = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare } = wranglerRequire('miniflare');
const { build } = wranglerRequire('esbuild');

// Wrangler 4.73's splitter only closes CASE on END followed by whitespace/semicolon.
// END, and END) therefore swallow subsequent DDL into one statement. Tokenize locally
// so CASE and trigger BEGIN/END nesting do not depend on the following punctuation.
function sqlTokens(sql) {
  const lexer = /\s+|--[^\r\n]*|\/\*[\s\S]*?\*\/|[xX]'(?:[^']|'')*'|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*|->>|->|\|\||!=|<>|<=|>=|==|<<|>>|[^\s]/gy;
  const tokens = [];
  let match;
  while ((match = lexer.exec(sql)) !== null) {
    const text = match[0];
    if (/^\s|^--|^\/\*/.test(text)) continue;
    if (/^['"`\[]$/.test(text) || (text === '/' && sql[lexer.lastIndex] === '*')) {
      throw new Error(`Unterminated SQL quote/comment at character ${match.index + 1}`);
    }
    tokens.push({ text, start: match.index, end: lexer.lastIndex,
      word: /^[A-Za-z_][A-Za-z0-9_$]*$/.test(text) ? text.toUpperCase() : null });
  }
  return tokens;
}

function splitSql(sql) {
  const statements = [];
  const blocks = [];
  let start = null;
  let header = [];
  let trigger = false;
  for (const token of sqlTokens(sql)) {
    if (start === null) start = token.start;
    if (header.length < 3) header.push(token.word);
    trigger = header[0] === 'CREATE' && (header[1] === 'TRIGGER'
      || (['TEMP', 'TEMPORARY'].includes(header[1]) && header[2] === 'TRIGGER'));
    if (token.word === 'CASE' || (trigger && token.word === 'BEGIN')) blocks.push(token.word);
    if (token.word === 'END' && !blocks.pop()) throw new Error(`Unmatched SQL END at character ${token.start + 1}`);
    if (token.text === ';' && blocks.length === 0) {
      const query = sql.slice(start, token.end).trim();
      if (query !== ';') statements.push(query);
      start = null;
      header = [];
      trigger = false;
    }
  }
  if (blocks.length) throw new Error(`Unclosed SQL ${blocks.at(-1)} block`);
  if (start !== null) statements.push(sql.slice(start).trim());
  return statements;
}

function canonicalSqlTokens(sql) {
  const tokens = sqlTokens(sql);
  // SQLite omits this CREATE-header clause in sqlite_master. Never strip it from
  // a literal or body, and never collapse whitespace/escapes inside quoted tokens.
  const kindIndex = tokens[1]?.word === 'UNIQUE' ? 2 : 1;
  const clause = kindIndex + 1;
  if (tokens[0]?.word === 'CREATE' && ['INDEX', 'VIEW', 'TRIGGER'].includes(tokens[kindIndex]?.word)
    && tokens[clause]?.word === 'IF' && tokens[clause + 1]?.word === 'NOT' && tokens[clause + 2]?.word === 'EXISTS') {
    tokens.splice(clause, 3);
  }
  if (tokens.at(-1)?.text === ';') tokens.pop();
  return tokens;
}

function assertSameSql(name, actual, expected, actualLabel = 'sqlite_master', expectedLabel = 'src/schema.sql') {
  const left = canonicalSqlTokens(actual);
  const right = canonicalSqlTokens(expected);
  let index = 0;
  while (index < left.length && index < right.length && left[index].text === right[index].text) index++;
  if (index === left.length && index === right.length) return;
  const a = left[index]?.text ?? '';
  const b = right[index]?.text ?? '';
  let within = 0;
  while (within < a.length && within < b.length && a[within] === b[within]) within++;
  const context = tokens => {
    const start = Math.max(0, index - 3);
    return JSON.stringify(tokens.slice(start, index + 4).map((token, offset) => {
      const from = start + offset === index ? Math.max(0, within - 20) : 0;
      const text = token.text.slice(from, from + 44);
      return `${from ? '...' : ''}${text}${from + 44 < token.text.length ? '...' : ''}`;
    }).join(' '));
  };
  // Do not assert.equal on SQL strings: Node expands the entire colored SQL diff.
  throw new Error(`SQL definition mismatch: ${name}; first difference at token ${index + 1}; `
    + `${actualLabel} character ${(left[index]?.start ?? actual.length) + (left[index] ? within : 0) + 1}: ${context(left)}; `
    + `${expectedLabel} character ${(right[index]?.start ?? expected.length) + (right[index] ? within : 0) + 1}: ${context(right)}`);
}

function checkSqlComparisonContract() {
  // Runs only on the user's explicit invocation, before creating or opening D1.
  const view = "CREATE VIEW IF NOT EXISTS v AS SELECT CASE WHEN 1 THEN 'END; -- /*' ELSE '' END, ABS(CASE WHEN 2 THEN 3 ELSE 4 END);";
  const trigger = "CREATE TRIGGER t AFTER UPDATE ON x BEGIN SELECT CASE WHEN 1 THEN 'a'';b' ELSE 'z' END; SELECT 2; END;";
  const queries = splitSql(`${view}\n/* END; */ ${trigger}\nCREATE INDEX i ON x(a);`);
  assert.equal(queries.length, 3, 'CASE END, and END) must not merge adjacent definitions');
  assertSameSql('split CASE view', queries[0], view);
  assertSameSql('split trigger body', queries[1], trigger);
  assertSameSql('header/format only', "CREATE VIEW v AS SELECT 'IF NOT EXISTS  x';",
    "CREATE VIEW IF NOT EXISTS v\nAS /* spacing */ SELECT 'IF NOT EXISTS  x'");
  for (const [before, after] of [
    ["SELECT 'a  b'", "SELECT 'a b'"], ["SELECT 'IF NOT EXISTS x'", "SELECT 'x'"],
    ["SELECT 'a''b'", "SELECT 'ab'"], ['SELECT 1 WHERE a >= 0', 'SELECT 1 WHERE a > 0'],
    ['SELECT a, b', 'SELECT b, a'], [trigger, trigger.replace('SELECT 2', 'SELECT 3')],
  ]) {
    assert.notDeepEqual(canonicalSqlTokens(before).map(t => t.text), canonicalSqlTokens(after).map(t => t.text),
      'SQL comparison must retain literal, condition, column and trigger-body differences');
  }
}

const tempParent = await realpath(tmpdir());
const sandbox = await mkdtemp(join(tempParent, 'flying-luggage-d1-pickup-'));
const marker = randomUUID();
await writeFile(join(sandbox, '.local-only'), marker, { flag: 'wx', mode: 0o600 });
const dbDir = join(sandbox, 'd1');
const reportFile = join(sandbox, 'report.json');
const report = { status: 'RUNNING', startedAt: new Date().toISOString(), sandbox, dbDir,
  sourceHashes: {}, scenarios: [], rejectedWrites: [] };
let mf;
let activeStep = 'isolation';

async function assertIsolation() {
  assert.equal(await realpath(sandbox), sandbox, 'Sandbox must not be a symlink');
  assert.equal(dirname(sandbox), tempParent, 'Sandbox must be directly inside canonical OS temp');
  assert.match(basename(sandbox), /^flying-luggage-d1-pickup-[A-Za-z0-9]+$/);
  const stat = await lstat(sandbox);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  if (process.getuid) assert.equal(stat.uid, process.getuid());
  assert.equal(stat.mode & 0o077, 0, 'Sandbox must be private');
  const rel = relative(workerDir, sandbox);
  assert.ok(rel === '..' || rel.startsWith(`..${sep}`), 'Sandbox must be outside the repository');
  assert.equal(await readFile(join(sandbox, '.local-only'), 'utf8'), marker);
  const dbStat = await lstat(dbDir);
  assert.ok(dbStat.isDirectory() && !dbStat.isSymbolicLink());
  assert.equal(await realpath(dbDir), dbDir);
}

try {
  checkSqlComparisonContract();
  await mkdir(dbDir, { mode: 0o700 });
  await assertIsolation();
  assert.deepEqual((await readdir(sandbox)).sort(), ['.local-only', 'd1']);
  assert.deepEqual(await readdir(dbDir), [], 'An existing D1 target is never accepted');
  console.log(`ISOLATED LOCAL D1: ${dbDir}\nREPORT: ${reportFile}`);
  const sourceFiles = ['src/schema.sql', 'migrations/20261025_extension_receipts.sql',
    'migrations/20261026_root_settlement_review.sql', 'src/services/luggageBilling.ts',
    'src/services/orderNumber.ts', 'src/services/storage.ts', 'src/lib/payments.ts',
    'src/services/cashClosingSales.ts'];
  const sources = {};
  for (const name of sourceFiles) {
    sources[name] = await readFile(join(workerDir, name), 'utf8');
    report.sourceHashes[name] = createHash('sha256').update(sources[name]).digest('hex');
  }
  const schema = sources['src/schema.sql'];
  const firstMigration = sources['migrations/20261025_extension_receipts.sql'];
  const policyMigration = sources['migrations/20261026_root_settlement_review.sql'];
  const policyStart = 'CREATE UNIQUE INDEX IF NOT EXISTS idx_luggage_extension_date';
  assert.ok(schema.includes(policyStart) && policyMigration.includes(policyStart));
  const expectedDefinitions = splitSql(schema.slice(schema.indexOf(policyStart)));
  const migrationDefinitions = splitSql(policyMigration.slice(policyMigration.indexOf(policyStart)));
  assert.equal(migrationDefinitions.length, expectedDefinitions.length, 'Migration/schema financial statement count differs');
  for (let index = 0; index < expectedDefinitions.length; index++) {
    const expected = expectedDefinitions[index];
    const name = expected.match(/^CREATE\s+(?:UNIQUE\s+)?(?:INDEX|VIEW|TRIGGER)\s+(?:IF NOT EXISTS\s+)?(\w+)/i)?.[1];
    assertSameSql(name ?? `financial statement ${index + 1}`, migrationDefinitions[index], expected,
      'settlement policy migration', 'src/schema.sql');
  }
  // Reconstruct only the empty pre-feature schema, then actually apply both migrations locally.
  // Do not ALTER, patch, clock-rewrite or disable any final financial trigger/view.
  let baseSchema = schema.slice(0, schema.indexOf(policyStart));
  for (const column of ['extension_date', 'receipt_request_id']) {
    const pattern = new RegExp(`^  ${column} TEXT,?\\r?\\n`, 'gm');
    assert.equal([...baseSchema.matchAll(pattern)].length, 1, `Unexpected base column: ${column}`);
    baseSchema = baseSchema.replace(pattern, '');
  }
  activeStep = 'load-local-services';
  const servicesFile = join(sandbox, 'services.cjs');
  await build({ stdin: { contents: `export { confirmCollection, createDatedExtension, getBillingSummary } from './src/services/luggageBilling.ts';
    export { resolveAutoSalesSummaryForDate } from './src/services/cashClosingSales.ts';`,
    resolveDir: workerDir, sourcefile: 'local-d1-services.ts', loader: 'ts' },
    outfile: servicesFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' });
  const { confirmCollection, createDatedExtension, getBillingSummary, resolveAutoSalesSummaryForDate } = require(servicesFile);
  await assertIsolation(); // Final path check before starting workerd or executing any SQL.
  mf = new Miniflare({
    name: 'luggage-pickup-local-only', rootPath: sandbox, modules: true,
    compatibilityDate: '2025-03-05', host: '127.0.0.1', port: 0,
    script: `export default { fetch() { return new Response('DB verification only', { status: 405 }); } };`,
    outboundService: () => new Response('Outbound network is disabled', { status: 403 }),
    d1Databases: { DB: 'luggage-pickup-local-only' }, d1Persist: dbDir,
  });
  const db = await mf.getD1Database('DB');
  const statement = (sql, ...values) => values.length ? db.prepare(sql).bind(...values) : db.prepare(sql);
  const rows = async (sql, ...values) => (await statement(sql, ...values).all()).results;
  const one = (sql, ...values) => statement(sql, ...values).first();
  const run = (sql, ...values) => statement(sql, ...values).run();
  activeStep = 'initialize-empty-local-d1-and-apply-two-migrations';
  assert.equal((await one("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'luggage_%'")).n, 0);
  for (const [name, sql] of [['base schema', baseSchema], ['extension receipts', firstMigration], ['settlement policy', policyMigration]]) {
    for (const query of splitSql(sql)) await run(query);
    console.log(`LOCAL SCHEMA OK: ${name}`);
  }
  // Compare every final financial index/view/trigger to the actual definitions D1 installed.
  for (const query of expectedDefinitions) {
    const match = query.match(/^CREATE\s+(?:UNIQUE\s+)?(?:INDEX|VIEW|TRIGGER)\s+(?:IF NOT EXISTS\s+)?(\w+)/i);
    assert.ok(match, `Unexpected financial DDL: ${query.slice(0, 80)}`);
    const installed = await one('SELECT sql FROM sqlite_master WHERE name = ?', match[1]);
    assert.ok(installed, `Missing D1 financial definition: ${match[1]}`);
    assertSameSql(match[1], installed.sql, query);
  }
  const calendar = await one("SELECT date('now', '+9 hours') AS today, date('now', '+9 hours', '-1 day') AS yesterday");
  report.calendar = calendar;
  const { today, yesterday } = calendar;
  const staff = 'D1TEST-EDITOR';
  const historic = `${yesterday} 01:00:00`;
  const jstDate = instant => {
    // SQLite timestamps are UTC even when their text has no offset. Ignore host TZ.
    const utc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(instant)
      ? `${instant.replace(' ', 'T')}Z` : instant;
    return new Date(new Date(utc).getTime() + 9 * 3600000).toISOString().slice(0, 10);
  };
  const ensureDay = async () => assert.equal((await one("SELECT date('now', '+9 hours') AS day")).day, today,
    'JST midnight passed during verification; stop and rerun in a NEW sandbox');
  const body = (tender = 'CASH', amount = 1600, requestId = randomUUID()) => ({ request_id: requestId,
    expected_amount: amount, cash_amount: tender === 'CASH' ? amount : 0,
    qr_amount: tender === 'PAY_QR' ? amount : 0, confirm_received: 'yes' });
  const snapshot = async () => ({
    orders: await rows('SELECT * FROM luggage_orders ORDER BY order_id'),
    payments: await rows('SELECT * FROM luggage_order_payments ORDER BY payment_id'),
    audits: await rows('SELECT * FROM luggage_audit_logs ORDER BY log_id'),
    balances: await rows('SELECT * FROM luggage_billing_balances ORDER BY root_id'),
    dailySales: await rows('SELECT * FROM luggage_sales_daily ORDER BY business_date'),
    cashClosings: await rows('SELECT * FROM luggage_cash_closings ORDER BY closing_id'),
  });
  async function blocked(label, action, message) {
    const before = await snapshot();
    let rejectedMessage;
    await assert.rejects(action, error => {
      const text = [error, error?.cause, error?.cause?.cause].map(String).join('\n');
      assert.match(text, message, `${label}: unexpected rejection, not proof of the intended guard`);
      rejectedMessage = text;
      return true;
    }, `${label}: unexpectedly succeeded`);
    assert.deepEqual(await snapshot(), before, `${label}: failed write was not fully rolled back`);
    report.rejectedWrites.push({ label, error: rejectedMessage, rolledBack: true });
  }
  async function seed(id, { review = false, overdue = false, pickedUp = false } = {}) {
    assert.match(id, /^D1TEST-S\d{2}$/);
    // Insert synthetic historical end states, never mutate a collected price or disable its guard.
    await run(`INSERT INTO luggage_orders(order_id, created_at, expected_pickup_at, status, actual_pickup_at,
      expected_storage_days, price_per_day, prepaid_amount, final_amount, discount_rate,
      staff_prepaid_override_amount, payment_method, staff_id, tag_no)
      VALUES (?, ?, ?, ?, ?, ?, 1600, ?, ?, ?, ?, 'CASH', ?, '146')`,
      id, `${yesterday} 00:00:00`, `${overdue ? yesterday : today}T03:00:00Z`, pickedUp ? 'PICKED_UP' : 'PAID',
      pickedUp ? `${yesterday}T03:00:00Z` : null, review ? 6 : 1,
      review ? 9000 : 1600, review ? 9000 : 1600, review ? 0.05 : 0, review ? 9000 : null, staff);
    await run(`INSERT INTO luggage_order_payments(order_id, business_date, tender_type, amount, staff_id, recorded_at)
      VALUES (?, ?, 'CASH', ?, ?, ?)`, id, yesterday, review ? 8550 : 1600, staff, historic);
    if (review) await run(`INSERT INTO luggage_audit_logs(order_id, staff_id, action, details, timestamp)
      VALUES (?, ?, 'UPDATE_PRICE', 'Legacy text-only price edit; insufficient before/after evidence', ?)`,
      id, staff, `${yesterday} 02:00:00`);
  }
  const pickup = id => db.batch([
    statement(`INSERT INTO luggage_audit_logs(order_id, staff_id, device_id, action, details)
      VALUES (?, ?, ?, 'D1TEST_PICKUP', 'Atomic D1 pickup probe')`, id, staff, randomUUID()),
    statement(`UPDATE luggage_orders SET status = 'PICKED_UP', actual_pickup_at = datetime('now'),
      updated_at = datetime('now') WHERE order_id = ? AND status = 'PAID' RETURNING order_id`, id),
  ]);
  async function pickupSuccess(id) {
    const ledger = await rows('SELECT * FROM luggage_order_payments ORDER BY payment_id');
    const result = await pickup(id);
    assert.equal(result[1].results.length, 1, 'Pickup must actually update a PAID root');
    assert.deepEqual(await rows('SELECT * FROM luggage_order_payments ORDER BY payment_id'), ledger);
  }
  async function check(id, { status, count, received, due = 0, review = 0, reviewBlocked = 0 }) {
    const orders = await rows('SELECT * FROM luggage_orders WHERE order_id = ? OR parent_order_id = ? ORDER BY order_id', id, id);
    assert.equal(orders.find(o => o.order_id === id).status, status);
    for (const child of orders.filter(o => o.parent_order_id === id)) {
      assert.equal(child.status, status === 'PICKED_UP' ? 'PICKED_UP' : due > 0 ? 'PAYMENT_PENDING' : 'PAID');
      assert.equal(child.extension_date, today);
      assert.equal(child.final_amount, 1600);
    }
    const ledger = await one(`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM luggage_order_payments
      WHERE order_id IN (SELECT order_id FROM luggage_orders WHERE order_id = ? OR parent_order_id = ?)`, id, id);
    assert.deepEqual([ledger.n, ledger.amount], [count, received]);
    const balance = await getBillingSummary(db, id);
    assert.deepEqual([balance.outstanding_amount, balance.extension_outstanding_amount, balance.root_review_amount,
      balance.review_pickup_blocked, balance.recorded_amount, balance.invalid_amount, balance.legacy_paid_estimate],
      [due, due, review, reviewBlocked, received, 0, 0]);
    assert.equal(balance.root_review_difference, review);
    if (review) assert.equal(balance.root_review_reason, 'UNVERIFIED_ROOT_DIFFERENCE');
    return { orders, ledger, balance };
  }
  async function collect(id, tender = 'CASH', request = body(tender)) {
    await ensureDay();
    const rootLedger = await rows('SELECT * FROM luggage_order_payments WHERE order_id = ? ORDER BY payment_id', id);
    const start = Date.now();
    const result = await confirmCollection(db, id, staff, request);
    const finish = Date.now();
    assert.equal(result.collected_amount, 1600);
    const receipts = await rows('SELECT * FROM luggage_order_payments WHERE receipt_request_id = ?', request.request_id);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].amount, 1600);
    assert.equal(receipts[0].tender_type, tender);
    assert.equal(receipts[0].staff_id, staff);
    assert.notEqual(receipts[0].order_id, id, 'Never collect the root review amount');
    const recordedAt = Date.parse(receipts[0].recorded_at);
    assert.ok(recordedAt >= start && recordedAt <= finish, 'Record actual receipt instant, not extension_date');
    assert.equal(receipts[0].business_date, jstDate(receipts[0].recorded_at));
    assert.equal(result.business_date, receipts[0].business_date);
    assert.equal(receipts[0].business_date, today);
    assert.deepEqual(await rows('SELECT * FROM luggage_order_payments WHERE order_id = ? ORDER BY payment_id', id), rootLedger);
    const audit = await one("SELECT * FROM luggage_audit_logs WHERE device_id = ? AND action = 'CONFIRM_COLLECTION'", request.request_id);
    assert.ok(audit);
    assert.equal(audit.staff_id, staff);
    assert.equal(JSON.parse(audit.details).receipts[0].orderId, receipts[0].order_id);
    return request;
  }
  async function scenario(number, label, action) {
    activeStep = `S${number}: ${label}`;
    await ensureDay();
    const id = `D1TEST-S${number}`;
    const result = await action(id);
    report.scenarios.push({ scenario: number, label, ...result });
    console.log(`PASS S${number}: ${label}`);
  }

  await scenario('01', 'paid root without extension permits pickup', async id => {
    await seed(id);
    await check(id, { status: 'PAID', count: 1, received: 1600 });
    await pickupSuccess(id);
    return check(id, { status: 'PICKED_UP', count: 1, received: 1600 });
  });
  await scenario('02', 'unpaid extension blocks pickup and rolls back the entire batch', async id => {
    await seed(id, { overdue: true });
    // Projection protects midnight-to-cron gap before an extension exists.
    await check(id, { status: 'PAID', count: 1, received: 1600, due: 1600 });
    const child = await createDatedExtension(db, id, today, staff);
    assert.ok(child);
    await blocked('unpaid extension pickup', () => pickup(id), /Outstanding collection prevents pickup/);
    const requestId = randomUUID();
    const now = new Date().toISOString();
    // The partial receipt is valid; the later pickup must fail. D1 must roll back receipt AND audit.
    await blocked('valid partial receipt then blocked pickup in one D1 batch', () => db.batch([
      statement(`INSERT INTO luggage_audit_logs(order_id, staff_id, device_id, action, details)
        VALUES (?, ?, ?, 'CONFIRM_COLLECTION', 'D1TEST atomic rollback probe')`, id, staff, requestId),
      statement(`INSERT INTO luggage_order_payments(order_id, business_date, tender_type, amount, staff_id, recorded_at, receipt_request_id)
        VALUES (?, ?, 'PAY_QR', 800, ?, ?, ?)`, child, jstDate(now), staff, now, requestId),
      statement("UPDATE luggage_orders SET status = 'PICKED_UP', actual_pickup_at = datetime('now') WHERE order_id = ?", id),
    ]), /Outstanding collection prevents pickup/);
    return check(id, { status: 'PAID', count: 1, received: 1600, due: 1600 });
  });
  await scenario('03', 'paid root and cash-collected extension permit synchronized pickup', async id => {
    await seed(id, { overdue: true });
    await collect(id);
    await check(id, { status: 'PAID', count: 2, received: 3200 });
    await pickupSuccess(id);
    const result = await check(id, { status: 'PICKED_UP', count: 2, received: 3200 });
    assert.equal(result.orders.length, 2);
    assert.ok(result.orders.every(o => o.status === 'PICKED_UP' && o.actual_pickup_at === result.orders[0].actual_pickup_at));
    return result;
  });
  await scenario('04', 'unverified 450 root difference blocks pickup without collecting it', async id => {
    await seed(id, { review: true });
    await blocked('root review pickup', () => pickup(id), /Outstanding collection prevents pickup/);
    await blocked('root review is not an extra collection', () => confirmCollection(db, id, staff, body('CASH', 450)), /기존 원주문 정산 차이/);
    return check(id, { status: 'PAID', count: 1, received: 8550, review: 450, reviewBlocked: 1 });
  });
  await scenario('05', 'collect only 1600 QR extension; retain 450 review and pickup block', async id => {
    await seed(id, { review: true, overdue: true });
    await createDatedExtension(db, id, today, staff);
    await check(id, { status: 'PAID', count: 1, received: 8550, due: 1600, review: 450, reviewBlocked: 1 });
    await blocked('do not bundle review into extension collection', () => confirmCollection(db, id, staff, body('PAY_QR', 2050)), /미수납액이 변경/);
    await collect(id, 'PAY_QR');
    await blocked('root review remains after collecting extension', () => pickup(id), /Outstanding collection prevents pickup/);
    return check(id, { status: 'PAID', count: 2, received: 10150, review: 450, reviewBlocked: 1 });
  });
  let historical;
  await scenario('06', 'historical picked-up review preserves state, claim, ledger and evidence', async id => {
    await seed(id, { review: true, overdue: true, pickedUp: true });
    const result = await check(id, { status: 'PICKED_UP', count: 1, received: 8550, review: 450, reviewBlocked: 1 });
    await blocked('historical review cannot be collected', () => confirmCollection(db, id, staff, body('CASH', 450)), /기존 원주문 정산 차이/);
    await blocked('historical review ledger cannot be edited', () => run('UPDATE luggage_order_payments SET amount = amount + 1 WHERE order_id = ?', id), /Preserve collection history/);
    historical = { ...result, payments: await rows('SELECT * FROM luggage_order_payments WHERE order_id = ?', id),
      audits: await rows('SELECT * FROM luggage_audit_logs WHERE order_id = ? ORDER BY log_id', id) };
    return result;
  });
  await scenario('07', 'synchronized pickup, duplicate/concurrent extension and receipt protection', async id => {
    await seed(id, { overdue: true });
    const attempts = await Promise.all([createDatedExtension(db, id, today, staff), createDatedExtension(db, id, today, staff)]);
    const children = await rows('SELECT * FROM luggage_orders WHERE parent_order_id = ?', id);
    assert.equal(children.length, 1);
    assert.equal(attempts.filter(Boolean).length, 1);
    const child = children[0].order_id;
    assert.equal(await createDatedExtension(db, id, today, staff), null);
    await blocked('duplicate date at D1 trigger/index', () => run(`INSERT INTO luggage_orders(order_id, parent_order_id,
      extension_date, status, final_amount, prepaid_amount) VALUES ('D1TEST-DUPLICATE', ?, ?, 'PAYMENT_PENDING', 1600, 1600)`, id, today),
      /Extension date already covered|UNIQUE constraint failed/);
    await blocked('child cannot bypass root pickup', () => run("UPDATE luggage_orders SET status = 'PICKED_UP' WHERE order_id = ?", child), /Pick up the root order/);
    await blocked('unpaid child cannot be marked paid', () => run("UPDATE luggage_orders SET status = 'PAID' WHERE order_id = ?", child), /Actual collection is required/);
    const requests = [body('CASH'), body('PAY_QR')];
    const outcomes = await Promise.allSettled(requests.map(request => confirmCollection(db, id, staff, request)));
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1, 'Exactly one competing receipt request must commit');
    const rejected = outcomes.find(r => r.status === 'rejected');
    assert.match(String(rejected.reason), /주문이 변경|이미 처리|미수납액|Invalid or excess collection|UNIQUE constraint failed/);
    const winner = requests[outcomes.findIndex(r => r.status === 'fulfilled')];
    await check(id, { status: 'PAID', count: 2, received: 3200 });
    await blocked('same request retry', () => confirmCollection(db, id, staff, winner), /이미 처리된 수납 요청/);
    await blocked('new request after full collection', () => confirmCollection(db, id, staff, body()), /미수납액/);
    await blocked('same receipt request at D1 unique index', () => run(`INSERT INTO luggage_audit_logs
      (order_id, staff_id, device_id, action) VALUES (?, ?, ?, 'CONFIRM_COLLECTION')`, id, staff, winner.request_id), /UNIQUE constraint failed/);
    const received = await one('SELECT * FROM luggage_order_payments WHERE receipt_request_id = ?', winner.request_id);
    await blocked('overcollection at D1 receipt trigger', () => run(`INSERT INTO luggage_order_payments
      (order_id, business_date, tender_type, amount, staff_id, recorded_at, receipt_request_id) VALUES (?, ?, ?, 1600, ?, ?, ?)`,
      child, received.business_date, received.tender_type, staff, received.recorded_at, winner.request_id), /Invalid or excess collection/);
    await pickupSuccess(id);
    assert.equal(await createDatedExtension(db, id, today, staff), null);
    await blocked('picked-up root rejects new extension at D1', () => run(`INSERT INTO luggage_orders(order_id,
      parent_order_id, extension_date, status) VALUES ('D1TEST-AFTER-PICKUP', ?, date(?, '+1 day'), 'PAYMENT_PENDING')`, id, today), /Extension requires an active root order/);
    const result = await check(id, { status: 'PICKED_UP', count: 2, received: 3200 });
    assert.ok(result.orders.every(o => o.status === 'PICKED_UP' && o.actual_pickup_at === result.orders[0].actual_pickup_at));
    return { ...result, competingRequests: outcomes.map(r => r.status) };
  });

  activeStep = 'final-ledger-daily-sales-cash-closing-and-history-invariants';
  await ensureDay();
  assert.deepEqual(await rows('SELECT * FROM luggage_orders WHERE order_id = ?', 'D1TEST-S06'), historical.orders);
  assert.deepEqual(await rows('SELECT * FROM luggage_order_payments WHERE order_id = ?', 'D1TEST-S06'), historical.payments);
  assert.deepEqual(await rows('SELECT * FROM luggage_audit_logs WHERE order_id = ? ORDER BY log_id', 'D1TEST-S06'), historical.audits);
  for (const payment of await rows('SELECT * FROM luggage_order_payments ORDER BY payment_id')) {
    assert.equal(payment.business_date, jstDate(payment.recorded_at));
    assert.equal(payment.staff_id, staff);
  }
  const totals = await rows(`SELECT business_date, SUM(amount) AS total,
    SUM(CASE WHEN tender_type = 'CASH' THEN amount ELSE 0 END) AS cash,
    SUM(CASE WHEN tender_type = 'PAY_QR' THEN amount ELSE 0 END) AS qr
    FROM luggage_order_payments GROUP BY business_date ORDER BY business_date`);
  for (const total of totals) {
    const sale = await one('SELECT * FROM luggage_sales_daily WHERE business_date = ?', total.business_date);
    assert.deepEqual([sale.cash, sale.qr, sale.total_amount, sale.recorded_amount, sale.legacy_estimated_amount],
      [total.cash, total.qr, total.total, total.total, 0]);
    const closing = await resolveAutoSalesSummaryForDate(db, total.business_date);
    assert.ok(closing);
    assert.deepEqual([closing.cashAmount, closing.qrAmount, closing.totalAmount], [total.cash, total.qr, total.total]);
  }
  assert.equal((await one('SELECT COUNT(*) AS n FROM luggage_order_payments')).n, 10);
  assert.equal((await one('SELECT SUM(amount) AS amount FROM luggage_order_payments')).amount, 36850);
  assert.equal((await one('SELECT SUM(root_review_amount) AS amount FROM luggage_billing_balances')).amount, 1350);
  const modern = await one('SELECT COUNT(*) AS n, SUM(amount) AS amount FROM luggage_order_payments WHERE receipt_request_id IS NOT NULL');
  assert.deepEqual([modern.n, modern.amount], [3, 4800]);
  assert.equal((await one("SELECT COUNT(*) AS n FROM luggage_audit_logs WHERE action = 'CONFIRM_COLLECTION'")).n, 3);
  assert.equal((await one('SELECT COUNT(*) AS n FROM luggage_cash_closings')).n, 0, 'Only verify computed cash-closing figures, never create closing records');
  assert.equal((await one("SELECT COUNT(*) AS n FROM luggage_orders WHERE parent_order_id IS NULL AND order_id NOT LIKE 'D1TEST-%'")).n, 0);
  report.dailyTotals = totals;
  report.final = await snapshot();
  report.status = 'PASS';
  console.log('PASS: 7/7 scenarios; 10 ledger rows / JPY 36,850; 3 modern receipts / JPY 4,800; retained review JPY 1,350');
} catch (error) {
  report.status = 'FAIL';
  report.failedStep = activeStep;
  report.error = String(error?.stack ?? error);
  console.error(`STOP: ${activeStep}\n${report.error}`);
  process.exitCode = 1;
} finally {
  if (mf) {
    try { await mf.dispose(); }
    catch (error) { report.status = 'FAIL'; report.disposeError = String(error); process.exitCode = 1; }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(reportFile, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(`Retained isolated local DB and report: ${sandbox}`);
}
