/**
 * Static malware scan of a downloaded repository before any of it is copied
 * into the project. Files are only read as bytes and text: nothing here runs,
 * imports or requires what it scans. Rules are regular expressions plus a few
 * per-file signals; weak signals are escalated only when they combine (secrets
 * paths with a network call, an install hook with a download), which keeps
 * false positives down on ordinary code.
 */
import * as fs from 'fs';
import * as path from 'path';
import { collapseSpace, short } from '../text';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface Finding {
  rule: string;
  severity: Severity;
  /** Relative to the scanned root, with forward slashes. */
  file: string;
  /** 1-based; missing for findings about the whole file. */
  line?: number;
  snippet: string;
  message: string;
}

export interface ScanResult {
  findings: Finding[];
  filesScanned: number;
  counts: Record<Severity, number>;
}

type Kind = 'code' | 'script' | 'text' | 'data';

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
/** Matches on comment lines drop one level: comments don't run, but may still steer a reader. */
const LOWER: Record<Severity, Severity> = { critical: 'high', high: 'medium', medium: 'low', low: 'low' };
const MAX_BYTES = 5 * 1024 * 1024;
/** Longer lines are blanked before the pattern rules so a minified blob can't stall them. */
const MAX_LINE = 20_000;
/** Findings kept per rule per file; the first few are enough to judge it. */
const PER_RULE = 5;

const CODE_EXT = new Set(
  'js mjs cjs jsx ts tsx mts cts py pyw rb php go rs java kt kts scala groovy cs fs vb swift m mm c h cc cpp cxx hpp hh lua pl pm r dart ex exs erl clj cljs vue svelte coffee html htm'.split(' '),
);
const SCRIPT_EXT = new Set('sh bash zsh fish ksh ps1 psm1 bat cmd gradle mk'.split(' '));
const SCRIPT_NAMES = new Set(['makefile', 'gnumakefile', 'dockerfile', 'justfile', 'rakefile', 'vagrantfile']);
const DATA_EXT = new Set('json jsonc json5 yaml yml toml xml ini cfg conf lock csv tsv svg plist properties env'.split(' '));
const MEDIA_EXT = new Set('png jpg jpeg gif webp ico bmp tif tiff avif heic svg woff woff2 ttf otf eot'.split(' '));
const BINARY_EXT = new Set(
  'so dll exe node pyc pyo jar war wasm dylib class o a lib obj bin msi dmg apk deb rpm pdb zip tar gz tgz bz2 xz 7z rar'.split(' '),
);
const CONFIG_DIRS = new Set(['.vscode', '.claude', '.cursor', '.devcontainer', '.idea', '.windsurf', '.continue']);
const CONFIG_FILES = new Set(['.mcp.json', 'claude.md', 'agents.md', 'gemini.md', '.cursorrules', '.windsurfrules', '.clinerules', '.envrc']);
const GIT_FILES = new Set(['.gitmodules', '.lfsconfig', '.gitattributes']);
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish'];

const baseName = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);
const dirSegments = (rel: string) => rel.split('/').slice(0, -1);
const extOf = (rel: string) => {
  const b = baseName(rel);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
};

const isBundle = (rel: string) => /\.min\.(?:js|mjs|cjs|css)$|\.map$/i.test(rel) || dirSegments(rel).some((s) => s === 'dist' || s === 'build');
const isBinaryName = (rel: string) => BINARY_EXT.has(extOf(rel)) || /\.so(?:\.\d+)+$/.test(rel);
const isEditorConfig = (rel: string) =>
  dirSegments(rel).some((s) => CONFIG_DIRS.has(s)) ||
  CONFIG_FILES.has(baseName(rel).toLowerCase()) ||
  /(?:^|\/)\.github\/(?:copilot-instructions\.md|instructions\/|prompts\/|chatmodes\/)/.test(rel);

/** Why `rel` must never be imported into a project, or undefined when it may be. */
export function doNotCopy(rel: string): string | undefined {
  if (rel.split('/').includes('.git') || GIT_FILES.has(baseName(rel))) return 'git metadata';
  if (isEditorConfig(rel)) return 'editor or agent config (can run commands or steer an agent)';
  if (/^\.(?:npmrc|yarnrc(?:\.yml)?|pypirc)$/.test(baseName(rel))) return 'package manager config';
  if (/^\.env(?:\.|$)/.test(baseName(rel))) return 'environment file';
  if (isBinaryName(rel)) return 'binary';
  if (isBundle(rel)) return 'minified or built bundle (copy the source instead)';
  return undefined;
}

function kindOf(rel: string, text: string): Kind {
  const ext = extOf(rel);
  if (/\.d\.[mc]?ts$/.test(rel)) return 'text';
  if (CODE_EXT.has(ext)) return 'code';
  if (SCRIPT_EXT.has(ext) || SCRIPT_NAMES.has(baseName(rel).toLowerCase())) return 'script';
  if (DATA_EXT.has(ext)) return 'data';
  return text.startsWith('#!') ? 'script' : 'text';
}

const INVISIBLE = /[\0-\x08\x0B-\x1F\x7F-\x9F\u00AD\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

/** Invisible, bidi and control characters shown as <U+XXXX> so a reviewer can see them. */
export const renderInvisible = (s: string) =>
  s.replace(INVISIBLE, (c) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`);

function snippetAt(line: string, col: number): string {
  const start = Math.max(0, col - 40);
  return (start ? '…' : '') + short(collapseSpace(renderInvisible(line.slice(start, col + 200))), 120);
}

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let e = 0;
  for (const n of counts.values()) e -= (n / s.length) * Math.log2(n / s.length);
  return e;
}

interface FileCtx {
  rel: string;
  kind: Kind;
  raw: string;
  /** `raw` with over-long lines replaced by spaces, so offsets still line up. */
  text: string;
  install: boolean;
  net: boolean;
  envFs: boolean;
  lineAt(index: number): string;
  /** The text of the line holding `index`, up to it. */
  before(index: number): string;
}

interface Rule {
  id: string;
  re: RegExp;
  sev: Severity;
  msg: string;
  /** Default: code and script. */
  kinds?: Kind[];
  /** Scan `raw` rather than the line-capped text. */
  raw?: boolean;
  /** Severity for this match given the file's signals; undefined drops it. */
  grade?: (m: RegExpMatchArray, f: FileCtx) => Severity | undefined;
  /** Offset within the match the finding points at. */
  at?: (m: RegExpMatchArray) => number;
}

const ANY: Kind[] = ['code', 'script', 'text', 'data'];
const EXECUTABLE: Kind[] = ['code', 'script'];

const NET_CODE =
  /\bfetch\s*\(|\bhttps?\.(?:request|get|post|Get|Post)\s*\(|\bXMLHttpRequest\b|\bWebSocket\s*\(|\bnet\.(?:Socket|connect|createConnection)\b|\bdgram\b|\bdns\.(?:promises\.)?(?:resolve\w*|lookup)\b|\brequests\.(?:get|post|put|delete|patch|request|Session)\b|\burllib\b|\bsocket\.socket\b|\baxios\b/g;
const NET_SCRIPT = /\b(?:curl|wget|nc|ncat|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/g;
const EXFIL_HOSTS =
  /discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org\/bot|hooks\.slack\.com\/|pastebin\.com|paste\.ee|hastebin\.com|transfer\.sh|\.ngrok(?:-free)?\.(?:io|app|dev)\b|trycloudflare\.com|webhook\.site|requestbin\.(?:com|net)|pipedream\.net|interactsh|interact\.sh|\boast\.(?:fun|pro|live|site|online|me)\b|burpcollaborator\.net|oastify\.com|\bbit\.ly\/|\btinyurl\.com\/|(?<=[a-z2-7]{16})\.onion\b/gi;
const IPV4_URL = /\bhttps?:\/\/(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}\b/g;
const ENV_ACCESS = /\bprocess\.env\b|\bos\.environ\b|\bos\.getenv\b|\bSystem\.getenv\b|\bDeno\.env\b|\benv::var/;
const FS_ACCESS = /\bfs\.\w+|\b(?:readFileSync|writeFileSync|readFile|writeFile)\b|\bos\.homedir\b|\bexpanduser\b|\bPath\.home\b|\bopen\s*\(/;
const CRED_PATHS =
  /[~/\\'"`]\.ssh\b|\bid_(?:rsa|ed25519|ecdsa)\b|\.aws[/\\]credentials|\.npmrc\b|\.git-credentials|\.docker[/\\]config\.json|\.kube[/\\]config|Login Data|[/\\'"]Cookies['"]|[/\\]Cookies\b|Local State|wallet\.dat|MetaMask|nkbihfbeogaeaoehlefnkodbefgpgknn|\bExodus\b|\/etc\/(?:passwd|shadow)\b|\bKeychains?\b|login\.keychain|find-(?:generic|internet)-password/g;
const INSTALL_RISK = /\b(?:curl|wget|nc|base64|eval|powershell|iwr|irm)\b|\bnode\s+-[ep]\b|\bpython3?\s+-c\b|https?:\/\/|\|\s*(?:ba|z)?sh\b/i;

/** Like `re.test(s)` but safe for shared /g patterns: `search` ignores and keeps `lastIndex`. */
const found = (re: RegExp, s: string) => s.search(re) >= 0;

const PRIVATE_IP = (a: number, b: number) => a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);

/** A call whose first argument is a plain string (or list of strings) is far less dangerous than one built at runtime. */
function literalArg(m: RegExpMatchArray, f: FileCtx): Severity | undefined {
  if (!m[0].endsWith('(')) return 'medium';
  if (/\b(?:async|function|def|static|public|private|protected)\s+$/.test(f.before(m.index!))) return undefined;
  const rest = f.text.slice(m.index! + m[0].length, m.index! + m[0].length + 300);
  return /^\s*(?:(?:'[^'\n]*'|"[^"\n]*"|`[^`$\n]*`)\s*[,)]|\)|\[\s*['"])/.test(rest) ? 'medium' : 'high';
}

/** Whether the line text before a match ends inside a comment. A block comment closed earlier on the line doesn't count, so it can't hide code. */
function inComment(before: string): boolean {
  if (/^\s*(?:\/\/|\*(?!\/)|#(?![!\[]|include|define|if|pragma)|--|<!--)/.test(before)) return true;
  const open = before.lastIndexOf('/*');
  if (open >= 0 && before.indexOf('*/', open) < 0) return true;
  return /(?<![:'"\\])\/\/|\s#\s/.test(before);
}

const isPictographic = (cp: number | undefined) => cp !== undefined && /\p{Extended_Pictographic}|\p{So}|\p{Script=Han}/u.test(String.fromCodePoint(cp));
const isForeignLetter = (cp: number | undefined) => cp !== undefined && cp > 0x7f && /\p{L}|\p{M}/u.test(String.fromCodePoint(cp));
const isSelector = (cp: number | undefined) => cp !== undefined && ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef));

function prevCodePoint(s: string, i: number): number | undefined {
  if (i <= 0) return undefined;
  const c = s.charCodeAt(i - 1);
  return c >= 0xdc00 && c <= 0xdfff && i >= 2 ? s.codePointAt(i - 2) : c;
}

/** Emoji presentation selectors, emoji joiners and joiners inside non-Latin words are normal text. */
function benignInvisible(s: string, i: number, cp: number): boolean {
  const prev = prevCodePoint(s, i);
  const next = s.codePointAt(i + (cp > 0xffff ? 2 : 1));
  if (cp === 0xfeff) return i === 0;
  if (cp === 0xfe0e || cp === 0xfe0f) return !isSelector(next) && (isPictographic(prev) || (prev !== undefined && /[#*0-9]/.test(String.fromCodePoint(prev)) && next === 0x20e3));
  if (cp >= 0xe0100 && cp <= 0xe01ef) return !isSelector(next) && prev !== undefined && /\p{Script=Han}/u.test(String.fromCodePoint(prev));
  if (cp === 0x200d) return (isPictographic(prev) || prev === 0xfe0f || (prev !== undefined && prev >= 0x1f3fb && prev <= 0x1f3ff) || isForeignLetter(prev)) && (isPictographic(next) || isForeignLetter(next));
  if (cp === 0x200c) return isForeignLetter(prev);
  if (cp >= 0xe0020 && cp <= 0xe007f) {
    let j = i;
    while (j >= 2 && (prevCodePoint(s, j) ?? 0) >= 0xe0020 && (prevCodePoint(s, j) ?? 0) <= 0xe007e) j -= 2;
    return prevCodePoint(s, j) === 0x1f3f4 && i - j <= 14;
  }
  return false;
}

const SUSPECT_CHAR = /[\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069\uFE00-\uFE0F\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;

/** Consecutive invisible characters from `i` on (up to 64); payloads hide in long runs, emoji code uses one or two. */
function invisibleRun(s: string, i: number): number {
  let n = 0;
  for (const c of s.slice(i, i + 64)) {
    if (!SUSPECT_CHAR.test(c)) break;
    n++;
  }
  return n;
}

/** Whether the line so far has an unclosed quote (a rough check, enough to tell strings from code). */
const inString = (before: string) => [`'`, `"`, '`'].some((q) => before.split(q).length % 2 === 0);

const RULES: Rule[] = [
  {
    id: 'UNI-01',
    re: new RegExp(SUSPECT_CHAR.source, 'gu'),
    sev: 'high',
    msg: 'invisible or bidi characters (can hide code or instructions)',
    kinds: ANY,
    raw: true,
    grade: (m, f) => {
      const cp = m[0].codePointAt(0)!;
      if (benignInvisible(f.raw, m.index!, cp)) return undefined;
      if (!EXECUTABLE.includes(f.kind)) return 'high';
      const before = f.before(m.index!);
      if (inComment(before)) return 'high';
      const bidi = (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
      if (bidi || !inString(before)) return 'critical';
      const run = invisibleRun(f.raw, m.index!) + (SUSPECT_CHAR.test(String.fromCodePoint(prevCodePoint(f.raw, m.index!) ?? 0x20)) ? 1 : 0);
      if (run === 1 && [0xfe0e, 0xfe0f, 0x200c, 0x200d].includes(cp)) return undefined;
      return run >= 3 ? 'critical' : 'high';
    },
  },
  {
    id: 'OBF-01',
    re: /(?<![\w$])eval\s*\(\s*(?:atob|unescape|decodeURIComponent|String\.fromCharCode)\s*\(|(?<![\w$])eval\s*\(\s*(?:Buffer\.from|new\s+Buffer)\s*\([^;\n]*?['"](?:base64|hex)['"]|\bFunction\s*\(\s*atob\s*\(|(?<![\w$.])exec\s*\(\s*(?:base64\.b64decode|codecs\.decode|zlib\.decompress|marshal\.loads|bytes\.fromhex|compile\s*\(\s*base64|(?:''|"")\.join\s*\(\s*(?:\[\s*)?chr)/g,
    sev: 'critical',
    msg: 'decodes a hidden payload and executes it',
  },
  { id: 'EXEC-01', re: /(?<![\w$])(?:eval|execSync|execFileSync|execFile|spawn|spawnSync|shell_exec|passthru|proc_open|popen)\s*\(|(?<![\w$.])(?:exec|system)\s*\(/g, sev: 'medium', msg: 'runs code or a command', grade: literalArg },
  { id: 'EXEC-01', re: /\bnew\s+Function\s*\(|\bvm\.runIn\w+\s*\(|\b(?:child_process|cp|childProcess)\.exec\s*\(|\bos\.(?:system|popen|exec\w*|spawn\w*)\s*\(|\bsubprocess\.\w+\s*\(|\bpty\.spawn\s*\(|Runtime\.getRuntime\(\)\.exec\s*\(|\b__import__\s*\(/g, sev: 'medium', msg: 'runs code or a command', grade: literalArg },
  { id: 'EXEC-01', re: /\bchild_process\b|\bimport\s+subprocess\b|\bProcessBuilder\b|\bimportlib\b|\bIEX\b|\bInvoke-Expression\b/g, sev: 'medium', msg: 'can run code or commands' },
  { id: 'EXEC-01', re: /\bpowershell(?:\.exe)?\b[^\n]*?\s-e(?:nc|ncodedcommand)?\b/gi, sev: 'high', msg: 'runs an encoded PowerShell command' },
  {
    id: 'OBF-02',
    re: /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{200,}/g,
    sev: 'high',
    msg: 'long high-entropy string (encoded payload?)',
    grade: (m, f) => {
      if (/data:(?:image|font|audio|video)\/[\w.+-]+;base64,$/.test(f.text.slice(Math.max(0, m.index! - 60), m.index!))) return undefined;
      return entropy(m[0]) > (/^[0-9a-fA-F]+$/.test(m[0]) ? 3.5 : 4.5) ? 'high' : undefined;
    },
  },
  {
    id: 'OBF-02',
    re: /\S[ \t]{40,}(?=[A-Za-z_$([])/g,
    sev: 'high',
    msg: 'code pushed off-screen after a long run of spaces',
    at: (m) => m[0].length,
    grade: (m, f) => (inComment(f.before(m.index! + m[0].length)) ? undefined : 'high'),
  },
  { id: 'NET-01', re: NET_CODE, sev: 'low', msg: 'network call', grade: (_m, f) => (f.envFs ? 'medium' : 'low') },
  { id: 'NET-01', re: NET_SCRIPT, sev: 'low', msg: 'network tool', kinds: ['script'], grade: (_m, f) => (f.envFs ? 'medium' : 'low') },
  {
    id: 'NET-02',
    re: EXFIL_HOSTS,
    sev: 'high',
    msg: 'known exfiltration or tunnel endpoint',
    kinds: ANY,
    grade: (_m, f) => (f.install ? 'critical' : EXECUTABLE.includes(f.kind) ? 'high' : 'medium'),
  },
  {
    id: 'NET-02',
    re: IPV4_URL,
    sev: 'high',
    msg: 'URL with a raw public IP address',
    kinds: ANY,
    grade: (m, f) => (PRIVATE_IP(+m[1], +m[2]) ? undefined : f.install ? 'critical' : EXECUTABLE.includes(f.kind) ? 'high' : 'medium'),
  },
  {
    id: 'EXF-01',
    re: /JSON\.stringify\s*\(\s*process\.env\b|Object\.(?:keys|entries|values)\s*\(\s*process\.env\s*\)|json\.dumps\s*\(\s*(?:dict\s*\(\s*)?os\.environ\b|\bdict\s*\(\s*os\.environ\s*\)|\bstr\s*\(\s*os\.environ\s*\)|\b(?:printenv|env)\s*\|\s*(?:curl|nc|wget)\b/g,
    sev: 'high',
    msg: 'serializes all environment variables (secrets)',
    grade: (m, f) => {
      if (!/^Object/.test(m[0])) return f.net || f.install ? 'critical' : 'high';
      const picksSome = /^\s*\.filter\s*\(/.test(f.text.slice(m.index! + m[0].length, m.index! + m[0].length + 20));
      return f.net && !picksSome ? 'critical' : 'medium';
    },
  },
  { id: 'FS-01', re: CRED_PATHS, sev: 'high', msg: 'touches a credential or browser-secret path', grade: (_m, f) => (f.net ? 'critical' : 'high') },
  {
    id: 'DNS-01',
    re: /\b(?:dns\.(?:promises\.)?(?:resolve\w*|lookup)|resolver\.(?:resolve|query)|gethostbyname(?:_ex)?)\s*\(/g,
    sev: 'high',
    msg: 'DNS lookup of a name built at runtime (DNS exfiltration?)',
    grade: (m, f) => {
      const arg = f.text.slice(m.index! + m[0].length, m.index! + m[0].length + 160).split(/[)\n]/)[0];
      return /\$\{|\+|\.format\s*\(|^\s*f['"][^'"]*\{/.test(arg) && /\.[a-z]{2,}/i.test(arg) ? 'high' : undefined;
    },
  },
  { id: 'DNS-01', re: /\b(?:nslookup|dig|host)\s+[^\n]*\$\{?\w+\}?\.[\w-]+\.[a-z]{2,}/g, sev: 'high', msg: 'DNS lookup of a name built at runtime (DNS exfiltration?)', kinds: ['script'] },
  {
    id: 'PERS-01',
    re: /\bcrontab\s+-|\/etc\/cron|\/var\/spool\/cron|\bschtasks(?:\.exe)?\b|\bLaunch(?:Agents|Daemons)\b|CurrentVersion\\{1,2}Run(?:Once)?\b/gi,
    sev: 'high',
    msg: 'installs itself to run again later (persistence)',
  },
  {
    id: 'PERS-01',
    re: /[~/'"]\.(?:bashrc|zshrc|bash_profile|zprofile|profile)\b/g,
    sev: 'high',
    msg: 'writes to a shell startup file (persistence)',
    grade: (m, f) => (/>>?|appendFile|writeFile|open\s*\(/.test(f.before(m.index!)) ? 'high' : undefined),
  },
  {
    id: 'PERS-01',
    re: /\bchmod\s+(?:\+x|[0-7]?7[0-7]{2})\b|\bchmod(?:Sync)?\s*\([^)\n]*0o?7[0-7]{2}|\bos\.chmod\s*\(/g,
    sev: 'high',
    msg: 'makes a downloaded file executable',
    grade: (_m, f) => (f.net ? 'high' : undefined),
  },
  { id: 'WORM-01', re: /\bnpm\s+(?:publish|whoami)\b|\bactions\/runner\b|\bconfig\.(?:sh|cmd)\s+--url\b|\bgh\s+repo\s+create\b/g, sev: 'critical', msg: 'publishes or spreads itself (worm behavior)' },
  {
    id: 'WORM-01',
    re: /\.github[/\\]workflows/g,
    sev: 'critical',
    msg: 'writes CI workflows (worm behavior)',
    grade: (m, f) => (/writeFile|appendFile|createWriteStream|open\s*\(|>\s*\S|mkdir|\/contents\/|\bPUT\b|\.put\s*\(/.test(f.lineAt(m.index!)) ? 'critical' : undefined),
  },
  {
    id: 'SEC-01',
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}|\bAKIA[0-9A-Z]{16}\b|\bxox[bpas]-[A-Za-z0-9-]{10,}|\bsk-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    sev: 'medium',
    msg: 'hard-coded token or private key',
    kinds: ANY,
  },
  { id: 'INST-01', re: /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/g, sev: 'high', msg: 'downloads and pipes into a shell', kinds: ['script'] },
];

interface Hit {
  rule: string;
  severity: Severity;
  line?: number;
  col: number;
  message: string;
  snippet?: string;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function lineIndex(starts: number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Lifecycle scripts npm runs on install, from a package.json's text. */
function lifecycleScripts(text: string): [string, string][] {
  try {
    const scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {};
    return LIFECYCLE.flatMap((k) => (typeof scripts[k] === 'string' ? [[k, scripts[k] as string] as [string, string]] : []));
  } catch {
    return LIFECYCLE.flatMap((k) => {
      const m = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
      return m ? [[k, m[1]] as [string, string]] : [];
    });
  }
}

/** Files a package.json's install scripts run, relative to the scan root. */
function installTargets(pkgRel: string, text: string): string[] {
  const dir = path.posix.dirname(pkgRel);
  return lifecycleScripts(text).flatMap(([, cmd]) =>
    [...cmd.matchAll(/(?:^|[\s;&|])(?:node|sh|bash|python3?|tsx|ts-node|bun|deno\s+run)\s+([^\s;&|-][^\s;&|]*)|(?:^|[\s;&|])(\.\/[^\s;&|]+)/g)].map((m) =>
      path.posix.normalize(path.posix.join(dir, m[1] ?? m[2])),
    ),
  );
}

const isInstallFile = (rel: string) => /^(?:setup\.py|build\.rs|binding\.gyp|(?:pre|post)?install\.(?:c?m?js|sh|py|ps1))$/i.test(baseName(rel));

function pathFindings(rel: string, raw: string, lines: string[], add: (h: Hit) => void) {
  const base = baseName(rel);
  const lower = base.toLowerCase();
  const firstLine = (re: RegExp) => {
    const i = lines.findIndex((l) => re.test(l));
    return i < 0 ? undefined : { line: i + 1, col: Math.max(0, lines[i].search(re)) };
  };
  const at = (rule: string, severity: Severity, message: string, re?: RegExp) => {
    const pos = re && firstLine(re);
    add({ rule, severity, message, line: pos ? pos.line : undefined, col: pos ? pos.col : 0, snippet: pos ? undefined : rel });
  };

  if (isEditorConfig(rel)) {
    if (/(?:^|\/)\.vscode\/tasks\.json$/.test(rel) && /folderOpen/.test(raw)) at('EDIT-01', 'critical', 'VS Code task that runs automatically when the folder opens', /folderOpen/);
    else if (/(?:^|\/)\.vscode\/settings\.json$/.test(rel) && /"[\w.-]*(?:path|command|executable)"\s*:/i.test(raw)) {
      lines.forEach((l, i) => {
        const m = /"([\w.-]*(?:path|command|executable))"\s*:/i.exec(l);
        if (m) add({ rule: 'EDIT-01', severity: 'high', message: `editor setting "${m[1]}" points at a program to run`, line: i + 1, col: m.index });
      });
    } else if (/(?:^|\/)\.claude\/settings[\w.]*\.json$/.test(rel) && /"hooks"\s*:/.test(raw)) at('EDIT-01', 'high', 'Claude Code hooks run commands automatically', /"hooks"\s*:/);
    else if (lower === '.mcp.json' && /"command"\s*:/.test(raw)) at('EDIT-01', 'high', 'MCP server config launches a program', /"command"\s*:/);
    else at('EDIT-01', 'medium', 'editor or agent config (can run commands or steer an agent)');
  }

  if (lower === '.gitmodules') at('GIT-01', 'high', 'git submodules pull in code from elsewhere');
  else if (lower === '.lfsconfig') at('GIT-01', 'high', 'git LFS config can redirect downloads');
  else if (lower === '.gitattributes' && /filter=/.test(raw)) at('GIT-01', 'high', 'git filter runs a program on checkout', /filter=/);

  if (lower === 'package.json') {
    for (const [name, cmd] of lifecycleScripts(raw)) {
      const re = new RegExp(`"${name}"\\s*:`);
      const exfil = found(EXFIL_HOSTS, cmd);
      const risky = exfil || found(INSTALL_RISK, cmd);
      at('INST-01', risky ? 'critical' : 'high', `npm "${name}" script runs on install${risky ? ' and downloads, decodes or runs inline code' : ''}`, re);
      if (exfil) at('NET-02', 'critical', 'install script contacts an exfiltration endpoint', re);
    }
  } else if (lower === 'binding.gyp') at('INST-01', 'high', 'native build runs on npm install');
  else if (lower === 'setup.py' && /cmdclass|subprocess|os\.system|urllib|requests/.test(raw)) at('INST-01', 'high', 'setup.py runs custom code on install', /cmdclass|subprocess|os\.system|urllib|requests/);
  else if (lower === 'build.rs') at('INST-01', 'high', 'Cargo build script runs on build');
  else if (lower === 'cargo.toml' && /^\s*proc-macro\s*=\s*true/m.test(raw)) at('INST-01', 'medium', 'procedural macro runs at compile time', /^\s*proc-macro\s*=\s*true/);
}

/** File-wide obfuscation signals the line regexes can't express. */
function obfuscationFindings(f: FileCtx, lines: string[], add: (h: Hit) => void) {
  const ids = f.text.match(/\b_0x[0-9a-f]{4,}\b/gi);
  if (ids && ids.length >= 5) {
    const i = lines.findIndex((l) => /\b_0x[0-9a-f]{4,}\b/i.test(l));
    add({ rule: 'OBF-02', severity: 'high', message: `obfuscator-style identifiers (${ids.length} _0x… names)`, line: i + 1, col: lines[i].search(/_0x/i) });
  }
  const long = lines.findIndex((l) => l.length > 1000);
  if (long >= 0) add({ rule: 'OBF-02', severity: 'high', message: `line of ${lines[long].length} characters in a source file`, line: long + 1, col: 0 });
  if (/\\x[0-9a-fA-F]{2}|fromCharCode/.test(f.text)) {
    lines.forEach((l, i) => {
      if (l.length > MAX_LINE) return;
      const n = l.match(/String\.fromCharCode|\\x[0-9a-fA-F]{2}/g)?.length ?? 0;
      if (n >= 10) add({ rule: 'OBF-02', severity: 'high', message: `${n} character-code escapes on one line`, line: i + 1, col: Math.max(0, l.search(/String\.fromCharCode|\\x[0-9a-fA-F]{2}/)) });
    });
  }
}

function binaryReason(rel: string, b: Buffer): string | undefined {
  if (b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return 'ELF executable';
  if (b.length >= 4) {
    const magic = b.readUInt32BE(0);
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)) return 'Mach-O or Java class binary';
  }
  const head = b.subarray(0, 8192);
  if (b.length >= 64 && b[0] === 0x4d && b[1] === 0x5a && head.includes(0)) return 'Windows PE executable';
  if (isBinaryName(rel)) return `binary file (.${extOf(rel)})`;
  if (head.includes(0) && !MEDIA_EXT.has(extOf(rel))) return 'binary content';
  return undefined;
}

function scanContent(rel: string, content: Buffer, install: boolean): Finding[] {
  if (content.length > MAX_BYTES) return [{ rule: 'BIG-01', severity: 'medium', file: rel, snippet: rel, message: `file of ${(content.length / 1048576).toFixed(1)} MB not scanned` }];
  const bin = binaryReason(rel, content);
  if (bin) return [{ rule: 'BIN-01', severity: 'high', file: rel, snippet: rel, message: bin }];
  if (isBundle(rel)) return [];

  const raw = content.toString('utf8');
  const lines = raw.split('\n');
  const capped = lines.some((l) => l.length > MAX_LINE);
  const text = capped ? lines.map((l) => (l.length > MAX_LINE ? ' '.repeat(l.length) : l)).join('\n') : raw;
  const starts = lineStarts(raw);
  const kind = kindOf(rel, raw);
  const exec = EXECUTABLE.includes(kind);
  const net = exec && (found(NET_CODE, text) || (kind === 'script' && found(NET_SCRIPT, text)) || found(EXFIL_HOSTS, text));
  const f: FileCtx = {
    rel,
    kind,
    raw,
    text,
    install: install || isInstallFile(rel),
    net,
    envFs: exec && (found(ENV_ACCESS, text) || found(FS_ACCESS, text) || found(CRED_PATHS, text)),
    lineAt: (i) => lines[lineIndex(starts, i)].replace(/\r$/, ''),
    before: (i) => raw.slice(raw.lastIndexOf('\n', i - 1) + 1, i),
  };

  const hits = new Map<string, Hit>();
  const add = (h: Hit) => {
    const key = `${h.rule}:${h.line ?? 0}`;
    const old = hits.get(key);
    if (!old || RANK[h.severity] < RANK[old.severity]) hits.set(key, h);
  };

  pathFindings(rel, raw, lines, add);
  for (const r of RULES) {
    if (!(r.kinds ?? EXECUTABLE).includes(kind)) continue;
    let n = 0;
    for (const m of (r.raw ? raw : text).matchAll(r.re)) {
      const graded = r.grade ? r.grade(m, f) : r.sev;
      if (!graded) continue;
      const index = m.index! + (r.at?.(m) ?? 0);
      const line = lineIndex(starts, index);
      const secret = r.id === 'SEC-01' ? `${m[0].slice(0, 8)}…` : undefined;
      const lineText = lines[line].replace(/\r$/, '');
      const commented = exec && r.id !== 'UNI-01' && r.id !== 'SEC-01' && inComment(lineText.slice(0, index - starts[line]));
      add({
        rule: r.id,
        severity: commented ? LOWER[graded] : graded,
        message: commented ? `${r.msg} (in a comment)` : r.msg,
        line: line + 1,
        col: index - starts[line],
        snippet: secret && snippetAt(lineText.replace(m[0], secret), index - starts[line]),
      });
      if (++n >= 50) break;
    }
  }
  if (exec) obfuscationFindings(f, lines.map((l) => l.replace(/\r$/, '')), add);

  const obfLines = new Set([...hits.values()].filter((h) => h.rule === 'OBF-01').map((h) => h.line));
  const perRule = new Map<string, number>();
  return [...hits.values()]
    .filter((h) => !(h.rule === 'EXEC-01' && obfLines.has(h.line)))
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || (a.line ?? 0) - (b.line ?? 0))
    .filter((h) => {
      const n = (perRule.get(h.rule) ?? 0) + 1;
      perRule.set(h.rule, n);
      return n <= PER_RULE;
    })
    .map((h) => ({
      rule: h.rule,
      severity: h.severity,
      file: rel,
      ...(h.line ? { line: h.line } : {}),
      snippet: h.snippet ?? (h.line ? snippetAt(lines[h.line - 1].replace(/\r$/, ''), h.col) : rel),
      message: h.message,
    }));
}

/** Findings for one file. `rel` uses forward slashes; nothing in `content` is executed. */
export function scanFile(rel: string, content: Buffer): Finding[] {
  return scanContent(rel, content, false);
}

interface Listing {
  files: string[];
  findings: Finding[];
}

async function walk(root: string, dir: string, out: Listing): Promise<void> {
  for (const e of await fs.promises.readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isSymbolicLink()) out.findings.push({ rule: 'LINK-01', severity: 'medium', file: rel, snippet: rel, message: 'symbolic link not followed' });
    else if (e.isDirectory() && e.name === '.git') out.findings.push({ rule: 'GIT-01', severity: 'high', file: rel, snippet: rel, message: 'git metadata folder (hooks and config) not scanned' });
    else if (e.isDirectory()) await walk(root, rel, out);
    else if (e.isFile()) out.files.push(rel);
    else out.findings.push({ rule: 'LINK-01', severity: 'medium', file: rel, snippet: rel, message: 'special file not read' });
  }
}

const emptyCounts = (): Record<Severity, number> => ({ critical: 0, high: 0, medium: 0, low: 0 });

/** Scans `files` (relative to `root`), or every file under it. Files over 5 MB are reported, not read. */
export async function scanTree(root: string, files?: string[]): Promise<ScanResult> {
  const base = path.resolve(root);
  const listing: Listing = { files: [], findings: [] };
  if (files) listing.files = files.map((f) => f.replace(/\\/g, '/'));
  else await walk(base, '', listing);

  const abs = (rel: string) => {
    const p = path.resolve(base, rel);
    if (p !== base && !p.startsWith(base + path.sep)) throw new Error(`path outside the scanned folder: ${rel}`);
    return p;
  };

  const install = new Set<string>();
  const packages = new Set(listing.files.filter((f) => baseName(f) === 'package.json'));
  if (fs.existsSync(path.join(base, 'package.json'))) packages.add('package.json');
  for (const pkg of packages) {
    const text = await fs.promises.readFile(abs(pkg), 'utf8').catch(() => '');
    for (const t of installTargets(pkg, text)) install.add(t);
  }

  const findings = [...listing.findings];
  let scanned = 0;
  let next = 0;
  const worker = async () => {
    while (next < listing.files.length) {
      const rel = listing.files[next++];
      const p = abs(rel);
      const st = await fs.promises.lstat(p);
      if (st.isSymbolicLink() || !st.isFile()) {
        findings.push({ rule: 'LINK-01', severity: 'medium', file: rel, snippet: rel, message: 'symbolic link or special file not read' });
      } else if (st.size > MAX_BYTES) {
        findings.push({ rule: 'BIG-01', severity: 'medium', file: rel, snippet: rel, message: `file of ${(st.size / 1048576).toFixed(1)} MB not scanned` });
      } else {
        findings.push(...scanContent(rel, await fs.promises.readFile(p), install.has(rel)));
        scanned++;
      }
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));

  findings.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
  const counts = emptyCounts();
  for (const f of findings) counts[f.severity]++;
  return { findings, filesScanned: scanned, counts };
}

/** One line per finding, most severe first, at most `max` lines plus a count of the rest. */
export function formatFindings(result: ScanResult, max = 40): string {
  const sorted = [...result.findings].sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
  const lines = sorted
    .slice(0, max)
    .map((f) => `${f.severity.toUpperCase()} ${f.rule} ${f.file}${f.line ? `:${f.line}` : ''} ${f.message}${f.snippet && f.snippet !== f.file ? ` — ${f.snippet}` : ''}`);
  const rest = sorted.length - lines.length;
  if (rest > 0) {
    const counts = emptyCounts();
    for (const f of sorted.slice(max)) counts[f.severity]++;
    const parts = (Object.keys(counts) as Severity[]).filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`);
    lines.push(`… ${rest} more (${parts.join(', ')})`);
  }
  return lines.join('\n');
}
