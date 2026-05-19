import 'dotenv/config';
import path from 'node:path';

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT || 8080),
  publicBaseUrl: req('PUBLIC_BASE_URL', 'http://localhost:8080'),
  appKey: req('APP_KEY'),
  google: {
    clientId: req('GOOGLE_CLIENT_ID'),
    clientSecret: req('GOOGLE_CLIENT_SECRET'),
    redirectUri: req('PUBLIC_BASE_URL', 'http://localhost:8080') + '/oauth/google/callback',
    scopes: [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/documents',
      // Note: programmatic Gemini API typically uses an API key, not OAuth.
      // For end-user OAuth access to Gemini via Generative Language API:
      'https://www.googleapis.com/auth/generative-language.retriever',
    ],
  },
  dbPath: path.resolve(process.env.DB_PATH || './data/app.sqlite'),
  extractConcurrency: Number(process.env.EXTRACT_CONCURRENCY || 4),
  uploadConcurrency: Number(process.env.UPLOAD_CONCURRENCY || 3),
  // Stay safely under the Docs write-quota of 60/min/user (default). Each
  // recipe issues 1 docs.documents.batchUpdate, so we cap at ~50/min.
  docsWritesPerMinute: Number(process.env.DOCS_WRITES_PER_MINUTE || 50),
  isProd: process.env.NODE_ENV === 'production',
};
