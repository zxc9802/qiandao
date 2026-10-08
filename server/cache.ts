/** One cached value per instance; concurrent misses share the same database read. */
export function shortCache<T>(ttlMs: number, read: () => Promise<T>) {
  let current: { promise: Promise<T>; expires: number } | undefined;
  return {
    get(): Promise<T> {
      if (!current || current.expires <= Date.now()) {
        const entry = { promise: Promise.resolve().then(read), expires: Infinity };
        current = entry;
        entry.promise = entry.promise.then(value => { entry.expires = Date.now() + ttlMs; return value; }, error => {
          if (current === entry) current = undefined;
          throw error;
        });
      }
      return current.promise;
    },
    clear() { current = undefined; },
  };
}
