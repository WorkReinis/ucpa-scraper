import { translate, translateList } from "./translate.mjs";
import { tierOf, tierRank } from "./levels.mjs";
import { groupsOf, groupsPresent } from "./activities.mjs";
import { findUnknownCategories } from "./categories.mjs";
import { FLIGHT_REFRESH_DAYS } from "./flights.mjs";
import { gatewayCaseSql } from "./airports.mjs";

function translateListing(row) {
  return {
    ...row,
    flight_outbound_segments: JSON.parse(row.flight_outbound_segments || "[]"),
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

export function getFiltersData(db, { flightsConfigured = false } = {}) {
  const resortsByRegion = {};
  for (const r of db.prepare("SELECT DISTINCT resort, region FROM product WHERE resort IS NOT NULL ORDER BY resort").all()) {
    const region = translate(r.region);
    (resortsByRegion[region] ??= []).push(r.resort);
  }

  const distinct = (col) =>
    db.prepare(`SELECT DISTINCT ${col} v FROM product WHERE ${col} IS NOT NULL ORDER BY ${col}`).all().map((r) => r.v);
  const facetRows = db.prepare("SELECT resort, activity, level, instruction_type, age_min, age_max FROM v_week_listing WHERE seats_left > 0").all();
  const tally = (mapper) => {
    const counts = {};
    for (const row of facetRows) {
      for (const key of mapper(row)) counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  };

  const attemptedThisMonth = db.prepare(
    "SELECT COUNT(*) n FROM flight_search WHERE billing_month = strftime('%Y-%m', 'now')"
  ).get().n;
  const priceRangeRow = db.prepare(
    "SELECT MIN(price) min, MAX(price) max FROM v_week_current WHERE seats_left > 0"
  ).get();
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
      .prepare("SELECT DISTINCT substr(start_date,1,7) v FROM v_week_current WHERE seats_left > 0 ORDER BY v")
      .all()
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
    flightQuota: {
      limit: 225,
      used: attemptedThisMonth,
      remaining: Math.max(225 - attemptedThisMonth, 0),
    },
    unknownCategories: findUnknownCategories(db),
  };
}

export function getWeeksData(db, q = {}) {
  // UCPA keeps zero-stock offers in offersInfo. Preserve those explicit
  // sold-out rows as useful demand history; null stock is not an authoritative
  // sold-out signal and stays hidden.
  const where = ["seats_left IS NOT NULL"];
  const params = [];

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
  const sql = `
    SELECT wl.*, wd.price_prev, wd.delta_eur, wd.seats_prev, wd.seats_delta,
           CASE WHEN wn.code IS NOT NULL THEN 1 ELSE 0 END AS is_new,
           fp.price AS flight_price, fp.dep_airport AS flight_dep, fp.arr_airport AS flight_arr,
           fp.gateway AS flight_gateway,
           fp.airline AS flight_airline, fp.stops AS flight_stops,
           fp.duration_min AS flight_duration_min, fp.fetched_at AS flight_fetched_at,
           fp.outbound_segments AS flight_outbound_segments,
           fp.details_scope AS flight_details_scope,
           fp.outbound_date AS flight_depart_date, fp.return_date AS flight_return_date
    FROM v_week_listing wl
    LEFT JOIN v_week_delta wd ON wd.code = wl.code AND wd.start_date = wl.start_date
    LEFT JOIN v_week_new wn ON wn.code = wl.code AND wn.start_date = wl.start_date
    LEFT JOIN v_flight_current fp
      ON fp.outbound_date = date(wl.start_date, '-1 day') AND fp.return_date = wl.end_date
      AND fp.gateway = ${gatewayCaseSql("wl.resort")}
    WHERE ${where.join(" AND ")}
    ORDER BY (wl.seats_left <= 0) ASC, ${orderBy}`;
  return db.prepare(sql).all(...params).map(translateListing);
}
