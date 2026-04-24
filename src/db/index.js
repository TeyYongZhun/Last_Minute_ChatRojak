import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

let _db = null;

function resolveDbPath() {
  const p = process.env.DB_PATH || path.join('state', 'app.db');
  if (p === ':memory:') return p;
  const dir = path.dirname(p);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return p;
}

export function getDb() {
  if (_db) return _db;
  const dbPath = resolveDbPath();
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');
  return _db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
