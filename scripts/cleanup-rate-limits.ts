import path from 'node:path';
import { openDatabase } from '../server/db.ts';

// Run outside request handling. Keep a one-day grace period to avoid hot rows.
const db = await openDatabase(process.env.DATA_DIR || path.resolve('data'));
try {
  const result = await db.query('DELETE FROM rate_limits WHERE expires < ? RETURNING key', Date.now() - 24 * 3600000);
  console.log(`已清理 ${result.rows.length} 条过期限流记录。`);
} finally { await db.close(); }
