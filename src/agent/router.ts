/**
 * Which model answers the next user message. Auto mode picks one main model
 * per task, at its start: Flash for mechanical one-liners, V4 Pro for coding,
 * Claude for hard design work (when Claude is primary and its quota is on
 * pace). Within a task it never steps down, and steps up only on evidence:
 * trouble across turns (troubleReason) or in a turn's first steps
 * (earlyEscalation). Every switch relaunches the agent and drops the prompt
 * cache. Pure, so the controller only carries the decision out.
 */
import type { Effort, HelperRoster, Mode, ProviderId } from '../providers';

export interface ModelChoice { provider: ProviderId; effort: Effort }

/** Claude subscription rate-limit info, as reported by rate-limit events. */
export interface Quota { status?: 'allowed' | 'allowed_warning' | 'rejected'; utilization?: number; resetsAt?: number; windowStart?: number }

/** How the turns so far on this task went. */
export interface TaskSignals { failedChecks: number; toolErrors: number; editFailures: number; turnsOnTask: number; lastTurnOk?: boolean }

export interface RouterInput {
  mode: Mode;
  autoPrimary: ProviderId;
  configured: Record<ProviderId, boolean>;
  blockedUntil: Record<ProviderId, number>;
  /** The user's effort setting per provider. */
  preferred: Record<ProviderId, Effort>;
  /** What the running session uses, if any. */
  current?: ModelChoice;
  prompt: string;
  signals: TaskSignals;
  quota?: Quota;
  /** Claude is switched off for auto mode (it's being phased out), not merely unavailable. */
  claudeOff?: boolean;
  /** The repo's delegation split (Claude's target share, 0-1), its tokens today per provider and its usual day; replaces claudeRole. */
  split?: Split;
  contextTokens: number;
  /** Time since the last model call; the cache lives about 5 minutes. */
  idleMs: number;
  now: number;
}

export interface RouterDecision extends ModelChoice { reason: string; switching: boolean }

export interface Split { claudeTarget: number; claudeTokens: number; deepseekTokens: number; dayTokens: number }

/** Whose stint it is under a split, how many tokens it has run and how long it lasts (0: no rotation). */
export interface Stint { provider: ProviderId; used: number; size: number }

export const CACHE_TTL_MS = 5 * 60_000;
/** Below this, re-reading the context uncached costs less than staying on a pricier model. */
export const SMALL_CONTEXT_TOKENS = 20_000;
export const HARD_PROMPT_CHARS = 2000;
export const MECHANICAL_MAX_CHARS = 300;

/** Specific to hard work; everyday words ("why", "debug", "audit") stay out so wording alone doesn't pick Claude. */
export const HARD_WORDS = ['design', 'architecture', 'architect', 'race condition', 'concurrency', 'concurrent', 'deadlock', 'thread-safe',
  'bottleneck', 'security', 'vulnerability', 'migrate', 'migration', 'multi-module', 'across modules', 'root cause', 'flaky', 'intermittent',
  'memory leak', 'end-to-end', 'redesign', 'overhaul', 'plan out', 'from scratch', 'whole app', 'system design'];
/** Follow-ups that continue the current work on the current model. */
export const CONTINUE_RE = /^\s*(yes|yep|ok(ay)?|sure|go( ahead| for it| on)?|continue|carry on|keep going|do it|proceed|sounds good|approved?|next|please do)\b[\s\S]{0,60}$/i;
/** Prompts that point back at the current work. */
export const REFERS_BACK_RE = /\b(it|its|this|that|these|those|them|again|also|too|same|above|earlier|previous|before|still|instead|rest|remaining)\b/i;
/** Clearly mechanical one-liners; reading words ("show", "find", "list") are not. */
export const MECHANICAL_WORDS = ['rename', 'format', 'typo', 'lint', 'indent', 'spelling', 'docstring', 'bump', 'small edit', 'small change', 'one-line'];

/** Whole words or phrases, plus common inflections ("comments", "renamed"). */
const wordsRe = (words: string[]) => new RegExp(`\\b(?:${words.join('|')})(?:s|es|d|ed|ing)?\\b`, 'i');
const HARD_RE = wordsRe(HARD_WORDS);
const MECHANICAL_RE = wordsRe(MECHANICAL_WORDS);

/** Keyword and length based; hard words win over mechanical ones. */
export function classifyPrompt(prompt: string): 'mechanical' | 'normal' | 'hard' {
  if (prompt.length > HARD_PROMPT_CHARS || HARD_RE.test(prompt)) {
    return 'hard';
  }
  return prompt.length <= MECHANICAL_MAX_CHARS && MECHANICAL_RE.test(prompt) ? 'mechanical' : 'normal';
}

/** Epoch seconds or milliseconds, as rate-limit events vary. */
const toMs = (t: number) => (t < 1e12 ? t * 1000 : t);

/**
 * Whether Claude can take this turn without exhausting the subscription early:
 * usage may run at most 10 points ahead of the time elapsed in the window.
 */
export function claudeQuotaOk(quota: Quota | undefined, now: number): boolean {
  if (!quota) {
    return true;
  }
  const resetsAt = quota.resetsAt === undefined ? undefined : toMs(quota.resetsAt);
  if (resetsAt !== undefined && now >= resetsAt) {
    return true; // the window has reset, so the info is stale
  }
  if (quota.status === 'rejected' || quota.status === 'allowed_warning') {
    return false;
  }
  if (quota.utilization === undefined) {
    return true;
  }
  if (resetsAt !== undefined && quota.windowStart !== undefined) {
    const start = toMs(quota.windowStart);
    const elapsed = Math.min(1, Math.max(0, (now - start) / (resetsAt - start)));
    return quota.utilization <= elapsed + 0.1;
  }
  return quota.utilization < 0.8;
}

const same = (a: ModelChoice, b: ModelChoice) => a.provider === b.provider && a.effort === b.effort;

/**
 * Whether a message starts a new task, the only point where wording picks the
 * model: nothing runs yet, or losing the cache costs little (idle past its
 * lifetime, or a small context) and the prompt doesn't point back.
 */
export function startsTask(i: Pick<RouterInput, 'current' | 'prompt' | 'idleMs' | 'contextTokens'>): boolean {
  if (!i.current) {
    return true;
  }
  if (CONTINUE_RE.test(i.prompt) || REFERS_BACK_RE.test(i.prompt)) {
    return false;
  }
  return i.idleMs > CACHE_TTL_MS || i.contextTokens < SMALL_CONTEXT_TOKENS;
}

/** DeepSeek's model names for labels; the controller sets them from the models in use (models.ts displayName). */
const deepseekNames: Record<Effort, string> = { thinking: 'V4 Pro', flash: 'DeepSeek Flash' };
export function nameDeepSeekModels(names: Record<Effort, string>) {
  Object.assign(deepseekNames, names);
}

export function label(c: ModelChoice): string {
  return c.provider === 'claude' ? 'Claude' : deepseekNames[c.effort];
}

type Failures = Pick<TaskSignals, 'failedChecks' | 'toolErrors' | 'editFailures'>;

/** Plain failure counts that mean stuck, shared by both escalation checks. */
function failing(s: Failures, maxToolErrors: number): string | undefined {
  if (s.failedChecks >= 2) {
    return `checks failed ${s.failedChecks} times`;
  }
  if (s.editFailures >= 2) {
    return `${s.editFailures} failed edits`;
  }
  return s.toolErrors >= maxToolErrors ? `${s.toolErrors} tool errors` : undefined;
}

/** Why the task looks stuck across turns, or undefined when it doesn't. */
export function troubleReason(s: TaskSignals): string | undefined {
  const f = failing(s, 3);
  if (f) {
    return f;
  }
  if (s.turnsOnTask >= 6 && !s.lastTurnOk) {
    return `${s.turnsOnTask} turns without success`;
  }
  return undefined;
}

const other = (p: ProviderId): ProviderId => (p === 'claude' ? 'deepseek' : 'claude');
const usable = (input: RouterInput, p: ProviderId) => input.configured[p] && input.blockedUntil[p] <= input.now;

function decide(input: RouterInput, to: ModelChoice, reason: string): RouterDecision {
  return { ...to, reason, switching: !!input.current && !same(input.current, to) };
}

/** A provider picked by hand is never switched automatically (failures are reported instead). */
function fixed(input: RouterInput, p: ProviderId): RouterDecision {
  const to = { provider: p, effort: input.preferred[p] };
  return decide(input, to, `${label(to)}: chosen in settings`);
}

function claudeWhy(input: RouterInput): string {
  if (input.claudeOff) {
    return 'Claude is off';
  }
  if (!input.configured.claude) {
    return 'Claude not set up';
  }
  return input.blockedUntil.claude > input.now ? 'Claude paused' : 'Claude quota low';
}

export function route(input: RouterInput): RouterDecision {
  if (input.mode !== 'auto') {
    return fixed(input, input.mode);
  }
  const claudeOk = usable(input, 'claude') && claudeQuotaOk(input.quota, input.now);
  const claude: ModelChoice = { provider: 'claude', effort: input.preferred.claude };
  if (!usable(input, 'deepseek')) {
    if (usable(input, 'claude')) {
      return decide(input, claude, 'Claude: DeepSeek unavailable');
    }
    const to = { provider: input.autoPrimary, effort: input.preferred[input.autoPrimary] };
    return decide(input, to, `${label(to)}: no provider available`);
  }
  return ladder(input, claudeOk);
}

const sharePct = (x: number) => `${Math.round(x * 100)}%`;

const millions = (n: number) => `${(n / 1e6).toFixed(1)}M`;

/**
 * Stints: each side runs half its share of a usual day, then hands over, the
 * bigger share first (70/30: Claude 35%, DeepSeek 15%, twice a day). Counted
 * from the totals alone, so every chat and window agrees, and overshoot (a
 * task finishing, an escalation) shortens that side's next stint.
 */
export function currentStint(split: Split): Stint {
  const t = split.claudeTarget;
  const tokens = { claude: split.claudeTokens, deepseek: split.deepseekTokens };
  if (t >= 1 || t <= 0) {
    const provider = t >= 1 ? 'claude' : 'deepseek';
    return { provider, used: tokens[provider], size: 0 };
  }
  // Whole tokens: 0.3 isn't exact in floating point, and a stint must end on its last token.
  const size = { claude: Math.max(1, Math.round((t / 2) * split.dayTokens)), deepseek: Math.max(1, Math.round(((1 - t) / 2) * split.dayTokens)) };
  const done = { claude: Math.floor(tokens.claude / size.claude), deepseek: Math.floor(tokens.deepseek / size.deepseek) };
  const first: ProviderId = t >= 0.5 ? 'claude' : 'deepseek';
  const provider = done[first] <= done[other(first)] ? first : other(first);
  return { provider, used: tokens[provider] - done[provider] * size[provider], size: size[provider] };
}

const NAMES: Record<ProviderId, string> = { claude: 'Claude', deepseek: 'DeepSeek' };

/** "Claude stint 0.8M of 1.4M", for reasons and the chat. */
export const describeStint = (s: Stint) => (s.size ? `${NAMES[s.provider]} stint ${millions(s.used)} of ${millions(s.size)}` : `${NAMES[s.provider]} only`);

/**
 * A new task under a delegation split goes to whoever's stint it is, so the
 * provider changes only between tasks. Quick edits take Flash in either stint:
 * Claude's stint is for work that needs it, not renames and typos.
 */
function splitLevel(split: Split, stint: Stint, kind: ReturnType<typeof classifyPrompt>, claudeOk: boolean): { level: number; why: string } {
  const level = kind === 'mechanical' ? 0 : claudeOk && stint.provider === 'claude' ? 2 : 1;
  // "Claude: … Claude stint" would repeat the label.
  const own = level === 2 && stint.provider === 'claude';
  const part = !stint.size ? '' : own ? `, stint ${millions(stint.used)} of ${millions(stint.size)}` : `, ${describeStint(stint)}`;
  return { level, why: `split ${sharePct(split.claudeTarget)} Claude${part}` };
}

/** 0 Flash, 1 V4 Pro, 2 Claude. */
const LEVELS = (claudeEffort: Effort): ModelChoice[] => [{ provider: 'deepseek', effort: 'flash' }, { provider: 'deepseek', effort: 'thinking' }, { provider: 'claude', effort: claudeEffort }];
export const levelOf = (c: ModelChoice) => (c.provider === 'claude' ? 2 : c.effort === 'thinking' ? 1 : 0);

/**
 * Trouble steps up a level; otherwise a task keeps its model, and a new task
 * gets the level it needs. Hard work goes to Claude only when Claude is
 * primary (its subscription is already paid for); with DeepSeek primary,
 * Claude is reached by escalating from a stuck V4 Pro.
 */
function ladder(input: RouterInput, claudeOk: boolean): RouterDecision {
  const top = claudeOk ? 2 : 1;
  const from = input.current && levelOf(input.current);
  const trouble = troubleReason(input.signals);
  const kind = classifyPrompt(input.prompt);
  const fresh = from === undefined || startsTask(input);
  const stint = input.split && currentStint(input.split);

  let level: number;
  let why: string;
  let escalated = false;
  if (trouble && from !== undefined) {
    level = Math.min(Math.max(from + 1, kind === 'hard' ? 1 : 0), top);
    escalated = level > from;
    why = escalated ? trouble : `${trouble}, strongest available`;
  } else if (!fresh) {
    // One main model per task: never down, and up only on evidence. Claude out of quota is the one forced move.
    level = Math.min(from!, top);
    why = 'same task';
  } else if (input.split && stint) {
    ({ level, why } = splitLevel(input.split, stint, kind, claudeOk));
  } else if (kind === 'hard') {
    level = input.autoPrimary === 'claude' ? top : 1;
    why = 'hard task';
  } else if (kind === 'mechanical') {
    level = 0;
    why = 'mechanical change';
  } else {
    level = 1;
    why = 'coding task';
  }
  // Claude was running or wanted (its stint, or hard work with Claude primary) but can't take it: say why, once.
  const wanted = input.current?.provider === 'claude' || (fresh && (stint ? stint.provider === 'claude' : input.autoPrimary === 'claude' && kind === 'hard'));
  if (level < 2 && !claudeOk && wanted) {
    why = `${why} (${claudeWhy(input)})`;
  }
  const to = LEVELS(input.preferred.claude)[level];
  return decide(input, to, `${escalated ? 'escalated to ' : ''}${label(to)}: ${why}`);
}

/** What the main agent did so far this turn; helpers don't count. */
export interface TurnEvidence {
  modelCalls: number;
  toolErrors: number;
  editFailures: number;
  failedChecks: number;
  /** Files read (Read). */
  reads?: number;
  /** Searches (Grep, Glob, a shell rg/grep/find), and how many repeated an earlier one exactly. */
  searches?: number;
  repeatedSearches?: number;
}

/** The first steps' evidence is read once this many have run, and until EARLY_WINDOW (escalating later re-reads more uncached). */
export const EARLY_CALLS = 3;
export const EARLY_WINDOW = 12;
/** Backstop: a turn this long escalates whatever the evidence. */
export const MAX_CALLS = 40;

/**
 * Whether to escalate mid-turn from `current`, routing on the first steps'
 * evidence rather than the prompt's wording (SWE-Router). Plain failures count
 * any time; errors, repeated searches or searching without finding a file
 * count in the first steps; a clean run never escalates before MAX_CALLS.
 */
export function earlyEscalation(e: TurnEvidence, current: ModelChoice): string | undefined {
  if (levelOf(current) >= 2) {
    return undefined;
  }
  const f = failing(e, 4);
  if (f) {
    return f;
  }
  if (e.modelCalls >= EARLY_CALLS && e.modelCalls <= EARLY_WINDOW) {
    const steps = `in the first ${e.modelCalls} steps`;
    if (e.toolErrors >= 2 && (e.failedChecks + e.editFailures >= 1 || e.toolErrors * 2 >= e.modelCalls)) {
      return `${e.toolErrors} tool errors ${steps}`;
    }
    if ((e.repeatedSearches ?? 0) >= 2) {
      return `${e.repeatedSearches} repeated searches ${steps}`;
    }
    if (!e.reads && (e.searches ?? 0) >= EARLY_CALLS) {
      return `no file read after ${e.searches} searches`;
    }
  }
  return e.modelCalls >= MAX_CALLS ? `${e.modelCalls} steps without finishing` : undefined;
}


/** How far DeepSeek may run ahead of its share before delegated work goes back to Claude, so helpers don't flip every turn. */
export const HELPER_SPLIT_MARGIN = 0.05;

export interface RosterInput {
  /** Whether the other provider can take helpers in this session: set up, allowed and not paused. */
  deepseekReady: boolean;
  claudeReady: boolean;
  /** Claude's quota is on pace (claudeQuotaOk). */
  claudeOk: boolean;
  split?: Split;
  /** Who does the delegated work now. */
  current?: ProviderId;
}

/**
 * Who runs each helper tier, whichever provider leads. Delegated work (quick
 * jobs, searches, general tasks) and planning (Plan, deep-thinker) run on the
 * same provider, chosen by the split: DeepSeek while it is below its share
 * (always, with no split), Claude once DeepSeek is ahead by the margin — so a
 * DeepSeek-led chat uses Claude too. Each side plans on its strongest model:
 * Claude on Opus, DeepSeek on V4 Pro (never Flash), so the hard thinking stays
 * balanced between the two providers.
 */
export function helperRoster(main: ProviderId, i: RosterInput): HelperRoster {
  const claude = (main === 'claude' || i.claudeReady) && i.claudeOk;
  const deepseek = main === 'deepseek' || i.deepseekReady;
  const work: ProviderId = deepseek && (claude || main === 'claude') ? workFor(i) : main;
  const plan: ProviderId = claude && deepseek ? work : claude ? 'claude' : deepseek ? 'deepseek' : main;
  return { work, plan };
}

function workFor(i: RosterInput): ProviderId {
  const s = i.split;
  if (!s) {
    return 'deepseek';
  }
  const target = 1 - s.claudeTarget;
  const total = s.claudeTokens + s.deepseekTokens;
  const share = total ? s.deepseekTokens / total : 0;
  if (target <= 0) {
    return 'claude';
  }
  return share < target || (i.current === 'deepseek' && share < target + HELPER_SPLIT_MARGIN) ? 'deepseek' : 'claude';
}
