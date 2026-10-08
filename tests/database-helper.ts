import path from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { createApp } from '../server/app.ts';
import type { UploadStore } from '../server/uploads.ts';
import { schema, postgresSql, type Database, type Executor, type Row } from '../server/db.ts';

export async function createTestApp(dir: string, uploads?: UploadStore) {
  if (process.env.TEST_POSTGRES !== '1') return createApp(dir, undefined, uploads);
  const pg = new PGlite(path.join(dir, 'postgres'));
  await pg.exec(schema(true));
  const executor = (connection: PGlite | Transaction): Executor => ({
    async query(sql, ...values) {
      const result = await connection.query<Row>(postgresSql(sql), values);
      return { rows: result.rows, changes: result.affectedRows || 0 };
    },
  });
  const database: Database = {
    dialect: 'postgres',
    ...executor(pg),
    transaction: work => pg.transaction(tx => work(executor(tx))),
    close: () => pg.close(),
  };
  return createApp(dir, database, uploads);
}
