// SQLite-backed session store for @fastify/session. Sessions survive redeploys.
import { db, now } from './db.js';

type Cb = (err?: Error | null, value?: any) => void;

const get = db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?');
const upsert = db.prepare(
  `INSERT INTO sessions (sid, data, expires_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(sid) DO UPDATE SET data=excluded.data, expires_at=excluded.expires_at, updated_at=excluded.updated_at`,
);
const del = db.prepare('DELETE FROM sessions WHERE sid = ?');
const purge = db.prepare('DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < ?');

// Best-effort housekeeping on startup.
try { purge.run(Date.now()); } catch {}

export class SqliteSessionStore {
  set(sid: string, session: any, callback: Cb) {
    try {
      const expiresAt =
        session?.cookie?.expires
          ? new Date(session.cookie.expires).getTime()
          : session?.cookie?._expires
          ? new Date(session.cookie._expires).getTime()
          : null;
      upsert.run(sid, JSON.stringify(session), expiresAt, now());
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }

  get(sid: string, callback: Cb) {
    try {
      const row = get.get(sid) as { data: string; expires_at: number | null } | undefined;
      if (!row) return callback(null, null);
      if (row.expires_at != null && row.expires_at < Date.now()) {
        del.run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.data));
    } catch (err) {
      callback(err as Error);
    }
  }

  destroy(sid: string, callback: Cb) {
    try {
      del.run(sid);
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }
}
