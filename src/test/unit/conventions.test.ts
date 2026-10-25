import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { commandsLine, kindOf, loadConventions } from '../../memory/conventions';

const file = (root: string) => path.join(root, '.dual-agent', 'memory', 'conventions.md');
function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-'));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
  return root;
}
const commands = (root: string, recorded: string[] = [], persist = true) =>
  Object.fromEntries(Object.entries(loadConventions(root, recorded, persist)).map(([k, e]) => [k, e.command]));

test('conventions: package.json scripts, with the package manager from the lockfile', () => {
  const scripts = { test: 'node --test', lint: 'eslint .', typecheck: 'tsc --noEmit', build: 'tsc', pretest: 'tsc' };
  const root = project({ 'package.json': JSON.stringify({ scripts }) });
  assert.deepEqual(commands(root), { test: 'npm test', lint: 'npm run lint', typecheck: 'npm run typecheck', build: 'npm run build' });
  assert.match(fs.readFileSync(file(root), 'utf8'), /- test: `npm test` \(package\.json, runs pretest\)/);
  const yarn = project({ 'package.json': JSON.stringify({ scripts: { test: 'jest', compile: 'tsc -p .' } }), 'yarn.lock': '' });
  assert.deepEqual(commands(yarn), { test: 'yarn test', build: 'yarn run compile' });
});

test('conventions: the npm placeholder test script is not a test command', () => {
  const root = project({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
  assert.deepEqual(commands(root), {});
  assert.equal(fs.existsSync(file(root)), false, 'nothing found, nothing written');
});

test('conventions: tsc fallback needs tsconfig and an installed tsc', () => {
  const root = project({ 'package.json': '{}', 'tsconfig.json': '{}' });
  assert.deepEqual(commands(root), {});
  const installed = project({ 'package.json': '{}', 'tsconfig.json': '{}', 'node_modules/.bin/tsc': '' });
  assert.deepEqual(commands(installed), { typecheck: 'npx --no-install tsc --noEmit' });
});

test('conventions: Makefile, Cargo, Python and Go', () => {
  assert.deepEqual(commands(project({ Makefile: 'build:\n\tcc x\ncheck:\n\t./t\nlint:\n\tl\n' })), { test: 'make check', lint: 'make lint', build: 'make build' });
  assert.deepEqual(commands(project({ 'Cargo.toml': '[package]\n' })), { test: 'cargo test', lint: 'cargo clippy', typecheck: 'cargo check' });
  assert.deepEqual(commands(project({ 'go.mod': 'module x\n' })), { test: 'go test ./...', typecheck: 'go vet ./...' });
  const py = project({ 'pyproject.toml': '[tool.pytest.ini_options]\n[tool.ruff]\n[tool.mypy]\n' });
  assert.deepEqual(commands(py), { test: 'pytest', lint: 'ruff check .', typecheck: 'mypy .' });
  assert.deepEqual(commands(project({ 'pyproject.toml': '[project]\nname = "x"\n' })), {}, 'python tools only when configured');
});

test('conventions: package.json wins over a Makefile for the same kind', () => {
  const root = project({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), Makefile: 'test:\n\tx\nbuild:\n\ty\n' });
  assert.deepEqual(commands(root), { test: 'npm test', build: 'make build' });
});

test('conventions: missing and invalid manifests give nothing and do not throw', () => {
  assert.deepEqual(commands(project({})), {});
  assert.deepEqual(commands(project({ 'package.json': '{not json' })), {});
  assert.deepEqual(commands(project({ 'package.json': '{"scripts":"nope"}' })), {});
  assert.deepEqual(commands(project({ 'package.json': '[]' })), {});
  assert.deepEqual(commands('/nonexistent/dir/for/conventions'), {});
});

test('conventions: a hand edit wins; detection fills only what is missing', () => {
  const root = project({ 'package.json': JSON.stringify({ scripts: { test: 'jest', lint: 'eslint .' } }) });
  commands(root);
  const text = fs.readFileSync(file(root), 'utf8').replace('`npm test`', '`npm run test:fast`').replace(/^- lint:.*\n/m, '');
  fs.writeFileSync(file(root), text);
  // A manifest change reruns detection.
  const pkg = path.join(root, 'package.json');
  fs.writeFileSync(pkg, JSON.stringify({ scripts: { test: 'jest', lint: 'eslint .', build: 'tsc' } }));
  fs.utimesSync(pkg, new Date(), new Date(Date.now() + 5000));
  assert.deepEqual(commands(root), { test: 'npm run test:fast', lint: 'npm run lint', build: 'npm run build' });
  assert.match(fs.readFileSync(file(root), 'utf8'), /- test: `npm run test:fast`/);
});

test('conventions: "none" switches a kind off; a damaged comment treats every line as an edit', () => {
  const root = project({ 'package.json': JSON.stringify({ scripts: { test: 'jest', lint: 'eslint .' } }) });
  commands(root);
  fs.writeFileSync(file(root), fs.readFileSync(file(root), 'utf8').replace('`npm run lint`', 'none'));
  const pkg = path.join(root, 'package.json');
  fs.utimesSync(pkg, new Date(), new Date(Date.now() + 5000));
  assert.deepEqual(commands(root), { test: 'npm test' });
  const broken = fs.readFileSync(file(root), 'utf8').replace(/<!-- detected:.*-->/, '<!-- detected: {oops -->').replace('`npm test`', '`make t`');
  fs.writeFileSync(file(root), broken);
  assert.deepEqual(commands(root), { test: 'make t' });
});

test('conventions: unchanged manifests reuse the file without rewriting it', () => {
  const root = project({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) });
  commands(root);
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(file(root), past, past);
  commands(root);
  assert.equal(Math.round(fs.statSync(file(root)).mtimeMs / 1000), Math.round(past.getTime() / 1000));
});

test('conventions: recorded commands fill only kinds no manifest names, newest first', () => {
  const root = project({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) });
  const got = commands(root, ['npm run check-all', 'pytest -q', 'make -j4 build', 'swift build', 'echo hi']);
  assert.equal(got.test, 'npm test', 'the manifest wins');
  assert.equal(got.build, 'make -j4 build', 'the newest recorded build');
  assert.equal(kindOf('echo hi'), undefined);
  assert.equal(kindOf('cargo clippy -- -D warnings'), 'lint');
  assert.equal(kindOf('npx tsc --noEmit -p .'), 'typecheck');
});

test('conventions: persist false reads but never writes', () => {
  const root = project({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) });
  assert.deepEqual(commands(root, [], false), { test: 'npm test' });
  assert.equal(fs.existsSync(path.join(root, '.dual-agent')), false);
});

test('conventions: the primer line is compact', () => {
  assert.equal(commandsLine({}), undefined);
  const long = 'x'.repeat(200);
  const line = commandsLine({ test: { command: long, source: 's' }, lint: { command: 'l', source: 's' }, typecheck: { command: 't', source: 's' }, build: { command: long, source: 's' } })!;
  assert.ok(line.length < 300, String(line.length));
  assert.match(line, /^Project commands: test `x+…`; typecheck `t`; lint `l`; build /);
});
