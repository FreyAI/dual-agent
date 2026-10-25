/**
 * The hard tasks, one module each, so a broken fixture fails its own load test
 * (LOAD_ERRORS) instead of taking every other task down with it.
 */
import { HardTask } from '../fixture';

export const HARD_IDS = ['find-file', 'misleading-trace', 'wide-refactor', 'cross-module', 'regression-trap', 'stale-docs', 'perf'];

export const LOAD_ERRORS: Record<string, string> = {};

export const HARD_TASKS: HardTask[] = HARD_IDS.flatMap((id) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return [(require('./' + id) as { hard: HardTask }).hard];
  } catch (err) {
    LOAD_ERRORS[id] = (err as Error).message;
    return [];
  }
});
