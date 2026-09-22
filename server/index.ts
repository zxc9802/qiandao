import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { createApp } from './app.ts';

const { app } = createApp(process.env.DATA_DIR || path.resolve('data'));
const dist = path.resolve('dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}
const port = Number(process.env.PORT || 3001);
app.listen(port, '0.0.0.0', () => console.log(`相遇签到服务已启动：http://localhost:${port}`));
