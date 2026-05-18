// Phase 1: Walk all pages of the member's recipe list and collect (slug, title, thumb) tuples.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loginBrowser, loadEnv } from './lib.mjs';

const OUT = path.resolve('output');
mkdirSync(OUT, { recursive: true });

const { user } = loadEnv();
const { browser, page } = await loginBrowser(true);

const memberUrl = `https://cheftap.com/members/${user}/`;
await page.goto(memberUrl, { waitUntil: 'networkidle' });

async function harvestPage() {
  return page.evaluate(() => {
    const items = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/recipes/"]')) {
      const href = a.href;
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
        thumb: img?.src || null,
        slug: new URL(href).pathname.replace(/\/recipes\/|\/$/g, ''),
      });
    }
    return items;
  });
}

async function getTotalPages() {
  return page.evaluate(() => {
    const txt = document.body.innerText;
    const m = txt.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
    return m ? { current: +m[1], total: +m[2] } : null;
  });
}

const all = new Map();
let pageInfo = await getTotalPages();
console.log('First page info:', pageInfo);

// Page 1
for (const r of await harvestPage()) all.set(r.href, r);
console.log(`Page 1: ${all.size} recipes so far`);

if (pageInfo && pageInfo.total > 1) {
  for (let p = 2; p <= pageInfo.total; p++) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      page.evaluate((p) => {
        const el = document.getElementById('paged');
        if (el) el.value = String(p);
        const f = document.getElementById('search-form');
        if (f) f.submit();
      }, p),
    ]);
    const before = all.size;
    for (const r of await harvestPage()) {
      if (!all.has(r.href)) all.set(r.href, r);
    }
    console.log(`Page ${p}: +${all.size - before}  total=${all.size}`);
  }
}

const list = Array.from(all.values());
writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(list, null, 2));
console.log(`\nDone. ${list.length} recipes indexed -> output/index.json`);

await browser.close();
