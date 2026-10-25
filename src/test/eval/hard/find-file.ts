import { HardTask, T, TEST, project } from '../fixture';

// The bug is in src/utils/validate.js (normalizeEmail drops the +tag); the prompt gives only the symptom.
const VALIDATE_BUG = `// Lowercases an email and drops surrounding spaces and any +tag.
function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\\+[^@]*@/, '@');
}

function isValidEmail(value) {
  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value);
}

module.exports = { normalizeEmail, isValidEmail };
`;

const VALIDATE_FIXED = `// Lowercases an email and drops surrounding spaces.
function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value);
}

module.exports = { normalizeEmail, isValidEmail };
`;

const USERS_MODEL = `const crypto = require('node:crypto');
const { getDb } = require('../config/database');

// The user with this email (exact, case-insensitive), or undefined.
function findByEmail(email) {
  return getDb().users.find((u) => u.email.toLowerCase() === email.toLowerCase());
}

function findById(id) {
  return getDb().users.find((u) => u.id === Number(id));
}

function search(term) {
  const t = String(term || '').toLowerCase();
  return getDb().users.filter((u) => u.email.toLowerCase().includes(t));
}

// Compares a plain password with its stored sha256 hex digest.
function checkPassword(plainText, hash) {
  return crypto.createHash('sha256').update(String(plainText)).digest('hex') === hash;
}

module.exports = { findByEmail, findById, search, checkPassword };
`;

const files = project({
  'src/server.js': `// HTTP handler: picks a route and keeps the result as JSON.
const routes = require('./routes/index');
const { matchPath } = require('./routes/params');

// Runs the handler whose path pattern matches the request; 404 when none does.
async function handle(request) {
  const req = { method: request.method, path: request.path, body: request.body || {}, headers: request.headers, render: request.render };
  for (const route of routes) {
    if (route.method !== req.method) continue;
    const params = matchPath(route.path, req.path);
    if (!params) continue;
    try {
      return { status: 200, body: await route.handler(req, params) };
    } catch (err) {
      return { status: err.statusCode || 500, body: { error: err.message } };
    }
  }
  return { status: 404, body: { error: 'not found' } };
}

module.exports = { handle };
`,
  'src/routes/index.js': `const auth = require('./auth');
const users = require('./users');
const orders = require('./orders');
const billing = require('./billing');

module.exports = [...auth.routes, ...users.routes, ...orders.routes, ...billing.routes];
`,
  'src/routes/auth.js': `const hub = require('../hub');

// Auth routes: log in and out.
const routes = [
  { method: 'POST', path: '/login', handler: (req) => hub.login(req) },
  { method: 'POST', path: '/logout', handler: () => ({ ok: true }) },
];

module.exports = { routes };
`,
  'src/routes/users.js': `const users = require('../models/users');
const audit = require('../services/audit');

// Users routes: search, one user, suspend, restore.
const routes = [
  { method: 'GET', path: '/users', handler: (req, { term }) => users.search(term) },
  { method: 'GET', path: '/users/:id', handler: (req, { id }) => users.findById(id) },
  { method: 'POST', path: '/users/:id/suspend', handler: (req, { id }) => audit.suspend(Number(id), req.body.reason) },
  { method: 'POST', path: '/users/:id/restore', handler: (req, { id }) => audit.restore(Number(id)) },
];

module.exports = { routes };
`,
  'src/routes/orders.js': `const orders = require('../models/orders');

// Orders routes: an order by id and the orders of one user.
const routes = [
  { method: 'GET', path: '/orders/:id', handler: (req, { id }) => orders.findById(id) },
  { method: 'GET', path: '/users/:userId/orders', handler: (req, { userId }) => orders.forUser(userId) },
];

module.exports = { routes };
`,
  'src/routes/billing.js': `const invoices = require('../services/invoices');
const products = require('../models/products');

// Billing routes: one invoice and the price list.
const routes = [
  { method: 'GET', path: '/invoices/:id', handler: (req, { id }) => invoices.findById(id) || { error: 'missing' } },
  { method: 'GET', path: '/prices', handler: () => products.list() },
];

module.exports = { routes };
`,
  'src/routes/params.js': `// Splits a "/users/:id/orders" pattern and "/users/7/orders" path (query dropped) into params.
function matchPath(pattern, requestPath) {
  const p = requestPath.split('?')[0];
  const want = pattern.split('/').filter(Boolean);
  const have = p.split('/').filter(Boolean);
  if (want.length !== have.length) return null;
  const params = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':')) params[want[i].slice(1)] = decodeURIComponent(have[i]);
    else if (want[i] !== have[i]) return null;
  }
  return params;
}

module.exports = { matchPath };
`,
  'src/middleware/logging.js': `const LABELS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

// One log line for a request.
function line(method, path) {
  return '[' + method + '] ' + (path || '/');
}

module.exports = { LABELS, line };
`,
  'src/hub.js': `const users = require('./models/users');
const { normalizeEmail, isValidEmail } = require('./utils/validate');
const sessions = require('./services/session');

// Log in with an email and password (handler for POST /login).
function login(req) {
  const { email, password } = req.body || {};
  const normalized = normalizeEmail(email);
  const render = req.render || ((page, model) => ({ page, ...model }));
  if (!isValidEmail(normalized)) return render('login', { error: 'Enter a valid email address.' });
  const user = users.findByEmail(normalized);
  if (!user || !users.checkPassword(password, user.password)) return render('login', { error: 'Wrong email or password.' });
  sessions.start(req, user.id);
  return { redirect: '/' };
}

// The user of the current session, or null.
function currentUser(req) {
  const id = sessions.userId(req);
  return id == null ? null : users.findById(id);
}

module.exports = { login, currentUser };
`,
  'src/models/users.js': USERS_MODEL,
  'src/models/orders.js': `const { getDb } = require('../config/database');

function findById(id) {
  return getDb().orders.find((o) => o.id === Number(id));
}

// Orders placed by a user id, oldest first.
function forUser(userId) {
  return getDb().orders.filter((o) => o.userId === Number(userId));
}

module.exports = { findById, forUser };
`,
  'src/models/products.js': `// Fixed product list.
const items = [
  { sku: 'tea', name: 'Tea', price: 250 },
  { sku: 'cake', name: 'Cake', price: 400 },
];

const list = () => items;

module.exports = { list };
`,
  'src/services/auth.js': `const sessions = require('./session');

function isLoggedIn(req) {
  return sessions.userId(req) != null;
}

function requireLogin(req) {
  if (!isLoggedIn(req)) throw new Error('Login required');
  return sessions.userId(req);
}

module.exports = { isLoggedIn, requireLogin };
`,
  'src/services/session.js': `const { getDb } = require('../config/database');

// Opens a session for a user and remembers it in the request's cookie.
function start(req, userId) {
  const id = String(userId) + '-' + req.path.replace(/\\W/g, '');
  getDb().sessions.push({ id, userId });
  req.headers = { ...req.headers, cookie: 'sid=' + id };
  return id;
}

// The user id of the request's session, if any.
function userId(req) {
  const cookie = String((req.headers && req.headers.cookie) || '');
  const found = getDb().sessions.find((s) => cookie.includes('sid=' + s.id));
  return found ? found.userId : undefined;
}

module.exports = { start, userId };
`,
  'src/services/audit.js': `const { getDb } = require('../config/database');
const users = require('../models/users');
const { NotFound } = require('../utils/errors');

function suspend(id, reason) {
  const user = users.findById(id);
  if (!user) throw new NotFound('user');
  user.suspended = true;
  getDb().audit.push({ id, action: 'suspend', reason: reason || '' });
  return user;
}

function restore(id) {
  const user = users.findById(id);
  if (!user) throw new NotFound('user');
  user.suspended = false;
  getDb().audit.push({ id, action: 'restore' });
  return user;
}

module.exports = { suspend, restore };
`,
  'src/services/invoices.js': `const { getDb } = require('../config/database');

function findById(id) {
  return getDb().invoices.find((i) => i.id === Number(id));
}

function unpaid() {
  return getDb().invoices.filter((i) => !i.paid);
}

module.exports = { findById, unpaid };
`,
  'src/utils/validate.js': VALIDATE_BUG,
  'src/utils/format.js': `const { formatMoney } = require('./money');

function title(s) {
  return String(s).replace(/\\b\\w/g, (c) => c.toUpperCase());
}

function priceLine(cents) {
  return formatMoney(cents);
}

module.exports = { title, priceLine };
`,
  'src/utils/money.js': `// Cents to dollars: 250 -> "$2.50".
function formatMoney(cents) {
  return '$' + (cents / 100).toFixed(2);
}

module.exports = { formatMoney };
`,
  'src/utils/errors.js': `class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

class NotFound extends HttpError {
  constructor(what) {
    super(404, what + ' not found');
  }
}

class LimitError extends HttpError {
  constructor(limit) {
    super(429, 'too many requests: limit ' + limit);
  }
}

module.exports = { HttpError, NotFound, LimitError };
`,
  'src/utils/dates.js': `// The UTC instant at the start of a YYYY-MM-DD day.
function parseDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toDay(date) {
  return date.toISOString().slice(0, 10);
}

module.exports = { parseDay, toDay };
`,
  'src/config/env.js': `// Startup settings, overridable from the environment.
const env = process.env;

const config = {
  port: Number(env.PORT || 3000),
  dbFile: env.DB_FILE || './data/shop.json',
  pageSize: Number(env.PAGE_SIZE || 20),
  logLevel: env.LOG_LEVEL || 'info',
  timezone: env.TZ || 'UTC',
  currency: 'USD',
};

module.exports = { config };
`,
  'src/config/settings.js': `const SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 20;
const SUPPORT_EMAIL = 'support@example.com';
const ALLOWED_ORIGINS = ['https://app.example.com', 'https://admin.example.com'];

function isAllowedOrigin(origin) {
  return ALLOWED_ORIGINS.includes(origin);
}

module.exports = { SESSION_TTL_MS, DEFAULT_PAGE_SIZE, SUPPORT_EMAIL, isAllowedOrigin };
`,
  'src/config/database.js': `// One in-memory database, seeded empty.
function empty() {
  return { version: 1, users: [], orders: [], invoices: [], sessions: [], audit: [], settings: {}, counters: {} };
}

let db = null;

function getDb() {
  return db || (db = empty());
}

function resetDb() {
  db = empty();
}

module.exports = { getDb, resetDb };
`,
  'test/validate.test.js': T + `const { normalizeEmail, isValidEmail } = require('../src/utils/validate');

test('plain addresses are lowercased and trimmed', () => {
  assert.equal(normalizeEmail('  Bob@Example.com '), 'bob@example.com');
});
test('an address needs an @ and a dot', () => {
  assert.equal(isValidEmail('bob@example.com'), true);
  assert.equal(isValidEmail('bob'), false);
});
`,
  'test/routes.test.js': T + `const { handle } = require('../src/server');

test('the price list is served', async () => {
  const res = await handle({ method: 'GET', path: '/prices', headers: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
});
test('an unknown path is a 404', async () => {
  const res = await handle({ method: 'GET', path: '/nope', headers: {} });
  assert.equal(res.status, 404);
});
`,
});

export const hard: HardTask = {
  task: {
    id: 'hard-find-file',
    kind: 'bugfix',
    difficulty: 'hard',
    prompt:
      "Support says some customers can't log in at all: people whose email has a + in it, like jane+shopping@example.com (a perfectly valid Gmail-style address), get 'Wrong email or password' every time even with the right password. Plain addresses work fine. Nothing else should change.",
    files,
    solution: { 'src/utils/validate.js': VALIDATE_FIXED },
    hidden: {
      'test/hidden.login.test.js':
        T +
        `const crypto = require('node:crypto');
const { handle } = require('../src/server');
const { getDb } = require('../src/config/database');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const USER = { id: 42, email: 'jane+shopping@example.com', password: sha('hunter2') };

async function login(email, password = 'hunter2') {
  getDb().users = [USER];
  return handle({ method: 'POST', path: '/login', body: { email, password }, headers: {} });
}

test('an address with a plus logs in', async () => {
  const res = await login('jane+shopping@example.com');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { redirect: '/' });
});
test('case and surrounding spaces are ignored', async () => {
  const res = await login('  Jane+Shopping@Example.com ');
  assert.deepEqual(res.body, { redirect: '/' });
});
test('another plus address of the same mailbox is still rejected', async () => {
  const res = await login('jane+other@example.com');
  assert.match(res.body.error, /Wrong email or password/);
});
test('a wrong password is still rejected', async () => {
  const res = await login('jane+shopping@example.com', 'nope');
  assert.match(res.body.error, /Wrong email or password/);
});
test('an invalid address is still rejected', async () => {
  const res = await login('not-an-email');
  assert.match(res.body.error, /valid email/);
});
test('every login opens a session for the user', async () => {
  getDb().sessions = [];
  await login('jane+shopping@example.com');
  await login('Jane+Shopping@Example.com');
  assert.equal(getDb().sessions.filter((s) => s.userId === 42).length, 2);
});
`,
    },
    check: TEST,
  },
  naive: [
    {
      // Matching the stored address with its tag stripped too: jane+other would log in as jane+shopping.
      file: 'src/models/users.js',
      replace: [
        'u.email.toLowerCase() === email.toLowerCase()',
        "u.email.toLowerCase().replace(/\\+[^@]*@/, '@') === email.toLowerCase().replace(/\\+[^@]*@/, '@')",
      ],
    },
    {
      // Dropping the stripping but also the trim: spaced addresses stop working.
      file: 'src/utils/validate.js',
      replace: [".trim().toLowerCase().replace(/\\+[^@]*@/, '@')", '.toLowerCase()'],
    },
  ],
};
