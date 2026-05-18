import { chromium } from 'playwright';
import dotenv from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

dotenv.config({ path: path.resolve(process.cwd(), '..', '.cheftap-creds.env') });
const EMAIL = process.env.CHEFTAP_EMAIL;
const PASSWORD = process.env.CHEFTAP_PASSWORD;

const OUT = path.resolve('output');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

// Login
await page.goto('https://cheftap.com/site-login/?redirect_to=index.php');
await page.locator('input[name="log"]').fill(EMAIL);
await page.locator('input[name="pwd"]').fill(PASSWORD);
await Promise.all([
  page.waitForLoadState('networkidle'),
  page.locator('input[name="wp-submit"]').click(),
]);

// Member page: extract every recipe link + thumbnail
await page.goto('https://cheftap.com/members/bakingninja/', { waitUntil: 'networkidle' });

// Auto-scroll in case it's lazy-loaded
let prev = 0;
for (let i = 0; i < 50; i++) {
  await page.mouse.wheel(0, 8000);
  await page.waitForTimeout(400);
  const cnt = await page.locator('a[href*="/recipes/"]').count();
  if (cnt === prev) break;
  prev = cnt;
}

const recipes = await page.evaluate(() => {
  const seen = new Map();
  for (const a of document.querySelectorAll('a[href*="/recipes/"]')) {
    const href = a.href;
    if (seen.has(href)) continue;
    const card = a.closest('article, li, .recipe, .recipe-card, div') || a;
    const img = card.querySelector('img');
    const title = a.textContent.trim() || card.querySelector('h1,h2,h3,h4,.title')?.textContent.trim() || '';
    seen.set(href, {
      href,
      title,
      thumb: img?.src || null,
      thumbSrcset: img?.srcset || null,
      thumbDataSrc: img?.getAttribute('data-src') || null,
    });
  }
  return Array.from(seen.values());
});
console.log(`Total unique recipe URLs on member page: ${recipes.length}`);
writeFileSync(path.join(OUT, 'recipe-index.json'), JSON.stringify(recipes, null, 2));

// Print first 5
for (const r of recipes.slice(0, 5)) {
  console.log(`  - ${r.title}  ${r.href}  thumb=${r.thumb}`);
}

// Fetch first recipe detail page
if (recipes[0]) {
  const url = recipes[0].href;
  console.log(`\nFetching detail: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle' });
  const html = await page.content();
  writeFileSync(path.join(OUT, '80-recipe-detail.html'), html);
  await page.screenshot({ path: path.join(OUT, '80-recipe-detail.png'), fullPage: true });
  writeFileSync(path.join(OUT, '80-recipe-detail.url.txt'), url + '\n');
  console.log(`Saved detail (${html.length} bytes)`);

  // Try to extract structured data
  const structured = await page.evaluate(() => {
    const out = {};
    out.title = document.querySelector('h1, .recipe-title')?.textContent.trim();
    out.ingredients = Array.from(
      document.querySelectorAll('.ingredient, [class*=ingredient] li, ul.ingredients li'),
    ).map((e) => e.textContent.trim());
    out.directions = Array.from(
      document.querySelectorAll('.direction, [class*=direction] li, ol.directions li, .step'),
    ).map((e) => e.textContent.trim());
    out.images = Array.from(document.querySelectorAll('img')).map((i) => i.src).filter((s) => /uploads\/bakingninja/.test(s));
    out.jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((s) => s.textContent);
    return out;
  });
  writeFileSync(path.join(OUT, '80-recipe-detail.parsed.json'), JSON.stringify(structured, null, 2));
  console.log(`Title: ${structured.title}`);
  console.log(`Ingredients (${structured.ingredients.length}): ${structured.ingredients.slice(0, 5).join(' | ')}`);
  console.log(`Directions  (${structured.directions.length}): ${structured.directions.slice(0, 3).join(' | ').slice(0, 200)}`);
  console.log(`Images: ${structured.images.length}`);
  console.log(`JSON-LD blocks: ${structured.jsonLd.length}`);
}

await context.close();
await browser.close();
