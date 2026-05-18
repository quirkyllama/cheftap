import { chromium } from 'playwright';
import dotenv from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

dotenv.config({ path: path.resolve(process.cwd(), '..', '.cheftap-creds.env') });
const EMAIL = process.env.CHEFTAP_EMAIL;
const PASSWORD = process.env.CHEFTAP_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error('Missing CHEFTAP_EMAIL / CHEFTAP_PASSWORD in ../.cheftap-creds.env');
  process.exit(1);
}

const OUT = path.resolve('output');
mkdirSync(OUT, { recursive: true });

const HEADLESS = process.env.HEADED !== '1';
const browser = await chromium.launch({ headless: HEADLESS });
const context = await browser.newContext({
  recordHar: { path: path.join(OUT, 'session.har'), content: 'embed' },
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();

const requestLog = [];
page.on('request', (req) => {
  requestLog.push({
    t: Date.now(),
    kind: 'req',
    method: req.method(),
    url: req.url(),
    headers: req.headers(),
    post: req.postData(),
  });
});
page.on('response', async (resp) => {
  const req = resp.request();
  let bodyPreview = null;
  try {
    const ct = resp.headers()['content-type'] || '';
    if (/json|text|javascript|xml/.test(ct)) {
      const b = await resp.body();
      bodyPreview = b.toString('utf8').slice(0, 4000);
    }
  } catch {}
  requestLog.push({
    t: Date.now(),
    kind: 'resp',
    status: resp.status(),
    url: resp.url(),
    contentType: resp.headers()['content-type'],
    bodyPreview,
  });
});

async function snap(label) {
  await page.screenshot({ path: path.join(OUT, `${label}.png`), fullPage: true });
  writeFileSync(path.join(OUT, `${label}.url.txt`), page.url() + '\n');
  console.log(`[snap] ${label}  url=${page.url()}`);
}

console.log('Navigating to cheftap.com...');
await page.goto('https://cheftap.com/', { waitUntil: 'domcontentloaded' });
await snap('00-home');

// Try clicking a Login link if present
const loginLink = page.getByRole('link', { name: /log\s*in|sign\s*in/i }).first();
if (await loginLink.count()) {
  console.log('Found login link, clicking...');
  await loginLink.click().catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
} else {
  console.log('No login link; trying /login directly.');
  await page.goto('https://cheftap.com/login', { waitUntil: 'domcontentloaded' });
}
await snap('10-login-page');

// Dump form info
const forms = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('form')).map((f) => ({
    action: f.action,
    method: f.method,
    inputs: Array.from(f.querySelectorAll('input,button,select')).map((i) => ({
      tag: i.tagName,
      name: i.name,
      type: i.type,
      id: i.id,
      placeholder: i.placeholder,
    })),
  }));
});
writeFileSync(path.join(OUT, '10-login-forms.json'), JSON.stringify(forms, null, 2));
console.log('Forms on login page:', JSON.stringify(forms, null, 2));

// Try common field names
const userSel = 'input[name="email"], input[name="username"], input[name="log"], input[type="email"], input[id*="user" i], input[id*="email" i]';
const passSel = 'input[name="password"], input[name="pwd"], input[type="password"]';

const userField = page.locator(userSel).first();
const passField = page.locator(passSel).first();
if ((await userField.count()) && (await passField.count())) {
  console.log('Filling credentials...');
  await userField.fill(EMAIL);
  await passField.fill(PASSWORD);
  // Submit
  const submitBtn = page
    .locator('button[type="submit"], input[type="submit"]')
    .first();
  if (await submitBtn.count()) {
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      submitBtn.click().catch(() => {}),
    ]);
  } else {
    await passField.press('Enter');
    await page.waitForLoadState('networkidle').catch(() => {});
  }
} else {
  console.log('Could not locate login fields automatically.');
}

await page.waitForTimeout(2000);
await snap('20-after-login');

// Try to find recipes
const recipesLink = page.getByRole('link', { name: /recipes|my recipes|recipe box/i }).first();
if (await recipesLink.count()) {
  console.log('Found recipes link, clicking...');
  await recipesLink.click().catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await snap('30-recipes');
}

writeFileSync(path.join(OUT, 'requests.json'), JSON.stringify(requestLog, null, 2));
console.log(`Saved ${requestLog.length} request/response entries to output/requests.json`);

await context.close();
await browser.close();
console.log('Done.');
