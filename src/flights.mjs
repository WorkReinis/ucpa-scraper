// node src/flights.mjs -> refresh round-trip flight quotes for upcoming weeks
//
// Google Flights via SerpApi. One search covers every airport combo at once --
// departure_id/arrival_id both take comma-separated lists -- so a refresh
// costs one search per distinct upcoming (start, end) week in the week
// calendar, ~25-40 for a full Nov-Apr season. Quotes land append-only in
// flight_price (src/db.mjs). The flight_search ledger keeps successful quotes
// fresh for six days, allows no more than two attempts per pair in that rolling
// window, and enforces a hard 225-search monthly ceiling.
//
// Needs SERPAPI_KEY in the environment -- free key at https://serpapi.com.

import { fileURLToPath } from "node:url";
import {
  open,
  insertFlightPrice,
  startFlightSearch,
  finishFlightSearch,
} from "./db.mjs";
import { writeDiagnostic } from "./diagnostics.mjs";
import { wholePrice } from "./validation.mjs";

// Origins are fixed (Amsterdam + Rotterdam); destinations are the
// fly-to-the-Alps-or-Pyrenees candidates from the user's side. Google prices
// the whole cross-product in one search and we keep whichever itinerary is
// cheapest -- adding a destination here costs nothing extra query-wise, since
// it remains one search. Transfer suitability is deliberately outside this
// flight-price model.
const ORIGIN_AIRPORTS = "AMS,RTM";
const DEST_AIRPORTS = "LYS,ZRH,GVA,TRN,TLS";

export const MONTHLY_SEARCH_LIMIT = 225;
export const FLIGHT_REFRESH_DAYS = 6;
export const MAX_ATTEMPTS_PER_PAIR_WINDOW = 2;
// Wide enough that a summer refresh still covers the whole Nov-Apr season
// (the current catalogue is only ~22 distinct weeks, so this cap is about
// not querying beyond Google's ~11-month booking horizon, not about quota).
const MONTHS_AHEAD = 10;
const DELAY_MS = 1200;  // pacing between searches, same manners as scrape.mjs

// Every current package starts on a Sunday. Flying in that same morning is
// a real risk for a ski trip (missed connection = missed check-in), so we
// quote a flight landing the day before instead -- outbound_date shifts back
// by this many days, return_date stays on the package's own end_date. Purely
// a constant offset on already-distinct dates, so it doesn't add searches:
// see the freshness key and the server.mjs join, both of which must apply
// the same offset to stay in sync with this.
const FLIGHT_DEPART_DAYS_BEFORE = 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function flightPolicy({ monthlyAttempts, recentAttempts, hasFreshQuote }) {
  if (hasFreshQuote) return "fresh_quote";
  if (monthlyAttempts >= MONTHLY_SEARCH_LIMIT) return "monthly_quota";
  if (recentAttempts >= MAX_ATTEMPTS_PER_PAIR_WINDOW) return "recent_attempts";
  return "search";
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** One round-trip search covering all airport combos; returns the row shape
 *  insertFlightPrice expects. price null = Google had nothing for the pair. */
async function searchFlights(outboundDate, returnDate, apiKey) {
  const params = new URLSearchParams({
    engine: "google_flights",
    departure_id: ORIGIN_AIRPORTS,
    arrival_id: DEST_AIRPORTS,
    type: "1", // round trip
    outbound_date: outboundDate,
    return_date: returnDate,
    currency: "EUR",
    hl: "en",
    api_key: apiKey,
  });
  const res = await fetch(`https://serpapi.com/search.json?${params}`);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status} from SerpApi`);

  try {
    return parseFlightResponse(j, { outboundDate, returnDate });
  } catch (error) {
    writeDiagnostic(
      `flights-${outboundDate}-${returnDate}-invalid-response`, j, "json", { secrets: [apiKey] }
    );
    throw error;
  }
}

export function parseFlightResponse(j, { outboundDate, returnDate }) {
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("invalid SerpApi response object");
  if (j.best_flights != null && !Array.isArray(j.best_flights)) throw new Error("best_flights is not an array");
  if (j.other_flights != null && !Array.isArray(j.other_flights)) throw new Error("other_flights is not an array");
  if (j.search_metadata?.status && j.search_metadata.status !== "Success") {
    throw new Error(`SerpApi search status is ${j.search_metadata.status}`);
  }
  const hasFlightArrays = Array.isArray(j.best_flights) || Array.isArray(j.other_flights);
  const identifiesEngine = j.search_parameters?.engine === "google_flights";
  if (!hasFlightArrays && !identifiesEngine) throw new Error("response is not recognizable Google Flights data");

  // For type=1 the price on each itinerary is already the round-trip total;
  // the departure_token follow-up only adds return-leg *details*, which we
  // don't store. flights[] is the outbound leg's segments.
  const rawItineraries = [...(j.best_flights ?? []), ...(j.other_flights ?? [])]
    .filter((it) => it.price != null);
  const itineraries = rawItineraries.filter((it) => {
    const legs = it.flights;
    return wholePrice(it.price) > 0 && Array.isArray(legs) && legs.length > 0 && legs.every((leg) =>
      leg?.departure_airport?.id && leg?.arrival_airport?.id && leg?.airline
    );
  });
  if (rawItineraries.length > 0 && itineraries.length === 0) {
    throw new Error("flight itineraries exist but do not match the expected schema");
  }

  const row = {
    origins: ORIGIN_AIRPORTS,
    dests: DEST_AIRPORTS,
    outbound_date: outboundDate,
    return_date: returnDate,
    price: null,
    dep_airport: null,
    arr_airport: null,
    airline: null,
    stops: null,
    duration_min: null,
    outbound_segments: [],
    details_scope: "outbound",
    price_level: j.price_insights?.price_level ?? null,
  };
  if (!itineraries.length) return row;

  const best = itineraries.reduce((a, b) => (b.price < a.price ? b : a));
  const legs = best.flights ?? [];
  const outboundSegments = legs.map((leg) => ({
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
    outbound_segments: outboundSegments,
  };
}

/**
 * Quote every distinct upcoming bookable week that doesn't already have a
 * fresh quote. Pass an already-open `db` to reuse a connection (the server
 * does this, same contract as runScrape). Returns a summary the frontend
 * shows verbatim.
 */
export async function runFlightRefresh({ db } = {}) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) throw new Error("SERPAPI_KEY is not set -- get a free key at serpapi.com");

  const _db = db ?? open();

  // Distinct weeks, not distinct products: every product sharing a
  // Sat-to-Sat window shares one quote, which is what keeps a whole-season
  // refresh inside the free tier.
  const pairs = _db.prepare(
    `SELECT DISTINCT start_date, end_date FROM v_week_current
     WHERE seats_left > 0 AND end_date IS NOT NULL
       AND start_date > date('now') AND start_date <= date('now', ?)
     ORDER BY start_date`
  ).all(`+${MONTHS_AHEAD} months`);

  const now = new Date();
  const refreshKey = now.toISOString().slice(0, 10);
  const billingMonth = now.toISOString().slice(0, 7);
  let monthlyAttempts = _db.prepare(
    "SELECT COUNT(*) n FROM flight_search WHERE billing_month = ?"
  ).get(billingMonth).n;
  const hasFreshQuote = _db.prepare(
    `SELECT 1 FROM flight_price
     WHERE outbound_date = ? AND return_date = ?
       AND date(fetched_at) > date('now', ?)
     LIMIT 1`
  );
  const recentAttempts = _db.prepare(
    `SELECT COUNT(*) n FROM flight_search
     WHERE outbound_date = ? AND return_date = ?
       AND date(attempted_at) > date('now', ?)`
  );
  const freshnessWindow = `-${FLIGHT_REFRESH_DAYS} days`;

  const summary = {
    pairs: pairs.length,
    searched: 0,
    skipped: 0,
    failed: 0,
    noResult: 0,
    quotaSkipped: 0,
    recentAttemptSkipped: 0,
    quotaLimit: MONTHLY_SEARCH_LIMIT,
    quotaUsed: monthlyAttempts,
    quotaRemaining: Math.max(MONTHLY_SEARCH_LIMIT - monthlyAttempts, 0),
  };
  for (const { start_date, end_date } of pairs) {
    const flightDate = addDays(start_date, -FLIGHT_DEPART_DAYS_BEFORE);
    const policy = flightPolicy({
      monthlyAttempts,
      recentAttempts: recentAttempts.get(flightDate, end_date, freshnessWindow).n,
      hasFreshQuote: Boolean(hasFreshQuote.get(flightDate, end_date, freshnessWindow)),
    });
    if (policy !== "search") {
      summary.skipped++;
      if (policy === "monthly_quota") summary.quotaSkipped++;
      if (policy === "recent_attempts") summary.recentAttemptSkipped++;
      continue;
    }
    const searchId = startFlightSearch(_db, {
      outboundDate: flightDate,
      returnDate: end_date,
      weekKey: refreshKey,
      billingMonth,
    });
    monthlyAttempts++;
    try {
      const row = await searchFlights(flightDate, end_date, apiKey);
      insertFlightPrice(_db, row);
      finishFlightSearch(_db, searchId, row.price == null ? "no_result" : "success");
      summary.searched++;
      if (row.price == null) summary.noResult++;
      console.log(
        `  ${flightDate} -> ${end_date} (package starts ${start_date}): ` +
        (row.price != null ? `€${row.price} ${row.dep_airport}->${row.arr_airport}` : "no flights found")
      );
    } catch (e) {
      finishFlightSearch(_db, searchId, "failed", e.message);
      summary.failed++;
      console.error(`  ! ${flightDate} -> ${end_date} failed:`, e.message);
      // Out of monthly quota fails every remaining pair identically -- stop
      // here and report a partial summary instead of a wall of errors.
      if (/run out of searches/i.test(e.message)) break;
    }
    await sleep(DELAY_MS);
  }
  summary.quotaUsed = monthlyAttempts;
  summary.quotaRemaining = Math.max(MONTHLY_SEARCH_LIMIT - monthlyAttempts, 0);
  return summary;
}

// CLI entry point -- only runs when this file is executed directly
// (`node src/flights.mjs`), not when imported by src/server.mjs.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = await runFlightRefresh();
  console.log(JSON.stringify(summary));
}
