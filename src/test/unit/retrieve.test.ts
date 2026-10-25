import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { RETRIEVAL_CHARS, namesIndexedFile, rankFiles, retrievalBlock } from '../../code/retrieve';
import type { IndexedFile } from '../../code/repoIndex';

const file = (rel: string, names: string[], idents: string[] = []): IndexedFile => ({
  rel,
  symbols: names.map((name, i) => ({ name, kind: 'function', line: 10 * (i + 1) }) as unknown as IndexedFile['symbols'][number]),
  idents: new Set(idents),
  windows: [],
});

const repo = () => [
  file('src/cart.ts', ['addItem', 'recomputeTotal'], ['addItem', 'recomputeTotal', 'formatPrice']),
  file('src/price.ts', ['formatPrice', 'priceOf'], ['formatPrice', 'priceOf', 'addItem']),
  file('src/auth.ts', ['login', 'logout'], ['login', 'logout']),
  file('src/cartUtils.ts', ['helper'], ['helper']),
];

test('an exact definition name beats a word match', () => {
  const ranked = rankFiles(repo(), 'please fix the login word and then login() on the page');
  assert.equal(ranked[0].rel, 'src/auth.ts');
  assert.deepEqual(ranked[0].symbols.map((s) => s.name), ['login']);
});

test('a file using an identifier the message names gets the one-hop boost', () => {
  const plain = rankFiles(repo(), 'the price shows wrong');
  const withLink = rankFiles(repo(), 'the price shows wrong, addItem is called twice');
  assert.ok(withLink.find((r) => r.rel === 'src/cart.ts')!.score > (plain.find((r) => r.rel === 'src/cart.ts')?.score ?? 0));
  assert.equal(withLink[0].rel, 'src/price.ts');
  // The named addItem is cart.ts's definition: it outranks files that merely share a word.
  assert.equal(withLink[1].rel, 'src/cart.ts');
});

test('recently edited files get a boost', () => {
  const plain = rankFiles(repo(), 'login page');
  const recent = rankFiles(repo(), 'login page', ['src/cart.ts']);
  assert.ok(recent.find((r) => r.rel === 'src/cart.ts')!.score > (plain.find((r) => r.rel === 'src/cart.ts')?.score ?? 0));
});

test('stop words and short words are ignored', () => {
  assert.deepEqual(rankFiles(repo(), 'please could you make this work for the thing with it'), []);
  assert.deepEqual(rankFiles(repo(), ''), []);
});

test('camelCase and snake_case split into message words', () => {
  const ranked = rankFiles([file('src/x.ts', ['format_price'], ['format_price'])], 'format price on the screen');
  assert.equal(ranked[0].rel, 'src/x.ts');
});

test('nothing is returned when the message names a file the index knows', () => {
  const files = repo();
  assert.ok(namesIndexedFile(files, 'fix src/cart.ts please'));
  assert.ok(namesIndexedFile(files, 'look at ./src/price.ts'));
  assert.ok(!namesIndexedFile(files, 'fix the cart total'));
  assert.equal(retrievalBlock(files, 'fix src/cart.ts addItem', []), undefined);
  assert.ok(retrievalBlock(files, 'fix the price', []));
});

test('the block stays within the cap and still lists files', () => {
  const many = Array.from({ length: 40 }, (_, i) => file(`src/mod${i}/cartTotal${i}.ts`, [`cart${i}Total`, `cartTotal${i}More`], ['cartTotal']));
  // Ranked best first, so the first file written is the one in the block.
  const block = retrievalBlock(many, 'cart total wrong', [])!;
  assert.ok(block.length <= RETRIEVAL_CHARS, `${block.length} > ${RETRIEVAL_CHARS}`);
  assert.match(block, /^<likely_relevant>\n/);
  assert.match(block, /src\/mod\d+\/cartTotal\d+\.ts: cart\d+Total L10/);
  assert.ok(retrievalBlock(many, 'cart total wrong', [], 200)!.length <= 200);
});

test('an empty repository gives no block', () => {
  assert.equal(retrievalBlock([], 'fix the cart', []), undefined);
});

test('rankFiles lists at most eight files with definitions', () => {
  const many = Array.from({ length: 20 }, (_, i) => file(`src/cart${i}.ts`, [`cartThing${i}`, `cartHelper${i}`]));
  const ranked = rankFiles(many, 'cart thing is broken');
  assert.equal(ranked.length, 8, 'names no single file uses more than three times, so none is discounted');
  assert.ok(ranked.every((r) => r.symbols.length));
});
