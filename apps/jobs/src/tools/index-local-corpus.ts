/**
 * Indexa en DynamoDB (CORPUS#/CORPUSDAY) las notas cargadas a mano desde scripts/out/corpus,
 * para que el backoffice y las tarjetas de portada las vean. Uso:
 *   TABLE_NAME=pelp-main-dev AWS_PROFILE=dailybrief npx tsx apps/jobs/src/tools/index-local-corpus.ts scripts/out/corpus
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { DynamoDb, Store } from '@pelp/engine/core';

interface Sidecar {
  metadataAttributes: Record<string, string | number>;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith('.metadata.json')) yield full;
  }
}

async function main(): Promise<void> {
  const root = process.argv[2] ?? 'scripts/out/corpus';
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error('Falta TABLE_NAME');
  const store = new Store(new DynamoDb(tableName));
  const perDay = new Map<string, number>();
  let written = 0;
  let unchanged = 0;
  for (const file of walk(root)) {
    const attrs = (JSON.parse(readFileSync(file, 'utf8')) as Sidecar).metadataAttributes;
    const articleId = String(attrs.articleId);
    const s3Key = path.relative(root, file).replace(/\.metadata\.json$/, '');
    const existing = await store.getCorpusIndex(articleId);
    if (existing && existing.contentHash === String(attrs.contentHash) && !existing.removed) {
      unchanged += 1;
      continue;
    }
    const day = String(attrs.date);
    await store.putCorpusIndex({
      articleId,
      contentHash: String(attrs.contentHash),
      s3Key,
      date: day,
      title: String(attrs.title),
      url: String(attrs.url),
      section: String(attrs.section).split('/')[0] ?? String(attrs.section),
      origin: 'backfill',
      updatedAt: new Date().toISOString(),
      ...(attrs.imageUrl ? { imageUrl: String(attrs.imageUrl) } : {}),
      ...(attrs.deck ? { deck: String(attrs.deck) } : {}),
    });
    if (!existing || existing.removed) perDay.set(day, (perDay.get(day) ?? 0) + 1);
    written += 1;
  }
  for (const [day, count] of perDay) await store.incrementCorpusDay(day, count);
  console.log(JSON.stringify({ written, unchanged, days: Object.fromEntries(perDay) }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
