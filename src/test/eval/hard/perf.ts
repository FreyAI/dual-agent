import { HardTask, T, TEST, project } from '../fixture';

// Trial division by every smaller number: correct, but far too slow for 400,000.
const SLOW = `// The primes below n, in order.
function primesBelow(n) {
  const out = [];
  for (let i = 2; i < n; i++) {
    let prime = true;
    for (let j = 2; j < i; j++) {
      if (i % j === 0) {
        prime = false;
        break;
      }
    }
    if (prime) out.push(i);
  }
  return out;
}

module.exports = { primesBelow };
`;
const FAST = `// The primes below n, in order (sieve of Eratosthenes).
function primesBelow(n) {
  if (!(n > 2)) return [];
  const composite = new Uint8Array(n);
  const out = [];
  for (let i = 2; i < n; i++) {
    if (composite[i]) continue;
    out.push(i);
    for (let j = i * i; j < n; j += i) composite[j] = 1;
  }
  return out;
}

module.exports = { primesBelow };
`;

export const hard: HardTask = {
  task: {
    id: 'hard-perf',
    kind: 'bugfix',
    difficulty: 'hard',
    prompt:
      'The nightly stats job (src/stats.js) scans primes up to 400,000 and now times out - it used to finish in well under a second. The numbers are right, it is just far too slow. Please make it fast; the output must stay exactly the same.',
    files: project({
      'src/primes.js': SLOW,
      'src/digits.js': `// Sum of the decimal digits of n, or -1 when n is not a whole non-negative number.
function digitSum(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? [...String(n)].reduce((s, d) => s + Number(d), 0) : -1;
}

module.exports = { digitSum };
`,
      'src/stats.js': `const { digitSum } = require('./digits');
const { primesBelow } = require('./primes');

// Primes below limit whose digit sum equals digit, with the count of all primes.
function match(limit, digit) {
  const primes = primesBelow(limit);
  const matches = primes.filter((p) => digitSum(p) === digit);
  return { limit, digit, count: primes.length, matches };
}

module.exports = { match };
`,
      'test/primes.test.js':
        T +
        `const { primesBelow } = require('../src/primes');

test('small lists', () => {
  assert.deepEqual(primesBelow(1), []);
  assert.deepEqual(primesBelow(10), [2, 3, 5, 7]);
  assert.deepEqual(primesBelow(30), [2, 3, 5, 7, 11, 13, 17, 19, 23, 29]);
});
`,
    }),
    solution: { 'src/primes.js': FAST },
    hidden: {
      'test/hidden.perf.test.js':
        T +
        `const { primesBelow } = require('../src/primes');
const { digitSum } = require('../src/digits');
const { match } = require('../src/stats');

test('small lists are exact', () => {
  assert.deepEqual(primesBelow(2), []);
  assert.deepEqual(primesBelow(3), [2]);
  assert.deepEqual(primesBelow(10), [2, 3, 5, 7]);
  assert.deepEqual(primesBelow(100).slice(-3), [83, 89, 97]);
  assert.equal(digitSum(99999), 45);
});

test('primes below 400,000 take well under a second', { timeout: 3000 }, () => {
  const started = Date.now();
  const primes = primesBelow(400000);
  const took = Date.now() - started;
  assert.equal(primes.length, 33860);
  assert.equal(primes[0], 2);
  assert.equal(primes[primes.length - 1], 399989);
  assert.equal(primes.reduce((s, p) => s + digitSum(p), 0), 823164);
  assert.ok(took < 1000, 'took ' + took + 'ms');
});

test('the stats job is exact and quick', { timeout: 3000 }, () => {
  const started = Date.now();
  const r = match(400000, 10);
  const took = Date.now() - started;
  assert.equal(r.count, 33860);
  assert.equal(r.matches.length, 298);
  assert.ok(took < 1000, 'took ' + took + 'ms');
});
`,
    },
    check: TEST,
  },
  naive: [
    // Remembering answers does not speed up the one big call.
    { file: 'src/primes.js', replace: ['function primesBelow(n) {', 'const memo = new Map();\nfunction primesBelow(n) {\n  if (memo.has(n)) return memo.get(n).slice();'] },
    // Only a constant factor: skips the even numbers.
    { file: 'src/primes.js', replace: ['for (let i = 2; i < n; i++) {\n    let prime = true;', 'for (let i = 2; i < n; i++) {\n    if (i > 2 && i % 2 === 0) continue;\n    let prime = true;'] },
  ],
};
