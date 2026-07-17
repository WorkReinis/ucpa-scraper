// The /api/* route logic, shared between the two ways this app gets served:
// src/server.mjs (production -- serves web/dist, needs `npm run build` first)
// and web/dev-server.mjs (day-to-day dev -- Vite in middleware mode, hot
// reload, no build step). Both just call createApiApp() and mount whatever
// serves the frontend after it.

import express from "express";
import { open } from "./db.mjs";
import { translate, translateList } from "./translate.mjs";
import { runScrape } from "./scrape.mjs";
import { runFlightRefresh } from "./flights.mjs";
import { tierOf, tierRank } from "./levels.mjs";
import { groupsOf, groupsPresent } from "./activities.mjs";
import { findUnknownCategories } from "./categories.mjs";

function translateListing(row) {
  return {
    ...row,
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

// Reads ucpa.db directly on every request -- there's no caching layer because
// there's no need for one: a few hundred rows, one scrape a day.
export function createApiApp() {
  const db = open();
  const app = express();

  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    next();
  });

  // Distinct filter values, grouped where the frontend groups them (resorts by
  // mountain range, levels by skill tier) so it doesn't have to re-derive the
  // grouping itself -- built from what's actually in the DB, not a hardcoded
  // list that drifts as UCPA adds/removes products.
  app.get("/api/filters", (req, res) => {
    const resortsByRegion = {};
    for (const r of db.prepare("SELECT DISTINCT resort, region FROM product WHERE resort IS NOT NULL ORDER BY resort").all()) {
      const region = translate(r.region);
      (resortsByRegion[region] ??= []).push(r.resort);
    }

    const distinct = (col) =>
      db.prepare(`SELECT DISTINCT ${col} v FROM product WHERE ${col} IS NOT NULL ORDER BY ${col}`).all().map((r) => r.v);

    // How many still-bookable weeks match each filter value -- same grouping
    // /api/weeks' matchByGroup applies per-request, tallied once here instead.
    // Keyed the same way the corresponding meta list above is (raw resort/
    // instruction_type, canonical activity/tier bucket), so the frontend can
    // look a count up directly by the label it's already displaying.
    const facetRows = db.prepare("SELECT resort, activity, level, instruction_type FROM v_week_listing WHERE seats_left > 0").all();
    const tally = (mapper) => {
      const counts = {};
      for (const row of facetRows) {
        for (const key of mapper(row)) counts[key] = (counts[key] ?? 0) + 1;
      }
      return counts;
    };

    res.json({
      resortsByRegion,
      // Canonical activity buckets (src/activities.mjs), not UCPA's raw
      // per-product activity labels -- e.g. "Ski ou snowboard" folds into both
      // Ski and Snowboard rather than showing as its own confusing third option.
      activities: groupsPresent(distinct("activity")),
      // Skill tiers actually present (src/levels.mjs), not individual level
      // strings -- Activity already narrows by discipline, so the level filter
      // itself only needs to offer the beginner->expert gradation.
      tiers: [...new Set(distinct("level").map(tierOf))].sort((a, b) => tierRank(a) - tierRank(b)),
      instructionTypes: distinct("instruction_type"),
      resortCounts: tally((r) => [r.resort]),
      activityCounts: tally((r) => groupsOf(r.activity)),
      tierCounts: tally((r) => [tierOf(r.level)]),
      instructionTypeCounts: tally((r) => [r.instruction_type]),
      priceRange: db.prepare("SELECT MIN(price) min, MAX(price) max FROM v_week_current WHERE seats_left > 0").get(),
      // Months with at least one still-bookable week, across all products.
      months: db
        .prepare("SELECT DISTINCT substr(start_date,1,7) v FROM v_week_current WHERE seats_left > 0 ORDER BY v")
        .all()
        .map((r) => r.v),
      lastScrapedAt: db.prepare("SELECT MAX(started_at) v FROM run").get().v,
      // Trip cost tab: whether flight refresh can work at all (key is read at
      // request time in src/flights.mjs, this is just the UI's early warning),
      // and when quotes were last fetched.
      flightsConfigured: Boolean(process.env.SERPAPI_KEY),
      lastFlightsRefreshAt: db.prepare("SELECT MAX(fetched_at) v FROM flight_price").get().v,
      // Activity/level/region values UCPA has added that this codebase hasn't
      // been taught yet -- see src/categories.mjs. Surfaced here (not just the
      // scrape console) so it's visible from a page load alone.
      unknownCategories: findUnknownCategories(db),
    });
  });

  // The primary listing: one row per (product, specific week), not grouped by
  // product -- filters apply directly against each week's own price/date/seats.
  // Sold-out weeks are never returned, unconditionally -- there's nothing to
  // book, so nothing to list.
  app.get("/api/weeks", (req, res) => {
    const q = req.query;
    const where = ["seats_left > 0"];
    const params = [];

    const inFilter = (col, val) => {
      if (!val) return;
      const list = [].concat(val);
      where.push(`${col} IN (${list.map(() => "?").join(",")})`);
      params.push(...list);
    };
    inFilter("resort", q.resort);
    // activity and tier are both requested as a canonical, English name that
    // one or more raw (French) DB values can map to -- activity by canonical bucket
    // (src/activities.mjs; UCPA's dual-discipline packages map to two), tier by
    // skill level (src/levels.mjs). Resolve the raw values that match, rather
    // than storing the canonical name in SQL.
    const matchByGroup = (col, val, rawToGroups) => {
      if (!val) return;
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

    if (q.minPrice) { where.push("wl.price >= ?"); params.push(Number(q.minPrice)); }
    if (q.maxPrice) { where.push("wl.price <= ?"); params.push(Number(q.maxPrice)); }
    if (q.month) {
      const months = [].concat(q.month);
      where.push(`(${months.map(() => "substr(wl.start_date,1,7) = ?").join(" OR ")})`);
      params.push(...months);
    }

    const orderBy = SORTS[q.sort] ?? SORTS.price_asc;
    const sql = `
      SELECT wl.*, wd.price_prev, wd.delta_eur, wd.seats_prev, wd.seats_delta,
             CASE WHEN wn.code IS NOT NULL THEN 1 ELSE 0 END AS is_new,
             fp.price AS flight_price, fp.dep_airport AS flight_dep, fp.arr_airport AS flight_arr,
             fp.airline AS flight_airline, fp.stops AS flight_stops,
             fp.duration_min AS flight_duration_min, fp.fetched_at AS flight_fetched_at,
             fp.outbound_date AS flight_depart_date, fp.return_date AS flight_return_date
      FROM v_week_listing wl
      LEFT JOIN v_week_delta wd ON wd.code = wl.code AND wd.start_date = wl.start_date
      LEFT JOIN v_week_new wn ON wn.code = wl.code AND wn.start_date = wl.start_date
      -- Flight quotes are searched a day before the package's own start_date
      -- (src/flights.mjs FLIGHT_DEPART_DAYS_BEFORE) -- this offset must match.
      LEFT JOIN v_flight_current fp
        ON fp.outbound_date = date(wl.start_date, '-1 day') AND fp.return_date = wl.end_date
      WHERE ${where.join(" AND ")}
      ORDER BY ${orderBy}`;
    const rows = db.prepare(sql).all(...params);
    res.json(rows.map(translateListing));
  });

  // Runs the real scraper against the live site (~1-2 minutes for the current
  // catalogue, same DELAY_MS-paced requests as the CLI -- see src/scrape.mjs).
  // One at a time: `scraping` guards against a double-click firing two
  // overlapping scrapes, which would both hammer UCPA and race on SQLite
  // writes. The request just blocks until it's done -- simplest thing that
  // works for a single-user tool, no job queue or websocket needed.
  let scraping = false;
  app.post("/api/scrape", async (req, res) => {
    if (scraping) return res.status(409).json({ error: "a scrape is already running" });
    scraping = true;
    try {
      const result = await runScrape({ db });
      res.json(result);
    } catch (e) {
      console.error("scrape failed:", e);
      res.status(500).json({ error: e.message });
    } finally {
      scraping = false;
    }
  });

  // Same shape as /api/scrape: one at a time, request blocks until done.
  // ~25-40 SerpApi searches on a cold season, near-instant when everything's
  // still fresh (the 24h skip in src/flights.mjs does the real throttling).
  let refreshingFlights = false;
  app.post("/api/flights/refresh", async (req, res) => {
    if (refreshingFlights) return res.status(409).json({ error: "a flight refresh is already running" });
    refreshingFlights = true;
    try {
      const result = await runFlightRefresh({ db });
      res.json(result);
    } catch (e) {
      console.error("flight refresh failed:", e);
      res.status(500).json({ error: e.message });
    } finally {
      refreshingFlights = false;
    }
  });

  return app;
}
