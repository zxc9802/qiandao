import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { openDatabase } from './db.ts';
import { normalizePhone, validPhone, parseImport, type PersonInput } from './importer.ts';

type PersonRow = { id: number; phone: string; fields: string; token: string; checked_at: string | null; created_at: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const serialize = ({ token: _, ...row }: PersonRow) => ({ ...row, fields: JSON.parse(row.fields) });

export function createApp(dataDir: string) {
  const app = express();
  const { db, getSetting, setSetting } = openDatabase(dataDir);
  if (!getSetting('password')) {
    const password = process.env.ADMIN_PASSWORD;
    if (password !== undefined) {
      if (password.length < 8 || password.length > 128) { db.close(); throw new Error('ADMIN_PASSWORD 必须为 8–128 位。'); }
      const salt = randomBytes(16).toString('hex');
      setSetting('password', `${salt}:${scryptSync(password, salt, 64).toString('hex')}`);
    } else if (process.env.NODE_ENV === 'production') {
      db.close();
      throw new Error('首次生产部署请设置 ADMIN_PASSWORD，避免后台初始化入口暴露到公网。');
    }
  }
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
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
  const isAdmin = (req: Request) => !!db.prepare('SELECT 1 FROM sessions WHERE token_hash = ? AND expires > ?').get(sessionHash(req), Date.now());
  const requireAdmin = (req: Request, res: Response, next: NextFunction) => isAdmin(req) ? next() : res.status(401).json({ error: '请先登录主办方后台。' });
  const newSession = (req: Request, res: Response) => {
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES (?, ?)').run(hash(token), Date.now() + 12 * 3600000);
    res.cookie('meet_session', token, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 12 * 3600000, path: '/' });
  };
  const authLimit = rateLimit({ windowMs: 15 * 60000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: '尝试过于频繁，请 15 分钟后再试。' } });
  app.get('/api/public/event', (_req, res) => res.json(JSON.parse(getSetting('event')!)));
  app.get('/api/auth/status', (req, res) => res.json({ setupRequired: !getSetting('password'), authenticated: isAdmin(req) }));
  app.post('/api/auth/setup', authLimit, (req, res) => {
    if (getSetting('password')) return res.status(409).json({ error: '后台已经初始化，请使用密码登录。' });
    const password = req.body.password;
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) return res.status(400).json({ error: '请设置 8–128 位管理密码。' });
    const salt = randomBytes(16).toString('hex');
    setSetting('password', `${salt}:${scryptSync(password, salt, 64).toString('hex')}`);
    newSession(req, res); res.json({ ok: true });
  });
  app.post('/api/auth/login', authLimit, (req, res) => {
    const stored = getSetting('password');
    if (!stored) return res.status(400).json({ error: '请先初始化主办方后台。' });
    const password = req.body.password;
    if (typeof password !== 'string' || password.length > 128) return res.status(400).json({ error: '密码格式无效。' });
    const [salt, expected] = stored.split(':');
    if (!timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(expected, 'hex'))) return res.status(401).json({ error: '管理密码不正确。' });
    newSession(req, res); res.json({ ok: true });
  });
  app.post('/api/auth/logout', (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sessionHash(req));
    db.prepare('DELETE FROM drafts WHERE session_hash = ?').run(sessionHash(req));
    res.clearCookie('meet_session', { path: '/' }); res.json({ ok: true });
  });
  app.post('/api/public/ticket', rateLimit({ windowMs: 60000, limit: 20, message: { error: '领取频率过高，请稍后重试。' } }), (req, res) => {
    const phone = normalizePhone(req.body.phone);
    if (!validPhone(phone)) return res.status(400).json({ error: '请输入正确的 11 位手机号。' });
    const person = db.prepare('SELECT * FROM people WHERE phone = ?').get(phone) as PersonRow | undefined;
    if (!person) return res.status(404).json({ error: '暂未查到登记信息，请核对报名手机号，或联系现场工作人员。' });
    res.json({ code: `checkin:v1:${person.token}`, phone: `${phone.slice(0, 3)} **** ${phone.slice(-4)}` });
  });
  app.use('/api/admin', requireAdmin);
  app.get('/api/admin/dashboard', (_req, res) => {
    const stats = db.prepare('SELECT COUNT(*) AS total, COUNT(checked_at) AS checked FROM people').get();
    const recent = (db.prepare('SELECT * FROM people WHERE checked_at IS NOT NULL ORDER BY checked_at DESC LIMIT 5').all() as PersonRow[]).map(serialize);
    const imports = db.prepare('SELECT * FROM imports ORDER BY id DESC LIMIT 5').all();
    res.json({ stats, recent, imports });
  });
  app.get('/api/admin/people', (req, res) => {
    const q = String(req.query.q || '').slice(0, 100);
    const status = req.query.status;
    const condition = `WHERE (phone LIKE ? ESCAPE '\\' OR fields LIKE ? ESCAPE '\\')${status === 'checked' ? ' AND checked_at IS NOT NULL' : status === 'pending' ? ' AND checked_at IS NULL' : ''}`;
    const needle = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM people ${condition}`).get(needle, needle) as { total: number };
    const rows = db.prepare(`SELECT * FROM people ${condition} ORDER BY id DESC LIMIT 30 OFFSET ?`).all(needle, needle, (page - 1) * 30) as PersonRow[];
    res.json({ total, page, people: rows.map(serialize) });
  });
  app.get('/api/admin/people/export', (_req, res) => {
    const rows = (db.prepare('SELECT * FROM people ORDER BY id').all() as PersonRow[]).map(serialize);
    const headers = [...new Set(rows.flatMap(row => Object.keys(row.fields)))];
    const cell = (value: unknown) => { const str = String(value ?? ''); return `"${(/^[=+@\-\t\r]/.test(str) ? "'" : '') + str.replaceAll('"', '""')}"`; };
    const data = [['手机号', ...headers, '签到时间'], ...rows.map(row => [row.phone, ...headers.map(key => row.fields[key]), row.checked_at ? new Date(row.checked_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未签到'])];
    res.setHeader('Content-Disposition', 'attachment; filename="checkin-records.csv"');
    res.type('text/csv; charset=utf-8').send('\uFEFF' + data.map(row => row.map(cell).join(',')).join('\r\n'));
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
  app.post('/api/admin/import/preview', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '请选择文件。' });
    const filename = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const preview = await parseImport(req.file.buffer, filename);
    const existing = new Set((db.prepare('SELECT phone FROM people').all() as { phone: string }[]).map(row => row.phone));
    const updated = preview.records.filter(row => existing.has(row.phone)).length;
    const id = randomBytes(24).toString('hex');
    db.prepare('DELETE FROM drafts WHERE expires < ?').run(Date.now());
    db.prepare('INSERT INTO drafts VALUES (?, ?, ?, ?, ?)').run(id, sessionHash(req), filename, JSON.stringify(preview.records), Date.now() + 30 * 60000);
    res.json({ id, filename, ...preview, added: preview.records.length - updated, updated });
  });
  app.post('/api/admin/import/confirm', (req, res) => {
    const draft = db.prepare('SELECT * FROM drafts WHERE id = ? AND session_hash = ? AND expires > ?').get(String(req.body.id), sessionHash(req), Date.now()) as { filename: string; payload: string } | undefined;
    if (!draft) return res.status(400).json({ error: '预览已过期或已导入，请重新上传文件。' });
    const records: PersonInput[] = JSON.parse(draft.payload);
    let added = 0; let updated = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const person of records) {
        if (db.prepare('SELECT 1 FROM people WHERE phone = ?').get(person.phone)) {
          db.prepare('UPDATE people SET fields = ? WHERE phone = ?').run(JSON.stringify(person.fields), person.phone); updated++;
        } else {
          db.prepare('INSERT INTO people (phone, fields, token, created_at) VALUES (?, ?, ?, ?)').run(person.phone, JSON.stringify(person.fields), randomBytes(24).toString('hex'), new Date().toISOString()); added++;
        }
      }
      db.prepare('INSERT INTO imports (filename, total, added, updated, created_at) VALUES (?, ?, ?, ?, ?)').run(draft.filename, records.length, added, updated, new Date().toISOString());
      db.prepare('DELETE FROM drafts WHERE id = ?').run(String(req.body.id));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.json({ added, updated });
  });
  app.post('/api/admin/lookup', (req, res) => {
    let person: PersonRow | undefined;
    if (typeof req.body.code === 'string' && /^checkin:v1:[a-f0-9]{48}$/.test(req.body.code)) person = db.prepare('SELECT * FROM people WHERE token = ?').get(req.body.code.slice(11)) as PersonRow | undefined;
    else if (req.body.phone && validPhone(normalizePhone(req.body.phone))) person = db.prepare('SELECT * FROM people WHERE phone = ?').get(normalizePhone(req.body.phone)) as PersonRow | undefined;
    else return res.status(400).json({ error: '无效的签到码或手机号，请重新识别。' });
    if (!person) return res.status(404).json({ error: '未找到这位参会者，请确认是本活动的签到码。' });
    res.json(serialize(person));
  });
  app.post('/api/admin/checkin', (req, res) => {
    const id = Number(req.body.id);
    if (!Number.isSafeInteger(id)) return res.status(400).json({ error: '参会者无效。' });
    const changed = db.prepare('UPDATE people SET checked_at = ? WHERE id = ? AND checked_at IS NULL').run(new Date().toISOString(), id);
    const person = db.prepare('SELECT * FROM people WHERE id = ?').get(id) as PersonRow | undefined;
    if (!person) return res.status(404).json({ error: '未找到参会者。' });
    res.json({ person: serialize(person), alreadyChecked: !changed.changes });
  });
  app.put('/api/admin/event', (req, res) => {
    const limits: Record<string, number> = { title: 80, date: 10, time: 30, location: 160, description: 300 };
    if (typeof req.body.title !== 'string' || !req.body.title.trim()) return res.status(400).json({ error: '请填写活动名称。' });
    const event: Record<string, string> = {};
    for (const [key, limit] of Object.entries(limits)) {
      if (typeof req.body[key] !== 'string' || req.body[key].length > limit) return res.status(400).json({ error: '活动信息格式错误或文字过长。' });
      event[key] = req.body[key].trim();
    }
    setSetting('event', JSON.stringify(event)); res.json(event);
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在。' }));
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof multer.MulterError) return res.status(400).json({ error: '上传失败，请选择小于 8 MB 的单个文件。' });
    res.status(400).json({ error: error.message || '操作失败，请稍后重试。' });
  });
  return { app, db };
}
