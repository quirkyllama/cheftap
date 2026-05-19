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

CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);

// --- Migration: stabilize recipes.id to '<user_id>:<slug>' ----------------
// Earlier code rewrote `recipes.id` from the slug to the cheftap UUID during
// extraction. On re-runs this produced two rows per recipe (id=slug from the
// new pre-populate + id=UUID from the prior run) and the second extract's
// UPDATE then violated the PRIMARY KEY. We now use a stable per-user id.
db.exec(`
  -- Dedupe by (user_id, slug), keeping the most recent row.
  DELETE FROM recipes
    WHERE rowid NOT IN (
      SELECT MAX(rowid)
        FROM recipes
       WHERE slug IS NOT NULL AND user_id IS NOT NULL
       GROUP BY user_id, slug
    )
    AND slug IS NOT NULL;

  -- Re-key any non-conforming ids to '<user_id>:<slug>'.
  UPDATE recipes
     SET id = user_id || ':' || slug
   WHERE slug IS NOT NULL
     AND id <> user_id || ':' || slug;

  -- Belt-and-suspenders uniqueness on the natural key.
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_recipes_user_slug
    ON recipes(user_id, slug);
`);

// --- Startup recovery -----------------------------------------------------
// Any job left mid-flight by a previous process (deploy / crash / SIGKILL)
// is now a zombie -- no in-memory worker is running. Mark them canceled so
// a fresh job can start.
db.prepare(
  `UPDATE jobs
      SET status='canceled',
          message=COALESCE(message,'') || ' [process restarted before job finished]',
          finished_at=?,
          updated_at=?
    WHERE status NOT IN ('done','error','canceled')`,
).run(Date.now(), Date.now());

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
