/** Promise helpers shared across the extension. */

/** `promise`'s result, or a rejection naming `what` if it takes longer than `ms`. */
export function withTimeout<T>(promise: PromiseLike<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}
