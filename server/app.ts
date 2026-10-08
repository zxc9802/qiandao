import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { openDatabase, DatabaseUnavailableError, type Database } from './db.ts';
import { normalizePhone, validPhone, parseImport, type PersonInput } from './importer.ts';
import { databaseRateLimit, incrementRateLimits } from './rate-limit-store.ts';
import { shortCache } from './cache.ts';
import type { UploadStore } from './uploads.ts';
import { registrationName, registrationKey } from '../shared/registration.ts';

type PersonRow = { id: number; phone: string; name: string; fields: string; token: string; checked_at: string | null; created_at: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const serialize = ({ token: _, ...row }: PersonRow) => ({ ...row, fields: JSON.parse(row.fields) });

export async function createApp(dataDir: string, database?: Database, uploads?: UploadStore) {
  const ticketIpLimit = Number(process.env.TICKET_IP_LIMIT || 600);
  if (!Number.isSafeInteger(ticketIpLimit) || ticketIpLimit < 1) throw new Error('TICKET_IP_LIMIT 必须为正整数。');
  const app = express();
  if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY.split(',').map(value => value.trim()));
  const db = database || await openDatabase(dataDir);
  const getSetting = async (key: string) => (await db.query('SELECT value FROM settings WHERE key = ?', key)).rows[0]?.value as string | undefined;
  const setSetting = (key: string, value: string) => db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  const initSetting = (key: string, value: string) => db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING RETURNING key', key, value);
  const eventCache = shortCache(5000, async () => JSON.parse((await getSetting('event'))!));
  const dashboardCache = shortCache(2000, async () => {
    const [statsResult, recentResult, importsResult] = await Promise.all([
      db.query('SELECT COUNT(*) AS total, COUNT(checked_at) AS checked FROM people'),
      db.query('SELECT * FROM people WHERE checked_at IS NOT NULL ORDER BY checked_at DESC LIMIT 5'),
      db.query('SELECT * FROM imports ORDER BY id DESC LIMIT 5'),
    ]);
    const stats = statsResult.rows[0];
    return { stats: { total: Number(stats.total), checked: Number(stats.checked) }, recent: (recentResult.rows as PersonRow[]).map(serialize), imports: importsResult.rows };
  });
  await initSetting('event', JSON.stringify({ title: '线下活动签到', date: '', time: '', location: '', description: '欢迎赴约，期待与你相遇。' }));
  if (!await getSetting('password')) {
    const password = process.env.ADMIN_PASSWORD;
    if (password !== undefined) {
      if (password.length < 8 || password.length > 128) { await db.close(); throw new Error('ADMIN_PASSWORD 必须为 8–128 位。'); }
      const salt = randomBytes(16).toString('hex');
      await initSetting('password', `${salt}:${scryptSync(password, salt, 64).toString('hex')}`);
    } else if (process.env.NODE_ENV === 'production') {
      await db.close();
      throw new Error('首次生产部署请设置 ADMIN_PASSWORD，避免后台初始化入口暴露到公网。');
    }
  }
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
      const allowed = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`;
      if (req.headers.origin !== allowed) return res.status(403).json({ error: '请求来源不匹配，请在本站重新操作。' });
    }
    next();
  });
  const sessionHash = (req: Request) => {
    const cookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('meet_session='))?.slice(13);
    return cookie ? hash(cookie) : '';
  };
  const isAdmin = async (req: Request) => !!(await db.query('SELECT 1 FROM sessions WHERE token_hash = ? AND expires > ?', sessionHash(req), Date.now())).rows[0];
  const requireAdmin = async (req: Request, res: Response, next: NextFunction) => await isAdmin(req) ? next() : res.status(401).json({ error: '请先登录主办方后台。' });
  const newSession = async (req: Request, res: Response) => {
    const token = randomBytes(32).toString('hex');
    (await db.query('DELETE FROM sessions WHERE expires < ?', Date.now()));
    (await db.query('INSERT INTO sessions VALUES (?, ?)', hash(token), Date.now() + 12 * 3600000));
    res.cookie('meet_session', token, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 12 * 3600000, path: '/' });
  };
  const authLimit = rateLimit({ store: databaseRateLimit(db, 'auth:'), windowMs: 15 * 60000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: '尝试过于频繁，请 15 分钟后再试。' } });
  app.get('/api/health', async (_req, res) => { await db.query('SELECT 1'); res.json({ ok: true, revision: process.env.APP_REVISION || 'local', build: 'concurrency-20261004-cloudbase-2' }); });
  app.get('/api/public/event', async (_req, res) => res.json(await eventCache.get()));
  app.get('/api/auth/status', async (req, res) => res.json({ setupRequired: !await getSetting('password'), authenticated: await isAdmin(req) }));
  app.post('/api/auth/setup', authLimit, async (req, res) => {
    if (await getSetting('password')) return res.status(409).json({ error: '后台已经初始化，请使用密码登录。' });
    const password = req.body.password;
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) return res.status(400).json({ error: '请设置 8–128 位管理密码。' });
    const salt = randomBytes(16).toString('hex');
    const initialized = await initSetting('password', `${salt}:${scryptSync(password, salt, 64).toString('hex')}`);
    if (!initialized.rows.length) return res.status(409).json({ error: '后台已经初始化，请使用密码登录。' });
    await newSession(req, res); res.json({ ok: true });
  });
  app.post('/api/auth/login', authLimit, async (req, res) => {
    const stored = await getSetting('password');
    if (!stored) return res.status(400).json({ error: '请先初始化主办方后台。' });
    const password = req.body.password;
    if (typeof password !== 'string' || password.length > 128) return res.status(400).json({ error: '密码格式无效。' });
    const [salt, expected] = stored.split(':');
    if (!timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(expected, 'hex'))) return res.status(401).json({ error: '管理密码不正确。' });
    await newSession(req, res); res.json({ ok: true });
  });
  app.post('/api/auth/logout', async (req, res) => {
    (await db.query('DELETE FROM sessions WHERE token_hash = ?', sessionHash(req)));
    (await db.query('DELETE FROM drafts WHERE session_hash = ?', sessionHash(req)));
    res.clearCookie('meet_session', { path: '/' }); res.json({ ok: true });
  });
  app.post('/api/public/ticket', async (req, res) => {
    const phone = normalizePhone(req.body.phone);
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const people = validPhone(phone) ? (await db.query('SELECT name, token FROM people WHERE phone = ? ORDER BY id', phone)).rows : [];
    const ipKey = 'ticket-ip:' + ipKeyGenerator(req.ip || req.socket.remoteAddress || 'unknown');
    const keys = [ipKey];
    if (validPhone(phone)) keys.push('ticket-phone:' + hash(phone));
    const personKey = 'ticket-person:' + hash(registrationKey(phone, name));
    if (validPhone(phone) && name) keys.push(personKey);
    const limits = await incrementRateLimits(db, keys, 60000);
    const phoneLimit = people.length > 1 ? people.length * 10 : 5;
    const exceeded = limits.find(row => Number(row.hits) > (row.key === ipKey ? ticketIpLimit : row.key === personKey ? 5 : phoneLimit));
    if (exceeded) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((Number(exceeded.expires) - Date.now()) / 1000)));
      return res.status(429).json({ error: '领取频率过高，请稍后重试。' });
    }
    if (!validPhone(phone)) return res.status(400).json({ error: '请输入正确的手机号或带区号的座机号码。' });
    if (req.body.name !== undefined && (typeof req.body.name !== 'string' || name.length > 100)) return res.status(400).json({ error: '姓名格式错误或过长。' });
    const maskedPhone = `${phone.slice(0, 3)} **** ${phone.slice(-4)}`;
    if (people.length > 1 && !name) return res.json({ needsName: true, phone: maskedPhone });
    const person = name ? people.find(person => person.name === name) : people[0];
    if (!person) return res.status(404).json({ error: '暂未查到登记信息，请核对报名电话和姓名，或联系现场工作人员。' });
    res.json({ code: `checkin:v1:${person.token}`, phone: maskedPhone });
  });
  app.use('/api/admin', requireAdmin);
  app.get('/api/admin/dashboard', async (_req, res) => res.json(await dashboardCache.get()));
  app.get('/api/admin/people', async (req, res) => {
    const q = String(req.query.q || '').slice(0, 100);
    const status = req.query.status;
    const condition = `WHERE (phone LIKE ? ESCAPE '\\' OR fields LIKE ? ESCAPE '\\')${status === 'checked' ? ' AND checked_at IS NOT NULL' : status === 'pending' ? ' AND checked_at IS NULL' : ''}`;
    const needle = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
    const { total } = (await db.query(`SELECT COUNT(*) AS total FROM people ${condition}`, needle, needle)).rows[0] as { total: number };
    const rows = (await db.query(`SELECT * FROM people ${condition} ORDER BY id DESC LIMIT 30 OFFSET ?`, needle, needle, (page - 1) * 30)).rows as PersonRow[];
    res.json({ total: Number(total), page, people: rows.map(serialize) });
  });
  app.get('/api/admin/people/export', async (_req, res) => {
    const rows = ((await db.query('SELECT * FROM people ORDER BY id')).rows as PersonRow[]).map(serialize);
    const headers = [...new Set(rows.flatMap(row => Object.keys(row.fields)))];
    const cell = (value: unknown) => { const str = String(value ?? ''); return `"${(/^[=+@\-\t\r]/.test(str) ? "'" : '') + str.replaceAll('"', '""')}"`; };
    const data = [['联系电话', ...headers, '签到时间'], ...rows.map(row => [row.phone, ...headers.map(key => row.fields[key]), row.checked_at ? new Date(row.checked_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未签到'])];
    res.setHeader('Content-Disposition', 'attachment; filename="checkin-records.csv"');
    res.type('text/csv; charset=utf-8').send('\uFEFF' + data.map(row => row.map(cell).join(',')).join('\r\n'));
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
  app.get('/api/admin/import/options', (_req, res) => res.json({ directUpload: !!uploads }));
  app.post('/api/admin/import/upload', async (req, res) => {
    if (!uploads) return res.status(400).json({ error: '当前服务不需要直传，请刷新后重试。' });
    const { filename, size } = req.body;
    if (typeof filename !== 'string' || filename.length > 255 || !/\.(xlsx|csv|docx|pdf)$/i.test(filename)) return res.status(400).json({ error: '请选择 XLSX、CSV、DOCX 或 PDF 文件。' });
    if (!Number.isSafeInteger(size) || size <= 0 || size > 8 * 1024 * 1024) return res.status(400).json({ error: '请选择不超过 8 MB 的文件。' });
    const expired = (await db.query('SELECT key FROM uploads WHERE expires < ?', Date.now())).rows;
    for (const row of expired) { await uploads.delete(String(row.key)); await db.query('DELETE FROM uploads WHERE key = ?', row.key); }
    const id = randomBytes(24).toString('hex');
    const key = `${sessionHash(req)}/${id}`;
    await db.query('INSERT INTO uploads (key, filename, size, expires) VALUES (?, ?, ?, ?)', key, filename, size, Date.now() + 10 * 60000);
    const { url } = await uploads.createUploadUrl(key);
    res.json({ id, url });
  });
  const sendPreview = (res: Response, id: string, payload: string, offset = 0) => {
    if (offset === 0 && Buffer.byteLength(payload) <= 1024 * 1024) return res.type('json').send(payload);
    const end = Math.min(offset + 250000, payload.length);
    return res.json({ id, part: payload.slice(offset, end), nextOffset: end < payload.length ? end : null });
  };
  app.get('/api/admin/import/preview/:id', async (req, res) => {
    const draft = (await db.query('SELECT payload FROM drafts WHERE id = ? AND session_hash = ? AND expires > ?', String(req.params.id), sessionHash(req), Date.now())).rows[0];
    if (!draft) return res.status(400).json({ error: '预览已过期，请重新上传文件。' });
    const offset = Number(req.query.offset);
    const payload = String(draft.payload);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= payload.length) return res.status(400).json({ error: '预览分页无效。' });
    sendPreview(res, String(req.params.id), payload, offset);
  });
  app.post('/api/admin/import/preview', upload.single('file'), async (req, res) => {
    let filename: string; let buffer: Buffer;
    if (req.file) { filename = Buffer.from(req.file.originalname, 'latin1').toString('utf8'); buffer = req.file.buffer; }
    else if (uploads && typeof req.body.id === 'string' && /^[a-f0-9]{48}$/.test(req.body.id)) {
      const key = `${sessionHash(req)}/${req.body.id}`;
      const pending = (await db.query('SELECT filename, size FROM uploads WHERE key = ? AND expires > ?', key, Date.now())).rows[0];
      if (!pending) return res.status(400).json({ error: '上传已过期，请重新选择文件。' });
      const content = await uploads.read(key);
      if (!content) return res.status(400).json({ error: '文件尚未上传成功，请重新选择文件。' });
      await uploads.delete(key);
      await db.query('DELETE FROM uploads WHERE key = ?', key);
      if (content.byteLength > 8 * 1024 * 1024 || content.byteLength !== Number(pending.size)) return res.status(400).json({ error: '文件大小不匹配或超过 8 MB，请重新上传。' });
      filename = String(pending.filename); buffer = Buffer.from(content);
    } else return res.status(400).json({ error: '请选择文件。' });
    const preview = await parseImport(buffer, filename);
    const existingPeople = (await db.query('SELECT phone, name FROM people')).rows as { phone: string; name: string }[];
    const namedPhones = new Set(existingPeople.filter(person => person.name).map(person => person.phone));
    for (const row of preview.records) {
      if (!registrationName(row.fields) && namedPhones.has(row.phone)) throw new Error(`电话 ${row.phone} 已有具名人员，请填写“姓名”列，以免关联错误。`);
    }
    const existing = new Set(existingPeople.map(row => registrationKey(row.phone, row.name)));
    const updated = preview.records.filter(row => existing.has(registrationKey(row.phone, registrationName(row.fields)))).length;
    const id = randomBytes(24).toString('hex');
    (await db.query('DELETE FROM drafts WHERE expires < ?', Date.now()));
    const payload = JSON.stringify({ id, filename, ...preview, added: preview.records.length - updated, updated });
    await db.query('INSERT INTO drafts VALUES (?, ?, ?, ?, ?)', id, sessionHash(req), filename, payload, Date.now() + 30 * 60000);
    sendPreview(res, id, payload);
  });
  // The CloudBase HTTP channel cannot hold one transaction across statements, so
  // imports are written as two set-based statements per batch instead of one
  // statement per attendee. Every batch is atomic on its own and safe to repeat:
  // the insert ignores attendees that already exist, and the update only rewrites
  // their profile fields, leaving token and checked_at untouched.
  const IMPORT_BATCH = 500;
  const writeRecords = async (records: PersonInput[]) => {
    if (db.dialect === 'postgres') {
      let added = 0; let matched = 0;
      for (let start = 0; start < records.length; start += IMPORT_BATCH) {
        const batch = records.slice(start, start + IMPORT_BATCH);
        const phones = batch.map(person => person.phone);
        const names = batch.map(person => registrationName(person.fields));
        const fields = batch.map(person => JSON.stringify(person.fields));
        added += (await db.query(`INSERT INTO people (phone, name, fields, token, created_at)
          SELECT * FROM unnest(?::text[], ?::text[], ?::text[], ?::text[], ?::text[])
          ON CONFLICT (phone, name) DO NOTHING RETURNING id`,
          phones, names, fields, batch.map(() => randomBytes(24).toString('hex')), batch.map(() => new Date().toISOString()))).rows.length;
        matched += (await db.query(`UPDATE people SET fields = incoming.fields
          FROM unnest(?::text[], ?::text[], ?::text[]) AS incoming(phone, name, fields)
          WHERE people.phone = incoming.phone AND people.name = incoming.name RETURNING people.id`, phones, names, fields)).rows.length;
      }
      return { added, updated: Math.max(0, matched - added) };
    }
    return db.transaction(async tx => {
      let added = 0; let updated = 0;
      for (const person of records) {
        const name = registrationName(person.fields);
        const inserted = await tx.query('INSERT INTO people (phone, name, fields, token, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(phone, name) DO NOTHING RETURNING id', person.phone, name, JSON.stringify(person.fields), randomBytes(24).toString('hex'), new Date().toISOString());
        if (inserted.rows.length) added++;
        else { await tx.query('UPDATE people SET fields = ? WHERE phone = ? AND name = ?', JSON.stringify(person.fields), person.phone, name); updated++; }
      }
      return { added, updated };
    });
  };
  app.post('/api/admin/import/confirm', async (req, res) => {
    const draft = (await db.query('DELETE FROM drafts WHERE id = ? AND session_hash = ? AND expires > ? RETURNING filename, payload', String(req.body.id), sessionHash(req), Date.now())).rows[0];
    if (!draft) return res.status(400).json({ error: '预览已过期或已导入，请重新上传文件。' });
    const saved = JSON.parse(String(draft.payload));
    const records: PersonInput[] = Array.isArray(saved) ? saved : saved.records;
    try {
      const { added, updated } = await writeRecords(records);
      await db.query('INSERT INTO imports (filename, total, added, updated, created_at) VALUES (?, ?, ?, ?, ?)', draft.filename, records.length, added, updated, new Date().toISOString());
      res.json({ added, updated });
    } finally { dashboardCache.clear(); }
  });
  app.post('/api/admin/lookup', async (req, res) => {
    let person: PersonRow | undefined;
    if (typeof req.body.code === 'string' && /^checkin:v1:[a-f0-9]{48}$/.test(req.body.code)) person = (await db.query('SELECT * FROM people WHERE token = ?', req.body.code.slice(11))).rows[0] as PersonRow | undefined;
    else if (req.body.phone && validPhone(normalizePhone(req.body.phone))) {
      const people = (await db.query('SELECT * FROM people WHERE phone = ? ORDER BY id', normalizePhone(req.body.phone))).rows as PersonRow[];
      if (people.length > 1) return res.json({ people: people.map(serialize) });
      person = people[0];
    } else return res.status(400).json({ error: '无效的签到码或联系电话，请重新识别。' });
    if (!person) return res.status(404).json({ error: '未找到这位参会者，请确认是本活动的签到码。' });
    res.json(serialize(person));
  });
  app.post('/api/admin/checkin', async (req, res) => {
    const id = Number(req.body.id);
    if (!Number.isSafeInteger(id)) return res.status(400).json({ error: '参会者无效。' });
    const changed = await db.query('UPDATE people SET checked_at = ? WHERE id = ? AND checked_at IS NULL RETURNING *', new Date().toISOString(), id);
    const person = (changed.rows[0] || (await db.query('SELECT * FROM people WHERE id = ?', id)).rows[0]) as PersonRow | undefined;
    if (!person) return res.status(404).json({ error: '未找到参会者。' });
    dashboardCache.clear();
    res.json({ person: serialize(person), alreadyChecked: !changed.changes });
  });
  app.put('/api/admin/event', async (req, res) => {
    const limits: Record<string, number> = { title: 80, date: 10, time: 30, location: 160, description: 300 };
    if (typeof req.body.title !== 'string' || !req.body.title.trim()) return res.status(400).json({ error: '请填写活动名称。' });
    const event: Record<string, string> = {};
    for (const [key, limit] of Object.entries(limits)) {
      if (typeof req.body[key] !== 'string' || req.body[key].length > limit) return res.status(400).json({ error: '活动信息格式错误或文字过长。' });
      event[key] = req.body[key].trim();
    }
    await setSetting('event', JSON.stringify(event)); eventCache.clear(); res.json(event);
  });
  app.use('/api', async (_req, res) => res.status(404).json({ error: '接口不存在。' }));
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof DatabaseUnavailableError) { res.setHeader('Retry-After', '2'); return res.status(503).json({ error: error.message }); }
    if (error instanceof multer.MulterError) return res.status(400).json({ error: '上传失败，请选择小于 8 MB 的单个文件。' });
    res.status(400).json({ error: error.message || '操作失败，请稍后重试。' });
  });
  return { app, db };
}
