import express from 'express';
import { createApp } from '../../server/app.ts';
import { makersUploads } from '../../server/uploads.ts';

const app = express();
let service: ReturnType<typeof createApp> | undefined;
app.use(async (req, res, next) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: '数据库尚未配置。' });
  service ||= createApp('/tmp/checkin', undefined, makersUploads()).catch(error => { service = undefined; throw error; });
  try { (await service).app(req, res, next); }
  catch (error) { console.error('签到服务初始化失败', error instanceof Error ? error.message : 'unknown'); res.status(503).json({ error: '服务暂时不可用，请稍后重试。' }); }
});
export default app;
