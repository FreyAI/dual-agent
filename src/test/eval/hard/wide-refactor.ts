import { HardTask, T, TEST, project } from '../fixture';

// formatMoney moves to an options object: 10 call sites over 9 files, two of them (tiers, legacy) not written as a plain formatMoney( call.
const tree = (next: boolean): Record<string, string> => {
  const fm = (cents: string, cur: string, name = 'formatMoney') => (next ? `${name}({ cents: ${cents}, currency: ${cur} })` : `${name}(${cents}, ${cur})`);
  return {
    'packages/money/index.js': next
      ? `// Cents to a money string.
function formatMoney({ cents, currency = 'USD' }) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

module.exports = { formatMoney };
`
      : `// Cents to a money string.
function formatMoney(cents, currency, locale) {
  return new Intl.NumberFormat(locale || 'en-US', { style: 'currency', currency: currency || 'USD' }).format(cents / 100);
}

module.exports = { formatMoney };
`,
    'packages/pricing/tiers.js': `const fmt = require('../money').formatMoney;

// When the next discount tier starts, as a money string.
function nextTierSpend(currency) {
  return ${fm('5000', 'currency', 'fmt')};
}

module.exports = { nextTierSpend };
`,
    'legacy/helpers.js': `const money = require('../packages/money');

// A label for a one-off gift (the old web shop still uses this).
const giftLabel = (name, cents) => name + ' ' + money['format' + 'Money'](${next ? "{ cents, currency: 'USD' }" : "cents, 'USD'"});

module.exports = { giftLabel };
`,
    'src/server.js': `const routes = require('./routes');
const { config } = require('./config');

// Runs a route and hands it the request with the config.
function serve(request) {
  const handler = routes[request.path] || (() => 'not found');
  return handler({ ...request, config });
}

module.exports = { serve };
`,
    'src/config.js': `module.exports = { config: { currency: 'EUR' } };
`,
    'src/messages.js': `const { formatMoney } = require('../packages/money');

function welcome(name) {
  return 'Welcome back, ' + name + '! Your first order ships free.';
}

function charged(cents) {
  return 'Your card was charged ' + ${fm('cents', "'USD'")};
}

module.exports = { welcome, charged };
`,
    'src/pricing.js': `const { nextTierSpend } = require('../packages/pricing/tiers');

module.exports = {
  describe: (currency) => 'Save more from ' + nextTierSpend(currency),
};
`,
    'src/routes/index.js': `const dashboard = require('./dashboard');
const checkout = require('./checkout');
const admin = require('./admin');

module.exports = { '/': dashboard.show, '/checkout': checkout.checkout, '/admin/stats': admin.stats };
`,
    'src/routes/dashboard.js': `const { formatMoney } = require('../../packages/money');

function show() {
  return 'Store  Money ' + ${fm('1000', "'USD'")};
}

module.exports = { show };
`,
    'src/routes/checkout.js': `const { formatMoney } = require('../../packages/money');
const format = require('../services/format');
const pricing = require('../pricing');

// The order line, the next tier hint and the shipping fee.
function checkout(req) {
  return format.money(1999, 'USD') + '\\n' + pricing.describe(req.config.currency) + '\\n' + ${fm('500', "'USD'")};
}

module.exports = { checkout };
`,
    'src/routes/admin.js': `const { formatMoney } = require('../../packages/money');

function stats(req) {
  return { revenue: ${fm('123456', 'req.config.currency')}, orders: 12 };
}

module.exports = { stats };
`,
    'src/services/format.js': `const money = require('../../packages/money');

module.exports = {
  money: (cents, currency) => ${fm('cents', 'currency', 'money.formatMoney')},
};
`,
    'src/models/user.js': `const { formatMoney } = require('../../packages/money');

function spending(user) {
  return ${fm('user.spent || 0', "'USD'")};
}

module.exports = { spending };
`,
    'bin/report.js': `const { spending } = require('../src/models/user');
const { welcome } = require('../src/messages');

// A user's welcome line with what they spent.
function report(user) {
  return welcome(user.name) + ' Spent so far: ' + spending(user);
}

module.exports = { report };
`,
    'test/messages.test.js': `const { test } = require('node:test');
const assert = require('node:assert/strict');
const { welcome } = require('../src/messages');

test('welcome names the user', () => {
  assert.equal(welcome('Ada'), 'Welcome back, Ada! Your first order ships free.');
});
`,
  };
};

const start = tree(false);
const done = tree(true);

export const hard: HardTask = {
  task: {
    id: 'hard-wide-refactor',
    kind: 'refactor',
    difficulty: 'hard',
    prompt:
      "We're adding multi-currency support, so pass-by-position money formatting has to go. Change formatMoney(cents, currency, locale) in packages/money/index.js to take one options object: formatMoney({ cents, currency }) - currency stays optional and defaults to USD, and the output must be identical to today. Update every caller in the repo so nothing breaks, including the legacy web shop helper and the pricing tier helper used by the storefront pricing module. Don't change the function's name or any message.",
    files: project(start),
    solution: Object.fromEntries(Object.entries(done).filter(([f, text]) => text !== start[f])),
    hidden: {
      'test/hidden.wide.test.js':
        T +
        `const { formatMoney } = require('../packages/money');
const { nextTierSpend } = require('../packages/pricing/tiers');
const { giftLabel } = require('../legacy/helpers');
const { serve } = require('../src/server');
const { report } = require('../bin/report');
const { charged } = require('../src/messages');
const pricing = require('../src/pricing');

test('formatMoney takes an options object', () => {
  assert.equal(formatMoney({ cents: 1000, currency: 'USD' }), '$10.00');
  assert.equal(formatMoney({ cents: 1999, currency: 'EUR' }), '€19.99');
  assert.equal(formatMoney({ cents: 123456 }), '$1,234.56');
});

test('every route and page behaves exactly as before', () => {
  assert.equal(serve({ path: '/' }), 'Store  Money $10.00');
  assert.equal(serve({ path: '/checkout' }), '$19.99\\nSave more from €50.00\\n$5.00');
  assert.deepEqual(serve({ path: '/admin/stats' }), { revenue: '€1,234.56', orders: 12 });
  assert.match(serve({ path: '/nope' }), /not found/);
});

test('indirect callers work too', () => {
  assert.equal(nextTierSpend('EUR'), '€50.00');
  assert.equal(giftLabel('Mug', 1250), 'Mug $12.50');
  assert.equal(report({ name: 'Ada', spent: 100 }), 'Welcome back, Ada! Your first order ships free. Spent so far: $1.00');
  assert.equal(charged(2500), 'Your card was charged $25.00');
  assert.equal(pricing.describe('USD'), 'Save more from $50.00');
});
`,
    },
    check: TEST,
  },
  naive: [
    // Renames the signature in the defining file only: every caller still passes positions.
    { file: 'packages/money/index.js', replace: ['function formatMoney(cents, currency, locale) {', 'function formatMoney({ cents, currency, locale }) {'] },
    // Fixes one page's caller, leaves the rest.
    { file: 'src/routes/dashboard.js', replace: ["formatMoney(1000, 'USD')", "formatMoney({ cents: 1000, currency: 'USD' })"] },
  ],
};
