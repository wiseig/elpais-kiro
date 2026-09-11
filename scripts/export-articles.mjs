#!/usr/bin/env node
// Exporta las notas de El País guardadas en Daily Brief (prod) a un corpus local
// listo para subir a S3 / Bedrock Knowledge Base. Sin dependencias: Node 18+.
//
// Uso:
//   DB_EMAIL=vos@elpais.com.uy DB_PASSWORD='***' node export-articles.mjs --days 7
//   node export-articles.mjs --feed            # solo el feed en vivo de hoy (sin login)
//   node export-articles.mjs --days 14 --out ./corpus
//
// Fuentes:
//   A) API Daily Brief prod: GET /v1/articles?date=YYYY-MM-DD  (lista liviana)
//                            GET /v1/articles/{articleId}       (cuerpo completo)
//      Requiere usuario Cognito del grupo `admin` (el mismo del backoffice
//      app.dailybriefsolution.com). Cognito pool/client se leen de
//      https://app.dailybriefsolution.com/config.json
//   B) Feed en vivo: https://herramientas.elpais.com.uy/feed-articles.php (solo notas de HOY)
//
// Salida (en --out, default ./corpus):
//   md/<fecha>_<articleId>.md   una nota por archivo (ideal para Knowledge Base)
//   corpus.jsonl                una nota por linea (ideal para RAG casero)
//   manifest.json               conteo por fecha

import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const API_URL = (process.env.DB_API_URL ?? "https://api.dailybriefsolution.com").replace(/\/$/, "");
const BACKOFFICE_URL = (process.env.DB_BACKOFFICE_URL ?? "https://app.dailybriefsolution.com").replace(/\/$/, "");
const FEED_URL =
  process.env.DB_FEED_URL ??
  "https://herramientas.elpais.com.uy/feed-articles.php?token=b9K2xT7mQp1Zr8Lw0vC6nH3yU5sEa4dGfJ9tXk2P";
const COGNITO_REGION = process.env.DB_COGNITO_REGION ?? "us-east-1";
const OUT_DIR = path.resolve(args.out ?? "./corpus");
const DAYS = Number(args.days ?? 7);
const CONCURRENCY = 5;

main().catch((err) => {
  console.error("\nERROR:", err.message ?? err);
  process.exit(1);
});

async function main() {
  await mkdir(path.join(OUT_DIR, "md"), { recursive: true });
  const all = [];

  if (args.feed) {
    const items = await fetchFeedToday();
    console.log(`feed en vivo: ${items.length} notas de hoy`);
    all.push(...items);
  } else {
    const token = await login();
    const dates = lastDates(DAYS, args.date);
    console.log(`exportando ${dates.length} dias desde ${API_URL} ...`);
    for (const date of dates) {
      const items = await fetchArticlesForDate(token, date);
      console.log(`  ${date}: ${items.length} notas`);
      all.push(...items);
    }
  }

  const manifest = {};
  await runPool(all, CONCURRENCY, async (a) => {
    const file = path.join(OUT_DIR, "md", `${a.date}_${a.articleId}.md`);
    if (await exists(file)) {
      manifest[a.date] = (manifest[a.date] ?? 0) + 1;
      return;
    }
    await writeFile(file, toMarkdown(a), "utf8");
    manifest[a.date] = (manifest[a.date] ?? 0) + 1;
  });

  const jsonl = all.map((a) => JSON.stringify(a)).join("\n") + "\n";
  await writeFile(path.join(OUT_DIR, "corpus.jsonl"), jsonl, "utf8");
  await writeFile(path.join(OUT_DIR, "manifest.json"), JSON.stringify({ total: all.length, byDate: manifest }, null, 2));
  console.log(`\nlisto: ${all.length} notas en ${OUT_DIR}`);
  console.log(`  md/         -> subir a S3 como data source de la Knowledge Base`);
  console.log(`  corpus.jsonl -> para RAG en memoria (plan B)`);
}

// ---------- Fuente A: API Daily Brief ----------

async function login() {
  const email = process.env.DB_EMAIL ?? (await ask("Email backoffice: "));
  const password = process.env.DB_PASSWORD ?? (await ask("Password: ", true));

  let clientId = process.env.DB_COGNITO_CLIENT_ID;
  if (!clientId) {
    const cfg = await getJSON(`${BACKOFFICE_URL}/config.json`);
    clientId = cfg.userPoolClientId;
    if (!clientId) throw new Error("no se pudo leer userPoolClientId de config.json; seteá DB_COGNITO_CLIENT_ID");
  }

  const res = await fetch(`https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth"
    },
    body: JSON.stringify({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: email, PASSWORD: password }
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Cognito ${res.status}: ${data.message ?? data.__type}`);
  if (data.ChallengeName) {
    throw new Error(`Cognito pide challenge ${data.ChallengeName}; resolvelo una vez desde el backoffice y volvé a correr`);
  }
  const { AccessToken, IdToken } = data.AuthenticationResult;

  // La API acepta Bearer; probamos access token y caemos a id token si hace falta.
  for (const tok of [AccessToken, IdToken]) {
    const probe = await fetch(`${API_URL}/v1/articles?date=${todayISO()}`, {
      headers: { Authorization: `Bearer ${tok}` }
    });
    if (probe.ok) return tok;
    if (probe.status !== 401 && probe.status !== 403) {
      throw new Error(`API ${probe.status} al probar el token: ${await probe.text()}`);
    }
  }
  throw new Error("la API rechazó el token (401/403): el usuario debe estar en el grupo admin");
}

async function fetchArticlesForDate(token, date) {
  const list = await getJSON(`${API_URL}/v1/articles?date=${date}`, token);
  const items = list.items ?? [];
  const out = [];
  await runPool(items, CONCURRENCY, async (it) => {
    const full = await getJSON(`${API_URL}/v1/articles/${encodeURIComponent(it.articleId)}`, token);
    out.push(normalize(full, "dailybrief-api", date));
  });
  return out;
}

// ---------- Fuente B: feed en vivo ----------

async function fetchFeedToday() {
  const res = await fetch(FEED_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`feed ${res.status}`);
  const feed = await res.json();
  return (feed.items ?? []).map((it) =>
    normalize(
      {
        articleId: `feed-${it.notId}`,
        title: it.titulo,
        deck: it.bajada,
        bodyText: it.cuerpo_texto || stripHTML(it.cuerpo ?? ""),
        link: it.link,
        category: it.categorySlug,
        keywords: it.keywords ?? [],
        feedDate: it.fecha,
        source: it.autor
      },
      "feed",
      feed.date ?? todayISO()
    )
  );
}

// ---------- Formato ----------

function normalize(a, origin, fallbackDate) {
  const date = (a.feedDate ?? "").slice(0, 10) || fallbackDate;
  return {
    articleId: a.articleId,
    date,
    feedDate: a.feedDate ?? "",
    title: (a.title ?? "").trim(),
    deck: (a.deck ?? "").trim(),
    bodyText: (a.bodyText ?? "").trim(),
    link: a.link ?? "",
    category: a.category ?? "",
    keywords: a.keywords ?? [],
    source: a.source ?? "El País",
    origin
  };
}

function toMarkdown(a) {
  // Metadata arriba en texto plano: la Knowledge Base la indexa junto al cuerpo
  // y el modelo puede citar fecha, sección y URL.
  return [
    `# ${a.title}`,
    "",
    `- Medio: El País (Uruguay)`,
    `- Fecha: ${a.date}${a.feedDate ? ` (${a.feedDate})` : ""}`,
    `- Sección: ${a.category || "sin sección"}`,
    `- URL: ${a.link}`,
    a.keywords.length ? `- Palabras clave: ${a.keywords.join(", ")}` : null,
    "",
    a.deck ? `> ${a.deck}\n` : null,
    a.bodyText,
    ""
  ]
    .filter((l) => l !== null)
    .join("\n");
}

// ---------- Utilidades ----------

async function getJSON(url, token) {
  const res = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}

function lastDates(n, startISO) {
  const end = startISO ? new Date(`${startISO}T12:00:00-03:00`) : new Date();
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(end);
    d.setDate(end.getDate() - i);
    out.push(montevideoISO(d));
  }
  return out;
}

function todayISO() {
  return montevideoISO(new Date());
}

function montevideoISO(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Montevideo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

async function runPool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try {
        await fn(item);
      } catch (err) {
        console.error(`  ! ${item.articleId ?? "?"}: ${err.message}`);
      }
    }
  });
  await Promise.all(workers);
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function stripHTML(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden && process.stdin.isTTY) {
      const orig = rl._writeToOutput;
      rl._writeToOutput = (s) => {
        if (s.includes(question)) orig.call(rl, question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}
