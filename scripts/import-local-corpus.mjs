#!/usr/bin/env node
// Convierte el export local de Daily Brief (corpus/corpus.jsonl, generado por export-articles.mjs)
// al formato de la sección 5.2 (notas/AAAA/MM/DD/<articleId>.md + .metadata.json) en scripts/out/corpus.
// Luego: aws s3 sync scripts/out/corpus s3://pelp-corpus-178042202224-dev/ && aws bedrock-agent start-ingestion-job …
// Uso: node scripts/import-local-corpus.mjs [corpus/corpus.jsonl] [scripts/out/corpus]
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const input = process.argv[2] ?? 'corpus/corpus.jsonl';
const outDir = process.argv[3] ?? 'scripts/out/corpus';
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const lines = readFileSync(input, 'utf8').split('\n').filter(Boolean);
let written = 0;
for (const line of lines) {
  const a = JSON.parse(line);
  const externalId = String(a.articleId ?? '').replace(/^feed-/, '');
  const articleId = /^[0-9a-f]{64}$/.test(a.articleId) ? a.articleId : sha256(`elpais:${externalId}`);
  const date = (a.date ?? '').slice(0, 10);
  if (!a.title || !a.link || !a.bodyText || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
  const [year, month, day] = date.split('-');
  const key = path.join(outDir, 'notas', year, month, day, `${articleId}.md`);
  const contentHash = sha256(`${a.title}\n${a.bodyText}\n${a.link}`);
  const md = [`# ${a.title}`, '', '- Medio: El País (Uruguay)', `- Fecha: ${date}`, `- Sección: ${a.category || 'sin-seccion'}`, `- URL: ${a.link}`, '', ...(a.deck ? [`> ${a.deck}`, ''] : []), a.bodyText, ''].join('\n');
  // Bedrock rechaza atributos con string vacío: author y keywords solo si tienen valor.
  const attributes = {
    articleId,
    title: String(a.title).slice(0, 200),
    url: String(a.link).slice(0, 300),
    section: String(a.category || 'sin-seccion').slice(0, 60),
    date,
    dateEpoch: Math.floor(Date.parse(`${date}T00:00:00-03:00`) / 1000),
    contentHash,
  };
  const author = String(a.source ?? '').trim().slice(0, 80);
  if (author) attributes.author = author;
  const keywords = (Array.isArray(a.keywords) ? a.keywords : []).join(', ').trim().slice(0, 200);
  if (keywords) attributes.keywords = keywords;
  const deck = String(a.deck ?? '').trim().slice(0, 200);
  if (deck) attributes.deck = deck;
  const metadata = { metadataAttributes: attributes };
  mkdirSync(path.dirname(key), { recursive: true });
  writeFileSync(key, md, 'utf8');
  writeFileSync(`${key}.metadata.json`, JSON.stringify(metadata), 'utf8');
  written += 1;
}
console.log(`${written} notas escritas en ${outDir}`);
console.log('Siguiente paso: aws s3 sync', outDir, 's3://<bucket-corpus>/ --profile dailybrief  y luego  aws bedrock-agent start-ingestion-job …');
