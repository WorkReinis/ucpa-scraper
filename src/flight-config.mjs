// Search-shape settings shared by both providers and fingerprinted into the
// airport policy key. Changing either value intentionally invalidates cached
// quotes so the next refresh cannot mix materially different searches.
export const FLIGHT_SEARCH_MARKET = "nl";
export const MAX_FLIGHT_STOPS = 1;

// SerpApi encodes "one stop or fewer" as 2, while the Apify actor accepts
// the literal maximum number of stops.
export const SERPAPI_STOPS_FILTER = String(MAX_FLIGHT_STOPS + 1);
