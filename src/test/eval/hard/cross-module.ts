import { HardTask, T, TEST, project } from '../fixture';

// One flag (urgent = priority 9 or 10) through settings, schema, model, storage, list formatting and the CLI.
const notes = (on: boolean): Record<string, string> => ({
  'cli.js': `const store = require('./lib/store');
const { list } = require('./lib/items');
${on ? "\n// Anything but true/false is passed on as is, so validation rejects it.\nconst flag = (s) => (s === 'true' ? true : s === 'false' ? false : s);\n" : ''}
// node cli.js add <title> [priority=3]${on ? ' [urgent]' : ''}   |   node cli.js list${on ? ' [urgent]' : ''}
function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'list') return list(store.all()${on ? ', rest[0]' : ''});
  if (cmd === 'add' && rest[0]) return store.add(rest[0], Number(rest[1] || 3)${on ? ', rest[2] === undefined ? undefined : flag(rest[2])' : ''});
  return 'usage: add <title> [priority]${on ? ' [urgent]' : ''} | list${on ? ' [urgent]' : ''}';
}

// The CLI's printed output; errors print as a message.
function run(argv) {
  try {
    const out = main(argv);
    return typeof out === 'string' ? out : JSON.stringify(out);
  } catch (err) {
    return 'error: ' + err.message;
  }
}

module.exports = { run };
`,
  'lib/settings.js': on
    ? `const urgentAt = 9;

module.exports = { maxTitle: 80, urgentAt, isUrgent: (priority) => priority >= urgentAt };
`
    : `module.exports = { maxTitle: 80 };
`,
  'lib/schema.js': `const { maxTitle } = require('./settings');

// Rejects items that do not fit the schema.
function checkItem(item) {
  if (!item || typeof item.title !== 'string' || !item.title.trim()) throw new Error('title is required');
  if (item.title.length > maxTitle) throw new Error('title is too long');
  if (!Number.isInteger(item.priority) || item.priority < 1 || item.priority > 10) throw new Error('priority must be 1-10');${
    on ? "\n  if (item.urgent !== undefined && typeof item.urgent !== 'boolean') throw new Error('urgent must be true or false');" : ''
  }
}

module.exports = { checkItem };
`,
  'lib/model.js': on
    ? `const { checkItem } = require('./schema');
const { isUrgent } = require('./settings');

// A normalised to-do item. A given urgent flag is validated, but the priority decides.
function makeItem(input, id) {
  const item = { id, title: input.title.trim(), priority: input.priority, done: false, urgent: input.urgent };
  checkItem(item);
  item.urgent = isUrgent(item.priority);
  return item;
}

module.exports = { makeItem };
`
    : `const { checkItem } = require('./schema');

// A normalised to-do item.
function makeItem(input, id) {
  const item = { id, title: input.title.trim(), priority: input.priority, done: false };
  checkItem(item);
  return item;
}

module.exports = { makeItem };
`,
  'lib/store.js': `const { makeItem } = require('./model');
const { checkItem } = require('./schema');
${on ? "const { isUrgent } = require('./settings');\n" : ''}
let items = [];
let nextId = 1;

function add(title, priority${on ? ', urgent' : ''}) {
  const item = makeItem({ title, priority${on ? ', urgent' : ''} }, nextId++);
  items.push(item);
  return item;
}

// Turns decoded JSON back into checked items.
function fromJSON(list) {
  return list.map((raw) => {
    const item = ${on ? '{ ...raw, urgent: isUrgent(raw.priority) }' : 'raw'};
    checkItem(item);
    return item;
  });
}

// Writes items out for storage.
function toJSON() {
  return JSON.stringify(items, null, 2);
}

const all = () => items;

function reset(saved = []) {
  items = fromJSON(saved);
  nextId = items.reduce((m, i) => Math.max(m, i.id), 0) + 1;
}

module.exports = { add, all, toJSON, fromJSON, reset };
`,
  'lib/items.js': on
    ? `const { isUrgent } = require('./settings');

// One line per item: a check mark or the urgent tag, the priority and the title.
function line(item) {
  const urgent = !item.done && isUrgent(item.priority);
  return (item.done ? '[x]' : urgent ? '[!]' : '[ ]') + ' ' + item.priority + ' ' + item.title + (urgent ? ' (urgent)' : '');
}

function list(items, only) {
  return items.filter((i) => only !== 'urgent' || isUrgent(i.priority)).map(line).join('\\n');
}

module.exports = { line, list };
`
    : `// One line per item: a check mark, the priority and the title.
function line(item) {
  return (item.done ? '[x]' : '[ ]') + ' ' + item.priority + ' ' + item.title;
}

function list(items) {
  return items.map(line).join('\\n');
}

module.exports = { line, list };
`,
  'test/store.test.js': `const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../lib/store');

test('adds items with increasing ids', () => {
  store.reset([]);
  assert.equal(store.add('milk', 3).id, 1);
  assert.equal(store.add('eggs', 4).id, 2);
});
`,
});

const start = notes(false);
const done = notes(true);

export const hard: HardTask = {
  task: {
    id: 'hard-cross-module',
    kind: 'feature',
    difficulty: 'hard',
    prompt:
      "Add an 'urgent' flag to our to-do app that runs across every layer. Rule: an item is urgent when its priority is 9 or 10, and never otherwise. What I expect: every item carries an `urgent` boolean (true or false) after it is read back from storage, not just after adding; `node cli.js list` marks urgent items (their line says '(urgent)') and `list urgent` shows only the urgent ones; and an urgent value given on the CLI as a third argument to `add` must go through the same validation as priority, so a bad value is rejected with an error and nothing is added. Keep the existing priority 1-10 validation and the title limit.",
    files: project(start),
    solution: Object.fromEntries(Object.entries(done).filter(([f, text]) => text !== start[f])),
    hidden: {
      'test/hidden.feature.test.js':
        T +
        `const { run } = require('../cli');
const store = require('../lib/store');
const { makeItem } = require('../lib/model');
const { checkItem } = require('../lib/schema');
const { line } = require('../lib/items');

test('the model carries the flag', () => {
  assert.deepEqual(makeItem({ title: ' x ', priority: 2 }, 5), { id: 5, title: 'x', priority: 2, done: false, urgent: false });
  assert.equal(makeItem({ title: 'x', priority: 10 }, 6).urgent, true);
});

test('reading from storage derives the flag', () => {
  store.reset([{ id: 1, title: 'a', priority: 10, done: false, urgent: false }, { id: 2, title: 'b', priority: 3, done: false }]);
  assert.deepEqual(store.all().map((i) => i.urgent), [true, false]);
  store.reset([{ id: 3, title: 'c', priority: 5, done: true }]);
  assert.equal(store.all()[0].urgent, false);
});

test('serialised items keep the flag', () => {
  store.reset([]);
  store.add('a', 1);
  store.add('b', 10);
  store.reset(JSON.parse(store.toJSON()));
  assert.deepEqual(store.all().map((i) => i.urgent), [false, true]);
  assert.equal(store.all()[1].id, 2);
});

test('the list marks urgent items', () => {
  // Items as storage gives them back (urgent included), so a line may read either field.
  assert.match(line({ title: 'x', priority: 9, done: false, urgent: true }), /\\(urgent\\)/);
  assert.doesNotMatch(line({ title: 'x', priority: 8, done: false, urgent: false }), /\\(urgent\\)/);
  assert.doesNotMatch(line({ title: 'x', priority: 1, done: true, urgent: false }), /\\(urgent\\)/);
});

test('the CLI adds, lists and filters urgent items', () => {
  store.reset([]);
  run(['add', 'milk', '2']);
  run(['add', 'ship release', '9']);
  assert.match(run(['list']), /milk/);
  assert.match(run(['list']), /ship release.*\\(urgent\\)/);
  const urgent = run(['list', 'urgent']);
  assert.match(urgent, /ship release/);
  assert.doesNotMatch(urgent, /milk/);
});

test('urgent is validated and bad values are rejected', () => {
  assert.throws(() => checkItem({ title: 'x', priority: 2, urgent: 'yes' }), /urgent/);
  checkItem({ title: 'x', priority: 9, urgent: true });
  checkItem({ title: 'x', priority: 2, urgent: false });
  assert.throws(() => checkItem({ title: 'x', priority: 11 }), /priority must be 1-10/);
  assert.throws(() => checkItem({ title: 'y'.repeat(81), priority: 2 }), /too long/);
  store.reset([]);
  assert.match(run(['add', 'x', '4', 'maybe']), /urgent/);
  assert.equal(store.all().length, 0);
});
`,
    },
    check: TEST,
  },
  naive: [
    // Flag only on new items: nothing derives it when items are read back, and the list and CLI know nothing of it.
    { file: 'lib/model.js', replace: ['done: false };', 'done: false, urgent: input.priority >= 9 };'] },
    // Only the list line is marked: no flag on items, no filter, no validation.
    { file: 'lib/items.js', replace: ["' ' + item.title;", "' ' + item.title + (item.priority >= 9 ? ' (urgent)' : '');"] },
  ],
};
