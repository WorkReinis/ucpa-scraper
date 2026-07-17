// node src/scrape.mjs            -> scrape the configured listing URLs
// node src/scrape.mjs --dry      -> parse and print, write nothing
//
// Snapshots the catalogue into ucpa.db. Safe to run daily via cron, or via
// the local API (src/server.mjs's POST /api/scrape calls runScrape() below
// directly) -- both paths share this
// exact logic, nothing is duplicated between CLI and server.
//
// Each run appends rows rather than overwriting: product upserts (keyed on
// code) and week/observation inserts (keyed with observed_at in the
// primary key) both use existing DB conflict handling, so running this
// twice, or fifty times, never produces duplicate listings -- the read-side
// views (v_week_current, v_week_listing) already collapse to the
// latest snapshot per (code, start_date). The history that piles up
// underneath is exactly what v_delta/v_week_delta need to detect a
// genuine price or seat-count change between two runs.

import { fileURLToPath } from "node:url";
import fs from "node:fs";
import * as cheerio from "cheerio";
import { parseCard } from "./parse.mjs";
import {
  open, startRun, upsert, finishRun, upsertWeek, setProductDetails, insertSourceSnapshot,
} from "./db.mjs";
import { fetchWeeks } from "./weeks.mjs";
import { parseDetails } from "./details.mjs";
import { findUnknownCategories } from "./categories.mjs";
import { assertDetailFailureRate, detailIssues, productIssues, sourceIssues } from "./validation.mjs";
import { writeDiagnostic } from "./diagnostics.mjs";

// --- config ----------------------------------------------------------------
// Path shape is /activites/{duree}/{activite}. "semaine" = 7d packages.
// Add rows here to widen the catalogue; the DB dedupes on product code, so
// overlapping lists are harmless.
const SOURCES = [
  "https://www.ucpa.com/activites/semaine/sejour-snowboard",
  "https://www.ucpa.com/activites/semaine/sejour-snowboard-hors-piste",
  "https://www.ucpa.com/activites/semaine/sejour-splitboard",
  "https://www.ucpa.com/activites/semaine/sejour-ski-alpin",
  "https://www.ucpa.com/activites/semaine/sejour-ski-hors-piste",
  "https://www.ucpa.com/activites/semaine/sejour-ski-de-randonnee",
];

const PAGE_PARAM = "page"; // <- CONFIRM WITH probe.mjs. See README.
const MAX_PAGES = 20;
const DELAY_MS = 1500; // be a good citizen; 97 products is not a load test

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function canonicalImageUrl(url) {
  return url?.replace("/image/upload/f_auto/t_UCPA/", "/image/upload/") ?? null;
}

function cardImageUrl(url, width, height) {
  const original = canonicalImageUrl(url);
  if (!original?.includes("/image/upload/")) return original;
  return original.replace(
    "/image/upload/",
    `/image/upload/f_auto,q_auto:good,c_fill,g_auto,w_${width},h_${height}/`
  );
}

// Cloudinary takes a few seconds to generate a never-before-seen crop. Warm
// only newly discovered source images after a scrape, with bounded concurrency,
// so that generation happens here instead of while the user scrolls the app.
export async function warmImageVariants(imageUrls) {
  const jobs = [...new Set(imageUrls.flatMap((url) => [
    cardImageUrl(url, 250, 376),
    cardImageUrl(url, 1200, 256),
  ]).filter(Boolean))];
  let next = 0;
  let warmed = 0;

  async function worker() {
    while (next < jobs.length) {
      const url = jobs[next++];
      try {
        const response = await fetch(url, { headers: { accept: "image/avif,image/webp,image/*,*/*" } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await response.arrayBuffer();
        warmed++;
      } catch (error) {
        console.warn(`  ! image warm failed: ${error.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker));
  return { warmed, total: jobs.length };
}

function structuredTitles($) {
  const titles = new Map();

  function visit(value) {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;

    const types = [].concat(value["@type"] ?? []);
    const productUrl = value.url ?? value.offers?.url;
    const code = typeof productUrl === "string" && productUrl.match(/\/sejour\/([a-z0-9]+)-/i)?.[1]?.toLowerCase();
    if (types.includes("Product") && code && typeof value.name === "string") {
      titles.set(code, value.name.trim());
    }
    Object.values(value).forEach(visit);
  }

  for (const script of $('script[type="application/ld+json"]').toArray()) {
    try {
      visit(JSON.parse($(script).html() || ""));
    } catch {
      // A malformed unrelated JSON-LD block must not discard the cards.
    }
  }
  return titles;
}

async function getCards(url) {
  const html = await fetch(url, {
    headers: { "user-agent": UA, "accept-language": "fr-FR,fr;q=0.9,en;q=0.8" },
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
    return r.text();
  });

  const $ = cheerio.load(html);
  const titles = structuredTitles($);
  const out = [];
  const seen = new Set();
  const invalid = [];
  for (const el of $('a[href*="/sejour/"]').toArray()) {
    const href = $(el).attr("href");
    const text = $(el).text();
    // Card links carry the whole card body; nav and "vous aimerez aussi"
    // links are short. 80 chars separates them cleanly.
    if (text.length < 80 || seen.has(href)) continue;
    seen.add(href);
    const code = href.match(/\/sejour\/([a-z0-9]+)-/i)?.[1]?.toLowerCase();
    const canonicalTitle = code ? titles.get(code) : null;
    const row = parseCard(href, text, canonicalTitle);
    const issues = row ? productIssues(row) : ["card parser returned no product"];
    if (row && !canonicalTitle) issues.push("missing canonical JSON-LD title");
    if (issues.length === 0) {
      out.push(row);
    } else {
      invalid.push({ href, issues, parsed: row });
      console.warn(`  ! invalid product card: ${href} (${issues.join("; ")})`);
    }
  }
  if (invalid.length > 0) {
    const tag = new URL(url).pathname.split("/").at(-1) + `-p${new URL(url).searchParams.get(PAGE_PARAM) ?? 1}`;
    writeDiagnostic(`${tag}-invalid-cards`, html, "html");
    writeDiagnostic(`${tag}-invalid-cards`, invalid, "json");
  }
  return {
    rows: out,
    candidateHrefs: [...seen],
    invalidHrefs: invalid.map((item) => item.href),
  };
}

/** Walk pages until the codes stop changing (works whether or not ?page= is real). */
async function crawl(base) {
  const all = new Map();
  const candidateHrefs = new Set();
  const invalidHrefs = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1 ? base : `${base}?${PAGE_PARAM}=${page}`;
    const pageResult = await getCards(url);
    const rows = pageResult.rows;
    pageResult.candidateHrefs.forEach((href) => candidateHrefs.add(href));
    pageResult.invalidHrefs.forEach((href) => invalidHrefs.add(href));
    const fresh = rows.filter((r) => !all.has(r.code));

    console.log(`  p${page}: ${rows.length} cards, ${fresh.length} new`);
    for (const r of rows) all.set(r.code, r);

    // If page 2 gives us nothing new, ?page= is being ignored -> stop and say so.
    if (page > 1 && fresh.length === 0) {
      if (page === 2) {
        console.warn(
          `  ! "${PAGE_PARAM}" appears inert -- page 2 returned the same products.\n` +
          `    Pagination is probably an XHR. Run probe.mjs and read the README.`
        );
      }
      break;
    }
    if (rows.length === 0) break;
    await sleep(DELAY_MS);
  }
  return {
    rows: [...all.values()],
    candidateCount: candidateHrefs.size,
    unparseableCount: invalidHrefs.size,
  };
}

/**
 * Run one full scrape: listings -> products, then per-product week
 * calendars + package details. Pass an already-open `db` to reuse a
 * connection (the server does this); otherwise one is opened here.
 * `dry: true` parses and returns rows without touching the DB or fetching
 * per-product weeks.
 */
export async function runScrape({ dry = false, db, strict = false } = {}) {
  const _db = db ?? open();
  const collected = new Map();
  const sourceFailures = [];
  const sourceSnapshots = [];
  const previousSourceCount = _db.prepare(
    `SELECT product_count FROM source_snapshot
     WHERE source_url = ? ORDER BY run_id DESC LIMIT 1`
  );
  for (const src of SOURCES) {
    console.log(`\n${src}`);
    try {
      const result = await crawl(src);
      const snapshot = {
        source: src,
        count: result.rows.length,
        candidateCount: result.candidateCount,
        unparseableCount: result.unparseableCount,
      };
      sourceSnapshots.push(snapshot);
      const issues = sourceIssues({
        ...snapshot,
        previousCount: previousSourceCount.get(src)?.product_count ?? null,
      });
      if (issues.length > 0) sourceFailures.push({ source: src, error: issues.join("; ") });
      for (const r of result.rows) collected.set(r.code, r);
    } catch (e) {
      console.error("  ! failed:", e.message);
      sourceFailures.push({ source: src, error: e.message });
    }
  }

  const rows = [...collected.values()];
  console.log(`\n${rows.length} distinct products.`);

  const previousTotal = _db.prepare(
    "SELECT n_products FROM run WHERE n_products IS NOT NULL ORDER BY id DESC LIMIT 1"
  ).get()?.n_products;
  const totalIssues = sourceIssues({
    count: rows.length, previousCount: previousTotal, unparseableCount: 0,
  });
  if (totalIssues.length > 0) {
    sourceFailures.push({ source: "combined catalogue", error: totalIssues.join("; ") });
  }

  if (strict && sourceFailures.length > 0) {
    const error = new Error(
      `strict scrape rejected ${sourceFailures.length} source failure(s): ` +
      sourceFailures.map((failure) => failure.source).join(", ")
    );
    error.summary = { products: rows.length, sourceFailures, sourceSnapshots, detailFailures: [] };
    throw error;
  }

  if (dry) {
    return { dry: true, products: rows.length, rows, sourceFailures, sourceSnapshots };
  }

  const knownImageUrls = new Set(
    _db.prepare("SELECT image_url FROM product WHERE image_url IS NOT NULL").all()
      .map((row) => canonicalImageUrl(row.image_url))
  );
  // Per-product week calendar + package details: two extra requests each
  // (product page, then its reserve-state JSON), same DELAY_MS between
  // products as the listing crawl above -- this doubles request count but
  // stays sequential and slow, not a load test. Package composition
  // (inclus/hébergement/encadrement) comes free off the same product-page
  // fetch the week calendar already needs -- see src/details.mjs.
  console.log(`\nfetching week calendars for ${rows.length} products...`);
  const weeks = [];
  const details = new Map();
  const detailFailures = [];
  for (const r of rows) {
    try {
      const { html, weeks: weekRows } = await fetchWeeks(r.code, r.url, UA);
      console.log(`  ${r.code}: ${weekRows.length} weeks`);
      weeks.push(...weekRows);
      const parsedDetails = parseDetails(html);
      const issues = detailIssues(parsedDetails);
      if (issues.length > 0) {
        writeDiagnostic(`${r.code}-incomplete-details`, html, "html");
        detailFailures.push({ code: r.code, error: issues.join("; ") });
      } else {
        details.set(r.code, parsedDetails);
      }
    } catch (e) {
      console.error(`  ! ${r.code} weeks failed:`, e.message);
      detailFailures.push({ code: r.code, error: e.message });
    }
    await sleep(DELAY_MS);
  }

  let detailFailureRate;
  try {
    detailFailureRate = strict
      ? assertDetailFailureRate(detailFailures.length, rows.length)
      : (rows.length === 0 ? 1 : detailFailures.length / rows.length);
  } catch (error) {
    error.summary = { products: rows.length, sourceFailures, sourceSnapshots, detailFailures };
    throw error;
  }

  const newImageUrls = [...new Set(
    [...details.values()]
      .map((detail) => canonicalImageUrl(detail.image_url))
      .filter((url) => url && !knownImageUrls.has(url))
  )];
  if (newImageUrls.length > 0) {
    console.log(`warming card images for ${newImageUrls.length} new product image(s)...`);
    const warmed = await warmImageVariants(newImageUrls);
    console.log(`  ${warmed.warmed}/${warmed.total} image variants ready`);
  }

  let runId;
  _db.exec("BEGIN");
  try {
    runId = startRun(_db, SOURCES.join(" | "));
    for (const r of rows) upsert(_db, runId, r);
    for (const w of weeks) upsertWeek(_db, w);
    for (const [code, d] of details) setProductDetails(_db, code, d);
    for (const snapshot of sourceSnapshots) insertSourceSnapshot(_db, runId, snapshot);
    finishRun(_db, runId, rows.length);
    _db.exec("COMMIT");
  } catch (error) {
    _db.exec("ROLLBACK");
    throw error;
  }
  console.log(`run #${runId}: ${rows.length} products, ${weeks.length} weeks, ${details.size} detail sets written.`);

  const unknownCategories = findUnknownCategories(_db);

  return {
    dry: false, runId, products: rows.length, weeks: weeks.length,
    details: details.size, detailFailureRate, unknownCategories, sourceFailures, sourceSnapshots, detailFailures,
  };
}

// CLI entry point -- only runs when this file is executed directly
// (`node src/scrape.mjs`), not when imported by src/server.mjs.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dry = process.argv.includes("--dry");
  const strict = process.argv.includes("--strict");
  try {
    const result = await runScrape({ dry, strict });
    const summary = { ...result };
    delete summary.rows;
    fs.writeFileSync(".scrape-summary.json", `${JSON.stringify(summary, null, 2)}\n`);
    if (result.dry) {
      console.table(
        result.rows.map((r) => ({
          code: r.code, resort: r.resort, activity: r.activity,
          level: r.level, price: r.price, off: r.discount_pct, from: r.first_week_dm,
        }))
      );
    }
  } catch (error) {
    fs.writeFileSync(
      ".scrape-summary.json",
      `${JSON.stringify({ error: error.message, ...error.summary }, null, 2)}\n`
    );
    throw error;
  }
}
