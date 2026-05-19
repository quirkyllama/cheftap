import { nanoid } from 'nanoid';
import { db, now, type JobRow, type RecipeRow, type UserRow } from './db.js';
import { decrypt } from './crypto.js';
import { loginCheftap } from './cheftap/login.js';
import { indexRecipes, fetchRecipeData } from './cheftap/extract.js';
import { ensureRecipesFolder, createDocInFolder } from './google/drive.js';
import { writeRecipeIntoDoc, type CheftapRecipe } from './google/docs.js';
import { userOauthClient } from './google/oauth.js';
import { config } from './config.js';

// One job at a time per user. Global registry of in-flight jobs.
const inflight = new Map<string, AbortController>();

export function getActiveJob(userId: string): JobRow | undefined {
  return db
    .prepare(
      `SELECT * FROM jobs
        WHERE user_id = ? AND status NOT IN ('done','error','canceled')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(userId) as JobRow | undefined;
}

export function getLatestJob(userId: string): JobRow | undefined {
  return db
    .prepare(`SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(userId) as JobRow | undefined;
}

export function getRecipeCounts(jobId: string) {
  return db
    .prepare(
      `SELECT
         COALESCE(SUM(status='pending'), 0)   AS pending,
         COALESCE(SUM(status='extracted'), 0) AS extracted,
         COALESCE(SUM(status='uploaded'), 0)  AS uploaded,
         COALESCE(SUM(status='error'), 0)     AS errors
       FROM recipes WHERE job_id = ?`,
    )
    .get(jobId) as { pending: number; extracted: number; uploaded: number; errors: number };
}

function updateJob(id: string, patch: Partial<JobRow>) {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  const sets = cols.map((c) => `${c} = ?`).join(', ');
  const values = cols.map((c) => (patch as any)[c]);
  db.prepare(`UPDATE jobs SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, now(), id);
}

export function startJobForUser(userId: string): JobRow {
  const existing = getActiveJob(userId);
  if (existing) return existing;
  const cred = db
    .prepare('SELECT username, password FROM cheftap_creds WHERE user_id = ?')
    .get(userId) as { username: string; password: string } | undefined;
  if (!cred) throw new Error('No ChefTap credentials on file. Connect ChefTap first.');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
  if (!user) throw new Error('Unknown user');

  const t = now();
  const id = nanoid(12);
  db.prepare(
    `INSERT INTO jobs (id, user_id, status, message, created_at, updated_at)
       VALUES (?, ?, 'queued', 'Queued', ?, ?)`,
  ).run(id, userId, t, t);

  const controller = new AbortController();
  inflight.set(id, controller);
  runJob(id, userId, decrypt(cred.username)!, decrypt(cred.password)!, controller.signal).catch(
    (e) => {
      console.error('[job error]', id, e);
      updateJob(id, {
        status: 'error',
        message: String(e?.message || e).slice(0, 500),
        finished_at: now(),
      });
      inflight.delete(id);
    },
  );
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow;
}

export function cancelJob(jobId: string) {
  const c = inflight.get(jobId);
  if (c) {
    c.abort();
    updateJob(jobId, { status: 'canceled', message: 'Canceled', finished_at: now() });
    inflight.delete(jobId);
  }
}

async function runJob(
  jobId: string,
  userId: string,
  username: string,
  password: string,
  signal: AbortSignal,
) {
  const checkAbort = () => { if (signal.aborted) throw new Error('canceled'); };

  updateJob(jobId, { status: 'logging_in', message: 'Logging in to ChefTap...', started_at: now() });
  const { browser, context, page, memberUrl } = await loginCheftap(username, password);
  try {
    checkAbort();
    updateJob(jobId, { status: 'indexing', message: 'Indexing recipes...' });
    const list = await indexRecipes(page, memberUrl);
    updateJob(jobId, { total_recipes: list.length, message: `Indexed ${list.length} recipes.` });

    // Pre-populate the recipes table as pending so we can show progress.
    // id = '<user_id>:<slug>' so it's stable across re-runs and the same
    // INSERT OR IGNORE skips already-known recipes for this user.
    const insertStmt = db.prepare(
      `INSERT INTO recipes
         (id, user_id, job_id, slug, title, cheftap_url, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT(user_id, slug) DO UPDATE SET
           job_id = excluded.job_id,
           title = COALESCE(NULLIF(excluded.title, ''), recipes.title),
           cheftap_url = excluded.cheftap_url,
           updated_at = excluded.updated_at`,
    );
    const t0 = now();
    db.transaction(() => {
      for (const r of list) {
        const slug = r.slug || r.href;
        insertStmt.run(`${userId}:${slug}`, userId, jobId, slug, r.title, r.href, t0, t0);
      }
    })();

    checkAbort();
    updateJob(jobId, { status: 'extracting', message: 'Extracting recipe details...' });

    // Skip recipes already extracted or uploaded (resume / re-run support).
    const alreadyDone = new Set(
      (
        db
          .prepare(
            `SELECT cheftap_url FROM recipes WHERE user_id=? AND status IN ('extracted','uploaded')`,
          )
          .all(userId) as { cheftap_url: string }[]
      ).map((r) => r.cheftap_url),
    );

    let extracted = alreadyDone.size;
    updateJob(jobId, {
      extracted_count: extracted,
      message:
        alreadyDone.size > 0
          ? `Resuming: ${alreadyDone.size} recipes already extracted; fetching the rest.`
          : 'Extracting recipe details...',
    });

    const concurrency = config.extractConcurrency;
    const queue = list.filter((item) => !alreadyDone.has(item.href));
    async function extractWorker() {
      while (queue.length) {
        if (signal.aborted) return;
        const item = queue.shift();
        if (!item) return;
        try {
          const data = await fetchRecipeData(context, item.href);
          const payload = data.payload as CheftapRecipe;
          // NOTE: we no longer mutate `recipes.id` here. The cheftap recipe
          // UUID is already preserved inside `payload`.
          db.prepare(
            `UPDATE recipes
               SET title=?, source_url=?, payload=?, hero_image_url=?,
                   status='extracted', updated_at=?
             WHERE user_id=? AND cheftap_url=?`,
          ).run(
            payload?.title ?? item.title,
            payload?.sourceURL ?? null,
            JSON.stringify(payload),
            data.heroImage,
            now(),
            userId,
            item.href,
          );
          extracted++;
          if (extracted % 5 === 0) updateJob(jobId, { extracted_count: extracted });
        } catch (e: any) {
          db.prepare(
            `UPDATE recipes SET status='error', error=?, updated_at=? WHERE user_id=? AND cheftap_url=?`,
          ).run(String(e?.message || e).slice(0, 500), now(), userId, item.href);
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, extractWorker));
    updateJob(jobId, { extracted_count: extracted });

    checkAbort();
    updateJob(jobId, { status: 'uploading', message: 'Creating Google Docs...' });

    // Ensure Drive folder
    const auth = userOauthClient(userId);
    const folderId = await ensureRecipesFolder(auth);
    db.prepare('UPDATE users SET drive_folder_id=?, updated_at=? WHERE id=?').run(folderId, now(), userId);

    const pending = db
      .prepare(`SELECT * FROM recipes WHERE job_id=? AND status='extracted'`)
      .all(jobId) as RecipeRow[];

    let uploaded = 0;
    const uploadQueue = pending.slice();
    async function uploadWorker() {
      while (uploadQueue.length) {
        if (signal.aborted) return;
        const r = uploadQueue.shift();
        if (!r) return;
        try {
          const recipe: CheftapRecipe = JSON.parse(r.payload || '{}');
          const title = recipe.title?.trim() || r.title || 'Untitled recipe';
          const { id: fileId, webViewLink } = await createDocInFolder(auth, folderId, title);
          // Pass the document URL so it gets embedded at the bottom of the doc.
          await writeRecipeIntoDoc(auth, fileId, recipe, {
            heroImageUrl: r.hero_image_url,
            docUrl: webViewLink ?? `https://docs.google.com/document/d/${fileId}/edit`,
          });
          db.prepare(
            `UPDATE recipes SET status='uploaded', drive_file_id=?, drive_web_link=?, updated_at=?
               WHERE id=?`,
          ).run(fileId, webViewLink, now(), r.id);
          uploaded++;
          if (uploaded % 5 === 0) updateJob(jobId, { uploaded_count: uploaded });
        } catch (e: any) {
          db.prepare(`UPDATE recipes SET status='error', error=?, updated_at=? WHERE id=?`).run(
            String(e?.message || e).slice(0, 500),
            now(),
            r.id,
          );
        }
      }
    }
    await Promise.all(Array.from({ length: config.uploadConcurrency }, uploadWorker));

    const counts = getRecipeCounts(jobId);
    updateJob(jobId, {
      status: 'done',
      uploaded_count: counts.uploaded,
      error_count: counts.errors,
      message: `Uploaded ${counts.uploaded} recipes (${counts.errors} errors).`,
      finished_at: now(),
    });
  } finally {
    await browser.close().catch(() => {});
    inflight.delete(jobId);
  }
}
