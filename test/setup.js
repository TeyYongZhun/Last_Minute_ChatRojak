import { beforeEach } from 'vitest';
import { closeDb } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
process.env.SKIP_SERVER_START = '1';
process.env.SESSION_SECRET = 'test-secret-do-not-use-in-prod';
process.env.Z_AI_API_KEY = process.env.Z_AI_API_KEY || 'test-key';

beforeEach(() => {
  closeDb();
  runMigrations({ silent: true });
});
