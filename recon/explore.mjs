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
const context = await browser.newContext({
  recordHar: { path: path.join(OUT, 'explore.har'), content: 'embed' },
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();

const reqs = [];
page.on('response', async (resp) => {
  const ct = resp.headers()['content-type'] || '';
  let body = null;
  if (/json|html|text|javascript/.test(ct) && resp.status() < 400) {
    try {
      const b = await resp.body();
      if (b.length < 200000) body = b.toString('utf8');
    } catch {}
  }
  reqs.push({ status: resp.status(), url: resp.url(), ct, body });
});

async function dump(label) {
  await page.screenshot({ path: path.join(OUT, `${label}.png`), fullPage: true });
  const html = await page.content();
  writeFileSync(path.join(OUT, `${label}.html`), html);
  writeFileSync(path.join(OUT, `${label}.url.txt`), page.url() + '\n');
  console.log(`[dump] ${label}  url=${page.url()}  htmlLen=${html.length}`);
}

// Login
await page.goto('https://cheftap.com/site-login/?redirect_to=index.php', {
  waitUntil: 'domcontentloaded',
});
await page.locator('input[name="log"]').fill(EMAIL);
await page.locator('input[name="pwd"]').fill(PASSWORD);
await Promise.all([
  page.waitForLoadState('networkidle'),
  page.locator('input[name="wp-submit"]').click(),
]);
await dump('40-member-home');

// Try plausible recipe paths
const paths = [
  '/members/bakingninja/recipes/',
  '/members/bakingninja/recipe-box/',
  '/members/bakingninja/recipe/',
  '/recipes/',
  '/recipe-box/',
  '/my-recipes/',
];
for (const p of paths) {
  try {
    const resp = await page.goto('https://cheftap.com' + p, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    const status = resp ? resp.status() : 0;
    const label = `50${p.replace(/[^a-z0-9]+/gi, '-')}`;
    await dump(label);
    console.log(`  -> ${p}  status=${status}  final=${page.url()}`);
  } catch (e) {
    console.log(`  -> ${p}  ERROR ${e.message}`);
  }
}

// Extract anchors from the original member page and look for recipe-like links
await page.goto('https://cheftap.com/members/bakingninja/', { waitUntil: 'networkidle' });
const links = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('a[href]')).map((a) => ({
    text: a.textContent.trim().slice(0, 80),
    href: a.href,
  }));
});
writeFileSync(path.join(OUT, '60-member-links.json'), JSON.stringify(links, null, 2));
const recipeLinks = links.filter(
  (l) => /recipe/i.test(l.href) || /recipe/i.test(l.text),
);
console.log(`Recipe-related links: ${recipeLinks.length}`);
for (const l of recipeLinks.slice(0, 20)) console.log(`  ${l.href}  "${l.text}"`);

// If any recipe links found, visit the first one and dump HTML
if (recipeLinks.length) {
  const first = recipeLinks[0].href;
  await page.goto(first, { waitUntil: 'networkidle' });
  await dump('70-first-recipe');
}

writeFileSync(path.join(OUT, 'explore-requests.json'), JSON.stringify(reqs.slice(-200), null, 2));
console.log(`Captured ${reqs.length} responses.`);

await context.close();
await browser.close();
