// Google Flights via the Apify actor marketplace. The actor's dataset item
// deliberately mirrors SerpApi's google_flights schema (best_flights /
// other_flights, legs with departure_airport.id / arrival_airport.id /
// airline), so src/flights.mjs parseFlightResponse consumes it unchanged.
// Known difference: price_insights is null, so flight_price.price_level
// stays null on Apify-served rows.
//
// One run covers the whole origins x dests matrix (~$0.03 flat regardless of
// matrix size, measured 2026-07). Keys rotate: each search screens every
// APIFY_KEY_* and spends from the account with the most free credit left.

import { screenAndPick } from "./apify-keys.mjs";

const API = "https://api.apify.com/v2";
export const ACTOR_ID = "johnvc~google-flights-data-scraper-flight-and-price-search";

// Stop before draining the pool to zero so manual screening/debugging always
// has a little headroom left to work with.
export const APIFY_RESERVE_USD = 0.25;

const POLL_MS = 3000;
const RUN_TIMEOUT_MS = 5 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function apifyApi(path, token, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) {
    const detail = json?.error?.message ?? text.slice(0, 200);
    throw new Error(`HTTP ${res.status} on ${path}: ${detail}`);
  }
  return json?.data ?? json;
}

/** Start the actor, poll to completion, return the run object + dataset items. */
export async function runApifyActor(token, input, { quiet = false } = {}) {
  const started = await apifyApi(`/acts/${ACTOR_ID}/runs`, token, {
    method: "POST",
    body: JSON.stringify(input),
  });
  const runId = started.id;
  if (!quiet) console.log(`  apify run ${runId} started -- polling...`);

  const TERMINAL = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);
  let run = started;
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (!TERMINAL.has(run.status)) {
    if (Date.now() > deadline) throw new Error(`apify run ${runId} still ${run.status} after ${RUN_TIMEOUT_MS / 60_000} min`);
    await sleep(POLL_MS);
    run = await apifyApi(`/actor-runs/${runId}`, token);
  }

  let items = [];
  if (run.defaultDatasetId) {
    items = await apifyApi(`/datasets/${run.defaultDatasetId}/items?format=json`, token) ?? [];
  }
  return { run, items };
}

/** Provider entry point: one round-trip search over the whole airport
 *  matrix, returning the SerpApi-shaped response object. Throws on any
 *  failure (no credit, run failed, empty dataset) so providers/index.mjs
 *  can fall back to SerpApi. Also returns the token used, so diagnostics
 *  can redact it. */
export async function search({ originIds, destIds, outboundDate, returnDate }, env = process.env) {
  const { fullest, pooled } = await screenAndPick(env);
  if (!fullest) throw new Error("no Apify account has remaining credit");
  if (pooled < APIFY_RESERVE_USD) {
    throw new Error(`Apify pooled credit $${pooled.toFixed(2)} below reserve $${APIFY_RESERVE_USD}`);
  }

  const input = {
    departure_id: originIds,
    arrival_id: destIds,
    outbound_date: outboundDate,
    // Omitted return_date = one-way in the actor's schema. Round-trip
    // searches provide the authoritative fare; the separate return one-way
    // is schedule/viability data only and is never added to that fare.
    ...(returnDate ? { return_date: returnDate } : {}),
    currency: "EUR",
    hl: "en",
    // Each resolved booking URL bills as a separate event and one search
    // returns 80-120 of them. We only need the cheapest price. Keep this off.
    fetch_booking_options: false,
    max_pages: 1,
  };
  const { run, items } = await runApifyActor(fullest.token, input, { quiet: true });
  if (run.status !== "SUCCEEDED") throw new Error(`apify run ${run.id} ended ${run.status}`);
  if (!items.length) throw new Error(`apify run ${run.id} produced no dataset items`);
  if (items.length > 1) console.warn(`  ! apify run ${run.id} returned ${items.length} dataset items, expected 1`);
  return { raw: items[0], token: fullest.token };
}
