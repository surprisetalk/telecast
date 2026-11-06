// The first worker error rejects the run. Callers catch each expected per-item failure inside work().
export async function pool<T>(items: readonly T[], n: number, work: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await work(items[i++]!);
  });
  await Promise.all(workers);
}
