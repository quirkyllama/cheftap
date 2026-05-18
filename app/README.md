# ChefTap → Google Docs

Imports a user's ChefTap recipes as Google Docs in a "ChefTap Recipes" folder in their Drive.

## Flow
1. User signs in with Google (scopes: `drive.file`, `documents`, `generative-language.retriever`).
2. User enters their ChefTap credentials (encrypted at rest with AES-256-GCM).
3. A background job runs in Playwright Chromium:
   - logs in to cheftap.com
   - paginates the member recipe list
   - extracts `window.jsonRecipe` from each recipe page
   - creates one Google Doc per recipe in the user's Drive

## Local development
1. `cp .env.example .env` and fill in:
   - `APP_KEY` — `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` from Google Cloud Console
2. In Google Cloud Console → OAuth client → Authorized redirect URI:
   `http://localhost:8080/oauth/google/callback`
3. `npm install`
4. `npm run dev` (or `bun install && bun --bun run dev`)

## Deployment to Fly
```bash
fly launch --no-deploy   # or: fly apps create cheftap-import
fly volumes create cheftap_data --size 1 --region iad
fly secrets set \
  APP_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  GOOGLE_CLIENT_ID=... \
  GOOGLE_CLIENT_SECRET=... \
  PUBLIC_BASE_URL=https://cheftap-import.fly.dev
fly deploy
```

Add `https://cheftap-import.fly.dev/oauth/google/callback` to the Google OAuth client's Authorized redirect URIs.

## Notes on scopes
- `drive.file` — the app can only see files it created. Minimum-privilege.
- `documents` — read/write Google Docs the app created.
- `generative-language.retriever` — OAuth scope for the Generative Language API. (Most Gemini calls
  use an API key instead; this scope is here for future "ask Gemini about your recipes" UX.)
