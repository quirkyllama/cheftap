import { OAuth2Client } from 'google-auth-library';
import { config } from '../config.js';
import { db, now, type UserRow } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';

export function makeOauthClient(): OAuth2Client {
  return new OAuth2Client(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri,
  );
}

export function authUrl(state: string): string {
  const c = makeOauthClient();
  return c.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: config.google.scopes,
    state,
  });
}

type Profile = { sub: string; email: string; name?: string; picture?: string };

export async function exchangeCode(code: string): Promise<{
  user: Profile;
  tokens: { access_token: string; refresh_token?: string; expiry_date?: number };
}> {
  const c = makeOauthClient();
  const { tokens } = await c.getToken(code);
  if (!tokens.id_token) throw new Error('No id_token returned');
  const ticket = await c.verifyIdToken({
    idToken: tokens.id_token,
    audience: config.google.clientId,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) throw new Error('No subject/email in id_token');
  return {
    user: {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
    },
    tokens: {
      access_token: tokens.access_token!,
      refresh_token: tokens.refresh_token || undefined,
      expiry_date: tokens.expiry_date || undefined,
    },
  };
}

export function upsertUserFromOAuth(
  user: Profile,
  tokens: { access_token: string; refresh_token?: string; expiry_date?: number },
) {
  const t = now();
  const existing = db
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(user.sub) as UserRow | undefined;
  const refreshEnc = tokens.refresh_token
    ? encrypt(tokens.refresh_token)
    : existing?.refresh_token ?? null;
  const accessEnc = encrypt(tokens.access_token);
  if (existing) {
    db.prepare(
      `UPDATE users
         SET email=?, name=?, picture=?, refresh_token=?, access_token=?, access_expires=?, updated_at=?
       WHERE id=?`,
    ).run(
      user.email,
      user.name ?? null,
      user.picture ?? null,
      refreshEnc,
      accessEnc,
      tokens.expiry_date ?? null,
      t,
      user.sub,
    );
  } else {
    db.prepare(
      `INSERT INTO users
         (id, email, name, picture, refresh_token, access_token, access_expires, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      user.sub,
      user.email,
      user.name ?? null,
      user.picture ?? null,
      refreshEnc,
      accessEnc,
      tokens.expiry_date ?? null,
      t,
      t,
    );
  }
}

// Returns an OAuth2Client that auto-refreshes; persists new access tokens back to DB.
export function userOauthClient(userId: string): OAuth2Client {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
  if (!row) throw new Error(`User ${userId} not found`);
  const c = makeOauthClient();
  c.setCredentials({
    access_token: row.access_token ? decrypt(row.access_token) ?? undefined : undefined,
    refresh_token: row.refresh_token ? decrypt(row.refresh_token) ?? undefined : undefined,
    expiry_date: row.access_expires ?? undefined,
  });
  c.on('tokens', (toks) => {
    const t = now();
    db.prepare(
      `UPDATE users
         SET access_token=COALESCE(?, access_token),
             access_expires=COALESCE(?, access_expires),
             refresh_token=COALESCE(?, refresh_token),
             updated_at=?
       WHERE id=?`,
    ).run(
      toks.access_token ? encrypt(toks.access_token) : null,
      toks.expiry_date ?? null,
      toks.refresh_token ? encrypt(toks.refresh_token) : null,
      t,
      userId,
    );
  });
  return c;
}
