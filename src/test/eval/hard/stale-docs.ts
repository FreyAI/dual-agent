import { HardTask, T, TEST, project } from '../fixture';

const SLUG = `// Slugs for URLs: lowercase words joined by dashes.
function slugify(title) {
  return String(title)
    .normalize('NFKD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = { slugify };
`;
// Long slugs are cut at the last dash within 40 characters; a single long word stays whole.
const SLUG_FIXED = SLUG.replace(
  "    .replace(/^-+|-+$/g, '');\n}",
  "    .replace(/^-+|-+$/g, '');\n  const cut = s.length > 40 ? s.lastIndexOf('-', 40) : -1;\n  return cut > 0 ? s.slice(0, cut) : s;\n}",
).replace('  return String(title)', '  const s = String(title)');
const README = (example: string, rule: string) => `# Slugify

Turns titles into URL slugs.

${rule}

    slug('The Quick Brown Fox Jumps Over The Lazy Dog') // => '${example}'
`;
const README_STALE = README('the-quick-brown-fox-jumps-over-th-', 'Long titles are cut to 32 characters and a dash is added at the cut:');
const README_FIXED = README('the-quick-brown-fox-jumps-over-the-lazy', 'Long titles are cut at a word boundary, at most 40 characters, with no trailing dash:');

export const hard: HardTask = {
  task: {
    id: 'hard-stale-docs',
    kind: 'bugfix',
    difficulty: 'hard',
    prompt:
      "Our slug helper doesn't match what the tests expect for long titles, and the README describes different behaviour from the tests. Make the code match what the tests expect: a slug longer than 40 characters is cut at the last dash within the first 40, with no trailing dash, and a slug with no dash to cut at (one long word) stays whole. Then update README.md so its rule and its example are right, the example showing the real output for that title.",
    files: project({
      'README.md': README_STALE,
      'src/slug.js': SLUG,
      'test/slug.test.js':
        T +
        `const { slugify } = require('../src/slug');

test('makes an ascii slug', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
});
test('strips accents', () => {
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee');
});
test('a long title is cut at a word boundary without a trailing dash', () => {
  assert.equal(slugify('The Quick Brown Fox Jumps Over The Lazy Dog And Keeps Running'), 'the-quick-brown-fox-jumps-over-the-lazy');
});
`,
    }),
    solution: { 'src/slug.js': SLUG_FIXED, 'README.md': README_FIXED },
    hidden: {
      'test/hidden.slug.test.js':
        T +
        `const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { slugify } = require('../src/slug');

const long = 'The Quick Brown Fox Jumps Over The Lazy Dog';

test('long titles are cut at a word boundary', () => {
  assert.equal(slugify(long), 'the-quick-brown-fox-jumps-over-the-lazy');
  assert.equal(slugify('Café au lait ' + 'x'.repeat(40)), 'cafe-au-lait');
  assert.ok(slugify('word '.repeat(20)).length <= 40);
  assert.ok(!slugify('word '.repeat(20)).endsWith('-'));
});

test('a single long word and short titles are untouched', () => {
  assert.equal(slugify('abcdefghijklmnopqrstuvwxyz0123456789abcdef'), 'abcdefghijklmnopqrstuvwxyz0123456789abcdef');
  assert.equal(slugify('  Hello -- World  '), 'hello-world');
});

test('the README shows the real output', () => {
  const text = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
  assert.ok(text.includes(long) && text.includes("'" + slugify(long) + "'"), 'README example is not the real output');
  assert.ok(!/32 characters|-th-/.test(text), 'README still describes the old rule');
});
`,
    },
    check: TEST,
  },
  naive: [
    // Implements the README's rule (cut to 32 characters plus a dash) instead of the tests'.
    { file: 'src/slug.js', replace: ["    .replace(/^-+|-+$/g, '');", "    .replace(/^-+|-+$/g, '')\n    .replace(/^(.{32}).+$/, '$1-');"] },
    // Fixes the code only; the README stays stale.
    { file: 'src/slug.js', replace: ["    .replace(/^-+|-+$/g, '');\n}", "    .replace(/^-+|-+$/g, '')\n    .replace(/^(.{0,40})(-.*)?$/, '$1');\n}"] },
    // Updates the README only; the code still does not cut.
    { file: 'README.md', replace: ["Long titles are cut to 32 characters and a dash is added at the cut:", "Long titles are cut at a word boundary, at most 40 characters, with no trailing dash:"] },
  ],
};
