import { translate, translateList } from "./translate.mjs";
import { tierOf, tierRank } from "./levels.mjs";
import { groupsOf, groupsPresent, HIDDEN_ACTIVITIES } from "./activities.mjs";
import { findUnknownCategories } from "./categories.mjs";
import { FLIGHT_REFRESH_DAYS, MONTHLY_SEARCH_LIMIT, ARRIVAL_MODES } from "./flights.mjs";
import { gatewayCaseSql, ORIGIN_GROUPS } from "./airports.mjs";

// One LEFT JOIN per (origin group x arrival mode) cell; every row carries
// all six quotes nested under flight_quotes, and picking one is a pure
// client-side concern -- the same code path serves the live API and the
// static GitHub Pages export, so toggling origin or early-arrival in the
// UI never needs a re-fetch.
const FLIGHT_QUOTE_FIELDS = [
  "price", "price_outbound", "price_return", "pricing_mode",
  "dep_airport", "arr_airport", "gateway", "airline", "stops",
  "duration_min", "fetched_at", "outbound_segments",
  "return_dep_airport", "return_arr_airport", "return_airline",
  "return_stops", "return_duration_min", "return_segments",
  "details_scope", "outbound_date", "return_date",
  // Not used for display -- carried through so validate-airports.mjs can
  // tell a quote fetched under the currently-active airport policy from an
  // older-generation fallback still on display only because quota hasn't
  // allowed a fresh requote yet (see validateResortAirportAssignments).
  "config_key",
];
const FLIGHT_JOINS = ORIGIN_GROUPS.flatMap((og) => ARRIVAL_MODES.map((mode) => ({
  alias: `fp_${og.id}_${mode.id}`,
  originGroup: og.id,
  mode: mode.id,
  dateExpr: mode.offsetDays === 0
    ? "wl.start_date"
    : `date(wl.start_date, '${mode.offsetDays} day')`,
})));
// Every `${alias}_${field}` column translateListing strips out of the raw
// row -- precomputed once so stripping them is a single forward copy
// instead of a delete per key. `delete` forces the row object into
// dictionary mode in V8, and with 120 flight-quote columns per row that
// alone was costing ~400ms across a few thousand rows.
const FLIGHT_COLUMN_KEYS = new Set(
  FLIGHT_JOINS.flatMap(({ alias }) => FLIGHT_QUOTE_FIELDS.map((field) => `${alias}_${field}`))
);

function pickFlightQuote(row, alias) {
  // No fetched_at means the LEFT JOIN found nothing -- the cell was never
  // quoted. A quote with null price is different: searched, but nothing
  // inside the shuttle-viability windows. The UI words those separately.
  if (row[`${alias}_fetched_at`] == null) return null;
  const quote = {};
  for (const field of FLIGHT_QUOTE_FIELDS) quote[field] = row[`${alias}_${field}`];
  quote.outbound_segments = JSON.parse(quote.outbound_segments || "[]");
  quote.return_segments = JSON.parse(quote.return_segments || "[]");
  return quote;
}

function translateListing(row) {
  const flight_quotes = {};
  for (const { alias, originGroup, mode } of FLIGHT_JOINS) {
    (flight_quotes[originGroup] ??= {})[mode] = pickFlightQuote(row, alias);
  }
  const clean = {};
  for (const key in row) {
    if (!FLIGHT_COLUMN_KEYS.has(key)) clean[key] = row[key];
  }
  return {
    ...clean,
    flight_quotes,
    activity_groups: groupsOf(row.activity),
    tier: tierOf(row.level),
    title: translate(row.title),
    activity: translate(row.activity),
    level: translate(row.level),
    region: translate(row.region),
    status: row.status != null ? translate(row.status) : row.status,
    includes: translateList(JSON.parse(row.includes || "[]")),
    excludes: translateList(JSON.parse(row.excludes || "[]")),
    options: translateList(JSON.parse(row.options || "[]")),
    accommodation: translate(row.accommodation),
  };
}

const SORTS = {
  price_asc: "wl.price ASC",
  price_desc: "wl.price DESC",
  soonest: "wl.start_date ASC",
};

// Every read below goes through this, so a sidelined activity (see
// HIDDEN_ACTIVITIES) disappears from listings, facet counts, price range,
// month list and changelog together -- filtering only the listings would
// leave filter options that match nothing. Written against `code` rather than
// `activity` so it applies to the week views too, which don't carry the
// product's activity column.
const HIDDEN_ACTIVITY_PLACEHOLDERS = HIDDEN_ACTIVITIES.map(() => "?").join(",");
const notHiddenActivity = (alias) =>
  `${alias ? `${alias}.` : ""}code NOT IN (SELECT code FROM product WHERE activity IN (${HIDDEN_ACTIVITY_PLACEHOLDERS}))`;

export function getChangelogData(db, { limitDays = 7 } = {}) {
  const scrapeDays = db.prepare(
    `SELECT date(started_at) AS day, MAX(started_at) AS scraped_at,
            MAX(n_products) AS product_count
     FROM run
     GROUP BY date(started_at)
     ORDER BY day DESC
     LIMIT ?`
  ).all(limitDays);
  if (!scrapeDays.length) return [];

  const oldestDay = db.prepare("SELECT MIN(date(started_at)) AS day FROM run").get().day;
  const wantedDays = new Set(scrapeDays.map((row) => row.day));
  const snapshots = db.prepare(`
    WITH ranked AS (
      SELECT w.*,
             date(w.observed_at) AS scrape_day,
             ROW_NUMBER() OVER (
               PARTITION BY w.code, w.start_date, date(w.observed_at)
               ORDER BY w.observed_at DESC
             ) AS day_rank
      FROM week w
      WHERE ${notHiddenActivity("w")}
    ),
    daily AS (
      SELECT * FROM ranked WHERE day_rank = 1
    ),
    compared AS (
      SELECT d.*,
             LAG(d.price) OVER (
               PARTITION BY d.code, d.start_date ORDER BY d.scrape_day
             ) AS previous_price,
             LAG(d.seats_left) OVER (
               PARTITION BY d.code, d.start_date ORDER BY d.scrape_day
             ) AS previous_seats,
             ROW_NUMBER() OVER (
               PARTITION BY d.code, d.start_date ORDER BY d.scrape_day
             ) AS observation_day
      FROM daily d
    )
    SELECT c.*, p.title, p.resort
    FROM compared c
    JOIN product p ON p.code = c.code
    ORDER BY c.scrape_day DESC, p.title, c.start_date
  `).all(...HIDDEN_ACTIVITIES);

  const byDay = new Map(scrapeDays.map((row) => [row.day, {
    day: row.day,
    scrapedAt: row.scraped_at,
    productCount: row.product_count,
    summary: { newListings: 0, priceChanges: 0, availabilityChanges: 0, total: 0 },
    events: [],
  }]));

  for (const row of snapshots) {
    if (!wantedDays.has(row.scrape_day) || row.scrape_day === oldestDay) continue;
    const firstSeen = row.observation_day === 1;
    // Ignore small movements in the public changelog. Besides being noisy,
    // sub-€10 deltas include legacy fractional prices being normalized to
    // whole euros; a €1505.50 -> €1506 import must not render as €1506 ->
    // €1506. Seat changes on the same listing are still reported.
    const priceChanged = !firstSeen && row.price != null && row.previous_price != null &&
      Math.abs(row.price - row.previous_price) >= 10;
    const soldOut = !firstSeen && row.seats_left === 0 && row.previous_seats > 0;
    const restocked = !firstSeen && row.seats_left > 0 && row.previous_seats === 0;
    // Raw UCPA inventory moves constantly and overwhelms the useful changes.
    // Only availability state transitions belong in the changelog.
    const seatsChanged = soldOut || restocked;
    if (!firstSeen && !priceChanged && !seatsChanged) continue;

    const day = byDay.get(row.scrape_day);
    const kind = firstSeen
      ? "new"
      : soldOut
        ? "sold_out"
        : restocked
          ? "restocked"
          : priceChanged
            ? "price"
            : "availability";
    day.events.push({
      kind,
      code: row.code,
      title: translate(row.title),
      resort: row.resort,
      startDate: row.start_date,
      endDate: row.end_date,
      price: row.price == null ? null : Math.ceil(row.price),
      previousPrice: row.previous_price == null ? null : Math.ceil(row.previous_price),
      seats: row.seats_left,
      previousSeats: row.previous_seats,
      priceChanged,
      seatsChanged,
    });
    if (firstSeen) day.summary.newListings++;
    if (priceChanged) day.summary.priceChanges++;
    if (seatsChanged) day.summary.availabilityChanges++;
    day.summary.total++;
  }

  const priority = { new: 0, sold_out: 1, restocked: 2, price: 3, availability: 4 };
  for (const day of byDay.values()) {
    day.events.sort((a, b) =>
      (priority[a.kind] - priority[b.kind]) ||
      a.startDate.localeCompare(b.startDate) ||
      a.title.localeCompare(b.title)
    );
  }
  return [...byDay.values()];
}

export function getFiltersData(db, { flightsConfigured = false } = {}) {
  const notHiddenProduct = `activity NOT IN (${HIDDEN_ACTIVITY_PLACEHOLDERS})`;
  const resortsByRegion = {};
  for (const r of db.prepare(
    `SELECT DISTINCT resort, region FROM product
     WHERE resort IS NOT NULL AND ${notHiddenProduct} ORDER BY resort`
  ).all(...HIDDEN_ACTIVITIES)) {
    const region = translate(r.region);
    (resortsByRegion[region] ??= []).push(r.resort);
  }

  const distinct = (col) =>
    db.prepare(
      `SELECT DISTINCT ${col} v FROM product
       WHERE ${col} IS NOT NULL AND ${notHiddenProduct} ORDER BY ${col}`
    ).all(...HIDDEN_ACTIVITIES).map((r) => r.v);
  const facetRows = db.prepare(
    `SELECT resort, activity, level, instruction_type, age_min, age_max
     FROM v_week_listing WHERE seats_left > 0 AND ${notHiddenActivity("")}`
  ).all(...HIDDEN_ACTIVITIES);
  const tally = (mapper) => {
    const counts = {};
    for (const row of facetRows) {
      for (const key of mapper(row)) counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  };

  const attemptedThisMonth = (provider) => db.prepare(
    "SELECT COUNT(*) n FROM flight_search WHERE billing_month = strftime('%Y-%m', 'now') AND provider = ?"
  ).get(provider).n;
  const quotaFor = (provider, limit) => {
    const recordedUsed = attemptedThisMonth(provider);
    // No self-imposed ceiling (Apify): report null directly rather than a
    // raw Infinity that only *looks* like null once JSON-serialized -- the
    // two are different values in memory, and verify:static compares this
    // live object against the one read straight back from disk, not a
    // re-stringified one.
    if (limit == null) return { limit: null, used: recordedUsed, remaining: null };
    const externallyExhausted = provider === "serpapi" && Boolean(db.prepare(
      `SELECT 1 FROM flight_search
       WHERE billing_month = strftime('%Y-%m', 'now')
         AND provider = 'serpapi' AND status = 'failed'
         AND lower(COALESCE(error, '')) LIKE '%run out of searches%'
       LIMIT 1`
    ).get());
    const used = externallyExhausted ? limit : recordedUsed;
    return {
      limit,
      used,
      remaining: Math.max(limit - used, 0),
      ...(externallyExhausted ? { exhausted: true, recordedUsed } : {}),
    };
  };
  const priceRangeRow = db.prepare(
    `SELECT MIN(price) min, MAX(price) max FROM v_week_current
     WHERE seats_left > 0 AND ${notHiddenActivity("")}`
  ).get(...HIDDEN_ACTIVITIES);
  const ageGroups = [...new Set(facetRows
    .filter((row) => row.age_min != null && row.age_max != null)
    .map((row) => `${row.age_min}-${row.age_max}`))]
    .sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));

  return {
    resortsByRegion,
    activities: groupsPresent(distinct("activity")),
    tiers: [...new Set(distinct("level").map(tierOf))].sort((a, b) => tierRank(a) - tierRank(b)),
    instructionTypes: distinct("instruction_type"),
    resortCounts: tally((r) => [r.resort]),
    activityCounts: tally((r) => groupsOf(r.activity)),
    tierCounts: tally((r) => [tierOf(r.level)]),
    instructionTypeCounts: tally((r) => [r.instruction_type]),
    ageGroups,
    ageGroupCounts: tally((r) => r.age_min != null && r.age_max != null ? [`${r.age_min}-${r.age_max}`] : []),
    priceRange: { min: priceRangeRow.min, max: priceRangeRow.max },
    months: db
      .prepare(
        `SELECT DISTINCT substr(start_date,1,7) v FROM v_week_current
         WHERE seats_left > 0 AND ${notHiddenActivity("")} ORDER BY v`
      )
      .all(...HIDDEN_ACTIVITIES)
      .map((r) => r.v),
    lastScrapedAt: db.prepare("SELECT MAX(started_at) v FROM run").get().v,
    flightsConfigured,
    lastFlightsRefreshAt: db.prepare("SELECT MAX(fetched_at) v FROM flight_price").get().v,
    refreshSchedule: {
      time: "07:15",
      timeZone: "Europe/Riga",
      catalogueDays: 1,
      flightDays: FLIGHT_REFRESH_DAYS,
    },
    originGroups: ORIGIN_GROUPS.map(({ id, label, airports }) => ({ id, label, airports })),
    flightQuota: {
      // Apify has no self-imposed run-count ceiling -- its real constraint
      // is live account credit, not a count agreed in advance. Only
      // SerpApi's actual free-tier limit is a real number here.
      apify: quotaFor("apify", null),
      serpapi: quotaFor("serpapi", MONTHLY_SEARCH_LIMIT),
    },
    changelog: getChangelogData(db),
    unknownCategories: findUnknownCategories(db),
  };
}

export function getWeeksData(db, q = {}) {
  // UCPA keeps zero-stock offers in offersInfo. Preserve those explicit
  // sold-out rows as useful demand history; null stock is not an authoritative
  // sold-out signal and stays hidden.
  // Qualified with the alias: v_week_delta / v_week_new both carry `code` too.
  // Placed first so its bindings line up ahead of every filter appended below.
  const where = ["seats_left IS NOT NULL", notHiddenActivity("wl")];
  const params = [...HIDDEN_ACTIVITIES];

  const inFilter = (col, val) => {
    if (!val || (Array.isArray(val) && val.length === 0)) return;
    const list = [].concat(val);
    where.push(`${col} IN (${list.map(() => "?").join(",")})`);
    params.push(...list);
  };
  inFilter("resort", q.resort);

  const matchByGroup = (col, val, rawToGroups) => {
    if (!val || (Array.isArray(val) && val.length === 0)) return;
    const wanted = new Set([].concat(val));
    const all = db.prepare(`SELECT DISTINCT ${col} v FROM product WHERE ${col} IS NOT NULL`).all().map((r) => r.v);
    const matches = all.filter((v) => rawToGroups(v).some((g) => wanted.has(g)));
    if (!matches.length) matches.push("__none__");
    where.push(`${col} IN (${matches.map(() => "?").join(",")})`);
    params.push(...matches);
  };
  matchByGroup("activity", q.activity, groupsOf);
  matchByGroup("level", q.tier, (level) => [tierOf(level)]);
  inFilter("instruction_type", q.instructionType);

  if (q.ageGroup && (!Array.isArray(q.ageGroup) || q.ageGroup.length > 0)) {
    const groups = [].concat(q.ageGroup).map((group) => {
      const match = /^(\d+)-(\d+)$/.exec(group);
      return match ? [Number(match[1]), Number(match[2])] : null;
    }).filter(Boolean);
    if (!groups.length) groups.push([-1, -1]);
    where.push(`(${groups.map(() => "(wl.age_min = ? AND wl.age_max = ?)").join(" OR ")})`);
    params.push(...groups.flat());
  }

  if (q.minPrice) { where.push("wl.price >= ?"); params.push(Number(q.minPrice)); }
  if (q.maxPrice) { where.push("wl.price <= ?"); params.push(Number(q.maxPrice)); }
  if (q.month && (!Array.isArray(q.month) || q.month.length > 0)) {
    const months = [].concat(q.month);
    where.push(`(${months.map(() => "substr(wl.start_date,1,7) = ?").join(" OR ")})`);
    params.push(...months);
  }

  const orderBy = SORTS[q.sort] ?? SORTS.price_asc;
  // v_flight_current (src/db.mjs) picks the preferred quote per cell via a
  // correlated subquery. LEFT JOINing straight against it, once per (origin
  // group x arrival mode) cell, makes SQLite re-run that subquery for every
  // week row x every cell -- with a few hundred weeks and 6 cells that's
  // thousands of tiny per-row sorts, and was the actual source of the
  // multi-second /api/weeks response. Materializing the view into an indexed
  // temp table once per request (cheap: a few hundred flight_price rows)
  // turns each cell join into a flat index lookup instead. Recomputed on
  // every call rather than cached, matching this module's read-fresh
  // approach everywhere else.
  db.exec("DROP TABLE IF EXISTS temp.flight_current_now");
  db.exec("CREATE TEMP TABLE flight_current_now AS SELECT * FROM v_flight_current");
  db.exec(
    "CREATE INDEX flight_current_now_idx ON flight_current_now(outbound_date, return_date, gateway, origin_group)"
  );
  // alias/originGroup/mode are build-time constants from airports.mjs and
  // flights.mjs, never user input -- inlining them is the same deal as
  // gatewayCaseSql's inlined region names.
  const flightSelects = FLIGHT_JOINS.map(({ alias }) =>
    FLIGHT_QUOTE_FIELDS.map((field) => `${alias}.${field} AS ${alias}_${field}`).join(", ")
  ).join(",\n           ");
  const flightJoins = FLIGHT_JOINS.map(({ alias, originGroup, dateExpr }) => `
    LEFT JOIN flight_current_now ${alias}
      ON ${alias}.outbound_date = ${dateExpr} AND ${alias}.return_date = wl.end_date
      AND ${alias}.gateway = ${gatewayCaseSql("wl.region")}
      AND ${alias}.origin_group = '${originGroup}'`
  ).join("");
  const sql = `
    SELECT wl.*, wd.price_prev, wd.delta_eur, wd.seats_prev, wd.seats_delta,
           CASE WHEN wn.code IS NOT NULL THEN 1 ELSE 0 END AS is_new,
           ${flightSelects}
    FROM v_week_listing wl
    LEFT JOIN v_week_delta wd ON wd.code = wl.code AND wd.start_date = wl.start_date
    LEFT JOIN v_week_new wn ON wn.code = wl.code AND wn.start_date = wl.start_date${flightJoins}
    WHERE ${where.join(" AND ")}
    ORDER BY (wl.seats_left <= 0) ASC, ${orderBy}`;
  return db.prepare(sql).all(...params).map(translateListing);
}
