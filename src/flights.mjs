// node src/flights.mjs -> refresh flight quotes for upcoming weeks
//
// Google Flights via the provider seam in src/providers/ (Apify actor
// primary, SerpApi fallback). Each arrival mode uses a real round-trip search
// whose price is authoritative. One shared return one-way search supplies a
// shuttle-compatible return schedule without being added to that fare: per
// (start, end) week pair that's one round-trip search per mode. A separately
// cached return schedule is refreshed every 14 days, so most fare cycles need
// 2 searches/pair instead of 3. Searches include only gateways used by that
// date pair; a missing origin x gateway cell gets one exact narrow retry.
//
// Shuttle viability: itineraries are filtered by the transfer windows in
// src/airports.mjs (TRANSFER_BANDS) -- outbound flights must land before
// the gateway airport's latest-arrival time, return flights must depart
// after its earliest-departure time. The stored price is the authoritative
// round-trip fare; the separate return search contributes schedule details
// only and is never added to that fare.
//
// Quotes land append-only in flight_price (src/db.mjs). The flight_search
// ledger keeps successful quotes fresh for six days, allows no more than two
// attempts per (pair, mode) in that rolling window, and enforces a monthly
// ceiling per provider.
//
// Needs APIFY_KEY_1.. and/or SERPAPI_KEY in the environment.

import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import {
  open,
  insertFlightPrice,
  insertReturnSchedule,
  startFlightSearch,
  finishFlightSearch,
} from "./db.mjs";
import { writeDiagnostic } from "./diagnostics.mjs";
import { wholePrice } from "./validation.mjs";
import {
  AIRPORT_CONFIG_KEY, AIRPORT_GATEWAYS, DEST_AIRPORTS, ORIGIN_GROUPS,
  earliestReturnDepartureFor, gatewayById, gatewayForResort, latestArrivalFor, originGroupById,
} from "./airports.mjs";
import {
  search as providerSearch, configuredProviders, MONTHLY_RUN_LIMIT_APIFY,
} from "./providers/index.mjs";

export const MONTHLY_SEARCH_LIMIT = 225; // SerpApi free-tier ceiling
export const FLIGHT_REFRESH_DAYS = 6;
export const RETURN_SCHEDULE_REFRESH_DAYS = 14;
export const MAX_ATTEMPTS_PER_PAIR_WINDOW = 2;
// Wide enough that a summer refresh still covers the whole Nov-Apr season
// (the current catalogue is only ~22 distinct weeks, so this cap is about
// not querying beyond Google's ~11-month booking horizon, not about quota).
const MONTHS_AHEAD = 10;
const DELAY_MS = 1200;  // pacing between searches, same manners as scrape.mjs

// 'standard': fly out on the package's own start_date (Sunday check-in).
// 'early': fly out the day before (Saturday) for UCPA's early-arrival
// service -- you get to ride the whole first Sunday. The mode only shifts
// outbound_date; the return flight stays on the package's own end_date,
// which also handles the shorter 5/6-day packages for free.
export const ARRIVAL_MODES = [
  { id: "standard", offsetDays: 0 },
  { id: "early", offsetDays: -1 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function flightPolicy({ monthlyAttempts, recentAttempts, hasFreshQuote, provider = "serpapi" }) {
  if (hasFreshQuote) return "fresh_quote";
  const limit = provider === "apify" ? MONTHLY_RUN_LIMIT_APIFY : MONTHLY_SEARCH_LIMIT;
  if (monthlyAttempts >= limit) return "monthly_quota";
  if (recentAttempts >= MAX_ATTEMPTS_PER_PAIR_WINDOW) return "recent_attempts";
  return "search";
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Provider leg times are "YYYY-MM-DD HH:MM"; the windows are "HH:MM".
// Lexical comparison on the sliced time-of-day is correct for both.
function timeOfDay(value) {
  const match = /\b(\d{2}:\d{2})$/.exec(value ?? "");
  return match ? match[1] : null;
}

/**
 * One (origin group x gateway) cell of a one-way search response, in the
 * row shape insertFlightPrice expects for that direction. price null =
 * nothing viable for the cell.
 *
 * direction 'outbound': first leg departs the origin group, last leg lands
 * inside the gateway, and the landing must not be after the airport's
 * latest-arrival window. direction 'return' mirrors the airports (departs
 * the gateway, lands in the origin group) and the first leg must not
 * depart before the airport's earliest-departure window. Itineraries with
 * missing time data are kept -- a provider quirk must never wipe out all
 * quotes. window_dropped counts what the window filter removed, so a cell
 * that goes null while dropping N itineraries flags a miscalibrated window
 * in the refresh log instead of failing silently.
 */
export function parseFlightResponse(j, {
  outboundDate, returnDate, gateway = "legacy", dests = DEST_AIRPORTS,
  originGroup = "nl", originAirports = originGroupById("nl").airports,
  direction = "outbound",
}) {
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("invalid flight response object");
  if (j.best_flights != null && !Array.isArray(j.best_flights)) throw new Error("best_flights is not an array");
  if (j.other_flights != null && !Array.isArray(j.other_flights)) throw new Error("other_flights is not an array");
  if (j.search_metadata?.status && j.search_metadata.status !== "Success") {
    throw new Error(`search status is ${j.search_metadata.status}`);
  }
  const hasFlightArrays = Array.isArray(j.best_flights) || Array.isArray(j.other_flights);
  const identifiesEngine = j.search_parameters?.engine === "google_flights";
  if (!hasFlightArrays && !identifiesEngine) throw new Error("response is not recognizable Google Flights data");

  const rawItineraries = [...(j.best_flights ?? []), ...(j.other_flights ?? [])]
    .filter((it) => it.price != null);
  const validItineraries = rawItineraries.filter((it) => {
    const legs = it.flights;
    return wholePrice(it.price) > 0 && Array.isArray(legs) && legs.length > 0 && legs.every((leg) =>
      leg?.departure_airport?.id && leg?.arrival_airport?.id && leg?.airline
    );
  });
  if (rawItineraries.length > 0 && validItineraries.length === 0) {
    throw new Error("flight itineraries exist but do not match the expected schema");
  }

  // The cell is the intersection of origin-group and gateway airports,
  // mirrored between directions.
  const groupSet = new Set(originAirports);
  const gatewaySet = new Set(dests);
  const inCell = direction === "return"
    ? (it) => gatewaySet.has(it.flights[0]?.departure_airport?.id) &&
              groupSet.has(it.flights.at(-1)?.arrival_airport?.id)
    : (it) => groupSet.has(it.flights[0]?.departure_airport?.id) &&
              gatewaySet.has(it.flights.at(-1)?.arrival_airport?.id);
  const cellItineraries = validItineraries.filter(inCell);

  // Shuttle-viability window (src/airports.mjs TRANSFER_BANDS). Skipped for
  // the legacy gateway sentinel, which has no transfer config.
  const viable = gateway === "legacy" ? cellItineraries : cellItineraries.filter((it) => {
    if (direction === "return") {
      const firstLeg = it.flights[0];
      const departs = timeOfDay(firstLeg.departure_airport.time);
      return departs == null || departs >= earliestReturnDepartureFor(gateway, firstLeg.departure_airport.id);
    }
    const lastLeg = it.flights.at(-1);
    const lands = timeOfDay(lastLeg.arrival_airport.time);
    return lands == null || lands <= latestArrivalFor(gateway, lastLeg.arrival_airport.id);
  });

  const row = {
    origins: originAirports.join(","),
    dests: dests.join(","),
    gateway,
    origin_group: originGroup,
    direction,
    outbound_date: outboundDate,
    return_date: returnDate,
    price: null,
    dep_airport: null,
    arr_airport: null,
    airline: null,
    stops: null,
    duration_min: null,
    segments: [],
    price_level: j.price_insights?.price_level ?? null,
    candidate_count: cellItineraries.length,
    window_dropped: cellItineraries.length - viable.length,
  };
  if (!viable.length) return row;

  const best = viable.reduce((a, b) => (b.price < a.price ? b : a));
  const legs = best.flights ?? [];
  const segments = legs.map((leg) => ({
    from: leg.departure_airport.id,
    to: leg.arrival_airport.id,
    airline: leg.airline,
    flight_number: leg.flight_number ?? null,
    departure_at: leg.departure_airport.time ?? null,
    arrival_at: leg.arrival_airport.time ?? null,
    duration_min: Number.isFinite(Number(leg.duration)) ? Number(leg.duration) : null,
  }));
  return {
    ...row,
    price: wholePrice(best.price),
    dep_airport: legs[0]?.departure_airport?.id ?? null,
    arr_airport: legs.at(-1)?.arrival_airport?.id ?? null,
    airline: [...new Set(legs.map((leg) => leg.airline).filter(Boolean))].join(" + ") || null,
    stops: legs.length ? legs.length - 1 : null,
    duration_min: Number.isFinite(Number(best.total_duration)) ? Math.round(Number(best.total_duration)) : null,
    segments,
  };
}

/** Attach a viable return schedule to an authoritative round-trip fare.
 * `outbound.price` is the complete round-trip total returned by the outbound
 * round-trip search; `ret.price` is used only to prove that a return schedule
 * fits the shuttle window. It must never be added to the fare.
 *
 * `pricingMode: "separate"` remains available for a future explicitly
 * labelled two-booking strategy, where summing independently bookable
 * one-ways is intentional. */
export function combineDirections(outbound, ret, { pricingMode = "roundtrip" } = {}) {
  const complete = outbound.price != null && ret.price != null;
  const separate = pricingMode === "separate";
  return {
    origins: outbound.origins,
    dests: outbound.dests,
    gateway: outbound.gateway,
    origin_group: outbound.origin_group,
    outbound_date: outbound.outbound_date,
    return_date: outbound.return_date,
    price: complete ? (separate ? outbound.price + ret.price : outbound.price) : null,
    price_outbound: separate ? outbound.price : null,
    price_return: separate ? ret.price : null,
    pricing_mode: separate ? "separate" : "roundtrip",
    dep_airport: outbound.dep_airport,
    arr_airport: outbound.arr_airport,
    airline: outbound.airline,
    stops: outbound.stops,
    duration_min: outbound.duration_min,
    outbound_segments: outbound.segments,
    return_dep_airport: ret.dep_airport,
    return_arr_airport: ret.arr_airport,
    return_airline: ret.airline,
    return_stops: ret.stops,
    return_duration_min: ret.duration_min,
    return_segments: ret.segments,
    details_scope: "both",
    price_level: outbound.price_level ?? null,
  };
}

/** Origin groups for which a broad provider response contained no raw
 * itinerary for at least one required gateway. A zero viable-price cell is
 * not automatically a gap: if candidate_count is non-zero, the shuttle
 * window deliberately rejected those flights and a wider search should not
 * silently bypass that policy. */
export function originGroupsMissingCoverage(cells, gateways, originGroups = ORIGIN_GROUPS) {
  return originGroups.filter((group) => gateways.some((gateway) =>
    (cells.get(`${group.id}|${gateway.id}`)?.candidate_count ?? 0) === 0
  ));
}

/** Replace only cells absent from the broad response with cells from the
 * corresponding narrow origin-market search. */
export function mergeOriginCoverage(cells, recovered, originGroup, gateways) {
  const merged = new Map(cells);
  for (const gateway of gateways) {
    const key = `${originGroup.id}|${gateway.id}`;
    if ((merged.get(key)?.candidate_count ?? 0) === 0) {
      merged.set(key, recovered.get(key));
    }
  }
  return merged;
}

/**
 * Quote every distinct upcoming bookable week, in both arrival modes, that
 * doesn't already have a fresh quote for every (origin group x gateway)
 * cell. Pass an already-open `db` to reuse a connection (the server does
 * this, same contract as runScrape). Returns a summary the frontend shows
 * verbatim.
 */
export async function runFlightRefresh({
  db,
  providerNames,
  originGroupIds,
  searchProvider = providerSearch,
  delay = sleep,
} = {}) {
  const providers = providerNames ?? configuredProviders();
  if (!providers.length) {
    throw new Error("no flight provider configured -- set APIFY_KEY_1.. or SERPAPI_KEY");
  }
  const primaryProvider = providers[0];
  const requestedOriginIds = originGroupIds?.length
    ? [...new Set(originGroupIds)]
    : ORIGIN_GROUPS.map((group) => group.id);
  const unknownOriginIds = requestedOriginIds.filter((id) => !originGroupById(id));
  if (unknownOriginIds.length) {
    throw new Error(`unknown flight origin group: ${unknownOriginIds.join(", ")}`);
  }
  const targetOriginGroups = requestedOriginIds.map(originGroupById);
  const targetOriginAirportIds = targetOriginGroups.flatMap((group) => group.airports).join(",");

  const _db = db ?? open();

  const pairRows = _db.prepare(
    `SELECT DISTINCT w.start_date, w.end_date, p.resort
     FROM v_week_current w JOIN product p ON p.code = w.code
     WHERE w.seats_left > 0 AND w.end_date IS NOT NULL
       AND w.start_date > date('now') AND w.start_date <= date('now', ?)
     ORDER BY w.start_date`
  ).all(`+${MONTHS_AHEAD} months`);
  const pairMap = new Map();
  for (const row of pairRows) {
    const gateway = gatewayForResort(row.resort);
    if (!gateway) throw new Error(`No validated airport gateway for resort: ${row.resort}`);
    const key = `${row.start_date}|${row.end_date}`;
    const pair = pairMap.get(key) ?? {
      start_date: row.start_date, end_date: row.end_date, gatewayIds: new Set(),
    };
    pair.gatewayIds.add(gateway.id);
    pairMap.set(key, pair);
  }
  const pairs = [...pairMap.values()];

  const now = new Date();
  const refreshKey = now.toISOString().slice(0, 10);
  const billingMonth = now.toISOString().slice(0, 7);
  const monthlyAttemptsStmt = _db.prepare(
    "SELECT COUNT(*) n FROM flight_search WHERE billing_month = ? AND provider = ?"
  );
  const monthlyAttempts = Object.fromEntries(
    providers.map((p) => [p, monthlyAttemptsStmt.get(billingMonth, p).n])
  );
  const freshQuotes = _db.prepare(
    `SELECT gateway, origin_group, dests, origins FROM flight_price
     WHERE outbound_date = ? AND return_date = ?
       AND details_scope = 'both'
       AND config_key = ?
       AND date(fetched_at) > date('now', ?)
     GROUP BY gateway, origin_group`
  );
  const freshReturnSchedules = _db.prepare(
    `SELECT s.* FROM flight_return_schedule s
     WHERE s.return_date = ? AND s.config_key = ?
       AND date(s.fetched_at) > date('now', ?)
       AND s.rowid = (
         SELECT s2.rowid FROM flight_return_schedule s2
         WHERE s2.return_date = s.return_date
           AND s2.config_key = s.config_key
           AND s2.origin_group = s.origin_group
           AND s2.gateway = s.gateway
         ORDER BY s2.fetched_at DESC, s2.rowid DESC
         LIMIT 1
       )`
  );
  const recentAttempts = _db.prepare(
    `SELECT COUNT(*) n FROM flight_search
     WHERE outbound_date = ? AND return_date = ?
       AND config_key = ?
       AND status IN ('started', 'failed')
       AND date(attempted_at) > date('now', ?)`
  );
  const freshnessWindow = `-${FLIGHT_REFRESH_DAYS} days`;
  const returnFreshnessWindow = `-${RETURN_SCHEDULE_REFRESH_DAYS} days`;

  const summary = {
    pairs: pairs.length,
    modes: ARRIVAL_MODES.length,
    modesDue: 0,
    modesCompleted: 0,
    cellsDue: 0,
    cellsStored: 0,
    cellsUnpriced: 0,
    recoverySearches: 0,
    broadSearches: 0,
    targetedRetries: 0,
    returnCacheHits: 0,
    returnCellsReused: 0,
    searched: 0,
    skipped: 0,
    failed: 0,
    noResult: 0,
    quotaSkipped: 0,
    recentAttemptSkipped: 0,
    provider: primaryProvider,
    originGroups: requestedOriginIds,
    quotaLimit: primaryProvider === "apify" ? MONTHLY_RUN_LIMIT_APIFY : MONTHLY_SEARCH_LIMIT,
    quotaUsed: monthlyAttempts[primaryProvider],
    quotaExhausted: false,
    errors: [],
  };

  const runSearch = async ({
    originIds, destIds, outboundDate, returnDate, direction, arrivalMode, scope = "broad",
  }) => {
    const quotaLimit = primaryProvider === "apify" ? MONTHLY_RUN_LIMIT_APIFY : MONTHLY_SEARCH_LIMIT;
    if (monthlyAttempts[primaryProvider] >= quotaLimit) {
      summary.quotaExhausted = true;
      throw new Error(`run out of searches: ${primaryProvider} monthly quota reached`);
    }
    const searchId = startFlightSearch(_db, {
      outboundDate,
      returnDate,
      weekKey: refreshKey,
      billingMonth,
      configKey: AIRPORT_CONFIG_KEY,
      arrivalMode,
      provider: primaryProvider,
      direction,
    });
    monthlyAttempts[primaryProvider]++;
    try {
      const { raw, provider: usedProvider, secrets } = await searchProvider({
        originIds,
        destIds,
        outboundDate,
        // Outbound searches are genuine round trips so `price` is the fare
        // a user sees on Google Flights. Return searches remain one-way and
        // contribute schedule/viability only.
        returnDate: direction === "outbound" ? returnDate : undefined,
      });
      if (usedProvider !== primaryProvider) {
        monthlyAttempts[usedProvider] = (monthlyAttempts[usedProvider] ?? 0) + 1;
      }
      summary.searched++;
      if (scope === "targeted") summary.targetedRetries++;
      else summary.broadSearches++;
      return { searchId, raw, usedProvider, secrets };
    } catch (e) {
      finishFlightSearch(_db, searchId, "failed", e.message);
      summary.failed++;
      summary.errors.push(e.message);
      throw e;
    }
  };

  outer:
  for (const { start_date, end_date, gatewayIds } of pairs) {
    // Which arrival modes actually need a search this refresh?
    const staleModes = [];
    for (const mode of ARRIVAL_MODES) {
      const flightDate = addDays(start_date, mode.offsetDays);
      const freshCells = new Set(
        freshQuotes.all(flightDate, end_date, AIRPORT_CONFIG_KEY, freshnessWindow)
          .filter((r) =>
            r.dests === (gatewayById(r.gateway)?.airports ?? []).join(",") &&
            r.origins === (originGroupById(r.origin_group)?.airports ?? []).join(",")
          )
          .map((r) => `${r.origin_group}|${r.gateway}`)
      );
      const requiredCells = [...gatewayIds]
        .flatMap((gid) => targetOriginGroups.map((og) => `${og.id}|${gid}`));
      const hasFreshQuote = requiredCells.every((cell) => freshCells.has(cell));
      if (!hasFreshQuote) {
        summary.modesDue++;
        summary.cellsDue += requiredCells.length;
      }
      const policy = flightPolicy({
        monthlyAttempts: monthlyAttempts[primaryProvider],
        recentAttempts: recentAttempts.get(flightDate, end_date, AIRPORT_CONFIG_KEY, freshnessWindow).n,
        hasFreshQuote,
        provider: primaryProvider,
      });
      if (policy === "search") staleModes.push({ ...mode, flightDate });
      else {
        summary.skipped++;
        if (policy === "monthly_quota") summary.quotaSkipped++;
        if (policy === "recent_attempts") summary.recentAttemptSkipped++;
      }
    }
    if (!staleModes.length) continue;

    const gateways = AIRPORT_GATEWAYS.filter((gateway) => gatewayIds.has(gateway.id));
    const pairDestinationAirportIds = [...new Set(gateways.flatMap((gateway) => gateway.airports))].join(",");
    const requiredCellKeys = gateways.flatMap((gateway) =>
      targetOriginGroups.map((originGroup) => `${originGroup.id}|${gateway.id}`)
    );
    const cellsOf = (
      raw, options, originGroups = targetOriginGroups, selectedGateways = gateways,
    ) => {
      let cells;
      try {
        cells = new Map(originGroups.flatMap((og) => selectedGateways.map((gateway) => [
          `${og.id}|${gateway.id}`,
          parseFlightResponse(raw, {
            ...options,
            gateway: gateway.id, dests: gateway.airports,
            originGroup: og.id, originAirports: og.airports,
          }),
        ])));
      } catch (error) {
        writeDiagnostic(
          `flights-${options.outboundDate}-${options.direction}-invalid-response`,
          raw, "json", { secrets: options.secrets }
        );
        throw error;
      }
      return cells;
    };

    // Google Flights treats a many-origin/many-destination request as a
    // flexible search, not a Cartesian API. Retry only a cell for which the
    // broad response returned no candidate at all. A cell with candidates
    // that all miss the shuttle window is a real policy result, not a reason
    // to spend another provider request.
    const recoverMissingCoverage = async (cells, {
      direction, outboundDate, returnDate, arrivalMode,
    }) => {
      const covered = new Map(cells);
      for (const originGroup of targetOriginGroups) {
        for (const gateway of gateways) {
          const cellKey = `${originGroup.id}|${gateway.id}`;
          if ((covered.get(cellKey)?.candidate_count ?? 0) !== 0) continue;
          let recoverySearch;
          try {
            recoverySearch = await runSearch({
              originIds: direction === "return" ? gateway.airports.join(",") : originGroup.airports.join(","),
              destIds: direction === "return" ? originGroup.airports.join(",") : gateway.airports.join(","),
              outboundDate,
              returnDate,
              direction,
              arrivalMode,
              scope: "targeted",
            });
            const recovered = cellsOf(recoverySearch.raw, {
              outboundDate, returnDate, direction, secrets: recoverySearch.secrets,
            }, [originGroup], [gateway]);
            covered.set(cellKey, recovered.get(cellKey));
            finishFlightSearch(
              _db,
              recoverySearch.searchId,
              recovered.get(cellKey)?.price != null ? "success" : "no_result"
            );
            summary.recoverySearches++;
            console.log(
              `    retried ${originGroup.id}/${gateway.id} ${direction} via ${recoverySearch.usedProvider}`
            );
          } catch (error) {
            // runSearch has already closed provider failures. A set search row
            // means parsing failed after a successful response.
            if (recoverySearch) {
              finishFlightSearch(_db, recoverySearch.searchId, "failed", error.message);
              summary.failed++;
              summary.errors.push(error.message);
            }
            throw new Error(
              `${originGroup.id}/${gateway.id} ${direction} coverage retry failed: ${error.message}`
            );
          }
          await delay(DELAY_MS);
        }
      }
      return covered;
    };

    // A return schedule is shared by both arrival modes and cached longer
    // than fares. Null-price rows are cached too: they truthfully mean the
    // cell was searched but no shuttle-compatible return was available.
    let returnCells;
    const cachedReturnCells = new Map(
      freshReturnSchedules
        .all(end_date, AIRPORT_CONFIG_KEY, returnFreshnessWindow)
        .filter((row) => {
          const gateway = gatewayById(row.gateway);
          const originGroup = originGroupById(row.origin_group);
          return gatewayIds.has(row.gateway) && requestedOriginIds.includes(row.origin_group) &&
            row.dests === gateway?.airports.join(",") &&
            row.origins === originGroup?.airports.join(",");
        })
        .map((row) => [`${row.origin_group}|${row.gateway}`, {
          ...row,
          direction: "return",
          outbound_date: end_date,
          segments: JSON.parse(row.segments || "[]"),
        }])
    );
    if (requiredCellKeys.every((key) => cachedReturnCells.has(key))) {
      returnCells = new Map(requiredCellKeys.map((key) => [key, cachedReturnCells.get(key)]));
      summary.returnCacheHits++;
      summary.returnCellsReused += returnCells.size;
    } else {
      let returnSearch;
      let returnSearchClosed = false;
      try {
        returnSearch = await runSearch({
          originIds: pairDestinationAirportIds, destIds: targetOriginAirportIds,
          outboundDate: end_date, returnDate: end_date,
          direction: "return", arrivalMode: "standard",
        });
        returnCells = cellsOf(returnSearch.raw, {
          outboundDate: end_date, returnDate: end_date,
          direction: "return", secrets: returnSearch.secrets,
        });
        finishFlightSearch(_db, returnSearch.searchId,
          [...returnCells.values()].some((cell) => cell.price != null) ? "success" : "no_result");
        returnSearchClosed = true;
        returnCells = await recoverMissingCoverage(returnCells, {
          outboundDate: end_date, returnDate: end_date,
          direction: "return", arrivalMode: "standard",
        });
        for (const cell of returnCells.values()) {
          insertReturnSchedule(_db, {
            ...cell,
            provider: returnSearch.usedProvider,
            config_key: AIRPORT_CONFIG_KEY,
          });
        }
      } catch (e) {
        // runSearch finishes (and counts) its own failures; reaching here with
        // returnSearch set means the parse failed after a successful search.
        if (returnSearch && !returnSearchClosed) {
          finishFlightSearch(_db, returnSearch.searchId, "failed", e.message);
          summary.failed++;
          summary.errors.push(e.message);
        }
        console.error(`  ! ${end_date} return leg failed:`, e.message);
        if (/run out of searches|below reserve|no .* has remaining credit/i.test(e.message)) break outer;
        await delay(DELAY_MS);
        continue; // outbound halves are useless without the return -- retry next refresh
      }
      await delay(DELAY_MS);
    }

    for (const mode of staleModes) {
      let outboundSearch;
      let outboundSearchClosed = false;
      try {
        outboundSearch = await runSearch({
          originIds: targetOriginAirportIds, destIds: pairDestinationAirportIds,
          outboundDate: mode.flightDate, returnDate: end_date,
          direction: "outbound", arrivalMode: mode.id,
        });
        let outboundCells = cellsOf(outboundSearch.raw, {
          outboundDate: mode.flightDate, returnDate: end_date,
          direction: "outbound", secrets: outboundSearch.secrets,
        });
        finishFlightSearch(_db, outboundSearch.searchId,
          [...outboundCells.values()].some((cell) => cell.price != null) ? "success" : "no_result");
        outboundSearchClosed = true;
        outboundCells = await recoverMissingCoverage(outboundCells, {
          outboundDate: mode.flightDate, returnDate: end_date,
          direction: "outbound", arrivalMode: mode.id,
        });
        const rows = [];
        for (const [cellKey, outboundCell] of outboundCells) {
          rows.push({
            combined: combineDirections(outboundCell, returnCells.get(cellKey)),
            dropped: {
              late: outboundCell.window_dropped,
              early: returnCells.get(cellKey).window_dropped,
            },
          });
        }
        for (const { combined } of rows) {
          insertFlightPrice(_db, {
            ...combined,
            arrival_mode: mode.id,
            provider: outboundSearch.usedProvider,
            config_key: AIRPORT_CONFIG_KEY,
          });
        }
        const found = rows.filter(({ combined }) => combined.price != null);
        summary.modesCompleted++;
        summary.cellsStored += rows.length;
        summary.cellsUnpriced += rows.length - found.length;
        if (!found.length) summary.noResult++;
        console.log(
          `  ${mode.flightDate} -> ${end_date} (${mode.id}, package starts ${start_date}, via ${outboundSearch.usedProvider}): ` +
          (found.length
            ? found.map(({ combined, dropped }) =>
                `${combined.origin_group}/${combined.gateway}=€${combined.price} round trip ` +
                `${combined.dep_airport}->${combined.arr_airport}/${combined.return_dep_airport}->${combined.return_arr_airport}` +
                (dropped.late || dropped.early ? ` (${dropped.late} late, ${dropped.early} early dropped)` : "")
              ).join("; ")
            : "no viable flights")
        );
      } catch (e) {
        // Same contract as the return leg: only parse failures reach here
        // with the search row still open.
        if (outboundSearch && !outboundSearchClosed) {
          finishFlightSearch(_db, outboundSearch.searchId, "failed", e.message);
          summary.failed++;
          summary.errors.push(e.message);
        }
        console.error(`  ! ${mode.flightDate} -> ${end_date} (${mode.id}) failed:`, e.message);
        if (/run out of searches|below reserve|no .* has remaining credit/i.test(e.message)) break outer;
      }
      await delay(DELAY_MS);
    }
  }
  summary.quotaUsed = monthlyAttempts[primaryProvider];
  summary.quotaRemaining = Math.max(summary.quotaLimit - summary.quotaUsed, 0);
  summary.cellsMissing = Math.max(summary.cellsDue - summary.cellsStored, 0);
  summary.unresolvedCells = summary.cellsUnpriced + summary.cellsMissing;
  summary.complete = summary.failed === 0 && summary.cellsMissing === 0;
  summary.status = summary.complete
    ? (summary.modesDue === 0 ? "fresh" : "success")
    : "partial";
  return summary;
}

// CLI entry point -- only runs when this file is executed directly
// (`node src/flights.mjs`), not when imported by src/server.mjs.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const originGroupIds = process.env.FLIGHT_ORIGIN_GROUPS
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const summary = await runFlightRefresh({ originGroupIds });
    writeFileSync(".flight-summary.json", `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary));
    if (!summary.complete) process.exitCode = 2;
  } catch (error) {
    const summary = { status: "failed", complete: false, error: error.message };
    writeFileSync(".flight-summary.json", `${JSON.stringify(summary, null, 2)}\n`);
    console.error(error.message);
    process.exitCode = 1;
  }
}
