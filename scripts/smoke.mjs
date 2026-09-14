#!/usr/bin/env node
// Smoke test de la API pública: sesión → consentimiento neutral → las preguntas del set dorado.
// Uso: node scripts/smoke.mjs https://<api-id>.execute-api.us-east-1.amazonaws.com/dev [--personalize]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const base = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!base) {
  console.error('Uso: node scripts/smoke.mjs <apiBaseUrl> [--personalize]');
  process.exit(1);
}
const personalize = process.argv.includes('--personalize');
const here = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(path.join(here, '../packages/testing/src/golden-set.json'), 'utf8'));

async function call(method, route, body, token) {
  const started = Date.now();
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json, ms: Date.now() - started };
}

const { json: session } = await call('POST', '/v1/session');
const token = session.token;
const { json: text } = await call('GET', '/v1/consent/text', undefined, token);
const consent = await call('POST', '/v1/consent', { decision: personalize ? 'personalize' : 'neutral', textVersion: text.textVersion, ageConfirmed: personalize }, token);
console.log(`consentimiento: ${consent.status} modo=${consent.json.mode}`);

let passed = 0;
const latencies = [];
// El WAF limita /v1/ask a 10 pedidos por minuto por IP: se espacian las preguntas.
const PAUSE_MS = process.argv.includes('--fast') ? 0 : 6500;
for (const [index, item] of golden.cases.entries()) {
  if (index > 0 && PAUSE_MS) await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
  const { status, json, ms } = await call('POST', '/v1/ask', { question: item.question }, token);
  latencies.push(ms);
  const textBlock = json.blocks?.find((block) => block.type === 'text' || block.type === 'notice');
  const sources = json.blocks?.find((block) => block.type === 'sources')?.items ?? [];
  const coverageOk = status === 200 && Boolean(json.hadCoverage) === item.expectedCoverage;
  const sameUrl = (a, b) => a.replace(/^https?:\/\/(www\.)?/, '') === b.replace(/^https?:\/\/(www\.)?/, '');
  const matchesPattern = item.expectedUrlPattern && sources.some((source) => new RegExp(item.expectedUrlPattern).test(source.url));
  const urlOk = !item.expectedCoverage || matchesPattern || item.expectedUrls.some((url) => sources.some((source) => sameUrl(source.url, url)));
  const ok = coverageOk && urlOk;
  if (ok) passed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${item.id} (${ms} ms, ${status}) cobertura=${json.hadCoverage} fuentes=${sources.length}`);
  if (!ok) console.log(`     → ${(textBlock?.text ?? JSON.stringify(json)).slice(0, 200)}`);
}
latencies.sort((a, b) => a - b);
const p95 = latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] ?? 0;
console.log(`\n${passed}/${golden.cases.length} casos · p95 ${p95} ms (objetivo < 8000)`);
process.exit(passed === golden.cases.length ? 0 : 2);
