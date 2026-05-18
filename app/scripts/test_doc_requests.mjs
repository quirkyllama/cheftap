// Smoke-test: feed a sample recipe through the Docs request builder and print.
import { recipeToBlocks, buildRequests } from '../dist/google/docs.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const samplePath = path.resolve(
  '../extractor/output/recipes/eleven-madison-park-granola-26.json',
);
const sample = JSON.parse(readFileSync(samplePath, 'utf8'));
const recipe = sample.recipe;

const blocks = recipeToBlocks(recipe);
const reqs = buildRequests(blocks, sample.hero_image);
console.log('Blocks:', blocks.length);
console.log(JSON.stringify(blocks, null, 2));
console.log('\nGoogle Docs API requests:', reqs.length);
console.log(JSON.stringify(reqs, null, 2).slice(0, 2000));
