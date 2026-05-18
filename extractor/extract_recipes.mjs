// Phase 2: Visit each recipe URL, extract window.jsonRecipe -> JSON.
// Strategy: log in via browser, reuse cookies via APIRequestContext for parallel HTTP fetches.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { loginBrowser, extractJsonRecipeFromHtml } from './lib.mjs';

const OUT = path.resolve('output');
const RECIPES_DIR = path.join(OUT, 'recipes');
mkdirSync(RECIPES_DIR, { recursive: true });

const limit = Number(process.env.LIMIT || 0);
const concurrency = Number(process.env.CONCURRENCY || 6);
const force = process.env.FORCE === '1';

const index = JSON.parse(readFileSync(path.join(OUT, 'index.json'), 'utf8'));
let work = index.slice();
if (limit > 0) work = work.slice(0, limit);
console.log(`Indexed: ${index.length}.  Will process: ${work.length}  (concurrency=${concurrency})`);

const { browser, context } = await loginBrowser(true);

// Build an API request context that shares cookies with the logged-in browser context.
const cookies = await context.cookies();
const apiContext = await browser.newContext({ storageState: { cookies, origins: [] } });
const api = apiContext.request;

let done = 0;
let okCount = 0;
let errCount = 0;
const errors = [];

async function fetchOne(item) {
  const slug = item.slug;
  const outPath = path.join(RECIPES_DIR, `${slug}.json`);
  if (!force && existsSync(outPath)) return { skipped: true, slug };
  try {
    const resp = await api.get(item.href, { timeout: 30000 });
    if (resp.status() !== 200) {
      throw new Error(`HTTP ${resp.status()}`);
    }
    const html = await resp.text();
    const data = extractJsonRecipeFromHtml(html);
    if (!data) throw new Error('jsonRecipe not found');
    if (data.__error) throw new Error('jsonRecipe parse: ' + data.__error);
    const wpPostIdMatch = html.match(/postid-(\d+)/);
    const heroMatch = html.match(/id="recipe-hero"[^>]*src="([^"]+)"/);
    const enriched = {
      slug,
      url: item.href,
      wp_post_id: wpPostIdMatch ? Number(wpPostIdMatch[1]) : null,
      hero_image: heroMatch ? heroMatch[1] : null,
      thumb: item.thumb || null,
      recipe: data,
    };
    writeFileSync(outPath, JSON.stringify(enriched, null, 2));
    return { ok: true, slug };
  } catch (e) {
    return { error: e.message, slug, url: item.href };
  }
}

async function worker(items) {
  for (const item of items) {
    const r = await fetchOne(item);
    done++;
    if (r.ok) okCount++;
    else if (r.error) {
      errCount++;
      errors.push({ slug: r.slug, url: r.url, error: r.error });
    }
    if (done % 25 === 0 || done === work.length) {
      console.log(`[${done}/${work.length}]  ok=${okCount}  err=${errCount}`);
    }
  }
}

// Split work into N chunks for the N workers
const chunks = Array.from({ length: concurrency }, () => []);
work.forEach((item, i) => chunks[i % concurrency].push(item));
await Promise.all(chunks.map(worker));

writeFileSync(path.join(OUT, 'extract-errors.json'), JSON.stringify(errors, null, 2));
console.log(`\nDone.  ok=${okCount}  err=${errCount}  errors -> output/extract-errors.json`);

await apiContext.close();
await browser.close();
