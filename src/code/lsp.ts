/**
 * Code navigation through VS Code's language servers: a file's outline, where a
 * symbol is defined (with its type and docs), every place it is used, and the
 * editor's current errors. One call replaces a Grep plus several file reads,
 * and the answers are exact where text search guesses.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { withTimeout } from '../async';
import { extractSymbols, indexRepo, relPath, workspacePath } from './repoIndex';
import { REFERENCE_CAP, capGroups } from './analysis';
import { short } from '../text';

/** A symbol on a line, as the agent names it: the file, the 1-based line and the identifier. */
export interface Place {
  path?: string;
  line?: number;
  symbol: string;
  /** Lines of code to show around each reference. */
  context?: number;
}

const MAX_OUTLINE_LINES = 300;
/** How long one language-server request may take; servers can hang while indexing. */
const REQUEST_MS = 10_000;
/** One question's total time, retries included, so a missing language server costs seconds, not a minute. */
const DEADLINE_MS = 15_000;

const rel = (root: string, uri: vscode.Uri) => relPath(root, uri.fsPath) || uri.fsPath;
const abs = workspacePath;

/** `ask()`'s answer, or `fallback()`'s when the language features throw (a file outside the open folders, a stuck server) or have none. */
async function orIndex(ask: () => Promise<string | undefined>, fallback: () => Promise<string>): Promise<string> {
  let answer: string | undefined;
  try {
    answer = await ask();
  } catch {
    // The pattern index below needs no language server.
  }
  return answer ?? fallback();
}

const wordPattern = (name: string) => new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`);

/** Opens a document without showing it, within the request timeout. */
const open = (uri: vscode.Uri) => withTimeout(vscode.workspace.openTextDocument(uri), REQUEST_MS, `Opening ${uri.fsPath}`);

/** Language servers start lazily; the first request after opening a file can come back empty, so empty answers are retried. */
async function ask<T>(command: string, ...args: unknown[]): Promise<T | undefined> {
  return askTimes<T>(6, command, ...args);
}

function askTimes<T>(attempts: number, command: string, ...args: unknown[]): Promise<T | undefined> {
  return retryEmpty(() => vscode.commands.executeCommand<T | undefined>(command, ...args), attempts);
}

export interface RetryLimits {
  requestMs: number;
  deadlineMs: number;
  backoffMs: number;
}

/**
 * Calls until the answer isn't an empty list, within `attempts` and an overall
 * deadline. Undefined means no provider handles the request, so it isn't retried.
 */
export async function retryEmpty<T>(call: () => PromiseLike<T | undefined>, attempts: number, limits: RetryLimits = { requestMs: REQUEST_MS, deadlineMs: DEADLINE_MS, backoffMs: 400 }): Promise<T | undefined> {
  const deadline = Date.now() + limits.deadlineMs;
  for (let attempt = 0; attempt < attempts && Date.now() < deadline; attempt++) {
    const result = await withTimeout(call(), Math.min(limits.requestMs, deadline - Date.now()), 'The language server');
    if (result === undefined || result === null) {
      return undefined;
    }
    if (!Array.isArray(result) || result.length) {
      return result;
    }
    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(limits.backoffMs * (attempt + 1), deadline - Date.now()))));
  }
  return undefined;
}

function lineText(doc: vscode.TextDocument, line: number): string {
  return line >= 0 && line < doc.lineCount ? doc.lineAt(line).text.trim() : '';
}

/** Finds the symbol's position: on the given line, else its first whole-word occurrence in the file. */
async function locate(root: string, place: Place): Promise<{ uri: vscode.Uri; pos: vscode.Position } | string> {
  if (!place.path) {
    const matches = await workspaceSymbols(place.symbol);
    if (!matches.length) {
      return `No symbol named ${place.symbol} found in the workspace. Give its file with path.`;
    }
    if (matches.length > 1) {
      const where = matches.slice(0, 20).map((m) => `${rel(root, m.location.uri)}:${m.location.range.start.line + 1}`);
      return `${place.symbol} is defined in ${matches.length} places; give path and line:\n${where.join('\n')}${matches.length > 20 ? '\n…' : ''}`;
    }
    return { uri: matches[0].location.uri, pos: matches[0].location.range.start };
  }
  const uri = vscode.Uri.file(abs(root, place.path));
  const doc = await open(uri);
  const word = wordPattern(place.symbol);
  const lines = place.line ? [place.line - 1] : Array.from({ length: doc.lineCount }, (_, i) => i);
  for (const i of lines) {
    const m = word.exec(i >= 0 && i < doc.lineCount ? doc.lineAt(i).text : '');
    if (m) {
      return { uri, pos: new vscode.Position(i, m.index) };
    }
  }
  return `${place.symbol} isn't on ${place.line ? `line ${place.line} of ` : ''}${place.path}.`;
}

async function workspaceSymbols(name: string): Promise<vscode.SymbolInformation[]> {
  const all = (await ask<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', name)) ?? [];
  return all.filter((s) => s.name === name || s.name.replace(/\(.*$/, '') === name);
}

/** Hierarchical symbols of a file: kind, name, line range. */
export async function outline(root: string, file: string): Promise<string> {
  const uri = vscode.Uri.file(abs(root, file));
  return orIndex(() => lspOutline(root, uri), () => indexOutline(root, file, uri));
}

/** The pattern-based outline: for files with no language server, or outside the open folders. */
async function indexOutline(root: string, file: string, uri: vscode.Uri): Promise<string> {
  const text = await fs.promises.readFile(uri.fsPath, 'utf8');
  const approx = extractSymbols(text, path.extname(file));
  return approx.length
    ? capLines([`${rel(root, uri)} (${text.split('\n').length} lines; no language server, approximate)`, ...approx.map((s) => `  L${s.line} ${s.kind} ${s.name}`)])
    : `No outline for ${file}: no language server and no recognizable definitions.`;
}

async function lspOutline(root: string, uri: vscode.Uri): Promise<string | undefined> {
  const doc = await open(uri);
  const symbols = await ask<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', uri);
  if (!symbols) {
    return undefined;
  }
  const out: string[] = [`${rel(root, uri)} (${doc.lineCount} lines)`];
  // Members of classes and namespaces belong in an outline; locals of functions don't.
  const containers = [vscode.SymbolKind.Class, vscode.SymbolKind.Interface, vscode.SymbolKind.Module, vscode.SymbolKind.Namespace, vscode.SymbolKind.Enum, vscode.SymbolKind.Struct];
  const walk = (list: vscode.DocumentSymbol[], depth: number) => {
    for (const s of list) {
      // The declaration line shows what kind and detail don't: export, parameters, types.
      const decl = lineText(doc, s.selectionRange?.start.line ?? s.range.start.line);
      const what = decl.includes(s.name) ? short(decl.replace(/\s*[{=]\s*$/, ''), 120) : `${vscode.SymbolKind[s.kind].toLowerCase()} ${s.name}${s.detail ? ` ${s.detail}` : ''}`;
      out.push(`${'  '.repeat(depth + 1)}L${s.range.start.line + 1}-${s.range.end.line + 1} ${what}`);
      if (depth < 2 && containers.includes(s.kind)) {
        walk(s.children ?? [], depth + 1);
      }
    }
  };
  if ('children' in symbols[0]) {
    walk(symbols as vscode.DocumentSymbol[], 0);
  } else {
    for (const s of symbols as vscode.SymbolInformation[]) {
      out.push(`  L${s.location.range.start.line + 1} ${vscode.SymbolKind[s.kind].toLowerCase()} ${s.containerName ? `${s.containerName}.` : ''}${s.name}`);
    }
  }
  return capLines(out);
}

/** An outline cut to a size that can't flood the model's context. */
function capLines(lines: string[]): string {
  return lines.length > MAX_OUTLINE_LINES
    ? `${lines.slice(0, MAX_OUTLINE_LINES).join('\n')}\n(${lines.length - MAX_OUTLINE_LINES} more symbols; Read a range or use code_map with a query.)`
    : lines.join('\n');
}

function hoverText(hovers: vscode.Hover[] | undefined): string {
  const parts = (hovers ?? []).flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value)));
  return parts
    .join('\n')
    .replace(/```\w*\n?/g, '')
    .trim()
    .slice(0, 1200);
}

/** Where a symbol is defined, its type or signature, and its doc comment. */
export function definition(root: string, place: Place): Promise<string> {
  return orIndex(() => lspDefinition(root, place), () => indexDefinition(root, place.symbol));
}

/** Definitions by name from the pattern index. */
async function indexDefinition(root: string, name: string): Promise<string> {
  const hits = (await indexRepo(root)).flatMap((f) => f.symbols.filter((s) => s.name === name).map((s) => `${f.rel}:${s.line}  ${short(s.signature, 160)}`));
  return hits.length
    ? `${hits.slice(0, 20).join('\n')}${hits.length > 20 ? `\n… ${hits.length - 20} more` : ''}\n(pattern index; no language server answered)`
    : `No definition of ${name} found (no language server answered; pattern index has none). Use Grep.`;
}

async function lspDefinition(root: string, place: Place): Promise<string | undefined> {
  const at = await locate(root, place);
  if (typeof at === 'string') {
    return at;
  }
  const defs = (await ask<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', at.uri, at.pos))?.map((d) =>
    'targetUri' in d ? { uri: d.targetUri, range: d.targetSelectionRange ?? d.targetRange } : d,
  );
  // Hover on the definition itself: at a use site an import shows only as an alias.
  const target = defs?.[0] ?? { uri: at.uri, range: new vscode.Range(at.pos, at.pos) };
  const type = hoverText(await ask<vscode.Hover[]>('vscode.executeHoverProvider', target.uri, target.range.start));
  if (!defs) {
    return type ? `No definition found, but the language server describes ${place.symbol} as:\n${type}` : undefined;
  }
  const lines = await Promise.all(
    defs.slice(0, 20).map(async (d) => `${rel(root, d.uri)}:${d.range.start.line + 1}  ${lineText(await open(d.uri), d.range.start.line)}`),
  );
  return `${lines.join('\n')}${type ? `\n\n${type}` : ''}`;
}

/**
 * Opens (without showing) the files that mention a name, so language servers
 * that only know open files, such as TypeScript without a tsconfig, see every use.
 */
async function warmUp(root: string, name: string) {
  const files = (await indexRepo(root)).filter((f) => f.idents.has(name)).slice(0, 50);
  await Promise.all(files.map((f) => open(vscode.Uri.file(path.join(root, f.rel))).catch(() => undefined)));
}

/** Every use of a symbol, grouped by file, each with the function it sits in. */
export function references(root: string, place: Place): Promise<string> {
  return orIndex(() => lspReferences(root, place), () => indexReferences(root, place));
}

/** Whole-word matches in the files the index says mention the name; unlike the language server, also in comments and strings. */
async function indexReferences(root: string, place: Place): Promise<string> {
  const word = wordPattern(place.symbol);
  const n = place.context ?? 0;
  const groups: [string, string[]][] = [];
  let total = 0;
  for (const f of (await indexRepo(root)).filter((f) => f.idents.has(place.symbol))) {
    const lines = (await fs.promises.readFile(path.join(root, f.rel), 'utf8').catch(() => '')).split('\n');
    const hits: string[] = [];
    lines.forEach((text, i) => {
      if (!word.test(text)) {
        return;
      }
      const around: string[] = [];
      for (let k = Math.max(0, i - n); k <= Math.min(lines.length - 1, i + n); k++) {
        if (k !== i) {
          around.push(`\n    ${k + 1}| ${lines[k].slice(0, 140)}`);
        }
      }
      hits.push(`  L${i + 1}: ${text.trim().slice(0, 140)}${around.join('')}`);
    });
    total += hits.length;
    if (hits.length) {
      groups.push([f.rel, hits]);
    }
  }
  if (!total) {
    return `No uses of ${place.symbol} found (no language server answered; pattern index). Use Grep.`;
  }
  const { shown, more, moreGroups } = capGroups(groups, REFERENCE_CAP);
  const out = [`${total} text matches for ${place.symbol} in ${groups.length} files (no language server; includes comments and strings):`];
  for (const [file, hits] of shown) {
    out.push(file, ...hits);
  }
  if (more) {
    out.push(`… ${more} more in ${moreGroups} files; Grep under a path to narrow.`);
  }
  return out.join('\n');
}

async function lspReferences(root: string, place: Place): Promise<string | undefined> {
  const at = await locate(root, place);
  if (typeof at === 'string') {
    return at;
  }
  await warmUp(root, place.symbol);
  const refs = await ask<vscode.Location[]>('vscode.executeReferenceProvider', at.uri, at.pos);
  if (!refs) {
    return undefined;
  }
  const byFile = new Map<string, vscode.Location[]>();
  for (const r of refs) {
    byFile.set(r.uri.fsPath, [...(byFile.get(r.uri.fsPath) ?? []), r]);
  }
  const { shown, more, moreGroups } = capGroups([...byFile], REFERENCE_CAP);
  const out: string[] = [`${refs.length} references to ${place.symbol} in ${byFile.size} files:`];
  for (const [, list] of shown) {
    const doc = await open(list[0].uri);
    // Fewer retries than usual: a file may truly have no symbols, and this runs once per file.
    const symbols = (await askTimes<vscode.DocumentSymbol[]>(3, 'vscode.executeDocumentSymbolProvider', list[0].uri)) ?? [];
    out.push(rel(root, list[0].uri));
    for (const r of list) {
      const line = r.range.start.line;
      const inside = enclosing(symbols, r.range.start);
      out.push(`  L${line + 1}${inside ? ` in ${inside}` : ''}: ${lineText(doc, line).slice(0, 140)}`);
      const n = place.context ?? 0;
      for (let i = Math.max(0, line - n); i <= Math.min(doc.lineCount - 1, line + n); i++) {
        if (i !== line) {
          out.push(`    ${i + 1}| ${doc.lineAt(i).text.slice(0, 140)}`);
        }
      }
    }
  }
  if (more) {
    out.push(`… ${more} more references in ${moreGroups} files; check the most relevant files first, or Grep under a path to narrow.`);
  }
  return out.join('\n');
}

/** The innermost function, method or class containing a position, as "Class.method". */
function enclosing(symbols: vscode.DocumentSymbol[], pos: vscode.Position, prefix = ''): string {
  const KINDS = [vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Class, vscode.SymbolKind.Constructor, vscode.SymbolKind.Interface];
  for (const s of symbols) {
    if (s.range?.contains(pos) && KINDS.includes(s.kind)) {
      const name = prefix ? `${prefix}.${s.name}` : s.name;
      return enclosing(s.children ?? [], pos, name) || name;
    }
  }
  return '';
}

/** Files open in editor tabs: the ones language servers keep checked. */
function openFiles(): Set<string> {
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.input);
  return new Set(tabs.filter((i): i is vscode.TabInputText => i instanceof vscode.TabInputText).map((i) => i.uri.fsPath));
}

/** Errors and warnings the editor's language servers report, for one file or the workspace. */
export function problems(root: string, file?: string): string {
  const entries: [vscode.Uri, readonly vscode.Diagnostic[]][] = file
    ? [[vscode.Uri.file(abs(root, file)), vscode.languages.getDiagnostics(vscode.Uri.file(abs(root, file)))]]
    : vscode.languages.getDiagnostics();
  const out: string[] = [];
  for (const [uri, diags] of entries) {
    const serious = diags.filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning);
    if (!serious.length || (!file && !uri.fsPath.startsWith(root))) {
      continue;
    }
    out.push(rel(root, uri));
    for (const d of serious.slice(0, 20)) {
      out.push(`  L${d.range.start.line + 1} ${d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning'}: ${d.message.split('\n')[0]}${d.source ? ` (${d.source})` : ''}`);
    }
  }
  if (out.length) {
    return out.slice(0, 120).join('\n');
  }
  if (file && !openFiles().has(abs(root, file))) {
    return `The editor hasn't checked ${file}: language servers only check open files. Run the project's type check or linter instead.`;
  }
  return `No errors or warnings${file ? ` in ${file}` : ' in open files'}.`;
}

/** The longest an edit waits for the language server's fresh verdict (Kilo: 5-10 s; Cline and Roo a fixed 1 s). */
const RECHECK_MS = 3000;
/** Quiet time after a diagnostics update that counts as the server being done. */
const SETTLE_MS = 400;
const MAX_NEW_ERRORS = 10;

const errorsOf = (uri: vscode.Uri) => vscode.languages.getDiagnostics(uri).filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
const languageOf = (file: string) => vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file)?.languageId;

/** Languages that have reported diagnostics this session; an edit in another isn't waited on. */
let reporting: Set<string> | undefined;

/** `reporting`, watched from the first edit check on and seeded with the files that already have diagnostics. */
function reportingLanguages(): Set<string> {
  if (!reporting) {
    const seen = new Set<string>();
    const note = (uris: readonly vscode.Uri[]) => {
      const paths = new Set(uris.map((u) => u.fsPath));
      vscode.workspace.textDocuments.forEach((d) => paths.has(d.uri.fsPath) && seen.add(d.languageId));
    };
    vscode.languages.onDidChangeDiagnostics((e) => note(e.uris));
    note(vscode.languages.getDiagnostics().map(([uri]) => uri));
    reporting = seen;
  }
  return reporting;
}
/** Message and code line, so an error the edit only moved still matches. */
const errorKey = (lines: string[], d: vscode.Diagnostic) => `${d.message.split('\n')[0]}|${(lines[d.range.start.line] ?? '').trim()}`;

/**
 * A file's errors before an edit, to tell the edit's own errors apart after it.
 * Only for files open in a tab: language servers don't check the others, even
 * when opened unseen (TypeScript: none after 5 s hidden, 0.5 s once shown; 2026-10-20).
 */
export function errorSnapshot(file: string): Set<string> | undefined {
  try {
    if (!openFiles().has(file)) {
      return undefined;
    }
    reportingLanguages();
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    return new Set(errorsOf(vscode.Uri.file(file)).map((d) => errorKey(lines, d)));
  } catch {
    // Not running in VS Code (tests), or the file is new.
    return undefined;
  }
}

/** Errors the edit introduced, as a note for the agent, once the server has rechecked the file. */
export async function newErrors(root: string, file: string, before: Set<string> | undefined): Promise<string | undefined> {
  if (!before) {
    return undefined;
  }
  try {
    const uri = vscode.Uri.file(file);
    // Servers report in passes (TypeScript: syntax, then types), so wait until the file's diagnostics settle.
    let settled!: () => void;
    const fresh = new Promise<void>((resolve) => (settled = resolve));
    let quiet: NodeJS.Timeout | undefined;
    // A language not seen reporting gets one look after SETTLE_MS, unless it reports meanwhile.
    let reports = reportingLanguages().has(languageOf(uri.fsPath) ?? '');
    let cap = setTimeout(settled, reports ? RECHECK_MS : SETTLE_MS);
    const sub = vscode.languages.onDidChangeDiagnostics((e) => {
      if (e.uris.some((u) => u.fsPath === uri.fsPath)) {
        clearTimeout(quiet);
        quiet = setTimeout(settled, SETTLE_MS);
        if (!reports) {
          reports = true;
          clearTimeout(cap);
          cap = setTimeout(settled, RECHECK_MS);
        }
      }
    });
    try {
      await fresh;
    } finally {
      sub.dispose();
      clearTimeout(quiet);
      clearTimeout(cap);
    }
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const added = errorsOf(uri).filter((d) => !before.has(errorKey(lines, d)));
    if (!added.length) {
      return undefined;
    }
    const shown = added.slice(0, MAX_NEW_ERRORS).map((d) => `  L${d.range.start.line + 1}: ${d.message.split('\n')[0]}${d.source ? ` (${d.source})` : ''}`);
    const more = added.length > MAX_NEW_ERRORS ? `\n  … ${added.length - MAX_NEW_ERRORS} more` : '';
    return `The edit left ${added.length} new error${added.length === 1 ? '' : 's'} in ${relPath(root, file) || file}:\n${shown.join('\n')}${more}\nFix them before moving on.`;
  } catch {
    return undefined;
  }
}
