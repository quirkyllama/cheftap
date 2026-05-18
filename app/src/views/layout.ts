// Tiny HTML helper. No template engine; just tagged template strings.
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, s, i) => acc + s + (i < values.length ? esc(values[i]) : ''), '');
}

// Marker to inject raw (already-escaped) HTML inside an html`` template.
export function raw(s: string) {
  return { __raw: s } as const;
}

export function htmlMixed(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, s, i) => {
    if (i >= values.length) return acc + s;
    const v = values[i];
    const piece = typeof v === 'object' && v && '__raw' in (v as any) ? (v as any).__raw : esc(v);
    return acc + s + piece;
  }, '');
}

export function layout(opts: {
  title: string;
  user?: { email: string; name: string | null; picture: string | null } | null;
  body: string;
}): string {
  const userBadge = opts.user
    ? `<div class="user"><img src="${esc(opts.user.picture || '')}" alt=""><span>${esc(opts.user.name || opts.user.email)}</span><a href="/logout">Sign out</a></div>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)} · ChefTap → Google Docs</title>
<link rel="stylesheet" href="/public/style.css">
<script src="https://unpkg.com/htmx.org@1.9.12" defer></script>
</head>
<body>
<header>
  <a class="logo" href="/">🍳 ChefTap → Google Docs</a>
  ${userBadge}
</header>
<main>
${opts.body}
</main>
<footer>Your ChefTap credentials are encrypted at rest and only used to download your recipes.</footer>
</body>
</html>`;
}
