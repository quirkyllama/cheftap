import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export async function loginCheftap(
  username: string,
  password: string,
): Promise<{ browser: Browser; context: BrowserContext; page: Page; memberUrl: string }> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto('https://cheftap.com/site-login/?redirect_to=index.php', {
    waitUntil: 'domcontentloaded',
  });
  await page.locator('input[name="log"]').fill(username);
  await page.locator('input[name="pwd"]').fill(password);
  await Promise.all([
    page.waitForLoadState('networkidle'),
    page.locator('input[name="wp-submit"]').click(),
  ]);
  if (!/\/members\//.test(page.url())) {
    const errText = await page
      .locator('#login_error, .login-error, body')
      .first()
      .innerText()
      .catch(() => '');
    await browser.close();
    throw new Error(
      `Login failed (still at ${page.url()}). ${errText.slice(0, 200) || 'Check credentials.'}`,
    );
  }
  return { browser, context, page, memberUrl: page.url() };
}
