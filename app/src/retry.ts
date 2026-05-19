// Retry with exponential backoff for transient errors (429 / 5xx / network).
// Honors a `Retry-After` header if the server provides one.

type Logger = (msg: string) => void;

export type RetryOpts = {
  maxAttempts?: number;
  baseMs?: number;
  maxMs?: number;
  log?: Logger;
  label?: string;
};

function statusOf(err: any): number | string | undefined {
  // googleapis sets err.code = numeric HTTP status on GaxiosError.
  // Playwright APIRequestContext throws plain errors with status() on the Response.
  // Fetch-style errors have .response.status.
  return (
    err?.response?.status ??
    err?.status ??
    err?.code ??
    undefined
  );
}

function retryAfterMs(err: any): number | null {
  const ra =
    err?.response?.headers?.['retry-after'] ??
    err?.response?.headers?.get?.('retry-after') ??
    err?.headers?.['retry-after'];
  if (ra == null) return null;
  const n = Number(ra);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  const date = Date.parse(String(ra));
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

function isRetriable(err: any): boolean {
  const s = statusOf(err);
  if (s === 429) return true;
  if (typeof s === 'number' && s >= 500 && s < 600) return true;
  if (s === 'ETIMEDOUT' || s === 'ECONNRESET' || s === 'ECONNREFUSED' || s === 'EAI_AGAIN') return true;
  // googleapis nests under err.errors[0].reason; also surface message-based hints.
  const reason = err?.errors?.[0]?.reason;
  if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') return true;
  const msg = String(err?.message || '');
  if (/quota exceeded/i.test(msg) || /rate limit/i.test(msg)) return true;
  return false;
}

// Defaults: 4 attempts total (1 initial + 3 retries), exponential backoff 1s -> 2s -> 4s.
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const max = opts.maxAttempts ?? 4;
  const base = opts.baseMs ?? 1000;
  const cap = opts.maxMs ?? 60_000;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await fn();
    } catch (err: any) {
      if (!isRetriable(err) || attempt >= max) throw err;
      const ra = retryAfterMs(err);
      // When a 429 has no Retry-After, the quota window is typically 60s.
      // Wait at least ~30-60s for the per-minute counter to roll over.
      const status = statusOf(err);
      const minFor429 = status === 429 ? 30_000 : 0;
      const expo = Math.min(cap, base * 2 ** (attempt - 1));
      const jitter = Math.random() * Math.min(500, expo * 0.25);
      const wait = ra != null ? Math.max(ra, 100) : Math.max(minFor429, expo + jitter);
      opts.log?.(
        `[retry${opts.label ? ` ${opts.label}` : ''}] attempt ${attempt} status=${statusOf(err)} sleeping ${Math.round(wait)}ms`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
