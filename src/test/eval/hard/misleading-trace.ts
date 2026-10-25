import { HardTask, T, TEST, project } from '../fixture';

const CONFIG_PKG = `// Configuration shared by the API and the workers.
const defaults = {
  timezone: 'Europe/Berlin',
  locale: 'de-DE',
  pageSize: 20,
  retryDelayMs: 250,
  sessionMinutes: 30,
};

function createConfig(overrides = {}) {
  return { ...defaults, ...overrides };
}

module.exports = { createConfig, defaults };
`;

// The trace points at sessions.js; the cause is its require('../server') cycle (server.js is half loaded then).
const SESSIONS_BUG = `const { config } = require('../server');

// Whole minutes of session time left, never more than a full session.
function sessionsLeft(req) {
  const left = Math.floor((req.resetAt - Date.now()) / 60000);
  return Math.max(0, Math.min(config.sessionMinutes, left));
}

module.exports = { sessionsLeft };
`;

const SESSIONS_FIXED = `// Whole minutes of session time left, never more than a full session.
function sessionsLeft(req, config) {
  const left = Math.floor((req.resetAt - Date.now()) / 60000);
  return Math.max(0, Math.min(config.sessionMinutes, left));
}

module.exports = { sessionsLeft };
`;

const files = project({
  'packages/config/index.js': CONFIG_PKG,
  'src/server.js': `const { createConfig } = require('../packages/config');
const { handleError } = require('./middleware/errors');
const routes = require('./routes/index');

// Settings for the API process.
const config = createConfig({ pageSize: 25 });

// Runs one request: adds the session end, then the route's handler.
function serve(request) {
  const req = { method: request.method, path: request.path, body: request.body || {}, user: request.user || null, headers: request.headers || {}, resetAt: Date.now() + config.sessionMinutes * 60 * 1000 };
  try {
    return routes(req, config);
  } catch (err) {
    return handleError(err);
  }
}

module.exports = { serve, config };
`,
  'src/routes/index.js': `const { home } = require('./home');
const { dueDay } = require('./billing');

// Picks the handler for a path.
function routes(req, config) {
  if (req.path === '/') return home(req, config);
  if (req.path === '/billing/due') return dueDay(req, config);
  return { status: 404, body: 'not found' };
}

module.exports = routes;
`,
  'src/routes/home.js': `const { sessionsLeft } = require('../services/sessions');

// The home page of a logged-in user, with when their session ends.
function home(req, config) {
  if (!req.user) return { status: 302, location: '/login' };
  const left = sessionsLeft(req, config);
  return { status: 200, body: 'Welcome ' + req.user.name + ' (' + left + ' minutes left)' };
}

module.exports = { home };
`,
  'src/routes/billing.js': `const billing = require('../services/billing');

// The day the next invoice is due, in the account's timezone.
function dueDay(req, config) {
  if (!req.user) return { status: 302, location: '/login' };
  return { status: 200, body: billing.nextDueDay(req.user.createdAt, config.timezone) };
}

module.exports = { dueDay };
`,
  'src/services/sessions.js': SESSIONS_BUG,
  'src/services/billing.js': `// The YYYY-MM-DD of an account's next invoice: 30 days after it was created, in local time.
function nextDueDay(createdAt, timeZone) {
  const due = new Date(new Date(createdAt).getTime() + 30 * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(due);
}

module.exports = { nextDueDay };
`,
  'src/middleware/errors.js': `// Turns an error into a response with a safe message.
function handleError(err) {
  const message = /(connection|ECONN|socket|timeout)/i.test(err.message) ? 'Please try again later.' : err.message;
  return { status: 500, body: message };
}

module.exports = { handleError };
`,
  'test/home.test.js': T + `const { serve } = require('../src/server');

test('someone who is not logged in is sent to the login page', () => {
  const res = serve({ method: 'GET', path: '/' });
  assert.equal(res.status, 302);
});
`,
});

export const hard: HardTask = {
  task: {
    id: 'hard-misleading-trace',
    kind: 'bugfix',
    difficulty: 'hard',
    prompt:
      "The home page fails for logged-in users with 'Please try again later'-style errors; in a dev console it shows \"Cannot read properties of undefined (reading 'sessionMinutes')\" with the trace pointing into services/sessions.js. Hitting the home page with a logged-in request reproduces it. Please fix it - the home page should greet the user with the minutes left in their session. Other services share the config package, so don't change its defaults.",
    files,
    solution: { 'src/services/sessions.js': SESSIONS_FIXED },
    hidden: {
      'test/hidden.trace.test.js':
        T +
        `const { createConfig, defaults } = require('../packages/config');
const { serve } = require('../src/server');
const { sessionsLeft } = require('../src/services/sessions');
const { home } = require('../src/routes/home');

const ada = { id: 1, name: 'Ada', createdAt: '2026-01-02T10:00:00Z' };

test('the shared defaults are untouched', () => {
  assert.deepEqual(defaults, { timezone: 'Europe/Berlin', locale: 'de-DE', pageSize: 20, retryDelayMs: 250, sessionMinutes: 30 });
});

test('home greets a logged-in user with the minutes left', () => {
  const res = serve({ method: 'GET', path: '/', user: ada });
  assert.equal(res.status, 200);
  assert.match(res.body, /^Welcome Ada \\(\\d+ minutes left\\)$/);
});

test('a visitor who is not logged in is still sent to login', () => {
  assert.equal(serve({ method: 'GET', path: '/' }).status, 302);
});

test('the minutes come from the request', () => {
  const cfg = createConfig();
  assert.equal(sessionsLeft({ resetAt: Date.now() + 5 * 60000 + 1000 }, cfg), 5);
  assert.equal(sessionsLeft({ resetAt: Date.now() - 60000 }, cfg), 0);
});

test('the session length comes from the config it is given', () => {
  assert.equal(sessionsLeft({ resetAt: Date.now() + 25 * 60000 + 1000 }, { sessionMinutes: 10 }), 10);
  const res = home({ user: ada, resetAt: Date.now() + 25 * 60000 + 1000 }, { sessionMinutes: 10 });
  assert.equal(res.body, 'Welcome Ada (10 minutes left)');
});

test('billing still works', () => {
  const res = serve({ method: 'GET', path: '/billing/due', user: { createdAt: '2026-03-01T23:30:00Z' } });
  assert.equal(res.status, 200);
  assert.match(res.body, /^\\d{4}-\\d{2}-\\d{2}$/);
});
`,
    },
    check: TEST,
  },
  naive: [
    {
      // A local copy of the config: no crash, but the app's own config is ignored.
      file: 'src/services/sessions.js',
      replace: ["const { config } = require('../server');", 'const config = { sessionMinutes: 30 };'],
    },
    {
      // Requiring the server late avoids the cycle but still ignores the config passed in.
      file: 'src/services/sessions.js',
      replace: ['function sessionsLeft(req) {', "function sessionsLeft(req) {\n  const { config } = require('../server');"],
    },
    {
      // Swallowing the crash keeps the page up with a wrong minute count.
      file: 'src/routes/home.js',
      replace: ['const left = sessionsLeft(req, config);', 'let left = 0;\n  try { left = sessionsLeft(req, config); } catch (e) { left = 0; }'],
    },
  ],
};
