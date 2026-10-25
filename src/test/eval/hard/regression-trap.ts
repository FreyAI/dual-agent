import { HardTask, T, TEST, project } from '../fixture';

// Sorts by day of month only, so 03-31 lands after 04-01. The fix must keep same-day entries in recorded order.
const BUGGY = `// Everything recorded on the given days, as "day count", oldest first.
function entriesInRange(entries, start, end) {
  return entries
    .filter((e) => e.day >= start && e.day <= end)
    .sort((a, b) => Number(a.day.slice(8)) - Number(b.day.slice(8)));
}

module.exports = { entriesInRange };
`;
const FIXED = BUGGY.replace('Number(a.day.slice(8)) - Number(b.day.slice(8))', 'a.day < b.day ? -1 : a.day > b.day ? 1 : 0');

export const hard: HardTask = {
  task: {
    id: 'hard-regression-trap',
    kind: 'bugfix',
    difficulty: 'hard',
    prompt:
      "Our morning report 'changed for no reason' - the calendar is meant to show a range of days in date order, but it comes out jumbled: sometimes an earlier day is listed after a later one. It shows up around the month boundary. Please make the order right, and keep everything that is already right working (same entries, same fields, the input list untouched, and anything recorded on the same day should keep the order it was recorded in).",
    files: project({
      'src/calendar.js': BUGGY,
      'test/calendar.test.js':
        T +
        `const { entriesInRange } = require('../src/calendar');

const log = [
  { day: '2026-03-09', count: 3 },
  { day: '2026-03-09', count: 5 },
  { day: '2026-03-10', count: 2 },
];

test('only the asked days are returned', () => {
  assert.deepEqual(entriesInRange(log, '2026-03-10', '2026-03-10').map((e) => e.count), [2]);
});
test('a day keeps its recorded order', () => {
  assert.deepEqual(entriesInRange(log, '2026-03-09', '2026-03-10').map((e) => e.count), [3, 5, 2]);
});
`,
    }),
    solution: { 'src/calendar.js': FIXED },
    hidden: {
      'test/hidden.calendar.test.js':
        T +
        `const { entriesInRange } = require('../src/calendar');

const make = () => [
  { day: '2026-04-30', count: 1 },
  { day: '2026-03-31', count: 2 },
  { day: '2026-04-01', count: 3 },
  { day: '2026-03-02', count: 4 },
];
const across = make();

test('entries across month boundaries are in date order', () => {
  const r = entriesInRange(across, '2026-01-01', '2026-12-31');
  assert.deepEqual(r.map((e) => e.day), ['2026-03-02', '2026-03-31', '2026-04-01', '2026-04-30']);
});

test('entries sharing a day keep the recorded order', () => {
  const same = [{ day: '2026-05-02', count: 1 }, { day: '2026-05-02', count: 2 }, { day: '2026-05-02', count: 3 }];
  const r = entriesInRange(same, '2026-05-01', '2026-05-03');
  assert.deepEqual(r.map((e) => e.count), [1, 2, 3]);
  assert.deepEqual(Object.keys(r[0]), ['day', 'count']);
});

test('the input array is not modified', () => {
  const mine = make();
  entriesInRange(mine, '2026-01-01', '2026-12-31');
  assert.deepEqual(mine, make());
});

test('the range limits are inclusive', () => {
  const r = entriesInRange(across, '2026-03-31', '2026-04-01');
  assert.deepEqual(r.map((e) => e.day), ['2026-03-31', '2026-04-01']);
  assert.deepEqual(entriesInRange(across, '2026-05-01', '2026-06-01'), []);
});

test('it holds over many days and recordings', () => {
  const many = [];
  for (let d = 28; d <= 31; d++) many.push({ day: '2026-01-' + d, count: d });
  for (let d = 1; d <= 3; d++) many.push({ day: '2026-02-0' + d, count: d });
  for (let i = 0; i < 20; i++) many.push({ day: '2026-02-02', count: i });
  const r = entriesInRange(many, '2026-01-01', '2026-12-31');
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].day <= r[i].day, r.map((e) => e.day).join(','));
  assert.equal(r.length, 27);
  assert.deepEqual(r.filter((e) => e.day === '2026-02-02').map((e) => e.count), [2, ...Array(20).keys()]);
});
`,
    },
    check: TEST,
  },
  naive: [
    // Date order, but equal days compare as "before": same-day entries come out reversed.
    { file: 'src/calendar.js', replace: ['Number(a.day.slice(8)) - Number(b.day.slice(8))', 'a.day <= b.day ? -1 : 1'] },
    // Sorts by day then count as text, so count 10 lands before 2.
    { file: 'src/calendar.js', replace: ['Number(a.day.slice(8)) - Number(b.day.slice(8))', '(a.day + a.count).localeCompare(b.day + b.count)'] },
    // Sorts the caller's array in place.
    { file: 'src/calendar.js', replace: ['return entries\n    .filter((e) => e.day >= start && e.day <= end)\n    .sort((a, b) => Number(a.day.slice(8)) - Number(b.day.slice(8)));', "entries.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));\n  return entries.filter((e) => e.day >= start && e.day <= end);"] },
  ],
};
