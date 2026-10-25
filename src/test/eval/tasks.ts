/**
 * The eval's fixed tasks: tiny plain-Node projects (node:test, no npm install),
 * a prompt phrased like a real request, and hidden tests that are written into
 * the folder only after the agent finishes. `solution` is a known-good change,
 * used by the unit test to prove every check fails before and passes after.
 */
import { EvalTask, T, TEST, project } from './fixture';
import { HARD_TASKS } from './hard';

export { EvalTask };

// ---------- bug fixes ----------

const paginate: EvalTask = {
  id: 'bug-paginate',
  kind: 'bugfix',
  prompt: 'People are telling me the first page of results in src/paginate.js skips the first items - page 1 should start at the very first item. Can you fix it?',
  files: project({
    'src/paginate.js':
      '/** Items on a 1-based page. */\nfunction paginate(items, page, size) {\n  const start = page * size;\n  return items.slice(start, start + size);\n}\n\nfunction totalPages(count, size) {\n  return Math.ceil(count / size);\n}\n\nmodule.exports = { paginate, totalPages };\n',
    'test/paginate.test.js': T + "const { totalPages } = require('../src/paginate');\n\ntest('totalPages rounds up', () => {\n  assert.equal(totalPages(5, 2), 3);\n});\n",
  }),
  solution: {
    'src/paginate.js':
      '/** Items on a 1-based page. */\nfunction paginate(items, page, size) {\n  const start = (page - 1) * size;\n  return items.slice(start, start + size);\n}\n\nfunction totalPages(count, size) {\n  return Math.ceil(count / size);\n}\n\nmodule.exports = { paginate, totalPages };\n',
  },
  hidden: {
    'test/hidden.paginate.test.js':
      T + "const { paginate } = require('../src/paginate');\nconst items = [1, 2, 3, 4, 5];\n\ntest('first page starts at the first item', () => assert.deepEqual(paginate(items, 1, 2), [1, 2]));\ntest('middle page', () => assert.deepEqual(paginate(items, 2, 2), [3, 4]));\ntest('last page is short', () => assert.deepEqual(paginate(items, 3, 2), [5]));\ntest('past the end is empty', () => assert.deepEqual(paginate(items, 4, 2), []));\n",
  },
  check: TEST,
};

const memo: EvalTask = {
  id: 'bug-memo-race',
  kind: 'bugfix',
  prompt: 'We are seeing duplicate requests to /users/:id: when two components ask memoizeAsync (src/cache.js) for the same key at the same moment, the wrapped function runs twice. It should run once per key.',
  files: project({
    'src/cache.js':
      '/** Wraps an async function so repeated calls with the same key reuse the result. */\nfunction memoizeAsync(fn) {\n  const cache = new Map();\n  return async function (key) {\n    if (cache.has(key)) {\n      return cache.get(key);\n    }\n    const value = await fn(key);\n    cache.set(key, value);\n    return value;\n  };\n}\n\nmodule.exports = { memoizeAsync };\n',
    'test/cache.test.js':
      T + "const { memoizeAsync } = require('../src/cache');\n\ntest('a finished call is reused', async () => {\n  let calls = 0;\n  const get = memoizeAsync(async (k) => (calls++, k + '!'));\n  assert.equal(await get('a'), 'a!');\n  assert.equal(await get('a'), 'a!');\n  assert.equal(calls, 1);\n});\n",
  }),
  solution: {
    'src/cache.js':
      '/** Wraps an async function so repeated calls with the same key share one in-flight or finished call. */\nfunction memoizeAsync(fn) {\n  const cache = new Map();\n  return function (key) {\n    if (!cache.has(key)) {\n      const promise = (async () => fn(key))().catch((err) => {\n        cache.delete(key);\n        throw err;\n      });\n      cache.set(key, promise);\n    }\n    return cache.get(key);\n  };\n}\n\nmodule.exports = { memoizeAsync };\n',
  },
  hidden: {
    'test/hidden.cache.test.js':
      T +
      "const { memoizeAsync } = require('../src/cache');\nconst wait = (ms) => new Promise((r) => setTimeout(r, ms));\n\ntest('concurrent calls share one call', async () => {\n  let calls = 0;\n  const get = memoizeAsync(async (k) => (calls++, await wait(10), k));\n  const [a, b] = await Promise.all([get('x'), get('x')]);\n  assert.equal(a, 'x');\n  assert.equal(b, 'x');\n  assert.equal(calls, 1);\n});\n\ntest('different keys do not share', async () => {\n  let calls = 0;\n  const get = memoizeAsync(async (k) => (calls++, await wait(5), k));\n  await Promise.all([get('x'), get('y')]);\n  assert.equal(calls, 2);\n});\n\ntest('a failure is not remembered', async () => {\n  let calls = 0;\n  const get = memoizeAsync(async () => {\n    calls++;\n    await wait(5);\n    if (calls === 1) throw new Error('boom');\n    return 'ok';\n  });\n  await assert.rejects(get('k'), /boom/);\n  assert.equal(await get('k'), 'ok');\n  assert.equal(calls, 2);\n});\n",
  },
  check: TEST,
};

const wordCount: EvalTask = {
  id: 'bug-wordcount',
  kind: 'bugfix',
  prompt: 'wordCount in src/wordcount.js gives wrong numbers for some text: an empty string says 1, and extra spaces or line breaks throw the count off. Please fix it.',
  files: project({
    'src/wordcount.js': '/** Number of words in a text. */\nfunction wordCount(text) {\n  return text.split(\' \').length;\n}\n\nmodule.exports = { wordCount };\n',
    'test/wordcount.test.js': T + "const { wordCount } = require('../src/wordcount');\n\ntest('counts plain words', () => {\n  assert.equal(wordCount('hello big world'), 3);\n});\n",
  }),
  solution: {
    'src/wordcount.js': "/** Number of words in a text. */\nfunction wordCount(text) {\n  const trimmed = text.trim();\n  return trimmed ? trimmed.split(/\\s+/).length : 0;\n}\n\nmodule.exports = { wordCount };\n",
  },
  hidden: {
    'test/hidden.wordcount.test.js':
      T + "const { wordCount } = require('../src/wordcount');\n\ntest('empty and blank text have no words', () => {\n  assert.equal(wordCount(''), 0);\n  assert.equal(wordCount('   \\n '), 0);\n});\ntest('repeated and surrounding spaces', () => assert.equal(wordCount('  a   b  '), 2));\ntest('tabs and line breaks separate words', () => assert.equal(wordCount('one\\ttwo\\nthree\\r\\nfour'), 4));\n",
  },
  check: TEST,
};

// ---------- features ----------

const CSV_BASE =
  '/** CSV output for rows of cells. */\nfunction toCsv(rows) {\n  const cell = (v) => (/[",\\n]/.test(String(v)) ? \'"\' + String(v).replace(/"/g, \'""\') + \'"\' : String(v));\n  return rows.map((r) => r.map(cell).join(\',\')).join(\'\\n\') + \'\\n\';\n}\n\n';

const csv: EvalTask = {
  id: 'feat-parse-csv',
  kind: 'feature',
  prompt:
    'Add parseCsv(text) to src/csv.js. The first line is a header row, and it should return an array of objects keyed by the header. It needs to cope with quoted fields (commas, doubled quotes and line breaks inside them), Windows line endings and a missing final newline.',
  files: project({
    'src/csv.js': CSV_BASE + 'module.exports = { toCsv };\n',
    'test/csv.test.js': T + "const { toCsv } = require('../src/csv');\n\ntest('quotes cells with commas', () => {\n  assert.equal(toCsv([['a', 'b,c']]), 'a,\"b,c\"\\n');\n});\n",
  }),
  solution: {
    'src/csv.js':
      CSV_BASE +
      "/** Rows of text with a header line to an array of objects. */\nfunction parseCsv(text) {\n  const rows = [];\n  let row = [];\n  let field = '';\n  let quoted = false;\n  for (let i = 0; i < text.length; i++) {\n    const c = text[i];\n    if (quoted) {\n      if (c === '\"' && text[i + 1] === '\"') {\n        field += '\"';\n        i++;\n      } else if (c === '\"') {\n        quoted = false;\n      } else {\n        field += c;\n      }\n    } else if (c === '\"') {\n      quoted = true;\n    } else if (c === ',') {\n      row.push(field);\n      field = '';\n    } else if (c === '\\n' || c === '\\r') {\n      if (c === '\\r' && text[i + 1] === '\\n') i++;\n      row.push(field);\n      rows.push(row);\n      row = [];\n      field = '';\n    } else {\n      field += c;\n    }\n  }\n  if (field !== '' || row.length) {\n    row.push(field);\n    rows.push(row);\n  }\n  const [header = [], ...body] = rows.filter((r) => !(r.length === 1 && r[0] === ''));\n  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));\n}\n\nmodule.exports = { toCsv, parseCsv };\n",
  },
  hidden: {
    'test/hidden.csv.test.js':
      T +
      "const { parseCsv } = require('../src/csv');\n\ntest('header row becomes keys', () => {\n  assert.deepEqual(parseCsv('name,age\\nAda,36\\nLin,41\\n'), [{ name: 'Ada', age: '36' }, { name: 'Lin', age: '41' }]);\n});\ntest('quoted commas, doubled quotes and line breaks', () => {\n  assert.deepEqual(parseCsv('a,b\\n\"x, y\",\"say \"\"hi\"\"\"\\n\"two\\nlines\",z\\n'), [\n    { a: 'x, y', b: 'say \"hi\"' },\n    { a: 'two\\nlines', b: 'z' },\n  ]);\n});\ntest('Windows line endings and no final newline', () => {\n  assert.deepEqual(parseCsv('a,b\\r\\n1,2\\r\\n3,4'), [{ a: '1', b: '2' }, { a: '3', b: '4' }]);\n});\ntest('empty cells and header only', () => {\n  assert.deepEqual(parseCsv('a,b,c\\n1,,3\\n'), [{ a: '1', b: '', c: '3' }]);\n  assert.deepEqual(parseCsv('a,b\\n'), []);\n});\n",
  },
  check: TEST,
};

const retry: EvalTask = {
  id: 'feat-retry',
  kind: 'feature',
  prompt:
    'Create src/retry.js exporting retry(fn, { retries = 3, delayMs = 100 } = {}). It calls the async fn, and if it rejects it tries again, up to `retries` extra times, waiting delayMs * 2^attempt between tries (so delayMs, then 2x, then 4x). It resolves with the first success; if every try fails it rejects with the last error.',
  files: project({
    'src/sleep.js': '/** Resolves after ms milliseconds. */\nfunction sleep(ms) {\n  return new Promise((resolve) => setTimeout(resolve, ms));\n}\n\nmodule.exports = { sleep };\n',
    'test/sleep.test.js': T + "const { sleep } = require('../src/sleep');\n\ntest('sleep waits', async () => {\n  const t = Date.now();\n  await sleep(20);\n  assert.ok(Date.now() - t >= 15);\n});\n",
  }),
  solution: {
    'src/retry.js':
      "const { sleep } = require('./sleep');\n\n/** Calls fn until it succeeds, retrying with doubling delays; rejects with the last error. */\nasync function retry(fn, { retries = 3, delayMs = 100 } = {}) {\n  let lastError;\n  for (let attempt = 0; attempt <= retries; attempt++) {\n    try {\n      return await fn(attempt);\n    } catch (err) {\n      lastError = err;\n      if (attempt < retries) {\n        await sleep(delayMs * 2 ** attempt);\n      }\n    }\n  }\n  throw lastError;\n}\n\nmodule.exports = { retry };\n",
  },
  hidden: {
    'test/hidden.retry.test.js':
      T +
      "const { retry } = require('../src/retry');\n\ntest('resolves with the first success', async () => {\n  let calls = 0;\n  const out = await retry(async () => {\n    calls++;\n    if (calls < 3) throw new Error('flaky ' + calls);\n    return 'ok';\n  }, { delayMs: 1 });\n  assert.equal(out, 'ok');\n  assert.equal(calls, 3);\n});\ntest('rejects with the last error after retries + 1 tries', async () => {\n  let calls = 0;\n  await assert.rejects(retry(async () => { throw new Error('fail ' + ++calls); }, { retries: 2, delayMs: 1 }), /fail 3/);\n  assert.equal(calls, 3);\n});\ntest('retries: 0 tries once', async () => {\n  let calls = 0;\n  await assert.rejects(retry(async () => { calls++; throw new Error('x'); }, { retries: 0 }), /x/);\n  assert.equal(calls, 1);\n});\ntest('delays double between tries', async () => {\n  const t = Date.now();\n  await assert.rejects(retry(async () => { throw new Error('x'); }, { retries: 2, delayMs: 30 }));\n  const took = Date.now() - t;\n  assert.ok(took >= 85, 'waited ' + took + 'ms');\n});\n",
  },
  check: TEST,
};

const lru: EvalTask = {
  id: 'feat-lru',
  kind: 'feature',
  prompt:
    'I need a small LRU cache in a new file src/lru.js: export class LRUCache with constructor(capacity), get(key) (undefined when missing, and it counts as a use), set(key, value) (also a use; evicts the least recently used entry when over capacity), has(key) (does not count as a use) and a size getter.',
  files: project({
    'src/stack.js': '/** A minimal stack. */\nclass Stack {\n  items = [];\n  push(x) {\n    this.items.push(x);\n  }\n  pop() {\n    return this.items.pop();\n  }\n}\n\nmodule.exports = { Stack };\n',
    'test/stack.test.js': T + "const { Stack } = require('../src/stack');\n\ntest('pops the last pushed', () => {\n  const s = new Stack();\n  s.push(1);\n  s.push(2);\n  assert.equal(s.pop(), 2);\n});\n",
  }),
  solution: {
    'src/lru.js':
      '/** A least-recently-used cache. */\nclass LRUCache {\n  #map = new Map();\n  constructor(capacity) {\n    this.capacity = capacity;\n  }\n  get size() {\n    return this.#map.size;\n  }\n  has(key) {\n    return this.#map.has(key);\n  }\n  get(key) {\n    if (!this.#map.has(key)) {\n      return undefined;\n    }\n    const value = this.#map.get(key);\n    this.#map.delete(key);\n    this.#map.set(key, value);\n    return value;\n  }\n  set(key, value) {\n    this.#map.delete(key);\n    this.#map.set(key, value);\n    if (this.#map.size > this.capacity) {\n      this.#map.delete(this.#map.keys().next().value);\n    }\n  }\n}\n\nmodule.exports = { LRUCache };\n',
  },
  hidden: {
    'test/hidden.lru.test.js':
      T +
      "const { LRUCache } = require('../src/lru');\n\ntest('evicts the least recently used', () => {\n  const c = new LRUCache(2);\n  c.set('a', 1);\n  c.set('b', 2);\n  c.set('c', 3);\n  assert.equal(c.has('a'), false);\n  assert.equal(c.get('b'), 2);\n  assert.equal(c.size, 2);\n});\ntest('get counts as a use', () => {\n  const c = new LRUCache(2);\n  c.set('a', 1);\n  c.set('b', 2);\n  c.get('a');\n  c.set('c', 3);\n  assert.equal(c.has('b'), false);\n  assert.equal(c.get('a'), 1);\n});\ntest('has does not count as a use', () => {\n  const c = new LRUCache(2);\n  c.set('a', 1);\n  c.set('b', 2);\n  c.has('a');\n  c.set('c', 3);\n  assert.equal(c.has('a'), false);\n});\ntest('overwriting refreshes and does not grow', () => {\n  const c = new LRUCache(2);\n  c.set('a', 1);\n  c.set('b', 2);\n  c.set('a', 9);\n  c.set('c', 3);\n  assert.equal(c.get('a'), 9);\n  assert.equal(c.has('b'), false);\n  assert.equal(c.size, 2);\n  assert.equal(c.get('zzz'), undefined);\n});\n",
  },
  check: TEST,
};

// ---------- refactors ----------

const ORDERS = (name: string) => `/** Sum of line totals for an order. */\nfunction ${name}(order) {\n  return order.lines.reduce((sum, l) => sum + l.price * l.qty, 0);\n}\n\nmodule.exports = { ${name} };\n`;
const renameFiles = (name: string) => ({
  'src/orders.js': ORDERS(name),
  'src/invoice.js': `const { ${name} } = require('./orders');\n\n/** One-line invoice summary. */\nfunction invoiceLine(order) {\n  return 'Invoice ' + order.id + ': ' + ${name}(order).toFixed(2);\n}\n\nmodule.exports = { invoiceLine };\n`,
  'src/report.js': `const orders = require('./orders');\n\n/** Sum of all orders. */\nfunction grandTotal(list) {\n  return list.reduce((sum, o) => sum + orders.${name}(o), 0);\n}\n\nmodule.exports = { grandTotal };\n`,
  'bin/cli.js': `const { ${name} } = require('../src/orders');\n\n/** The CLI's output for one order. */\nfunction run(order) {\n  return 'Total: ' + ${name}(order);\n}\n\nmodule.exports = { run };\n`,
  'README.md': `# Orders\n\nUse \`${name}(order)\` to get an order's total.\n`,
  'test/orders.test.js': T + `const { ${name} } = require('../src/orders');\n\ntest('totals lines', () => {\n  assert.equal(${name}({ lines: [{ price: 2, qty: 3 }, { price: 1, qty: 1 }] }), 7);\n});\n`,
});

const rename: EvalTask = {
  id: 'refactor-rename',
  kind: 'refactor',
  prompt: 'calcTotal in src/orders.js is a bad name. Rename it to orderTotal everywhere it is used - code, tests and docs - without changing behaviour.',
  files: project(renameFiles('calcTotal')),
  solution: renameFiles('orderTotal'),
  hidden: {
    'test/hidden.rename.test.js':
      T +
      "const fs = require('node:fs');\nconst path = require('node:path');\nconst orders = require('../src/orders');\nconst { invoiceLine } = require('../src/invoice');\nconst { grandTotal } = require('../src/report');\nconst { run } = require('../bin/cli');\nconst order = { id: 7, lines: [{ price: 2.5, qty: 2 }, { price: 1, qty: 3 }] };\n\ntest('orderTotal exists and the old name is gone', () => {\n  assert.equal(orders.orderTotal(order), 8);\n  assert.equal(orders.calcTotal, undefined);\n});\ntest('callers still work', () => {\n  assert.equal(invoiceLine(order), 'Invoice 7: 8.00');\n  assert.equal(grandTotal([order, order]), 16);\n  assert.equal(run(order), 'Total: 8');\n});\ntest('no file still mentions the old name', () => {\n  const hits = [];\n  const walk = (dir) => {\n    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {\n      const p = path.join(dir, e.name);\n      if (e.isDirectory()) {\n        if (e.name !== 'node_modules' && e.name !== '_eval' && e.name !== '.git' && e.name !== '.dual-agent') walk(p);\n      } else if (!e.name.startsWith('hidden.') && fs.readFileSync(p, 'utf8').includes('calcTotal')) {\n        hits.push(path.relative(process.cwd(), p));\n      }\n    }\n  };\n  walk(process.cwd());\n  assert.deepEqual(hits, []);\n});\n",
  },
  check: TEST,
};

const moveFiles = (moved: boolean) => ({
  'src/util.js': moved
    ? "const { formatMoney } = require('./money');\n\n/** Pads text on the right. */\nfunction pad(s, n) {\n  return String(s).padEnd(n);\n}\n\n/** A name and a price, aligned. */\nfunction lineLabel(name, cents) {\n  return pad(name, 10) + formatMoney(cents);\n}\n\nmodule.exports = { pad, lineLabel };\n"
    : '/** Formats cents as dollars: 1999 -> "$19.99". */\nfunction formatMoney(cents) {\n  return \'$\' + (cents / 100).toFixed(2);\n}\n\n/** Pads text on the right. */\nfunction pad(s, n) {\n  return String(s).padEnd(n);\n}\n\n/** A name and a price, aligned. */\nfunction lineLabel(name, cents) {\n  return pad(name, 10) + formatMoney(cents);\n}\n\nmodule.exports = { formatMoney, pad, lineLabel };\n',
  'src/report.js': `const { formatMoney } = require('./${moved ? 'money' : 'util'}');\nconst { pad } = require('./util');\n\n/** One report row. */\nfunction row(name, cents) {\n  return pad(name, 8) + formatMoney(cents);\n}\n\nmodule.exports = { row };\n`,
  'src/receipt.js': `const util = require('./util');\n${moved ? "const money = require('./money');\n" : ''}\n/** Item lines and a total. */\nfunction receipt(items) {\n  const total = items.reduce((s, i) => s + i.cents, 0);\n  return items.map((i) => util.lineLabel(i.name, i.cents)).join('\\n') + '\\nTotal ' + ${moved ? 'money' : 'util'}.formatMoney(total);\n}\n\nmodule.exports = { receipt };\n`,
  'src/invoice.js': `const { formatMoney: money } = require('./${moved ? 'money' : 'util'}');\n\n/** The amount due line. */\nfunction due(cents) {\n  return 'Due: ' + money(cents);\n}\n\nmodule.exports = { due };\n`,
  'test/util.test.js': moved
    ? T + "const { pad } = require('../src/util');\nconst { formatMoney } = require('../src/money');\n\ntest('formats cents', () => assert.equal(formatMoney(1999), '$19.99'));\ntest('pads', () => assert.equal(pad('ab', 4), 'ab  '));\n"
    : T + "const { formatMoney, pad } = require('../src/util');\n\ntest('formats cents', () => assert.equal(formatMoney(1999), '$19.99'));\ntest('pads', () => assert.equal(pad('ab', 4), 'ab  '));\n",
  ...(moved ? { 'src/money.js': '/** Formats cents as dollars: 1999 -> "$19.99". */\nfunction formatMoney(cents) {\n  return \'$\' + (cents / 100).toFixed(2);\n}\n\nmodule.exports = { formatMoney };\n' } : {}),
});

const move: EvalTask = {
  id: 'refactor-move',
  kind: 'refactor',
  prompt: 'Money formatting does not belong in src/util.js. Move formatMoney into its own module, src/money.js, and update everything that uses it. Do not leave a re-export behind in util.js. Behaviour must stay the same.',
  files: project(moveFiles(false)),
  solution: moveFiles(true),
  hidden: {
    'test/hidden.move.test.js':
      T +
      "const money = require('../src/money');\nconst util = require('../src/util');\nconst { row } = require('../src/report');\nconst { receipt } = require('../src/receipt');\nconst { due } = require('../src/invoice');\n\ntest('formatMoney lives in money.js only', () => {\n  assert.equal(money.formatMoney(1999), '$19.99');\n  assert.equal(util.formatMoney, undefined);\n});\ntest('users of it behave the same', () => {\n  assert.equal(util.lineLabel('tea', 250), 'tea       $2.50');\n  assert.equal(row('tea', 250), 'tea     $2.50');\n  assert.equal(due(1005), 'Due: $10.05');\n  assert.equal(receipt([{ name: 'tea', cents: 250 }, { name: 'cake', cents: 400 }]), 'tea       $2.50\\ncake      $4.00\\nTotal $6.50');\n});\n",
  },
  check: TEST,
};

// ---------- make the failing tests pass ----------

const INVENTORY_TEST =
  T + "const { createInventory } = require('../src/inventory');\n\ntest('adds to existing stock', () => {\n  const inv = createInventory();\n  inv.add('apple', 2);\n  assert.equal(inv.count('apple'), 7);\n});\ntest('remove stock', () => {\n  const inv = createInventory();\n  inv.remove('apple', 2);\n  assert.equal(inv.count('apple'), 3);\n});\ntest('refuses to remove more than is there', () => {\n  const inv = createInventory();\n  assert.throws(() => inv.remove('pear', 4), /not enough pear/);\n});\n";

const inventory: EvalTask = {
  id: 'fix-tests-inventory',
  kind: 'fix-tests',
  prompt: "npm test is red: 'remove stock' in test/inventory.test.js fails with 5 !== 3. Can you get the suite passing? The tests are right, so don't change them.",
  files: project({
    'src/inventory.js':
      "const DEFAULT_STOCK = { apple: 5, pear: 3 };\n\n/** A stock book: quantities by item name. */\nfunction createInventory(initial = DEFAULT_STOCK) {\n  const stock = initial;\n  return {\n    add(name, qty) {\n      stock[name] = (stock[name] ?? 0) + qty;\n    },\n    remove(name, qty) {\n      if ((stock[name] ?? 0) < qty) {\n        throw new Error('not enough ' + name);\n      }\n      stock[name] -= qty;\n    },\n    count(name) {\n      return stock[name] ?? 0;\n    },\n  };\n}\n\nmodule.exports = { createInventory };\n",
    'test/inventory.test.js': INVENTORY_TEST,
  }),
  solution: {
    'src/inventory.js':
      "const DEFAULT_STOCK = { apple: 5, pear: 3 };\n\n/** A stock book: quantities by item name. */\nfunction createInventory(initial = DEFAULT_STOCK) {\n  const stock = { ...initial };\n  return {\n    add(name, qty) {\n      stock[name] = (stock[name] ?? 0) + qty;\n    },\n    remove(name, qty) {\n      if ((stock[name] ?? 0) < qty) {\n        throw new Error('not enough ' + name);\n      }\n      stock[name] -= qty;\n    },\n    count(name) {\n      return stock[name] ?? 0;\n    },\n  };\n}\n\nmodule.exports = { createInventory };\n",
  },
  hidden: {
    'test/inventory.test.js': INVENTORY_TEST,
    'test/hidden.inventory.test.js':
      T + "const { createInventory } = require('../src/inventory');\n\ntest('inventories are independent', () => {\n  const a = createInventory();\n  const b = createInventory();\n  a.add('apple', 10);\n  assert.equal(b.count('apple'), 5);\n});\ntest('the object passed in is not modified', () => {\n  const start = { kiwi: 1 };\n  const inv = createInventory(start);\n  inv.add('kiwi', 4);\n  assert.deepEqual(start, { kiwi: 1 });\n  assert.equal(inv.count('kiwi'), 5);\n});\n",
  },
  check: TEST,
};

const QUEUE_TEST =
  T + "const { parseTasks } = require('../src/parse');\nconst { nextTask } = require('../src/queue');\n\ntest('single digit priorities', () => {\n  assert.equal(nextTask(parseTasks('write:3\\nship:7\\ntest:2')).name, 'ship');\n});\ntest('picks the highest priority', () => {\n  assert.equal(nextTask(parseTasks('write:9\\nship:10\\ntest:2')).name, 'ship');\n});\n";

const queue: EvalTask = {
  id: 'fix-tests-queue',
  kind: 'fix-tests',
  prompt: "The 'picks the highest priority' test in test/queue.test.js fails: it gets 'write' instead of 'ship', so I think nextTask in src/queue.js is picking wrong. Please get npm test green - the tests are correct.",
  files: project({
    'src/parse.js': "/** Lines of \"name:priority\" to tasks. */\nfunction parseTasks(text) {\n  return text\n    .split('\\n')\n    .filter(Boolean)\n    .map((line) => {\n      const [name, priority] = line.split(':');\n      return { name, priority: priority.trim() };\n    });\n}\n\nmodule.exports = { parseTasks };\n",
    'src/queue.js': '/** The task with the highest priority. */\nfunction nextTask(tasks) {\n  let best;\n  for (const t of tasks) {\n    if (!best || t.priority > best.priority) {\n      best = t;\n    }\n  }\n  return best;\n}\n\nmodule.exports = { nextTask };\n',
    'test/queue.test.js': QUEUE_TEST,
  }),
  solution: {
    'src/parse.js': "/** Lines of \"name:priority\" to tasks. */\nfunction parseTasks(text) {\n  return text\n    .split('\\n')\n    .filter(Boolean)\n    .map((line) => {\n      const [name, priority] = line.split(':');\n      return { name, priority: Number(priority.trim()) };\n    });\n}\n\nmodule.exports = { parseTasks };\n",
  },
  hidden: {
    'test/queue.test.js': QUEUE_TEST,
    'test/hidden.queue.test.js':
      T + "const { parseTasks } = require('../src/parse');\nconst { nextTask } = require('../src/queue');\n\ntest('multi-digit priorities with spaces', () => {\n  assert.equal(nextTask(parseTasks('a: 100\\nb: 25\\nc: 9')).name, 'a');\n});\ntest('a lone task', () => {\n  assert.equal(nextTask(parseTasks('only:1')).name, 'only');\n});\ntest('no tasks', () => {\n  assert.equal(nextTask(parseTasks('')), undefined);\n});\n",
  },
  check: TEST,
};

// ---------- write tests (graded by mutation) ----------

const CART = (variant: 'ok' | 'threshold' | 'coupon' | 'round' | 'negative') =>
  '/** Cart total: line sums, 10% off from 100, an optional SAVE5 coupon, rounded to cents. */\nfunction cartTotal(items, opts = {}) {\n  let subtotal = 0;\n  for (const { price, qty } of items) {\n' +
  (variant === 'negative' ? '' : "    if (qty < 0) {\n      throw new RangeError('qty must not be negative');\n    }\n") +
  '    subtotal += price * qty;\n  }\n' +
  `  if (subtotal ${variant === 'threshold' ? '>' : '>='} 100) {\n    subtotal *= 0.9;\n  }\n` +
  "  if (opts.coupon === 'SAVE5') {\n    subtotal = " +
  (variant === 'coupon' ? 'subtotal - 5' : 'Math.max(0, subtotal - 5)') +
  ';\n  }\n  return ' +
  (variant === 'round' ? 'subtotal' : 'Math.round(subtotal * 100) / 100') +
  ';\n}\n\nmodule.exports = { cartTotal };\n';

/** Runs the agent's tests on the real code (must pass) and on each mutant (must fail). */
const MUTATION_RUNNER = `const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const root = process.cwd();
const run = (dir) => cp.spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8', timeout: 30000 });
const copy = (to) => fs.cpSync(root, to, { recursive: true, filter: (s) => !['_eval', 'node_modules'].includes(path.basename(s)) });
const base = run(root);
const count = Number(/# tests (\\d+)/.exec(base.stdout)?.[1] ?? 0);
if (base.status !== 0) {
  console.log('Your tests fail on the real code:\\n' + base.stdout.slice(-1500));
  process.exit(1);
}
if (count < 4) {
  console.log('Too few tests: ' + count);
  process.exit(1);
}
const survived = [];
const dir = path.join(root, '_eval', 'mutants');
for (const file of fs.readdirSync(dir)) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mutant-'));
  copy(tmp);
  fs.copyFileSync(path.join(dir, file), path.join(tmp, 'src', 'cart.js'));
  if (run(tmp).status === 0) survived.push(file);
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (survived.length) {
  console.log('Tests did not catch: ' + survived.join(', '));
  process.exit(1);
}
console.log('All mutants caught by ' + count + ' tests');
`;

const cartTests: EvalTask = {
  id: 'write-tests-cart',
  kind: 'write-tests',
  prompt: 'There are no tests for src/cart.js yet. Please add some in test/cart.test.js using node:test. I want them to catch regressions in the discount, coupon, rounding and validation logic.',
  files: project({ 'src/cart.js': CART('ok') }),
  solution: {
    'test/cart.test.js':
      T +
      "const { cartTotal } = require('../src/cart');\n\ntest('sums lines', () => assert.equal(cartTotal([{ price: 10, qty: 2 }, { price: 5, qty: 1 }]), 25));\ntest('empty cart is 0', () => assert.equal(cartTotal([]), 0));\ntest('discount applies at exactly 100', () => assert.equal(cartTotal([{ price: 100, qty: 1 }]), 90));\ntest('no discount just below 100', () => assert.equal(cartTotal([{ price: 99, qty: 1 }]), 99));\ntest('coupon takes 5 off', () => assert.equal(cartTotal([{ price: 20, qty: 1 }], { coupon: 'SAVE5' }), 15));\ntest('coupon never goes below zero', () => assert.equal(cartTotal([{ price: 3, qty: 1 }], { coupon: 'SAVE5' }), 0));\ntest('rounds to cents', () => assert.equal(cartTotal([{ price: 0.1, qty: 3 }]), 0.3));\ntest('negative quantity throws', () => assert.throws(() => cartTotal([{ price: 1, qty: -1 }]), RangeError));\n",
  },
  hidden: {
    '_eval/mutation.js': MUTATION_RUNNER,
    '_eval/mutants/threshold.js': CART('threshold'),
    '_eval/mutants/coupon.js': CART('coupon'),
    '_eval/mutants/round.js': CART('round'),
    '_eval/mutants/negative.js': CART('negative'),
  },
  check: ['node', '_eval/mutation.js'],
};

// ---------- lint must pass ----------

const LINT = `const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..', 'src');
let failed = false;
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  const problems = [];
  if (!text.startsWith('/**')) problems.push('missing header comment');
  text.split('\\n').forEach((line, i) => {
    if (/\\bconsole\\.log\\b/.test(line)) problems.push('line ' + (i + 1) + ': console.log');
    if (/^\\s*var\\s/.test(line)) problems.push('line ' + (i + 1) + ': var');
    if (line.length > 100) problems.push('line ' + (i + 1) + ': longer than 100 characters');
  });
  for (const p of problems) console.log('src/' + file + ': ' + p);
  failed ||= problems.length > 0;
}
process.exit(failed ? 1 : 0);
`;

const VERIFY = `const cp = require('node:child_process');
for (const args of [['scripts/lint.js'], ['--test']]) {
  const r = cp.spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}
`;

const temperature: EvalTask = {
  id: 'feat-lint-temperature',
  kind: 'lint',
  prompt:
    "Add src/temperature.js with toFahrenheit(c) and toCelsius(f), both rounded to one decimal, and describe(c) which returns 'freezing' at or below 0, 'cold' below 15, 'mild' below 25 and 'hot' otherwise. The repo has `npm run lint`; it has to pass when you are done.",
  files: project({
    'scripts/lint.js': LINT,
    'src/stack.js': '/** A minimal stack. */\nclass Stack {\n  items = [];\n  push(x) {\n    this.items.push(x);\n  }\n  pop() {\n    return this.items.pop();\n  }\n}\n\nmodule.exports = { Stack };\n',
    'test/stack.test.js': T + "const { Stack } = require('../src/stack');\n\ntest('pops the last pushed', () => {\n  const s = new Stack();\n  s.push(1);\n  assert.equal(s.pop(), 1);\n});\n",
  }),
  solution: {
    'src/temperature.js':
      "/** Temperature conversions and a short description. */\nconst round1 = (x) => Math.round(x * 10) / 10;\n\nconst toFahrenheit = (c) => round1((c * 9) / 5 + 32);\nconst toCelsius = (f) => round1(((f - 32) * 5) / 9);\n\nfunction describe(c) {\n  if (c <= 0) return 'freezing';\n  if (c < 15) return 'cold';\n  if (c < 25) return 'mild';\n  return 'hot';\n}\n\nmodule.exports = { toFahrenheit, toCelsius, describe };\n",
  },
  hidden: {
    'scripts/lint.js': LINT,
    '_eval/verify.js': VERIFY,
    'test/hidden.temperature.test.js':
      T +
      "const { toFahrenheit, toCelsius, describe } = require('../src/temperature');\n\ntest('converts', () => {\n  assert.equal(toFahrenheit(100), 212);\n  assert.equal(toFahrenheit(36.6), 97.9);\n  assert.equal(toCelsius(32), 0);\n  assert.equal(toCelsius(100), 37.8);\n});\ntest('describes at the boundaries', () => {\n  assert.equal(describe(0), 'freezing');\n  assert.equal(describe(-5), 'freezing');\n  assert.equal(describe(0.1), 'cold');\n  assert.equal(describe(14.9), 'cold');\n  assert.equal(describe(15), 'mild');\n  assert.equal(describe(25), 'hot');\n});\n",
  },
  check: ['node', '_eval/verify.js'],
};

export const TASKS: EvalTask[] = [paginate, memo, wordCount, csv, retry, lru, rename, move, inventory, queue, cartTests, temperature, ...HARD_TASKS.map((h) => h.task)];

import * as fs from 'fs';
import * as path from 'path';

/** Writes files (relative paths) under root, creating folders. */
export function writeFiles(root: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}
