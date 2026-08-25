/**
 * Minimal promise-concurrency gate. Keeps upstream fan-out polite without
 * pulling in a dependency for twenty lines of queueing.
 */
export function createLimiter(concurrency: number): <T>(task: () => Promise<T>) => Promise<T> {
  const max = Math.max(1, Math.floor(concurrency));
  let active = 0;
  const queue: Array<() => void> = [];

  const release = (): void => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };

  return function limit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        active += 1;
        void (async () => {
          try {
            resolve(await task());
          } catch (error) {
            reject(error);
          } finally {
            release();
          }
        })();
      };
      if (active < max) run();
      else queue.push(run);
    });
  };
}

/** Run `worker` over `items` with bounded parallelism, preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = createLimiter(concurrency);
  return Promise.all(items.map((item, index) => limit(() => worker(item, index))));
}
