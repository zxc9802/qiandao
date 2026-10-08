import path from 'node:path';
import { openDatabase } from '../server/db.ts';

process.env.DB_MIGRATE_ON_START = '1';
const db = await openDatabase(process.env.DATA_DIR || path.resolve('data'));
await db.close();
console.log('数据库表与索引已就绪。');
