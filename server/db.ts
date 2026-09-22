import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export function openDatabase(dataDir: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, 'checkin.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY, phone TEXT UNIQUE NOT NULL, fields TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, checked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, session_hash TEXT NOT NULL, filename TEXT NOT NULL, payload TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS imports (id INTEGER PRIMARY KEY, filename TEXT NOT NULL, total INTEGER NOT NULL, added INTEGER NOT NULL, updated INTEGER NOT NULL, created_at TEXT NOT NULL);
  `);
  const getSetting = (key: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  const setSetting = (key: string, value: string) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  if (!getSetting('event')) setSetting('event', JSON.stringify({ title: '线下活动签到', date: '', time: '', location: '', description: '欢迎赴约，期待与你相遇。' }));
  return { db, getSetting, setSetting };
}
