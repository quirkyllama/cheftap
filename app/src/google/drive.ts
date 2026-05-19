import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { withRetry } from '../retry.js';

const FOLDER_NAME = 'ChefTap Recipes';

export async function ensureRecipesFolder(auth: OAuth2Client): Promise<string> {
  const drive = google.drive({ version: 'v3', auth });
  const list = await withRetry(
    () =>
      drive.files.list({
        q: `name='${FOLDER_NAME.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        spaces: 'drive',
        fields: 'files(id,name)',
        pageSize: 5,
      }),
    { label: 'drive.files.list', log: (m) => console.log(m) },
  );
  const existing = list.data.files?.[0]?.id;
  if (existing) return existing;
  const created = await withRetry(
    () =>
      drive.files.create({
        requestBody: {
          name: FOLDER_NAME,
          mimeType: 'application/vnd.google-apps.folder',
        },
        fields: 'id',
      }),
    { label: 'drive.files.create(folder)', log: (m) => console.log(m) },
  );
  if (!created.data.id) throw new Error('Drive folder create returned no id');
  return created.data.id;
}

export async function createDocInFolder(
  auth: OAuth2Client,
  folderId: string,
  title: string,
): Promise<{ id: string; webViewLink: string | null }> {
  const drive = google.drive({ version: 'v3', auth });
  const res = await withRetry(
    () =>
      drive.files.create({
        requestBody: {
          name: title,
          mimeType: 'application/vnd.google-apps.document',
          parents: [folderId],
        },
        fields: 'id, webViewLink',
      }),
    { label: 'drive.files.create(doc)', log: (m) => console.log(m) },
  );
  if (!res.data.id) throw new Error('Drive doc create returned no id');
  return { id: res.data.id, webViewLink: res.data.webViewLink ?? null };
}
