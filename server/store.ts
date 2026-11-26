import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openStore(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS inbox (
      sequence INTEGER PRIMARY KEY, event_id TEXT UNIQUE NOT NULL,
      message_id TEXT UNIQUE, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS conversations (
      chat TEXT PRIMARY KEY, customer TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active',
      draft TEXT, touched_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opt_outs (customer TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY, chat TEXT NOT NULL REFERENCES conversations(chat),
      slot TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'booked', revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS booked_slot ON appointments(slot) WHERE state = 'booked';
    CREATE TABLE IF NOT EXISTS decisions (
      event_id TEXT PRIMARY KEY, chat TEXT NOT NULL, body TEXT NOT NULL, intent TEXT NOT NULL,
      detail TEXT NOT NULL, trace TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS decisions_chat ON decisions(chat);
    CREATE TABLE IF NOT EXISTS outbox (
      event_id TEXT PRIMARY KEY, chat TEXT NOT NULL, customer TEXT NOT NULL, body TEXT NOT NULL,
      key TEXT UNIQUE NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0,
      provider_id TEXT, trace TEXT, error TEXT
    );
    CREATE INDEX IF NOT EXISTS outbox_due ON outbox(state, due);
    CREATE INDEX IF NOT EXISTS outbox_provider_id ON outbox(provider_id);
    CREATE TABLE IF NOT EXISTS receipts (
      event_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, chat TEXT NOT NULL,
      state TEXT NOT NULL, occurred TEXT NOT NULL, trace TEXT, error TEXT
    );
    CREATE INDEX IF NOT EXISTS receipt_message ON receipts(provider_id, chat);
  `);
  return db;
}

export type Store = ReturnType<typeof openStore>;

export function transaction<T>(db: Store, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

