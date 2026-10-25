/**
 * Small statistics for metrics and benchmarks. Token counts are heavy-tailed
 * and vary a lot between runs of the same task, so comparisons use paired,
 * per-task log ratios with a bootstrap interval rather than plain averages.
 */

/** The p-th percentile (0-100) by linear interpolation; undefined for no data. */
export function percentile(values: number[], p: number): number | undefined {
  if (!values.length) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(at);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (at - lo);
}

export const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

/** Geometric mean of positive ratios. */
export const geometricMean = (ratios: number[]) => Math.exp(mean(ratios.map(Math.log)));

/** A deterministic generator, so a benchmark report can be reproduced. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** 95% bootstrap interval of the geometric mean of per-task ratios. */
export function bootstrapRatioCI(ratios: number[], samples = 2000, seed = 1): [number, number] {
  if (ratios.length < 2) {
    const only = ratios[0] ?? 1;
    return [only, only];
  }
  const rand = seeded(seed);
  const logs = ratios.map(Math.log);
  const means: number[] = [];
  for (let i = 0; i < samples; i++) {
    let sum = 0;
    for (let j = 0; j < logs.length; j++) {
      sum += logs[Math.floor(rand() * logs.length)];
    }
    means.push(sum / logs.length);
  }
  return [Math.exp(percentile(means, 2.5)!), Math.exp(percentile(means, 97.5)!)];
}

/** Mean of paired differences (b − a per task) with its 95% normal interval. */
export function pairedDifference(a: number[], b: number[]): { mean: number; low: number; high: number } {
  const d = a.map((x, i) => b[i] - x);
  const m = mean(d);
  const se = d.length > 1 ? Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / (d.length - 1) / d.length) : 0;
  return { mean: m, low: m - 1.96 * se, high: m + 1.96 * se };
}
