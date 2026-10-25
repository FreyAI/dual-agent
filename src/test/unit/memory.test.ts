import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { commandCore, confirmNotes, findNotes, helperBrief, loadHandoff, memoryDir, memoryPrimer, MemoryNote, notesForFile, pruneNotes, recordCommand, saveHandoff, upsertNote } from '../../memory/memory';
import { readText, readTextOrUndefined } from '../../memory/files';

const workspace = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-memory-'));
const note = (title: string, body: string, updated: string, files: string[] = []): MemoryNote => ({ title, body, files, updated });
const notesFile = (root: string) => fs.readFileSync(path.join(memoryDir(root), 'notes.md'), 'utf8');
const titles = (root: string) => [...notesFile(root).matchAll(/^## (.*)$/gm)].map((m) => m[1]);

test('memory: missing files read as empty, and the folder is git-ignored once written', () => {
  const root = workspace();
  assert.equal(loadHandoff(root), undefined);
  assert.equal(memoryPrimer(root), undefined);
  assert.equal(pruneNotes(root), 0);
  assert.ok(!fs.existsSync(memoryDir(root)), 'reading creates nothing');
  saveHandoff(root, 'Working on login.');
  assert.equal(memoryDir(root), path.join(root, '.dual-agent', 'memory'));
  assert.match(fs.readFileSync(path.join(root, '.dual-agent', '.gitignore'), 'utf8'), /^\*$/m);
  assert.deepEqual(fs.readdirSync(memoryDir(root)), ['handoff.md'], 'no temporary file left behind');
});

test('memory: handoffs round trip newest first, capped, with control characters stripped', () => {
  const root = workspace();
  saveHandoff(root, 'First\u0007 session.\r\n## not a section', new Date('2026-10-01T00:00:00Z'));
  saveHandoff(root, 'Second session.', new Date('2026-10-02T00:00:00Z'));
  const text = loadHandoff(root) ?? '';
  assert.ok(text.indexOf('Second session.') < text.indexOf('First session.'), text);
  assert.match(text, /^## 2026-10-02T00:00:00.000Z\nSecond session\./);
  assert.match(text, /### not a section/, 'a body line cannot start a new section');
  assert.ok(!/[\u0007\r]/.test(text));

  for (let i = 0; i < 20; i++) {
    saveHandoff(root, `Session ${i}: ${'x'.repeat(400)}`, new Date(Date.UTC(2026, 9, 3, i)));
  }
  const capped = fs.readFileSync(path.join(memoryDir(root), 'handoff.md'), 'utf8');
  assert.ok(capped.length <= 4096, String(capped.length));
  assert.match(capped, /Session 19:/, 'the newest is kept');
  assert.doesNotMatch(capped, /Session 0:|First session/, 'the oldest are dropped');

  saveHandoff(root, 'y'.repeat(10_000));
  const huge = fs.readFileSync(path.join(memoryDir(root), 'handoff.md'), 'utf8');
  assert.ok(huge.length <= 4096 && huge.includes('yyy…'), 'one summary over the cap is cut');
});

test('memory: notes merge by title, dedupe by body, and keep metadata', () => {
  const root = workspace();
  upsertNote(root, note('Build', 'Run make install on every machine.', '2026-10-01', ['Makefile', 'Makefile', '']));
  upsertNote(root, note('Tests', 'node --test out/test/unit/', '2026-10-02'));
  upsertNote(root, note('  build ', 'Use make install-all now.', '2026-10-03', ['Makefile']));
  upsertNote(root, note('Unit tests', 'node --test out/test/unit/', '2026-10-04'));
  upsertNote(root, note('', 'no title', '2026-10-04'));
  upsertNote(root, note('## Ctrl\u0000 title\nsplit', 'Body', 'not a date'));
  const text = notesFile(root);
  assert.deepEqual(titles(root).slice(1), ['Unit tests', 'build']);
  assert.match(titles(root)[0], /^Ctrl title split$/);
  assert.match(text, /## build\nUpdated: 2026-10-03\nFiles: Makefile\nVerified: 20[^\n]+\n\nUse make install-all now\./, 'written by the main agent: checked now');
  assert.doesNotMatch(text, /make install on every/);
  assert.match(text, new RegExp(`Updated: ${new Date().toISOString().slice(0, 10)}`), 'a missing date becomes today');
});

test('memory: notes are capped by dropping the oldest', () => {
  const root = workspace();
  for (let i = 0; i < 140; i++) {
    upsertNote(root, note(`Note ${String(i).padStart(3, '0')}`, `${'detail '.repeat(40)}${i}`, `2026-09-${String((i % 28) + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00Z`));
  }
  const text = notesFile(root);
  assert.ok(text.length <= 32_768, String(text.length));
  assert.ok(titles(root).includes('Note 139'), 'the newest stays');
  assert.ok(!titles(root).includes('Note 000'), 'the oldest went');
  upsertNote(root, note('Huge', 'z'.repeat(40_000), '2026-12-01'));
  assert.ok(notesFile(root).length <= 32_768);
  assert.deepEqual(titles(root), ['Huge'], 'a note over the cap alone is cut and kept');
});

test('memory: pruning drops stale notes whose files are all gone and forgets deleted files', () => {
  const root = workspace();
  const now = new Date('2026-10-20T00:00:00Z');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/a.ts'), '');
  upsertNote(root, note('Gone', 'About b.', '2026-10-01', ['src/b.ts']));
  upsertNote(root, note('Mixed', 'About a and c.', '2026-10-02', ['src/a.ts', 'src/c.ts']));
  upsertNote(root, note('General', 'No files.', '2026-10-03'));
  upsertNote(root, note('Other branch', 'About d.', '2026-10-15', ['src/d.ts']));
  assert.equal(pruneNotes(root, now), 1);
  assert.deepEqual(titles(root), ['Other branch', 'General', 'Mixed'], 'a recent note about missing files is kept');
  assert.match(notesFile(root), /Files: src\/a\.ts\n/);
  assert.match(notesFile(root), /Files: src\/d\.ts\n/);
  assert.match(memoryPrimer(root) ?? '', /- Other branch: About d\. \(src\/d\.ts\) \(files missing\)/);
  assert.equal(pruneNotes(root, now), 0);
});

test('memory: a read error other than a missing file is not mistaken for an empty file', () => {
  const root = workspace();
  fs.mkdirSync(path.join(memoryDir(root), 'notes.md'), { recursive: true });
  assert.throws(() => readText(path.join(memoryDir(root), 'notes.md')), /EISDIR/);
  assert.equal(readTextOrUndefined(path.join(memoryDir(root), 'notes.md')), undefined);
  assert.equal(readText(path.join(root, 'missing.md')), undefined);
  assert.throws(() => upsertNote(root, note('New', 'Body', '2026-10-05')), /EISDIR/, 'nothing is rewritten from a failed read');
  assert.equal(memoryPrimer(root), undefined, 'display reads stay lenient');
  assert.match(findNotes(root), /No notes yet/);
});

test('memory: the primer fits its budget, lists the notes and points to the handoff without sending it', () => {
  const root = workspace();
  saveHandoff(root, `Refactoring the controller. ${'More context. '.repeat(300)}`);
  assert.match(memoryPrimer(root) ?? '', /Summaries of recent sessions are in \.dual-agent\/memory\/handoff\.md/, 'a handoff alone still gets the pointer');
  for (let i = 0; i < 30; i++) {
    upsertNote(root, note(`Topic ${i}`, `First line ${i}\nSecond line`, `2026-10-${String(i + 1).padStart(2, '0')}`, ['src/x.ts']));
  }
  const primer = memoryPrimer(root) ?? '';
  assert.ok(primer.length <= 1600, String(primer.length));
  assert.match(primer, /handoff\.md; read it only when the request continues earlier work/);
  assert.doesNotMatch(primer, /Refactoring the controller|More context/, 'the handoff text is not sent');
  assert.match(primer, /- Topic 29: First line 29 \(src\/x\.ts\)/);
  assert.doesNotMatch(primer, /Second line/);
  const small = memoryPrimer(root, 600) ?? '';
  assert.ok(small.length <= 600 && small.includes('Topic 29'), small);
});

test('memory: corrupt files are read leniently and never throw', () => {
  const root = workspace();
  fs.mkdirSync(memoryDir(root), { recursive: true });
  fs.writeFileSync(path.join(memoryDir(root), 'notes.md'), '\u0000\u0001garbage\n## Kept\nno metadata here\n##\n## \n');
  fs.writeFileSync(path.join(memoryDir(root), 'handoff.md'), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
  assert.equal(loadHandoff(root), undefined);
  assert.match(memoryPrimer(root) ?? '', /- Kept: no metadata here/);
  upsertNote(root, note('New', 'Body', '2026-10-05'));
  assert.deepEqual(titles(root), ['New', 'Kept']);
  fs.writeFileSync(path.join(memoryDir(root), 'notes.md'), 'x'.repeat(300 * 1024));
  assert.equal(memoryPrimer(root), undefined, 'an oversized file is ignored');
});

test('memory: agents find notes by words in the title, body or files', () => {
  const root = workspace();
  assert.match(findNotes(root), /No notes yet/);
  upsertNote(root, note('Payment retries', 'Backoff lives in retry.ts; max 5 attempts.', '2026-10-01', ['src/pay/retry.ts']));
  upsertNote(root, note('Build', 'npm run build, then npm test.', '2026-10-02'));
  assert.match(findNotes(root, 'retry backoff'), /## Payment retries/);
  assert.match(findNotes(root, 'src/pay'), /Payment retries/);
  assert.doesNotMatch(findNotes(root, 'build'), /Payment/);
  assert.match(findNotes(root, 'kafka'), /No notes about "kafka"/);
  assert.ok(findNotes(root, '', 60).includes('more; narrow the query'), 'capped to the budget');
});

test('memory: a helper\'s note waits for its report, and a helper never replaces or drops another note', () => {
  const root = workspace();
  upsertNote(root, { ...note('Build', 'make install', '2026-10-21'), kind: 'command' });
  assert.equal(upsertNote(root, { ...note('build', 'rm -rf / then make', '2026-10-21'), by: 'helper', pending: 'h1' }), 'kept', 'the title is taken');
  assert.equal(upsertNote(root, { ...note('Copy', 'make install', '2026-10-21'), by: 'helper', pending: 'h1' }), 'saved');
  assert.deepEqual(titles(root).sort(), ['Build', 'Copy'], 'a helper repeating a body does not drop the original');
  assert.equal(upsertNote(root, { ...note('Copy', 'make install-all', '2026-10-21'), by: 'helper', pending: 'h1' }), 'saved', 'a helper may revise its own proposal');
  assert.doesNotMatch(memoryPrimer(root) ?? '', /Copy/, 'proposals are not injected');
  assert.match(findNotes(root, 'copy'), /\(a proposal, not confirmed yet\)/);
  assert.equal(confirmNotes(root, 'other'), 0);
  assert.equal(confirmNotes(root, 'h1'), 1);
  assert.match(memoryPrimer(root) ?? '', /- Copy: make install-all/);
  assert.doesNotMatch(findNotes(root, 'copy'), /a proposal/);
});

test('memory: commands that succeed are recorded once a day, without their output plumbing, newest kept', () => {
  const root = workspace();
  assert.deepEqual(commandCore('cd android && ./gradlew :app:testDebugUnitTest 2>&1 | tail -30'), { run: './gradlew :app:testDebugUnitTest', dir: 'android' });
  assert.deepEqual(commandCore('npm test'), { run: 'npm test', dir: undefined });
  const day = new Date('2026-10-21T10:00:00Z');
  assert.ok(recordCommand(root, 'cd android && ./gradlew :app:testDebugUnitTest 2>&1 | tail -30', day));
  assert.ok(!recordCommand(root, 'cd android && ./gradlew :app:testDebugUnitTest', new Date('2026-10-21T15:00:00Z')), 'once a day is enough');
  assert.ok(!recordCommand(root, `cd ${path.dirname(root)} && make test`, day), 'another repo\'s command is not this repo\'s');
  assert.match(notesFile(root), /## Command: \.\/gradlew :app:testDebugUnitTest \(in android\)\nUpdated: 2026-10-21\nKind: command\nBy: auto\nVerified: 2026-10-21T10:00:00\.000Z\n\n`cd android && \.\/gradlew :app:testDebugUnitTest` succeeded on 2026-10-21\./);
  for (let i = 0; i < 14; i++) {
    recordCommand(root, `make test-${i}`, new Date(Date.UTC(2026, 9, 1 + i)));
  }
  const commands = titles(root).filter((t) => t.startsWith('Command:'));
  assert.equal(commands.length, 12);
  assert.ok(commands.includes('Command: ./gradlew :app:testDebugUnitTest (in android)'), 'the newest success stays');
  assert.ok(!commands.includes('Command: make test-0'), 'the oldest went');
});

test('memory: helpers get a short, fixed brief of confirmed commands and gotchas, and nothing else', () => {
  const root = workspace();
  assert.equal(helperBrief(root), undefined);
  upsertNote(root, note('How the controller flows', 'Turn, then result, then usage.', '2026-10-21'));
  assert.equal(helperBrief(root), undefined, 'overviews are not in it');
  recordCommand(root, 'npm run compile', new Date('2026-10-21T10:00:00Z'));
  upsertNote(root, { ...note('Gradle lock', 'Two Gradle runs at once block on .gradle; run one at a time.', '2026-10-21', ['android/build.gradle']), kind: 'gotcha' });
  upsertNote(root, { ...note('Unchecked', 'Something a helper thinks.', '2026-10-21'), kind: 'gotcha', by: 'helper', pending: 'h9' });
  fs.mkdirSync(path.join(root, 'android'));
  fs.writeFileSync(path.join(root, 'android/build.gradle'), '');
  const brief = helperBrief(root) ?? '';
  assert.match(brief, /Build and test commands that succeeded here:\n- `npm run compile` succeeded on 2026-10-21/);
  assert.match(brief, /Gotchas:\n- Gradle lock: Two Gradle runs at once block on \.gradle; run one at a time\. \(android\/build\.gradle\)/);
  assert.doesNotMatch(brief, /Unchecked|controller flows/);
  assert.equal(helperBrief(root), brief, 'the same bytes every time, so it stays cached');
  for (let i = 0; i < 60; i++) {
    upsertNote(root, { ...note(`Gotcha ${i}`, 'x'.repeat(150), '2026-10-21'), kind: 'gotcha' });
  }
  assert.ok((helperBrief(root) ?? '').length <= 2000);
});

test('memory: notes say when their files changed since they were checked, and reading one marks it used', () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, 'src'));
  const file = path.join(root, 'src/a.ts');
  fs.writeFileSync(file, 'x'.repeat(10_000));
  const checked = new Date(Date.now() - 3_600_000);
  upsertNote(root, { ...note('A', 'a.ts keeps the cache key.', '2026-10-21', ['src/a.ts']), verified: checked.toISOString() });
  fs.utimesSync(file, new Date(), new Date());
  assert.match(findNotes(root, 'cache'), /\(its files changed since it was checked: read them before relying on it; if it no longer holds, save the correction with notes_add or say so in your report\)/);
  assert.match(memoryPrimer(root) ?? '', /- A: .* \(src\/a\.ts\) \(files changed since\)/);
  assert.match(notesFor(root), /Uses: 1/, 'counted as used');
  assert.match(notesFor(root), new RegExp(`Verified: ${checked.toISOString().replace(/\./g, '\\.')}`), 'changed files: not re-checked by reading');
  fs.utimesSync(file, checked, new Date(checked.getTime() - 1000));
  findNotes(root, 'cache');
  assert.match(notesFor(root), /Uses: 2/);
  assert.doesNotMatch(notesFor(root), new RegExp(`Verified: ${checked.toISOString().replace(/\./g, '\\.')}`), 'unchanged files: checked again');
  assert.match(notesForFile(root, 'src/a.ts') ?? '', /^Project notes about src\/a\.ts:\n- A: a\.ts keeps the cache key\./);
  assert.equal(notesForFile(root, 'src/b.ts'), undefined);
});
const notesFor = (root: string) => notesFile(root);

test('memory: unused notes move to the archive; unconfirmed proposals expire', () => {
  const root = workspace();
  const now = new Date('2026-12-01T00:00:00Z');
  upsertNote(root, { ...note('Old', 'Nobody read this.', '2026-10-01'), verified: '2026-10-01T00:00:00Z' }, new Date('2026-10-01T00:00:00Z'));
  upsertNote(root, { ...note('Fresh', 'Read last week.', '2026-11-20'), verified: '2026-11-25T00:00:00Z' }, new Date('2026-11-20T00:00:00Z'));
  upsertNote(root, { ...note('Proposal', 'From a helper.', '2026-11-20'), by: 'helper', pending: 'h2' });
  assert.equal(pruneNotes(root, now), 2);
  assert.deepEqual(titles(root), ['Fresh']);
  const archive = fs.readFileSync(path.join(memoryDir(root), 'notes-archive.md'), 'utf8');
  assert.match(archive, /^# Archived project notes/);
  assert.match(archive, /## Old\n/);
  assert.doesNotMatch(archive, /Proposal/, 'an unconfirmed proposal is dropped, not archived');
  assert.doesNotMatch(findNotes(root, 'nobody'), /Old/, 'archived notes are not searched');
});

test('memory: fixes from the audit: no keys in commands, old notes get a grace period, overflow is archived, commands stay out of the primer', () => {
  const root = workspace();
  const day = new Date('2026-10-21T10:00:00Z');
  assert.ok(!recordCommand(root, 'DEEPSEEK_API_KEY=abc123 npm test', day), 'a secret assignment is never stored');
  assert.ok(!recordCommand(root, 'curl -H "Authorization: Bearer abcdefghijklmnop1234" localhost && npm test', day)); // gitleaks:allow (fake token)
  assert.ok(recordCommand(root, 'npm test', day));
  upsertNote(root, note('Decision', 'Retries stay at 3.', '2026-10-21'));
  const primer = memoryPrimer(root) ?? '';
  assert.doesNotMatch(primer, /- Command:/, 'recorded commands go to helpers, not into the main primer');
  assert.match(primer, /1 build\/test command that succeeded here are in \.dual-agent\/memory\/notes\.md \(titles start "Command:"\)\./);
  assert.match(primer, /- Decision: Retries stay at 3\./);
  // A note from before use was tracked: no Verified, no Uses.
  const old = workspace();
  fs.mkdirSync(memoryDir(old), { recursive: true });
  fs.writeFileSync(path.join(memoryDir(old), 'notes.md'), '# Project notes\n\n## Legacy\nUpdated: 2026-01-01\n\nStill true.\n');
  assert.equal(pruneNotes(old, new Date('2026-10-21T00:00:00Z')), 0, 'not archived on the first prune after upgrading');
  assert.match(notesFile(old), /## Legacy\nUpdated: 2026-01-01\nVerified: 2026-10-21T00:00:00\.000Z/);
  // Notes about no file are read, never "checked".
  findNotes(old, 'still');
  assert.match(notesFile(old), /Verified: 2026-10-21T00:00:00\.000Z/);
  // Past the cap, the oldest go to the archive instead of disappearing.
  const full = workspace();
  for (let i = 0; i < 140; i++) {
    upsertNote(full, note(`Note ${String(i).padStart(3, '0')}`, `${'detail '.repeat(40)}${i}`, `2026-09-${String((i % 28) + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00Z`));
  }
  assert.match(fs.readFileSync(path.join(memoryDir(full), 'notes-archive.md'), 'utf8'), /## Note 000\n/);
});

test('memory: use keeps a note alive, uncited notes say nothing checks them, and the handoff has keys masked', () => {
  const root = workspace();
  upsertNote(root, note('Retry policy', 'Retries stay at 3.', '2026-10-01'), new Date('2026-10-01T00:00:00Z'));
  assert.doesNotMatch(notesFile(root), /Verified:/, 'a note citing no file is not "checked" by being written');
  assert.match(findNotes(root, 'retry', 6000, new Date('2026-11-15T00:00:00Z')), /\(cites no files, so nothing checks it: confirm before relying on it\)/);
  assert.match(notesFile(root), /Used: 2026-11-15T00:00:00\.000Z/);
  assert.equal(pruneNotes(root, new Date('2026-12-01T00:00:00Z')), 0, 'read two weeks ago: still in use');
  assert.equal(pruneNotes(root, new Date('2027-01-01T00:00:00Z')), 1, 'unused for a month: archived');
  recordCommand(root, 'npm test', new Date('2026-10-21T00:00:00Z'));
  assert.doesNotMatch(findNotes(root, 'command'), /cites no files/, 'recorded commands are checked by running');
  saveHandoff(root, 'Asked: deploy with key sk-ant-abcdefghijklmnopqrstuvwxyz0123');
  assert.doesNotMatch(loadHandoff(root) ?? '', /abcdefghijklmnopqrstuvwxyz/);
});

test('memory: the primer and brief carry the Project commands line and write conventions.md', () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'jest', lint: 'eslint .' } }));
  for (const text of [memoryPrimer(root), helperBrief(root)]) {
    assert.match(text ?? '', /Project commands: test `npm test`; lint `npm run lint`\./);
  }
  assert.match(fs.readFileSync(path.join(memoryDir(root), 'conventions.md'), 'utf8'), /- test: `npm test` \(package\.json\)/);
});

test('memory: a recorded command fills the Project commands line when no manifest names it', () => {
  const root = workspace();
  recordCommand(root, 'swift test', new Date('2026-10-21T00:00:00Z'));
  assert.match(memoryPrimer(root) ?? '', /Project commands: test `swift test`\./);
});

test('memory: an invalid package.json gives no primer or brief and creates no memory folder', () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'package.json'), '{not json');
  assert.equal(memoryPrimer(root), undefined);
  assert.equal(helperBrief(root), undefined);
  assert.ok(!fs.existsSync(memoryDir(root)));
});
