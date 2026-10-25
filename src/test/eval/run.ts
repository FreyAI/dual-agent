/**
 * The eval CLI: runs each task under each settings "arm" against the real
 * providers, grades the result with hidden tests, and writes rows plus a
 * Markdown summary. Spends real credit, so it stops starting runs once the
 * budget would be exceeded.
 *
 *   npm run eval -- --arms baseline,ds-flash --tasks bug-paginate,feat-lru --k 2 --budget 5
 *   npm run eval -- --arms baseline,mine --arm-json mine='{"mode":"deepseek","buildMode":"reuse"}'
 *
 * The first arm is the baseline for the paired comparison. Output goes to
 * eval-results/<time>.jsonl and eval-results/<time>.md.
 */
import { resetConfig } from '../helpers/vscodeStub';
import * as fs from 'fs';
import * as path from 'path';
import { trackEditor } from '../../context';
import { liveChat } from '../helpers/liveChat';
import { TurnMetrics } from '../../metrics/turns';
import { gradeFolder, setUp } from './grade';
import { Row, claimsDone, combine, renderReport } from './report';
import { TASKS, EvalTask } from './tasks';

/** Named settings overrides. `baseline` keeps the extension's defaults. */
export const ARMS: Record<string, Record<string, unknown>> = {
  baseline: {},
  'ds-flash': { mode: 'deepseek', effort: 'flash', 'deepseek.effort': 'flash', buildMode: 'craft' },
  'ds-pro': { mode: 'deepseek', effort: 'thinking', 'deepseek.effort': 'thinking', buildMode: 'craft' },
};

const RUN_TIMEOUT_MS = 10 * 60_000;

export interface Options {
  arms: string[];
  tasks: string[];
  k: number;
  budget: number;
  keyFile: string;
  armOverrides: Record<string, Record<string, unknown>>;
}

/** Parses argv; throws a readable message on bad input. */
export function parseArgs(argv: string[]): Options {
  const values = (name: string) => argv.flatMap((a, i) => (a === '--' + name && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
  const get = (name: string, fallback: string) => values(name).at(-1) ?? fallback;
  const armOverrides: Record<string, Record<string, unknown>> = { ...ARMS };
  for (const spec of values('arm-json')) {
    const eq = spec.indexOf('=');
    if (eq < 1) {
      throw new Error('--arm-json expects name=\'{"key":value}\', got: ' + spec);
    }
    try {
      armOverrides[spec.slice(0, eq)] = JSON.parse(spec.slice(eq + 1));
    } catch (err) {
      throw new Error('--arm-json ' + spec.slice(0, eq) + ' is not valid JSON: ' + (err as Error).message);
    }
  }
  const opts: Options = {
    arms: get('arms', 'baseline,ds-flash').split(',').filter(Boolean),
    tasks: get('tasks', TASKS.map((t) => t.id).join(',')).split(',').filter(Boolean),
    k: Number(get('k', '1')),
    budget: Number(get('budget', '5')),
    keyFile: get('key-file', process.env.DEEPSEEK_KEY_FILE ?? path.resolve(__dirname, '../../../credentials/deepseek.env')),
    armOverrides,
  };
  const unknownArm = opts.arms.find((a) => !armOverrides[a]);
  if (unknownArm) {
    throw new Error('Unknown arm "' + unknownArm + '". Known: ' + Object.keys(armOverrides).join(', '));
  }
  const unknownTask = opts.tasks.find((t) => !TASKS.some((x) => x.id === t));
  if (unknownTask) {
    throw new Error('Unknown task "' + unknownTask + '". Known: ' + TASKS.map((t) => t.id).join(', '));
  }
  if (!(opts.k >= 1) || !(opts.budget > 0)) {
    throw new Error('--k must be at least 1 and --budget above 0');
  }
  return opts;
}

async function runOnce(task: EvalTask, arm: string, run: number, opts: Options): Promise<Row> {
  const overrides = opts.armOverrides[arm];
  const root = setUp(task);
  resetConfig({
    mode: 'claude',
    effort: 'thinking',
    'deepseek.effort': 'thinking',
    permissionMode: 'bypassPermissions',
    autoPrimary: 'claude',
    fallbackCooldownMinutes: 30,
    'deepseek.apiKeyFile': opts.keyFile,
    ...overrides,
  });
  const chat = liveChat(root, { answerQuestions: true, approvePlans: true, quiet: true, timeoutMs: RUN_TIMEOUT_MS });
  let reply = '';
  let outcome = 'done';
  let error = '';
  try {
    reply = (await chat.ask(task.prompt)).reply;
  } catch (err) {
    outcome = /still busy/.test((err as Error).message) ? 'timeout' : 'error';
    error = outcome === 'timeout' ? 'Run exceeded ' + RUN_TIMEOUT_MS / 60_000 + ' minutes and was stopped.' : 'Run failed: ' + (err as Error).message;
    chat.controller.stop();
    reply = chat.posted.filter((m) => m.type === 'delta').map((m: any) => m.text).join('').trim();
  }
  const metrics = chat.posted.flatMap((m) => (m.type === 'done' && (m as any).metrics ? [(m as any).metrics as TurnMetrics] : []));
  const sum = combine(metrics);
  // A run that never started (no 'done' metrics) is not "done" even if nothing threw.
  if (outcome === 'done' && sum.outcome !== 'done') {
    outcome = sum.outcome;
  }
  const grade = await gradeFolder(root, task);
  chat.controller.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  return {
    task: task.id,
    arm,
    kind: task.kind,
    run,
    pass: grade.pass,
    claimedDone: claimsDone(reply),
    inputTokens: sum.input,
    outputTokens: sum.output,
    cacheRead: sum.cacheRead,
    cost: sum.cost,
    durationMs: sum.durationMs,
    toolCalls: sum.toolCalls,
    toolErrors: sum.toolErrors,
    modelCalls: sum.modelCalls,
    outcome,
    gradeOutput: (error ? error + '\n' : '') + grade.output,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const needsKey = opts.arms.some((a) => opts.armOverrides[a].mode === 'deepseek');
  if (needsKey && !fs.existsSync(opts.keyFile)) {
    throw new Error('DeepSeek key file not found: ' + opts.keyFile + ' (use --key-file or set DEEPSEEK_KEY_FILE)');
  }
  trackEditor(() => {});
  const dir = path.resolve(__dirname, '../../../eval-results');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonl = path.join(dir, stamp + '.jsonl');
  const rows: Row[] = [];
  let spent = 0;
  let stopped = false;
  outer: for (let run = 0; run < opts.k; run++) {
    for (const taskId of opts.tasks) {
      const task = TASKS.find((t) => t.id === taskId)!;
      // Alternate arm order so drift over time does not favour one arm.
      const order = run % 2 === 0 ? [...opts.arms].reverse() : opts.arms;
      for (const arm of order) {
        const estimate = rows.length ? spent / rows.length : 0;
        if (spent + estimate > opts.budget) {
          console.log('Budget $' + opts.budget + ' would be exceeded ($' + spent.toFixed(3) + ' spent, ~$' + estimate.toFixed(3) + ' per run); stopping.');
          stopped = true;
          break outer;
        }
        process.stdout.write(task.id + ' / ' + arm + ' / run ' + (run + 1) + ' ... ');
        const row = await runOnce(task, arm, run, opts);
        rows.push(row);
        spent += row.cost;
        fs.appendFileSync(jsonl, JSON.stringify(row) + '\n');
        console.log((row.pass ? 'PASS' : 'FAIL') + ' (' + row.outcome + ', $' + row.cost.toFixed(4) + ', total $' + spent.toFixed(3) + ')');
      }
    }
  }
  const md = renderReport(rows, opts.arms) + (stopped ? '\nStopped early: budget of $' + opts.budget + ' reached.\n' : '');
  fs.writeFileSync(jsonl.replace(/\.jsonl$/, '.md'), md);
  console.log('\n' + md + '\nRows: ' + jsonl);
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
