// Build a Google Doc from a ChefTap recipe payload.
import { google, docs_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

// ---------- ChefTap payload shape (the bits we care about) ----------
export type RecipeItem = {
  id?: string;
  ordinal?: number;
  class?: string; // TITLES | INGREDIENTS | STEPS | NOTES | YIELD | PREPTIME | COOKTIME | SOURCE
  text?: string;
};

export type CheftapPhoto = {
  id?: string;
  is_main?: boolean;
  recipe_id?: string;
};

export type CheftapRecipe = {
  id?: string;
  title?: string;
  source?: string;
  sourceURL?: string;
  notes?: string;
  tags?: Array<{ tag_text?: string } | string>;
  recipe?: RecipeItem[];
  main_photo?: CheftapPhoto | null;
  photos?: CheftapPhoto[];
  date_created?: string;
  date_modified?: string;
};

// ---------- Build the document body via batchUpdate requests ----------

// The Google Docs API positions are 1-indexed and refer to UTF-16 code units.
// We build a list of (text, optional style hints) chunks, then emit requests.

type Block =
  | { kind: 'h1'; text: string }
  | { kind: 'h2'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'link'; text: string; url: string }
  | { kind: 'bullet'; items: string[] }
  | { kind: 'numbered'; items: string[] }
  | { kind: 'image'; url: string };

function recipeToBlocks(r: CheftapRecipe): Block[] {
  const items = (r.recipe || []).slice().sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  const byClass = (cls: string) =>
    items.filter((i) => (i.class || '').toUpperCase() === cls).map((i) => (i.text || '').trim()).filter(Boolean);

  const ingredients = byClass('INGREDIENTS');
  const steps = byClass('STEPS');
  const yieldText = byClass('YIELD').join(', ');
  const prepTime = byClass('PREPTIME').join(', ');
  const cookTime = byClass('COOKTIME').join(', ');
  const sourceText = (r.source || '').trim();
  const sourceUrl = (r.sourceURL || '').trim();
  const notes = (r.notes || '').trim();
  const tags = (r.tags || [])
    .map((t) => (typeof t === 'string' ? t : t.tag_text || ''))
    .filter(Boolean);

  const blocks: Block[] = [];
  blocks.push({ kind: 'h1', text: r.title || 'Untitled recipe' });

  const meta: string[] = [];
  if (sourceText) meta.push(`Source: ${sourceText}`);
  if (yieldText) meta.push(`Yield: ${yieldText}`);
  if (prepTime) meta.push(`Prep: ${prepTime}`);
  if (cookTime) meta.push(`Cook: ${cookTime}`);
  if (meta.length) blocks.push({ kind: 'p', text: meta.join('  ·  ') });

  if (sourceUrl) blocks.push({ kind: 'link', text: sourceUrl, url: sourceUrl });

  if (ingredients.length) {
    blocks.push({ kind: 'h2', text: 'Ingredients' });
    blocks.push({ kind: 'bullet', items: ingredients });
  }
  if (steps.length) {
    blocks.push({ kind: 'h2', text: 'Directions' });
    blocks.push({ kind: 'numbered', items: steps });
  }
  if (notes) {
    blocks.push({ kind: 'h2', text: 'Notes' });
    blocks.push({ kind: 'p', text: notes });
  }
  if (tags.length) {
    blocks.push({ kind: 'h2', text: 'Tags' });
    blocks.push({ kind: 'p', text: tags.join(' · ') });
  }
  return blocks;
}

// Build Google Docs API requests. We insert text from the end of the document forward
// using a running index. For images, insertInlineImage with a public URI is used.
function buildRequests(blocks: Block[], heroImageUrl?: string | null): docs_v1.Schema$Request[] {
  const reqs: docs_v1.Schema$Request[] = [];
  // A new doc starts with a single empty paragraph at index 1. We append to it.

  // Insert optional hero image at index 1 first (before title), as a separate paragraph.
  if (heroImageUrl) {
    reqs.push({ insertInlineImage: { location: { index: 1 }, uri: heroImageUrl } });
    // After the image, insert a newline so the title starts on its own line.
    reqs.push({ insertText: { location: { index: 2 }, text: '\n' } });
  }

  // We'll build the rest as a single concatenated text, then apply paragraph styles
  // by computed ranges. This is simpler than sequential insert+style.
  type Segment = { start: number; end: number; style: 'h1' | 'h2' | 'normal'; bullet?: 'unord' | 'numbered'; linkUrl?: string };
  const segments: Segment[] = [];
  let body = '';

  const appendPara = (text: string, style: Segment['style'], extra?: Partial<Segment>) => {
    const start = body.length;
    body += text + '\n';
    segments.push({ start, end: body.length, style, ...extra });
  };

  for (const b of blocks) {
    if (b.kind === 'h1') appendPara(b.text, 'h1');
    else if (b.kind === 'h2') appendPara(b.text, 'h2');
    else if (b.kind === 'p') appendPara(b.text, 'normal');
    else if (b.kind === 'link') appendPara(b.text, 'normal', { linkUrl: b.url });
    else if (b.kind === 'bullet') for (const it of b.items) appendPara(it, 'normal', { bullet: 'unord' });
    else if (b.kind === 'numbered') for (const it of b.items) appendPara(it, 'normal', { bullet: 'numbered' });
    else if (b.kind === 'image') reqs.push({ insertInlineImage: { location: { index: 1 }, uri: b.url } });
  }

  // Compute the insertion index for the bulk text: end of any pre-inserted hero block.
  // Doc starts with index 1. If we inserted hero image + newline, the cursor is at index 3.
  const insertIndex = heroImageUrl ? 3 : 1;
  if (body.length > 0) {
    reqs.push({ insertText: { location: { index: insertIndex }, text: body } });
  }

  // Apply styles (offsets are relative to insertIndex).
  for (const seg of segments) {
    const startIndex = insertIndex + seg.start;
    const endIndex = insertIndex + seg.end; // includes the trailing newline -> paragraph range OK
    if (seg.style === 'h1') {
      reqs.push({
        updateParagraphStyle: {
          range: { startIndex, endIndex },
          paragraphStyle: { namedStyleType: 'HEADING_1' },
          fields: 'namedStyleType',
        },
      });
    } else if (seg.style === 'h2') {
      reqs.push({
        updateParagraphStyle: {
          range: { startIndex, endIndex },
          paragraphStyle: { namedStyleType: 'HEADING_2' },
          fields: 'namedStyleType',
        },
      });
    }
    if (seg.bullet) {
      reqs.push({
        createParagraphBullets: {
          range: { startIndex, endIndex },
          bulletPreset:
            seg.bullet === 'numbered'
              ? 'NUMBERED_DECIMAL_ALPHA_ROMAN'
              : 'BULLET_DISC_CIRCLE_SQUARE',
        },
      });
    }
    if (seg.linkUrl) {
      // textRange excludes the trailing newline for the link
      reqs.push({
        updateTextStyle: {
          range: { startIndex, endIndex: endIndex - 1 },
          textStyle: { link: { url: seg.linkUrl } },
          fields: 'link',
        },
      });
    }
  }

  return reqs;
}

export async function writeRecipeIntoDoc(
  auth: OAuth2Client,
  documentId: string,
  recipe: CheftapRecipe,
  opts: { heroImageUrl?: string | null } = {},
): Promise<void> {
  const docs = google.docs({ version: 'v1', auth });
  const blocks = recipeToBlocks(recipe);
  const requests = buildRequests(blocks, opts.heroImageUrl ?? null);
  if (!requests.length) return;
  await docs.documents.batchUpdate({
    documentId,
    requestBody: { requests },
  });
}

export { recipeToBlocks, buildRequests };
