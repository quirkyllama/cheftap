// Inspect one recipe deeply: dump jsonRecipe, userTags, postId, ajax nonce
import { chromium } from 'playwright';
import dotenv from 'dotenv';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

dotenv.config({ path: path.resolve(process.cwd(), '..', '.cheftap-creds.env') });
const OUT = path.resolve('output');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

await page.goto('https://cheftap.com/site-login/?redirect_to=index.php');
await page.locator('input[name="log"]').fill(process.env.CHEFTAP_EMAIL);
await page.locator('input[name="pwd"]').fill(process.env.CHEFTAP_PASSWORD);
await Promise.all([
  page.waitForLoadState('networkidle'),
  page.locator('input[name="wp-submit"]').click(),
]);

await page.goto('https://cheftap.com/recipes/eleven-madison-park-granola-26/', {
  waitUntil: 'networkidle',
});

const probe = await page.evaluate(() => {
  // Pull globals defined by the cheftap-recipe plugin
  const out = {};
  try { out.postId = window.postId; } catch {}
  try { out.jsonRecipe = window.jsonRecipe; } catch {}
  try { out.userTags = window.userTags; } catch {}
  try { out.ajaxurl = window.ajaxurl; } catch {}
  try { out.cheftapRecipe = window.cheftapRecipe; } catch {}
  // Hero / images
  const hero = document.querySelector('#recipe-hero');
  out.heroSrc = hero?.src;
  out.heroSrcset = hero?.srcset;
  // Source url
  out.sourceUrl = document.querySelector('.source-url')?.href;
  // Slug
  out.slug = location.pathname;
  return out;
});

writeFileSync(path.join(OUT, '90-probe.json'), JSON.stringify(probe, null, 2));
console.log('postId:', probe.postId);
console.log('ajaxurl:', probe.ajaxurl);
console.log('heroSrc:', probe.heroSrc);
console.log('sourceUrl:', probe.sourceUrl);
console.log('userTags count:', Array.isArray(probe.userTags) ? probe.userTags.length : 'n/a');
console.log('jsonRecipe keys:',
  probe.jsonRecipe && typeof probe.jsonRecipe === 'object'
    ? Object.keys(probe.jsonRecipe)
    : 'n/a');
if (probe.jsonRecipe) {
  console.log('jsonRecipe preview:', JSON.stringify(probe.jsonRecipe).slice(0, 1200));
}

// Also try to find AJAX security nonces in the HTML
const html = await page.content();
const nonces = [...html.matchAll(/security['"]?\s*[:=]\s*['"]([a-f0-9]{6,})['"]/g)].map((m) => m[1]);
const ajaxActions = [...html.matchAll(/action['"]?\s*[:=]\s*['"]([a-z_]+)['"]/g)].map((m) => m[1]);
console.log('nonces found:', [...new Set(nonces)].slice(0, 10));
console.log('ajax actions found:', [...new Set(ajaxActions)].slice(0, 20));

await context.close();
await browser.close();
