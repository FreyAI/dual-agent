/** The tiny test runner the in-VS Code suites use (mocha isn't bundled), and a polling wait. */

export async function waitFor<T>(what: string, check: () => T | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) {
      return value;
    }
    if (Date.now() > end) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const tests: [string, () => Promise<void>][] = [];
export const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

export async function run(): Promise<void> {
  const failures: string[] = [];
  for (const [name, fn] of tests) {
    const started = Date.now();
    try {
      await fn();
      console.log(`  ✔ ${name} (${Date.now() - started}ms)`);
    } catch (err) {
      console.log(`  ✖ ${name}\n    ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      failures.push(name);
    }
  }
  console.log(`\n  ${tests.length - failures.length} passed, ${failures.length} failed`);
  if (failures.length) {
    throw new Error(`${failures.length} VS Code test(s) failed`);
  }
}
