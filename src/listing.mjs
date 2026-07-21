// The catalogue listing, read from UCPA's own product API instead of the
// listing HTML.
//
// Why this exists: /activites/{duree}/{activite} server-renders only the
// first 9 cards. The rest arrive when "voir plus de séjours" is clicked, and
// `?page=2` is inert (it returns page 1 again), so an HTML scrape of the
// listing silently capped the catalogue at 9 products per activity. That was
// harmless while the only sources were snowboard/hors-piste/splitboard --
// each genuinely fits on one page -- and quietly wrong the moment
// sejour-ski-alpin (128 products) was added.
//
// The button calls this, plainly and without auth or cookies:
//
//   /api/products?filters={"context":"1-1-1","duration":["semaine"],
//                          "activity_label":["ski-alpin"]}&start=9&workspace=speedboat
//
// Same family as the per-product reserve endpoint src/weeks.mjs already uses.
// It returns structured fields (resort, activity, level, price, dates) rather
// than card text, so the fragile text anchoring in src/parse.mjs isn't needed
// on this path -- parseCard stays for src/probe.mjs and for reading a listing
// page by hand.

import { productIssues, wholePrice } from "./validation.mjs";

const API_BASE = "https://www.ucpa.com/api/products";

// Both observed verbatim in the request the listing page makes. `context`
// is UCPA's agency/booking context (the same "1-1-1" src/weeks.mjs passes),
// `workspace` selects the public vacances catalogue.
const CONTEXT = "1-1-1";
const WORKSPACE = "speedboat";

// The server ignores any page-size parameter and always returns 9, so the
// only lever is `start`. Kept as a constant for readability; the loop below
// advances by however many items actually came back, never by this number.
export const LISTING_PAGE_SIZE = 9;

// This catalogue is for adult stays. UCPA also sells "Séjour Ski Famille"
// weeks (age 3-77) on the same activity listings: a family books a room
// together rather than a bed in a level group, so their headline price is
// not comparable per-person with everything else here and would quietly
// distort price sorting. Dropped on the way in rather than filtered in the
// UI, so nothing downstream has to know they exist.
export const MIN_ADULT_AGE = 18;

/** True for the family stays described above -- out of scope, not malformed. */
export function isOutOfScope(row) {
  return row.age_min != null && row.age_min < MIN_ADULT_AGE;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "https://www.ucpa.com/activites/semaine/sejour-ski-alpin"
 *   -> { duration: "semaine", activity: "ski-alpin" } */
export function activityFilterFromUrl(sourceUrl) {
  const parts = new URL(sourceUrl).pathname.split("/").filter(Boolean);
  const duration = parts[1];
  const activity = (parts[2] ?? "").replace(/^sejour-/, "");
  if (!duration || !activity) {
    throw new Error(`cannot derive a listing filter from ${sourceUrl}`);
  }
  return { duration, activity };
}

export function listingApiUrl({ duration, activity, start = 0 }) {
  const filters = JSON.stringify({
    context: CONTEXT,
    duration: [duration],
    activity_label: [activity],
  });
  return `${API_BASE}?filters=${encodeURIComponent(filters)}&start=${start}&workspace=${WORKSPACE}`;
}

// Most product URLs read /sejour/{code}-{slug}, but a few use a slash instead
// of the hyphen (/sejour/44103/revival-monoski-vacances). Accept either, or
// those products are dropped for "no /sejour/ URL" despite being ordinary
// bookable packages.
const productCode = (url) => url.match(/\/sejour\/([a-z0-9]+)[-/]/i)?.[1]?.toLowerCase() ?? null;

/** One /api/products item -> the same row shape parseCard() produces, so
 *  db.upsert() and validation.productIssues() are unchanged by this path. */
export function parseApiItem(item) {
  const code = productCode(item?.url ?? "");
  if (!code) return null;

  // "France - Val d'Isère", "France - Argentière - Vallée du Mont Blanc", or
  // bare "Queyras". Only the country prefix is stripped: resort names carry
  // their own spaced hyphens, so splitting on " - " would truncate them.
  const destination = (item.center_or_destination_name ?? "").trim();
  const resort = destination.replace(/^France\s*-\s*/, "").trim() || null;

  const title = (item.product_name ?? "").trim();
  // Same retag parseCard() applies: UCPA's breadcrumb calls the dual-discipline
  // "Ski ou snowboard" packages "Ski alpin", which would hide them from a
  // snowboard filter even though the gear line offers either.
  const activity = /^Ski ou snowboard\b/i.test(title)
    ? "Ski ou snowboard"
    : (item.activity_name ?? null);

  return {
    code,
    site_code: code.length >= 6 ? code.slice(3, 6) : null, // sfa|VIS|n03 -> Val d'Isère
    url: item.url.startsWith("http") ? item.url : `https://www.ucpa.com${item.url}`,
    title,
    age_min: item.product_age_min ?? null,
    age_max: item.product_age_max ?? null,
    location: destination || null,
    country: "France",
    resort,
    region: (item.geographical_landscape ?? "").trim() || null,
    activity,
    level: (item.expertise_level ?? "").trim() || null,
    // The API prices in euros with cents (859.5); product/observation rows
    // and productIssues() both want whole euros.
    list_price: wholePrice(item.prediscountPrice ?? item.price),
    price: wholePrice(item.price),
    discount_pct: item.discount_percentage ?? 0,
    first_week_dm: item.start_date ?? null,
    days: item.product_days_duration_including_transportation ?? null,
    nights: item.product_nights_duration ?? null,
    transport_included: Boolean(item.transport_included),
  };
}

/**
 * Every product for one listing source, following `start` to the end.
 *
 * `count` is only present on the first page's response -- reading it off a
 * later page yields undefined, which is what made an earlier version of this
 * loop stop at 18 products. It's captured once and then only used to stop
 * early; an empty page ends the walk regardless, so a missing count degrades
 * to "walk until exhausted" rather than to a silent truncation.
 */
export async function fetchActivityProducts(sourceUrl, {
  ua, fetchImpl = fetch, delayMs = 400, maxPages = 80,
} = {}) {
  const { duration, activity } = activityFilterFromUrl(sourceUrl);
  const rows = [];
  const invalid = [];
  const excluded = [];
  const seen = new Set();
  let start = 0;
  let total = null;
  let pages = 0;

  while (pages++ < maxPages) {
    const url = listingApiUrl({ duration, activity, start });
    const response = await fetchImpl(url, {
      headers: { "user-agent": ua, accept: "application/json", "accept-language": "fr-FR,fr;q=0.9,en;q=0.8" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} on ${url}`);

    const search = (await response.json())?.productsGlobalSearch;
    if (!search || !Array.isArray(search.items)) {
      throw new Error(`unexpected /api/products response shape for ${activity}`);
    }
    if (total == null && Number.isInteger(search.count)) total = search.count;
    if (search.items.length === 0) break;

    for (const item of search.items) {
      const row = parseApiItem(item);
      if (row && seen.has(row.code)) continue;
      // Deliberately excluded, so it must not land in `invalid` -- that feeds
      // sourceIssues(), which treats any unparseable card as a source failure.
      if (row && isOutOfScope(row)) {
        seen.add(row.code);
        excluded.push(row);
        continue;
      }
      const issues = row ? productIssues(row) : ["API item carried no /sejour/ URL"];
      if (issues.length === 0) {
        seen.add(row.code);
        rows.push(row);
      } else {
        invalid.push({ url: item?.url ?? null, issues, parsed: row });
      }
    }

    start += search.items.length;
    if (total != null && start >= total) break;
    await sleep(delayMs);
  }

  return {
    rows,
    // What the source itself claims it has, so a shortfall shows up in the
    // run's source_snapshot instead of looking like a clean, smaller catalogue.
    candidateCount: total ?? rows.length + invalid.length + excluded.length,
    unparseableCount: invalid.length,
    invalid,
    excluded,
  };
}
