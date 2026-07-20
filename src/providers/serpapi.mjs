// Google Flights via SerpApi -- the original provider, now the fallback.
// One search covers every airport combo at once (departure_id / arrival_id
// both take comma-separated lists). Free key at https://serpapi.com.

import { FLIGHT_SEARCH_MARKET, SERPAPI_STOPS_FILTER } from "../flight-config.mjs";

export function buildSerpApiParams({
  originIds, destIds, outboundDate, returnDate, apiKey, exhaustive = false,
}) {
  return new URLSearchParams({
    engine: "google_flights",
    departure_id: originIds,
    arrival_id: destIds,
    // Production pricing uses two one-way searches so the displayed
    // outbound, return, and additive fare always describe the same two
    // separately bookable tickets. Round-trip remains supported here for
    // diagnostics and a future departure_token-capable pipeline.
    type: returnDate ? "1" : "2",
    outbound_date: outboundDate,
    ...(returnDate ? { return_date: returnDate } : {}),
    currency: "EUR",
    hl: "en",
    gl: FLIGHT_SEARCH_MARKET,
    stops: SERPAPI_STOPS_FILTER,
    ...(exhaustive ? { show_hidden: "true", deep_search: "true", sort_by: "2" } : {}),
    api_key: apiKey,
  });
}

export async function search({
  originIds, destIds, outboundDate, returnDate, apiKey, exhaustive = false,
}) {
  const params = buildSerpApiParams({
    originIds, destIds, outboundDate, returnDate, apiKey, exhaustive,
  });
  const res = await fetch(`https://serpapi.com/search.json?${params}`);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status} from SerpApi`);
  return j;
}
