// node src/scrape.mjs            -> scrape the configured listing URLs
// node src/scrape.mjs --dry      -> parse and print, write nothing
//
// Snapshots the catalogue into ucpa.db. Safe to run daily via cron, or via
// the "Scrape now" button in the frontend (src/server.mjs's POST
// /api/scrape calls runScrape() below directly) -- both paths share this
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
import * as cheerio from "cheerio";
import { parseCard } from "./parse.mjs";
import { open, startRun, upsert, finishRun, upsertWeek, setProductDetails } from "./db.mjs";
import { fetchWeeks } from "./weeks.mjs";
import { parseDetails } from "./details.mjs";
import { findUnknownCategories } from "./categories.mjs";

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
  for (const el of $('a[href*="/sejour/"]').toArray()) {
    const href = $(el).attr("href");
    const text = $(el).text();
    // Card links carry the whole card body; nav and "vous aimerez aussi"
    // links are short. 80 chars separates them cleanly.
    if (text.length < 80 || seen.has(href)) continue;
    seen.add(href);
    const code = href.match(/\/sejour\/([a-z0-9]+)-/i)?.[1]?.toLowerCase();
    const row = parseCard(href, text, code ? titles.get(code) : null);
    if (row) out.push(row);
    else console.warn("  ! unparseable:", href);
  }
  return out;
}

/** Walk pages until the codes stop changing (works whether or not ?page= is real). */
async function crawl(base) {
  const all = new Map();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1 ? base : `${base}?${PAGE_PARAM}=${page}`;
    const rows = await getCards(url);
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
  return [...all.values()];
}

/**
 * Run one full scrape: listings -> products, then per-product week
 * calendars + package details. Pass an already-open `db` to reuse a
 * connection (the server does this); otherwise one is opened here.
 * `dry: true` parses and returns rows without touching the DB or fetching
 * per-product weeks.
 */
export async function runScrape({ dry = false, db } = {}) {
  const collected = new Map();
  for (const src of SOURCES) {
    console.log(`\n${src}`);
    try {
      for (const r of await crawl(src)) collected.set(r.code, r);
    } catch (e) {
      console.error("  ! failed:", e.message);
    }
  }

  const rows = [...collected.values()];
  console.log(`\n${rows.length} distinct products.`);

  if (dry) {
    return { dry: true, products: rows.length, rows };
  }

  const _db = db ?? open();
  const knownImageUrls = new Set(
    _db.prepare("SELECT image_url FROM product WHERE image_url IS NOT NULL").all()
      .map((row) => canonicalImageUrl(row.image_url))
  );
  const runId = startRun(_db, SOURCES.join(" | "));
  _db.exec("BEGIN");
  for (const r of rows) upsert(_db, runId, r);
  _db.exec("COMMIT");
  finishRun(_db, runId, rows.length);
  console.log(`run #${runId} written to ucpa.db`);

  // Catches UCPA adding a new activity/level/region before anything else in
  // this codebase would notice -- see src/categories.mjs for why that
  // otherwise fails silently instead of erroring.
  const unknownCategories = findUnknownCategories(_db);
  for (const [col, values] of Object.entries(unknownCategories)) {
    console.warn(
      `  ! ${values.length} unclassified ${col} value(s) -- add to src/${col === "level" ? "levels" : "categories"}.mjs: ${values.join(", ")}`
    );
  }

  // Per-product week calendar + package details: two extra requests each
  // (product page, then its reserve-state JSON), same DELAY_MS between
  // products as the listing crawl above -- this doubles request count but
  // stays sequential and slow, not a load test. Package composition
  // (inclus/hébergement/encadrement) comes free off the same product-page
  // fetch the week calendar already needs -- see src/details.mjs.
  console.log(`\nfetching week calendars for ${rows.length} products...`);
  const weeks = [];
  const details = new Map();
  for (const r of rows) {
    try {
      const { html, weeks: weekRows } = await fetchWeeks(r.code, r.url, UA);
      console.log(`  ${r.code}: ${weekRows.length} weeks`);
      weeks.push(...weekRows);
      details.set(r.code, parseDetails(html));
    } catch (e) {
      console.error(`  ! ${r.code} weeks failed:`, e.message);
    }
    await sleep(DELAY_MS);
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

  _db.exec("BEGIN");
  for (const w of weeks) upsertWeek(_db, w);
  for (const [code, d] of details) setProductDetails(_db, code, d);
  _db.exec("COMMIT");
  console.log(`${weeks.length} week rows, ${details.size} product detail sets written.`);

  return {
    dry: false, runId, products: rows.length, weeks: weeks.length,
    details: details.size, unknownCategories,
  };
}

// CLI entry point -- only runs when this file is executed directly
// (`node src/scrape.mjs`), not when imported by src/server.mjs.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dry = process.argv.includes("--dry");
  const result = await runScrape({ dry });
  if (result.dry) {
    console.table(
      result.rows.map((r) => ({
        code: r.code, resort: r.resort, activity: r.activity,
        level: r.level, price: r.price, off: r.discount_pct, from: r.first_week_dm,
      }))
    );
  }
}
