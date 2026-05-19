import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import formbody from '@fastify/formbody';
import staticFiles from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db, now, type UserRow, type JobRow, type RecipeRow } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { authUrl, exchangeCode, upsertUserFromOAuth } from './google/oauth.js';
import { layout, htmlMixed, esc, raw } from './views/layout.js';
import {
  startJobForUser,
  startRewriteJob,
  cancelJob,
  getActiveJob,
  getLatestJob,
  getRecipeCounts,
} from './jobs.js';
import { SqliteSessionStore } from './session_store.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const app = Fastify({ logger: true, trustProxy: true });

await app.register(cookie);
await app.register(session, {
  secret: config.appKey,
  cookie: { secure: config.isProd, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 30 },
  saveUninitialized: false,
  store: new SqliteSessionStore() as any,
});
await app.register(formbody);
await app.register(staticFiles, {
  root: path.join(here, 'public'),
  prefix: '/public/',
});

declare module 'fastify' {
  interface Session {
    userId?: string;
    oauthState?: string;
    flash?: { type: 'ok' | 'err'; text: string };
  }
}

function currentUser(req: { session: { userId?: string } }): UserRow | null {
  if (!req.session.userId) return null;
  return (db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId) as UserRow) || null;
}

function flash(req: any, type: 'ok' | 'err', text: string) {
  req.session.flash = { type, text };
}
function takeFlash(req: any) {
  const f = req.session.flash;
  req.session.flash = undefined;
  return f;
}

// ---------------- Home ----------------
app.get('/', async (req, reply) => {
  const user = currentUser(req as any);
  const flashMsg = takeFlash(req);
  if (!user) {
    return reply.type('text/html').send(
      layout({
        title: 'Sign in',
        body: htmlMixed`
          ${flashMsg ? raw(`<div class="banner ${flashMsg.type}">${esc(flashMsg.text)}</div>`) : ''}
          <div class="card">
            <h1>Export your ChefTap recipes to Google Docs</h1>
            <p class="muted">Sign in with Google. We'll create a "ChefTap Recipes" folder in your Drive and put one Google Doc per recipe in it.</p>
            <p><a class="btn" href="/oauth/google">Sign in with Google</a></p>
            <p class="muted">Scopes requested: <span class="kbd">drive.file</span> (only files this app creates), <span class="kbd">documents</span>, <span class="kbd">generative-language.retriever</span> (Gemini).</p>
          </div>`,
      }),
    );
  }

  const job = getActiveJob(user.id) || getLatestJob(user.id);
  const hasCreds = !!(db.prepare('SELECT 1 FROM cheftap_creds WHERE user_id = ?').get(user.id) as any);

  let body: string;
  if (job && job.status !== 'done' && job.status !== 'error' && job.status !== 'canceled') {
    reply.redirect('/progress');
    return reply.send();
  } else if (!hasCreds) {
    body = htmlMixed`
      ${flashMsg ? raw(`<div class="banner ${flashMsg.type}">${esc(flashMsg.text)}</div>`) : ''}
      <div class="card">
        <h1>Connect ChefTap</h1>
        <p>Enter your ChefTap account credentials. They're encrypted at rest and only used to download your recipes.</p>
        <form method="post" action="/cheftap/connect">
          <label>ChefTap username or email</label>
          <input type="text" name="username" required autocomplete="username">
          <label>ChefTap password</label>
          <input type="password" name="password" required autocomplete="current-password">
          <p><button class="btn" type="submit">Save and start import</button></p>
        </form>
      </div>`;
  } else {
    const cached = db
      .prepare(
        `SELECT
           COALESCE(SUM(status='extracted'),0) AS extracted,
           COALESCE(SUM(status='uploaded'),0)  AS uploaded,
           COALESCE(SUM(status='pending'),0)   AS pending,
           COUNT(*) AS total
         FROM recipes WHERE user_id = ?`,
      )
      .get(user.id) as { extracted: number; uploaded: number; pending: number; total: number };
    body = htmlMixed`
      ${flashMsg ? raw(`<div class="banner ${flashMsg.type}">${esc(flashMsg.text)}</div>`) : ''}
      <div class="card">
        <h1>Ready to import</h1>
        <p class="muted">Your ChefTap credentials are saved.</p>
        ${
          cached.total > 0
            ? raw(
                `<p class="muted"><strong>${cached.total}</strong> cached recipes (${cached.uploaded} uploaded, ${cached.extracted} extracted, ${cached.pending} pending). A new import will skip recipes already extracted.</p>`,
              )
            : ''
        }
        <form method="post" action="/jobs/start"><button class="btn" type="submit">${cached.total > 0 ? raw('Resume import') : raw('Start import')}</button></form>
        <p style="margin-top:16px">
          ${
            cached.uploaded > 0
              ? raw(
                  `<form method="post" action="/jobs/rewrite" style="display:inline; margin-right:8px" onsubmit="return confirm('Rewrite all ${cached.uploaded} uploaded Google Docs in place? Each doc keeps its URL but its body is replaced.')"><button type="submit" class="btn secondary">Rewrite ${cached.uploaded} Google Docs</button></form>`,
                )
              : ''
          }
          ${
            cached.total > 0
              ? raw(
                  `<form method="post" action="/cheftap/cache/clear" style="display:inline" onsubmit="return confirm('Delete ${cached.total} cached recipes from this app? (Existing Google Docs in your Drive are not affected.)')"><button type="submit" class="btn secondary">Clear cached recipes</button></form>`,
                )
              : ''
          }
        </p>
        <p><a class="muted" href="/cheftap/disconnect" onclick="return confirm('Remove your stored ChefTap credentials?')">Remove ChefTap credentials</a></p>
      </div>
      ${
        job && job.status === 'done'
          ? raw(`<div class="card"><h2>Last import</h2><p>${esc(job.message || 'Completed')}</p><p class="muted"><a href="/progress">View details</a></p></div>`)
          : ''
      }`;
  }

  return reply.type('text/html').send(layout({ title: 'Home', user, body }));
});

// ---------------- OAuth ----------------
app.get('/oauth/google', async (req, reply) => {
  const state = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');
  req.session.oauthState = state;
  reply.redirect(authUrl(state));
});

app.get('/oauth/google/callback', async (req, reply) => {
  const q = req.query as { code?: string; state?: string; error?: string };
  if (q.error) { flash(req, 'err', `Google sign-in canceled: ${q.error}`); return reply.redirect('/'); }
  if (!q.code || !q.state || q.state !== req.session.oauthState) {
    flash(req, 'err', 'Invalid OAuth state'); return reply.redirect('/');
  }
  try {
    const { user, tokens } = await exchangeCode(q.code);
    upsertUserFromOAuth(user, tokens);
    req.session.userId = user.sub;
    flash(req, 'ok', `Signed in as ${user.email}.`);
  } catch (e: any) {
    req.log.error(e);
    flash(req, 'err', `Sign-in failed: ${e?.message || e}`);
  }
  reply.redirect('/');
});

app.get('/logout', async (req, reply) => {
  await new Promise<void>((res) => req.session.destroy(() => res()));
  reply.redirect('/');
});

// ---------------- ChefTap creds ----------------
app.post('/cheftap/connect', async (req, reply) => {
  const user = currentUser(req as any);
  if (!user) return reply.redirect('/');
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) { flash(req, 'err', 'Missing credentials'); return reply.redirect('/'); }
  const t = now();
  db.prepare(
    `INSERT INTO cheftap_creds (user_id, username, password, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, password=excluded.password, updated_at=excluded.updated_at`,
  ).run(user.id, encrypt(username), encrypt(password), t);
  // Auto-start a job after connecting.
  try {
    startJobForUser(user.id);
    reply.redirect('/progress');
  } catch (e: any) {
    flash(req, 'err', e?.message || 'Could not start import');
    reply.redirect('/');
  }
});

app.get('/cheftap/disconnect', async (req, reply) => {
  const user = currentUser(req as any);
  if (!user) return reply.redirect('/');
  db.prepare('DELETE FROM cheftap_creds WHERE user_id = ?').run(user.id);
  flash(req, 'ok', 'ChefTap credentials removed.');
  reply.redirect('/');
});

app.post('/cheftap/cache/clear', async (req, reply) => {
  const user = currentUser(req as any);
  if (!user) return reply.redirect('/');
  // Cancel any in-flight job first so it doesn't keep writing rows back.
  const job = getActiveJob(user.id);
  if (job) cancelJob(job.id);
  const result = db.prepare('DELETE FROM recipes WHERE user_id = ?').run(user.id);
  flash(req, 'ok', `Cleared ${result.changes} cached recipes.`);
  reply.redirect('/');
});

// ---------------- Job control ----------------
app.post('/jobs/start', async (req, reply) => {
  const user = currentUser(req as any);
  if (!user) return reply.redirect('/');
  try {
    startJobForUser(user.id);
  } catch (e: any) {
    flash(req, 'err', e?.message || 'Could not start');
    return reply.redirect('/');
  }
  reply.redirect('/progress');
});

app.post('/jobs/rewrite', async (req, reply) => {
  const user = currentUser(req as any);
  if (!user) return reply.redirect('/');
  try {
    startRewriteJob(user.id);
  } catch (e: any) {
    flash(req, 'err', e?.message || 'Could not start rewrite');
    return reply.redirect('/');
  }
  reply.redirect('/progress');
});

app.post('/jobs/cancel', async (req, reply) => {
  const user = currentUser(req as any);
  if (!user) return reply.redirect('/');
  const job = getActiveJob(user.id);
  if (job) cancelJob(job.id);
  reply.redirect('/progress');
});

// ---------------- Progress ----------------
app.get('/progress', async (req, reply) => {
  const user = currentUser(req as any);
  if (!user) return reply.redirect('/');
  return reply.type('text/html').send(layout({ title: 'Import progress', user, body: renderProgress(user.id, true) }));
});

app.get('/progress/partial', async (req, reply) => {
  const user = currentUser(req as any);
  if (!user) return reply.code(401).send();
  return reply.type('text/html').send(renderProgress(user.id, false));
});

function pct(num: number, den: number) {
  if (!den) return 0;
  return Math.min(100, Math.round((num * 100) / den));
}

function renderProgress(userId: string, fullPage: boolean): string {
  const job = getActiveJob(userId) || getLatestJob(userId);
  if (!job) {
    return `<div class="card"><p>No job yet.</p><p><a href="/" class="btn">Back</a></p></div>`;
  }
  const counts = getRecipeCounts(job.id);
  const total = job.total_recipes || (counts.pending + counts.extracted + counts.uploaded + counts.errors);
  const recent = db
    .prepare(`SELECT * FROM recipes WHERE job_id = ? AND status='uploaded' ORDER BY updated_at DESC LIMIT 10`)
    .all(job.id) as RecipeRow[];

  const running = !['done', 'error', 'canceled'].includes(job.status);
  const polling = running
    ? `hx-get="/progress/partial" hx-trigger="every 2s" hx-target="#progress" hx-swap="outerHTML"`
    : '';

  const phase = job.status;
  const phaseLabel: Record<string, string> = {
    queued: 'Queued',
    logging_in: 'Logging in to ChefTap…',
    indexing: 'Indexing recipes…',
    extracting: 'Extracting recipes…',
    uploading: 'Creating Google Docs…',
    rewriting: 'Rewriting Google Docs…',
    done: 'Done',
    error: 'Error',
    canceled: 'Canceled',
  };

  const overall = total
    ? Math.round(((counts.uploaded + counts.errors) * 100) / total)
    : (running ? 5 : 0);

  const errors = db
    .prepare(`SELECT * FROM recipes WHERE job_id = ? AND status='error' ORDER BY updated_at DESC LIMIT 10`)
    .all(job.id) as RecipeRow[];

  const body = `
<div id="progress" ${polling}>
  <div class="card">
    <h1>${esc(phaseLabel[phase] || phase)}</h1>
    <p class="muted">${esc(job.message || '')}</p>
    <div class="bar"><div style="width:${overall}%"></div></div>
    <div class="statusline">
      ${total ? `<strong>${counts.uploaded}</strong> uploaded · <strong>${counts.extracted}</strong> extracted · <strong>${counts.pending}</strong> queued · <strong>${counts.errors}</strong> errors · of <strong>${total}</strong>` : 'Starting…'}
    </div>
    ${running ? `<form method="post" action="/jobs/cancel" style="margin-top:12px"><button class="btn secondary" type="submit">Cancel</button></form>` : `<div style="margin-top:12px"><a class="btn secondary" href="/">Back to home</a></div>`}
  </div>
  ${
    recent.length
      ? `<div class="card"><h2>Recently uploaded</h2><div class="list">` +
        recent
          .map(
            (r) =>
              `<a target="_blank" rel="noopener" href="${esc(r.drive_web_link || '#')}">${esc(r.title || r.slug || r.id)}</a>`,
          )
          .join('') +
        `</div></div>`
      : ''
  }
  ${
    errors.length
      ? `<div class="card"><h2>Errors</h2><div class="list">` +
        errors
          .map((r) => `<div><strong>${esc(r.title || r.slug)}</strong> — <span class="err">${esc(r.error || '')}</span></div>`)
          .join('') +
        `</div></div>`
      : ''
  }
</div>`;
  return fullPage ? body : body;
}

// ---------------- Healthcheck ----------------
app.get('/healthz', async () => ({ ok: true }));

app.listen({ port: config.port, host: '0.0.0.0' }).then(() => {
  console.log(`Listening on ${config.publicBaseUrl}  (port ${config.port})`);
});
