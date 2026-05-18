// Shared helpers
import { chromium } from 'playwright';
import dotenv from 'dotenv';
import path from 'node:path';

export function loadEnv() {
  dotenv.config({ path: path.resolve(process.cwd(), '..', '.cheftap-creds.env') });
  const email = process.env.CHEFTAP_EMAIL;
  const password = process.env.CHEFTAP_PASSWORD;
  if (!email || !password) throw new Error('Missing CHEFTAP_EMAIL/CHEFTAP_PASSWORD');
  return { email, password, user: email };
}

export async function loginBrowser(headless = true) {
  const { email, password } = loadEnv();
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto('https://cheftap.com/site-login/?redirect_to=index.php', {
    waitUntil: 'domcontentloaded',
  });
  await page.locator('input[name="log"]').fill(email);
  await page.locator('input[name="pwd"]').fill(password);
  await Promise.all([
    page.waitForLoadState('networkidle'),
    page.locator('input[name="wp-submit"]').click(),
  ]);
  if (!/\/members\//.test(page.url())) {
    throw new Error(`Login did not land on /members/; got ${page.url()}`);
  }
  return { browser, context, page };
}

// Extract jsonRecipe out of an HTML body using regex. Returns parsed object or null.
export function extractJsonRecipeFromHtml(html) {
  // jsonRecipe is assigned inline like:  var jsonRecipe = { ... };
  // We need to capture a balanced JSON object after the assignment.
  const re = /\bjsonRecipe\s*=\s*(\{)/g;
  const m = re.exec(html);
  if (!m) return null;
  let i = m.index + m[0].length - 1; // index of opening brace
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
        try { return JSON.parse(raw); }
        catch (e) { return { __error: e.message, __raw: raw.slice(0, 200) }; }
      }
    }
  }
  return null;
}

// Convert ChefTap's compact ISO (YYYYMMDDTHHmmssZ) to standard ISO
export function ctDate(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return s;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}
