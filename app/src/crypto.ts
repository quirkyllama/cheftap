import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from './config.js';

const KEY = Buffer.from(config.appKey, 'hex');
if (KEY.length !== 32) {
  throw new Error(`APP_KEY must be 32 bytes (64 hex chars). Got ${KEY.length} bytes.`);
}

// AES-256-GCM with a fresh 12-byte IV per call. Output: base64(iv | tag | ciphertext).
export function encrypt(plain: string | null | undefined): string | null {
  if (plain == null) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decrypt(b64: string | null | undefined): string | null {
  if (b64 == null) return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 28) throw new Error('Ciphertext too short');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
