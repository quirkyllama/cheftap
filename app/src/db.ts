import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,        -- google sub
  email           TEXT NOT NULL,
  name            TEXT,
  picture         TEXT,
  refresh_token   TEXT,                    -- encrypted
  access_token    TEXT,                    -- encrypted (short-lived)
  access_expires  INTEGER,                 -- epoch ms
  drive_folder_id TEXT,                    -- "recipes" folder in Drive
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cheftap_creds (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username   TEXT NOT NULL,                -- encrypted
  password   TEXT NOT NULL,                -- encrypted
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          TEXT NOT NULL,           -- queued|logging_in|indexing|extracting|uploading|done|error|canceled
  message         TEXT,
  total_recipes   INTEGER DEFAULT 0,
  extracted_count INTEGER DEFAULT 0,
  uploaded_count  INTEGER DEFAULT 0,
  error_count     INTEGER DEFAULT 0,
  started_at      INTEGER,
  finished_at     INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS recipes (
  id               TEXT PRIMARY KEY,        -- cheftap recipe UUID
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id           TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  slug             TEXT,
  title            TEXT,
  source_url       TEXT,
  cheftap_url      TEXT,
  payload          TEXT,                    -- jsonRecipe JSON
  status           TEXT NOT NULL,           -- pending|extracted|uploaded|error
  error            TEXT,
  drive_file_id    TEXT,
  drive_web_link   TEXT,
  hero_image_url   TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recipes_user_status ON recipes(user_id, status);
CREATE INDEX IF NOT EXISTS idx_recipes_job ON recipes(job_id);
`);

export const now = () => Date.now();

export type UserRow = {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  refresh_token: string | null;
  access_token: string | null;
  access_expires: number | null;
  drive_folder_id: string | null;
  created_at: number;
  updated_at: number;
};

export type JobRow = {
  id: string;
  user_id: string;
  status: string;
  message: string | null;
  total_recipes: number;
  extracted_count: number;
  uploaded_count: number;
  error_count: number;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
};

export type RecipeRow = {
  id: string;
  user_id: string;
  job_id: string | null;
  slug: string | null;
  title: string | null;
  source_url: string | null;
  cheftap_url: string | null;
  payload: string | null;
  status: string;
  error: string | null;
  drive_file_id: string | null;
  drive_web_link: string | null;
  hero_image_url: string | null;
  created_at: number;
  updated_at: number;
};
