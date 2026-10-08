import type { Store } from 'express-rate-limit';
import type { Database } from './db.ts';

export async function incrementRateLimits(db: Database, keys: string[], windowMs: number) {
  const now = Date.now();
  // Reset expired windows in the same statement as the increment, across instances.
  return (await db.query(`INSERT INTO rate_limits (key, hits, expires) VALUES ${keys.map(() => '(?, 1, ?)').join(', ')}
    ON CONFLICT(key) DO UPDATE SET
      hits = CASE WHEN rate_limits.expires <= ? THEN 1 ELSE rate_limits.hits + 1 END,
      expires = CASE WHEN rate_limits.expires <= ? THEN excluded.expires ELSE rate_limits.expires END
    RETURNING key, hits, expires`, ...keys.flatMap(key => [key, now + windowMs]), now, now)).rows;
}

export function databaseRateLimit(db: Database, prefix: string): Store {
  let windowMs = 60000;
  return {
    prefix,
    init(options) { windowMs = options.windowMs; },
    async increment(key) {
      const row = (await incrementRateLimits(db, [prefix + key], windowMs))[0];
      return { totalHits: Number(row.hits), resetTime: new Date(Number(row.expires)) };
    },
    async decrement(key) { await db.query('UPDATE rate_limits SET hits = CASE WHEN hits > 0 THEN hits - 1 ELSE 0 END WHERE key = ?', prefix + key); },
    async resetKey(key) { await db.query('DELETE FROM rate_limits WHERE key = ?', prefix + key); },
  };
}
