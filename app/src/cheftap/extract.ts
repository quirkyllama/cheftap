import type { Page, BrowserContext } from 'playwright';
import { withRetry } from '../retry.js';

export type IndexedRecipe = { href: string; title: string; slug: string; thumb: string | null };

export async function indexRecipes(page: Page, memberUrl: string): Promise<IndexedRecipe[]> {
  await page.goto(memberUrl, { waitUntil: 'networkidle' });

  const pageInfo = await page.evaluate(() => {
    const m = document.body.innerText.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
    return m ? { current: +m[1], total: +m[2] } : { current: 1, total: 1 };
  });

  const all = new Map<string, IndexedRecipe>();
  async function harvest() {
    return page.evaluate(() => {
      const items: { href: string; title: string; slug: string; thumb: string | null }[] = [];
      const seen = new Set<string>();
      for (const a of Array.from(document.querySelectorAll('a[href*="/recipes/"]'))) {
        const href = (a as HTMLAnchorElement).href;
        if (seen.has(href)) continue;
        seen.add(href);
        const card = a.closest('article, li, .recipe-card, div');
        const img = card?.querySelector('img');
        const title =
          (a.textContent || '').trim() ||
          card?.querySelector('h1,h2,h3,h4,.title')?.textContent?.trim() ||
          '';
        items.push({
          href,
          title,
          slug: new URL(href).pathname.replace(/\/recipes\/|\/$/g, ''),
          thumb: (img as HTMLImageElement | null)?.src || null,
        });
      }
      return items;
    });
  }

  for (const r of await harvest()) all.set(r.href, r);

  for (let p = 2; p <= pageInfo.total; p++) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      page.evaluate((n) => {
        const el = document.getElementById('paged') as HTMLInputElement | null;
        if (el) el.value = String(n);
        const f = document.getElementById('search-form') as HTMLFormElement | null;
        f?.submit();
      }, p),
    ]);
    for (const r of await harvest()) if (!all.has(r.href)) all.set(r.href, r);
  }
  return Array.from(all.values());
}

// Extract window.jsonRecipe by regex from HTML body.
export function extractJsonRecipeFromHtml(html: string): unknown | null {
  const re = /\bjsonRecipe\s*=\s*(\{)/g;
  const m = re.exec(html);
  if (!m) return null;
  let i = m.index + m[0].length - 1;
  let depth = 0;
  let inStr = false;
  let strCh = '';
  let esc = false;
  const start = i;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === strCh) { inStr = false; continue; }
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const raw = html.slice(start, i + 1);
        return JSON.parse(raw);
      }
    }
  }
  return null;
}

// Use the context's APIRequestContext to fetch the recipe page using the existing cookies.
// Wraps the fetch+parse in retry logic that treats 429/5xx as transient.
export async function fetchRecipeData(
  context: BrowserContext,
  url: string,
): Promise<{ payload: unknown; heroImage: string | null; wpPostId: number | null }> {
  return withRetry(
    async () => {
      const resp = await context.request.get(url, { timeout: 30000 });
      const status = resp.status();
      if (status !== 200) {
        const err: any = new Error(`HTTP ${status} fetching ${url}`);
        err.status = status;
        // Surface Retry-After if cheftap ever sets it.
        const headers = resp.headers();
        if (headers['retry-after']) err.headers = { 'retry-after': headers['retry-after'] };
        throw err;
      }
      const html = await resp.text();
      const payload = extractJsonRecipeFromHtml(html);
      if (!payload) throw new Error(`jsonRecipe not found in ${url}`);
      const heroMatch = html.match(/id="recipe-hero"[^>]*src="([^"]+)"/);
      const idMatch = html.match(/postid-(\d+)/);
      return {
        payload,
        heroImage: heroMatch ? heroMatch[1] : null,
        wpPostId: idMatch ? Number(idMatch[1]) : null,
      };
    },
    { label: `cheftap-fetch ${url}`, log: (m) => console.log(m) },
  );
}
