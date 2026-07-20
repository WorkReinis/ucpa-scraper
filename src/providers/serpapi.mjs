// Google Flights via SerpApi -- the original provider, now the fallback.
// One search covers every airport combo at once (departure_id / arrival_id
// both take comma-separated lists). Free key at https://serpapi.com.

export async function search({ originIds, destIds, outboundDate, returnDate, apiKey }) {
  const params = new URLSearchParams({
    engine: "google_flights",
    departure_id: originIds,
    arrival_id: destIds,
    // Round trip (type 1) supplies the authoritative fare. A separate
    // one-way return search is used only to select a shuttle-compatible
    // return schedule; its price is not added to the round-trip total.
    type: returnDate ? "1" : "2",
    outbound_date: outboundDate,
    ...(returnDate ? { return_date: returnDate } : {}),
    currency: "EUR",
    hl: "en",
    api_key: apiKey,
  });
  const res = await fetch(`https://serpapi.com/search.json?${params}`);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status} from SerpApi`);
  return j;
}
