// node src/flights.mjs -> refresh flight quotes for upcoming weeks
//
// Google Flights via the provider seam in src/providers/ (Apify actor
// primary, SerpApi fallback). Every displayed itinerary is priced as two
// separately bookable one-way tickets: one outbound search per arrival mode
// plus one shared return search per (start, end) pair. This is intentional:
// the Apify actor exposes departure_token but cannot consume it, so attaching
// an independently selected return to its round-trip fare would be false.
// Searches include only gateways used by that date pair; a missing origin x
// gateway cell gets one exact narrow retry.
//
// Shuttle viability: itineraries are filtered by the transfer windows in
// src/airports.mjs (TRANSFER_BANDS) -- outbound flights must land before
// the gateway airport's latest-arrival time, return flights must depart
// after its earliest-departure time. Transfer-service availability is assumed;
// the policy deliberately checks time windows only. The stored flight price is
// the sum of the chosen outbound and return one-way fares.
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
  earliestReturnDepartureFor, gatewayById, gatewayForRegion, latestArrivalFor, originGroupById,
} from "./airports.mjs";
import {
  searchWithProvider as providerSearchWithProvider, configuredProviders,
} from "./providers/index.mjs";
import { MAX_FLIGHT_STOPS } from "./flight-config.mjs";

export const MONTHLY_SEARCH_LIMIT = 225; // SerpApi free-tier ceiling
export const FLIGHT_REFRESH_DAYS = 6;
// Return rows now contribute to the displayed price, so they must be no older
// than the outbound fare they are combined with.
export const RETURN_SCHEDULE_REFRESH_DAYS = FLIGHT_REFRESH_DAYS;
export const MAX_ATTEMPTS_PER_PAIR_WINDOW = 2;
// Wide enough that a summer refresh still covers the whole Nov-Apr season
// (the current catalogue is only ~22 distinct weeks, so this cap is about
// not querying beyond Google's ~11-month booking horizon, not about quota).
export const FLIGHT_MONTHS_AHEAD = 10;
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
  // Only SerpApi has a real monthly ceiling to gate on -- Apify's is live
  // account credit, checked at call time, not a count agreed in advance.
  if (provider !== "apify" && monthlyAttempts >= MONTHLY_SEARCH_LIMIT) return "monthly_quota";
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

function calendarDate(value) {
  const match = /^(\d{4}-\d{2}-\d{2})\b/.exec(value ?? "");
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

  // A flight sold for Saturday that lands on Sunday cannot serve the early
  // arrival mode, even if its arrival clock time is before the shuttle
  // cutoff. Return flights may land home the following day, but must still
  // leave the resort gateway on the searched return date.
  const sameTravelDay = cellItineraries.filter((it) => {
    const legs = it.flights;
    const relevant = direction === "return"
      ? [legs[0]?.departure_airport?.time]
      : [legs[0]?.departure_airport?.time, legs.at(-1)?.arrival_airport?.time];
    return relevant.every((value) => {
      const date = calendarDate(value);
      return date == null || date === outboundDate;
    });
  });
  const practical = sameTravelDay.filter((it) => it.flights.length - 1 <= MAX_FLIGHT_STOPS);

  // Shuttle-viability window (src/airports.mjs TRANSFER_BANDS). Skipped for
  // the legacy gateway sentinel, which has no transfer config.
  const viable = gateway === "legacy" ? practical : practical.filter((it) => {
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
    date_dropped: cellItineraries.length - sameTravelDay.length,
    stops_dropped: sameTravelDay.length - practical.length,
    window_dropped: practical.length - viable.length,
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

/** Combine a viable outbound and return. Production uses `separate`: both
 * halves came from one-way searches, their prices are added, and the UI can
 * truthfully identify the result as two bookings. `roundtrip` remains only
 * for validated legacy/imported rows whose return was selected through the
 * same fare token. */
export function combineDirections(outbound, ret, { pricingMode = "separate" } = {}) {
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
    candidate_count: outbound.candidate_count,
    window_dropped: outbound.window_dropped,
    date_dropped: outbound.date_dropped,
    stops_dropped: outbound.stops_dropped,
    return_candidate_count: ret.candidate_count,
    return_window_dropped: ret.window_dropped,
    return_date_dropped: ret.date_dropped,
    return_stops_dropped: ret.stops_dropped,
  };
}

/** A broad flexible-airport response is not authoritative when it produces
 * no viable price for a cell. It may have omitted later/more expensive
 * options, so that exact origin-group/gateway pair earns one deeper retry. */
export function cellNeedsTargetedRetry(cell) {
  return cell?.price == null;
}

/** A cell can look "covered" (non-null price) while still hiding real, cheap
 * service: Google's flexible multi-airport search caps its response at
 * roughly 60-65 itineraries, and one dominant gateway airport (Geneva, in
 * measurements taken 2026-07) can consume nearly all of that cap, leaving a
 * second real gateway airport (Grenoble, Chambery) with 0-1 raw itineraries
 * even though genuine, bookable, often-cheaper flights exist there --
 * confirmed live: an isolated search with Geneva/Lyon removed from
 * competition surfaced GBP120-260 EasyJet/Ryanair/Jet2 fares from London
 * airports into Grenoble/Chambery that the broad search never returned at
 * all. cellNeedsTargetedRetry can't see this, since the cell as a whole
 * isn't empty.
 *
 * Returns at most ONE airport -- the single most under-represented one, if
 * it falls below `minCandidates` -- not every thin airport. Deliberately
 * bounded to one extra search per cell, the same "one exact narrow retry"
 * cost as the whole-cell-empty case above: an unbounded per-airport version
 * fires on nearly every airport in a gateway whenever the broad response
 * happens to be sparse (routine for smaller gateways like Pyrenees, which
 * has only two airports to begin with), turning a targeted fix into an
 * unbounded, permanently-recurring one on every future refresh. */
export function thinnestGatewayAirport(raw, { gateway, originGroup, direction, minCandidates = 2 }) {
  if (gateway.airports.length < 2) return null; // nothing else in this gateway to be crowded out by
  const rawItineraries = [...(raw?.best_flights ?? []), ...(raw?.other_flights ?? [])]
    .filter((it) => it?.price != null && Array.isArray(it.flights) && it.flights.length > 0);
  const groupSet = new Set(originGroup.airports);
  const gatewayAirportOf = (it) => direction === "return"
    ? it.flights[0]?.departure_airport?.id
    : it.flights.at(-1)?.arrival_airport?.id;
  const originAirportOf = (it) => direction === "return"
    ? it.flights.at(-1)?.arrival_airport?.id
    : it.flights[0]?.departure_airport?.id;
  const countFor = (airport) => rawItineraries.filter((it) =>
    gatewayAirportOf(it) === airport && groupSet.has(originAirportOf(it))
  ).length;
  const counted = gateway.airports.map((airport) => ({ airport, count: countFor(airport) }));
  const thinnest = counted.reduce((a, b) => (b.count < a.count ? b : a));
  return thinnest.count < minCandidates ? thinnest.airport : null;
}

/** Origin groups for which a broad provider response contained no raw
 * itinerary for at least one required gateway. This reports raw matrix
 * coverage only; cellNeedsTargetedRetry also handles candidates rejected by
 * feasibility filters. */
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
  searchProvider,
  delay = sleep,
  // On by default: an already-covered cell can still be skewed toward one
  // dominant gateway airport (see thinnestGatewayAirport). Exposed so a test
  // exercising something else entirely can use a minimal, single-itinerary
  // fixture without also tripping this separate check.
  checkThinAirports = true,
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
  const dispatchSearch = searchProvider
    ? (provider, options) => searchProvider(options, provider)
    : (provider, options) => providerSearchWithProvider(provider, options);

  const _db = db ?? open();

  const pairRows = _db.prepare(
    `SELECT DISTINCT w.start_date, w.end_date, p.resort, p.region
     FROM v_week_current w JOIN product p ON p.code = w.code
     WHERE w.seats_left > 0 AND w.end_date IS NOT NULL
       AND w.start_date > date('now') AND w.start_date <= date('now', ?)
     ORDER BY w.start_date`
  ).all(`+${FLIGHT_MONTHS_AHEAD} months`);
  const pairMap = new Map();
  const unmappedResorts = new Set();
  for (const row of pairRows) {
    const gateway = gatewayForRegion(row.region);
    // A region UCPA added, or renamed, that nobody has mapped to a gateway
    // yet must not cost every other resort its quotes -- this used to throw
    // and abort the whole refresh. Skipping leaves that resort's weeks
    // unquoted (the UI already renders an unquoted week), and
    // validate-airports.mjs still reports it as an unmapped region.
    if (!gateway) {
      if (!unmappedResorts.has(row.resort)) {
        unmappedResorts.add(row.resort);
        console.warn(`  ! no airport gateway for region, skipping its weeks: ${row.resort} [${row.region}]`);
      }
      continue;
    }
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
  // SerpApi usage can also happen outside this database. Once its own API
  // explicitly reports exhaustion, remember that fact for the billing month
  // instead of repeatedly retrying it or advertising fictitious quota.
  const serpApiExhausted = _db.prepare(
    `SELECT 1 FROM flight_search
     WHERE billing_month = ? AND provider = 'serpapi' AND status = 'failed'
       AND lower(COALESCE(error, '')) LIKE '%run out of searches%'
     LIMIT 1`
  ).get(billingMonth);
  if (serpApiExhausted && Object.hasOwn(monthlyAttempts, "serpapi")) {
    monthlyAttempts.serpapi = MONTHLY_SEARCH_LIMIT;
  }
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
       AND config_key = ? AND direction = ?
       AND provider = ?
       AND status IN ('started', 'failed')
       AND date(attempted_at) > date('now', ?)`
  );
  const freshnessWindow = `-${FLIGHT_REFRESH_DAYS} days`;
  const returnFreshnessWindow = `-${RETURN_SCHEDULE_REFRESH_DAYS} days`;

  // Infinity for apify (no self-imposed ceiling) is correct for the gating
  // comparisons below, but a bare Infinity is the wrong thing to put in any
  // written/reported field: JSON.stringify silently turns it into `null`,
  // which means an in-memory Infinity and a freshly-parsed-from-disk null
  // look identical when printed but are NOT `===` or deepEqual -- exactly
  // what verify:static caught by re-computing this live and comparing
  // objects directly, not stringified ones. reportedLimit/reportedRemaining
  // make that `null` explicit up front instead of relying on the coercion.
  const quotaLimitFor = (provider) => provider === "apify" ? Infinity : MONTHLY_SEARCH_LIMIT;
  const reportedLimit = (limit) => Number.isFinite(limit) ? limit : null;
  const reportedRemaining = (limit, used) => Number.isFinite(limit) ? Math.max(limit - used, 0) : null;

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
    quotaLimit: reportedLimit(quotaLimitFor(primaryProvider)),
    quotaUsed: monthlyAttempts[primaryProvider],
    quotaExhausted: false,
    providerAttempts: 0,
    providerAttemptFailures: 0,
    providerFallbacks: 0,
    errors: [],
  };

  const providerWithQuota = () => providers.find(
    (provider) => monthlyAttempts[provider] < quotaLimitFor(provider)
  );

  const runSearch = async ({
    originIds, destIds, outboundDate, returnDate, direction, arrivalMode, scope = "broad",
  }) => {
    let lastError;
    let failedProviders = 0;
    let unavailableProviders = 0;
    for (const provider of providers) {
      const quotaLimit = quotaLimitFor(provider);
      if (monthlyAttempts[provider] >= quotaLimit) {
        summary.quotaSkipped++;
        unavailableProviders++;
        continue;
      }
      const searchId = startFlightSearch(_db, {
        outboundDate,
        returnDate,
        weekKey: refreshKey,
        billingMonth,
        configKey: AIRPORT_CONFIG_KEY,
        arrivalMode,
        provider,
        direction,
      });
      monthlyAttempts[provider]++;
      summary.providerAttempts++;
      try {
        const { raw, provider: usedProvider = provider, secrets = [] } = await dispatchSearch(provider, {
          originIds,
          destIds,
          outboundDate,
          // Both directions are one-way. Combining their prices is the only
          // truthful fallback for providers that cannot follow Google's
          // departure_token to retrieve returns belonging to a round trip.
          returnDate: undefined,
          exhaustive: scope === "targeted",
        });
        if (usedProvider !== provider) {
          throw new Error(`provider dispatcher returned ${usedProvider} while accounting ${provider}`);
        }
        if (failedProviders) summary.providerFallbacks++;
        summary.searched++;
        if (scope === "targeted") summary.targetedRetries++;
        else summary.broadSearches++;
        return { searchId, raw, usedProvider, secrets };
      } catch (error) {
        finishFlightSearch(_db, searchId, "failed", error.message);
        summary.providerAttemptFailures++;
        failedProviders++;
        lastError = error;
        if (/run out of searches|below reserve|no .* has remaining credit/i.test(error.message)) {
          unavailableProviders++;
        }
        console.error(`  ! provider ${provider} failed:`, error.message);
      }
    }
    summary.failed++;
    if (!lastError) {
      lastError = new Error("run out of searches: every configured provider reached its monthly quota");
    }
    // Only stop the whole refresh when every configured provider is actually
    // out of usable quota. A transient primary-provider failure followed by
    // an exhausted fallback must not discard the remaining season.
    if (unavailableProviders === providers.length) summary.quotaExhausted = true;
    summary.errors.push(lastError.message);
    throw lastError;
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
      const availableProvider = providerWithQuota();
      const policy = flightPolicy({
        monthlyAttempts: availableProvider ? monthlyAttempts[availableProvider] : Number.MAX_SAFE_INTEGER,
        recentAttempts: recentAttempts.get(
          flightDate, end_date, AIRPORT_CONFIG_KEY, "outbound", primaryProvider, freshnessWindow
        ).n,
        hasFreshQuote,
        provider: availableProvider ?? primaryProvider,
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
    // flexible search, not a Cartesian API. If an exact cell has no viable
    // fare—whether omitted entirely or because every returned candidate was
    // rejected—retry that cell once with deeper provider results. The same
    // date/stop/transfer filters are applied again; this never widens policy.
    // `broadRaw` is the same broad response `cells` was parsed from -- passed
    // through so the second pass below can also inspect it per airport.
    const recoverMissingCoverage = async (cells, broadRaw, {
      direction, outboundDate, returnDate, arrivalMode,
    }) => {
      const covered = new Map(cells);
      for (const originGroup of targetOriginGroups) {
        for (const gateway of gateways) {
          const cellKey = `${originGroup.id}|${gateway.id}`;
          const previousCell = covered.get(cellKey);
          if (!cellNeedsTargetedRetry(previousCell)) continue;
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
            const reason = (previousCell?.candidate_count ?? 0) === 0
              ? "missing broad coverage"
              : "no broad candidate fit policy";
            console.log(
              `    retried ${originGroup.id}/${gateway.id} ${direction} via ${recoverySearch.usedProvider} (${reason})`
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

      // Second pass: a cell that IS covered can still be quietly skewed
      // toward one dominant gateway airport (see thinnestGatewayAirport) --
      // check only cells that survived the pass above, so a fully empty
      // cell never pays for both retries. At most one narrow single-airport
      // search per cell, for whichever gateway airport is most under-
      // represented -- either recovers a real, cheaper fare the broad
      // search dropped, or -- if that airport genuinely has no service for
      // this origin group -- confirms that cheaply, the same bounded cost
      // as the whole-cell-empty case above.
      for (const originGroup of checkThinAirports ? targetOriginGroups : []) {
        for (const gateway of gateways) {
          const cellKey = `${originGroup.id}|${gateway.id}`;
          const cell = covered.get(cellKey);
          if (cellNeedsTargetedRetry(cell)) continue;
          const airport = thinnestGatewayAirport(broadRaw, { gateway, originGroup, direction });
          if (!airport) continue;
          let recoverySearch;
          try {
            recoverySearch = await runSearch({
              originIds: direction === "return" ? airport : originGroup.airports.join(","),
              destIds: direction === "return" ? originGroup.airports.join(",") : airport,
              outboundDate,
              returnDate,
              direction,
              arrivalMode,
              scope: "targeted",
            });
            const narrowCell = parseFlightResponse(recoverySearch.raw, {
              outboundDate, returnDate, direction, secrets: recoverySearch.secrets,
              gateway: gateway.id, dests: [airport],
              originGroup: originGroup.id, originAirports: originGroup.airports,
            });
            finishFlightSearch(
              _db, recoverySearch.searchId, narrowCell.price != null ? "success" : "no_result"
            );
            summary.recoverySearches++;
            const current = covered.get(cellKey);
            const better = narrowCell.price != null && (current.price == null || narrowCell.price < current.price);
            if (better) covered.set(cellKey, narrowCell);
            console.log(
              `    retried ${originGroup.id}/${gateway.id} ${direction} via ${recoverySearch.usedProvider} ` +
              `for thin airport ${airport} (most under-represented in the broad response) -- ` +
              (narrowCell.price != null
                ? `found €${narrowCell.price}${better ? ", replacing" : ", kept existing"} €${current.price ?? "null"}`
                : "nothing viable there")
            );
          } catch (error) {
            if (recoverySearch) {
              finishFlightSearch(_db, recoverySearch.searchId, "failed", error.message);
              summary.failed++;
              summary.errors.push(error.message);
            }
            throw new Error(
              `${originGroup.id}/${gateway.id} ${direction} thin-airport (${airport}) retry failed: ${error.message}`
            );
          }
          await delay(DELAY_MS);
        }
      }
      return covered;
    };

    // A return fare/schedule is shared by both arrival modes. Null-price rows
    // are cached too: broad and focused searches both found no return inside
    // the configured transfer window.
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
      const failedReturnAttempts = recentAttempts.get(
        end_date, end_date, AIRPORT_CONFIG_KEY, "return", primaryProvider, freshnessWindow
      ).n;
      if (failedReturnAttempts >= MAX_ATTEMPTS_PER_PAIR_WINDOW) {
        summary.recentAttemptSkipped++;
        summary.skipped++;
        console.warn(
          `  ! ${end_date} return leg skipped after ${failedReturnAttempts} recent failed provider attempts`
        );
        continue;
      }
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
        returnCells = await recoverMissingCoverage(returnCells, returnSearch.raw, {
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
        if (summary.quotaExhausted) break outer;
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
        outboundCells = await recoverMissingCoverage(outboundCells, outboundSearch.raw, {
          outboundDate: mode.flightDate, returnDate: end_date,
          direction: "outbound", arrivalMode: mode.id,
        });
        const rows = [];
        for (const [cellKey, outboundCell] of outboundCells) {
          rows.push({
            combined: combineDirections(outboundCell, returnCells.get(cellKey), {
              pricingMode: "separate",
            }),
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
                `${combined.origin_group}/${combined.gateway}=€${combined.price} separate tickets ` +
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
        if (summary.quotaExhausted) break outer;
      }
      await delay(DELAY_MS);
    }
  }
  summary.quotaUsed = monthlyAttempts[primaryProvider];
  summary.quotaRemaining = reportedRemaining(quotaLimitFor(primaryProvider), summary.quotaUsed);
  summary.quotaByProvider = Object.fromEntries(providers.map((provider) => [provider, {
    used: monthlyAttempts[provider],
    limit: reportedLimit(quotaLimitFor(provider)),
    remaining: reportedRemaining(quotaLimitFor(provider), monthlyAttempts[provider]),
  }]));
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
