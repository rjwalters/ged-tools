export const DEFAULT_POOL_CONCURRENCY = 3;

export async function runPool(items, worker, opts = {}) {
  const { concurrency = DEFAULT_POOL_CONCURRENCY, shouldAbort = () => false } = opts;
  if (typeof worker !== 'function') {
    throw new Error(`runPool needs a worker function, got ${typeof worker}`);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`runPool concurrency must be a positive integer, got ${JSON.stringify(concurrency)}`);
  }

  const results = new Array(items.length);
  const controller = new AbortController();
  let next = 0;
  let aborted = false;

  const runner = async () => {
    for (;;) {
      if (aborted || next >= items.length) return;
      const i = next++;
      let record;
      try {
        record = { ok: true, value: await worker(items[i], i, { signal: controller.signal }) };
      } catch (error) {
        record = { ok: false, error };
      }
      results[i] = record;
      if (!aborted && shouldAbort(record, items[i], i)) {
        aborted = true;
        controller.abort();
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));

  let skipped = 0;
  for (let i = 0; i < items.length; i++) {
    if (!results[i]) {
      results[i] = { skipped: true };
      skipped++;
    }
  }
  return { results, aborted, skipped };
}
