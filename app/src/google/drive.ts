import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

const FOLDER_NAME = 'ChefTap Recipes';

export async function ensureRecipesFolder(auth: OAuth2Client): Promise<string> {
  const drive = google.drive({ version: 'v3', auth });
  // With drive.file scope, we can only see files the app created. So the lookup
  // is scoped by us anyway. We still try to find a prior folder before creating.
  const list = await drive.files.list({
    q: `name='${FOLDER_NAME.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    spaces: 'drive',
    fields: 'files(id,name)',
    pageSize: 5,
  });
  const existing = list.data.files?.[0]?.id;
  if (existing) return existing;
  const created = await drive.files.create({
    requestBody: {
      name: FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id',
  });
  if (!created.data.id) throw new Error('Drive folder create returned no id');
  return created.data.id;
}

export async function createDocInFolder(
  auth: OAuth2Client,
  folderId: string,
  title: string,
): Promise<{ id: string; webViewLink: string | null }> {
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.create({
    requestBody: {
      name: title,
      mimeType: 'application/vnd.google-apps.document',
      parents: [folderId],
    },
    fields: 'id, webViewLink',
  });
  if (!res.data.id) throw new Error('Drive doc create returned no id');
  return { id: res.data.id, webViewLink: res.data.webViewLink ?? null };
}
