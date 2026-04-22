import crypto from 'crypto';
import { getDb } from '../index.js';

function newId() {
  return crypto.randomUUID();
}

export function createUser(email, passwordHash) {
  const db = getDb();
  const id = newId();
  db.prepare(
    'INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)'
  ).run(id, email, passwordHash, Date.now());
  return { id, email };
}

export function getUserByEmail(email) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
}

export function getUserById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}
