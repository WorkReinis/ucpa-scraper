import { FLIGHT_SEARCH_MARKET, MAX_FLIGHT_STOPS } from "./flight-config.mjs";

// Shuttle-viability policy: a flight only counts if ground transport to the
// resort is still catchable. Rather than hand-picking a cutoff per airport,
// one scalar per (gateway, airport) -- the typical transfer duration to the
// gateway's farthest common resort -- maps through these shared bands.
// Tuning the policy = editing this table; adding an airport = one number.
// The last band is the user-set global floor: never assume a landing later
// than 21:00 works anywhere, never cut earlier than 18:30 anywhere.
export const TRANSFER_BANDS = [
  { maxHours: 1.5, latestArrival: "21:00", earliestReturnDeparture: "10:00" },
  { maxHours: 2.5, latestArrival: "20:00", earliestReturnDeparture: "11:00" },
  { maxHours: 3.5, latestArrival: "19:00", earliestReturnDeparture: "11:30" },
  { maxHours: Infinity, latestArrival: "18:30", earliestReturnDeparture: "12:30" },
];

// Airport groups are keyed by UCPA's own catalogue region (the
// `geographical_landscape` value src/listing.mjs stores as `product.region`),
// not by individual resort. A resort's gateway is whichever one of these
// three covers its region -- every resort in that region shares the exact
// same airport set, so a resort UCPA adds to a region already covered here
// (as Deux Alpes Venosc and Flaine les Lindars were, until this restructuring)
// is mapped automatically, with no per-resort research and no new gateway to
// invent. The tradeoff is precision: a gateway's numbers now have to work for
// the farthest resort anywhere in that whole region, not just one valley.
//
// transferHours: typical airport -> farthest-common-resort transfer time
// *within the region*, feeding TRANSFER_BANDS below. Where a region merges
// what used to be separate valley-level clusters, the number is the max of
// the old per-cluster values for that airport -- the more conservative
// (safer, earlier-cutoff) figure, since the airport now has to serve
// whichever resort in the region is actually farthest from it, not just the
// one valley it originally priced. Sources (2026-07): Altibus/Alpskibus GVA &
// LYS coach schedules (last GVA->Bourg-St-Maurice ~18:30, ~4h ride), Ben's Bus
// GNB/GVA/LYS Saturday services, GVA->Chamonix buses to ~20:35
// (FlixBus/easyBus), Linkbus TRN<->Serre Chevalier Saturday line, ZOU
// Marseille->Guillestre reserved shuttle (Queyras is reservation-only --
// noted, not overridden), liO 963 + SkiGo for Saint-Lary. Transfer service
// availability is deliberately assumed; only these time windows are applied.
// overrides: per-airport { latestArrival, earliestReturnDeparture } escape
// hatch for pairs the bands can't express. Empty at launch.
export const AIRPORT_GATEWAYS = [
  {
    id: "northern-alps",
    region: "Alpes du Nord",
    // Covers the Mont Blanc valley (Chamonix, Argentière, Les Contamines) and
    // the Tarentaise/Vanoise valley (Val d'Isère, Tignes, Val Thorens, Les
    // Arcs, La Plagne, Valloire, Pralognan, Flaine) as one group.
    //
    // ZRH was cut (2026-07): at 4.5h it was more than double any other
    // airport's transfer here, Zurich isn't on the established GVA/LYS
    // ski-shuttle network (Altibus, Ben's Bus, FlixBus/easyBus all run those
    // two, not ZRH), and it was the least-used gateway airport in the quote
    // history that existed at the time (11 of 446 quotes).
    //
    // CMF was cut (2026-07): 0 wins out of 893 stored northern-alps quotes.
    // GVA and LYS dominate (330/300 wins) and even GNB, the next-thinnest
    // airport, still won 77 times through the thinnest-gateway-airport
    // recovery pass -- but that same recovery pass, actively retrying CMF
    // whenever it was the most under-represented airport, never once found
    // it cheaper. Paying for a dedicated recovery search that has never paid
    // off isn't a hedge, it's a standing cost with no observed return.
    airports: ["GNB", "GVA", "LYS"],
    transferHours: { GNB: 2.25, GVA: 3.0, LYS: 3.0 },
    evidence: "https://www.valdisere.com/en/prepare-for-your-stay/how-do-i-get-there/",
  },
  {
    id: "southern-alps",
    region: "Alpes du Sud",
    // Covers Serre Chevalier, Queyras, and the Oisans valley (Deux Alpes).
    airports: ["GNB", "TRN", "MRS", "GVA", "LYS"],
    transferHours: { GNB: 2.5, TRN: 3.0, MRS: 3.25, GVA: 4.0, LYS: 4.0 },
    evidence: "https://www.serre-chevalier.com/en/resort/mobility-and-transport/plane",
  },
  {
    id: "pyrenees",
    region: "Pyrénées",
    // LDE was cut (2026-07): 0 wins out of 160 stored pyrenees quotes -- TLS
    // took every priced one. LDE is the airport actually closer to
    // Saint-Lary, so this is a price-only call, not a convenience one: a
    // traveller who values the shorter transfer over the fare may still do
    // better booking LDE directly than anything this scraper will ever show.
    airports: ["TLS"],
    transferHours: { TLS: 2.0 },
    evidence: "https://www.ucpa.com/destination/village-sportif/saint-lary-soulan",
  },
];

// Departure-side counterpart to AIRPORT_GATEWAYS: airports a traveller from
// each home base would realistically fly out of. All groups first go into one
// provider search (departure_id takes a comma-separated list); the response
// is partitioned back into per-group quotes. If Google omits a market from
// that flexible search, flights.mjs makes a narrower recovery request.
//
// LCY was cut (2026-07): 1 win out of 418 stored uk-origin quotes -- a
// business-oriented airport that's essentially never competitive on leisure
// fares, but was still occupying a slot in every flexible uk-origin search.
//
// The "ch" (Basel, single airport BSL) origin group was retired (2026-07):
// half of its 552 stored quotes came back with no viable fare at all (vs.
// ~0-1% for nl/uk), and the ones that did price were disproportionately
// expensive to reach -- Basel is thin enough a market that it routinely fell
// out of the broad flexible search and needed its own dedicated recovery
// search, origin-group by origin-group, mode by mode, every refresh cycle.
// Against a total spend budget sized for this app's ~1-month lifespan, that
// standing cost for one thin market was disproportionate. Also, unlike the
// other origins, Basel sits close enough to the Alps that the rail
// alternative may just be the better answer for that traveller anyway --
// this was a product call as much as a cost one. Raw historical quotes for
// "ch" remain in flight_price (append-only, nothing was deleted); a
// legacy-tier row can still surface through v_flight_current indefinitely
// (that fallback tier doesn't expire), so validation must recognize "ch" as
// retired rather than flag it forever -- see RETIRED_ORIGIN_GROUP_IDS below.
export const ORIGIN_GROUPS = [
  { id: "nl", label: "Netherlands", airports: ["AMS", "RTM"] },
  { id: "uk", label: "London", airports: ["LHR", "LGW", "LTN", "STN"] },
];
export const DEFAULT_ORIGIN_GROUP = "nl";

const BY_REGION = new Map(AIRPORT_GATEWAYS.map((gateway) => [gateway.region, gateway]));
const BY_ID = new Map(AIRPORT_GATEWAYS.map((gateway) => [gateway.id, gateway]));
const BY_ORIGIN_GROUP_ID = new Map(ORIGIN_GROUPS.map((group) => [group.id, group]));

// Gateway ids retired by this region-based restructuring (2026-07), mapped to
// whichever new gateway absorbed their airports. Not a live routing table --
// nothing here ever quotes a *new* flight against these ids, they only exist
// so gatewayById() (used to sanity-check stored flight_price rows) still
// recognizes a quote fetched under the old per-valley scheme, rather than
// flagging it "unknown gateway" forever. Each retired id's airports are a
// subset of the new gateway's, so validating them against the wider region
// set is strictly correct, just less exact than the cluster it was quoted
// under. Safe to delete once no flight_price row references these ids.
export const RETIRED_GATEWAY_IDS = {
  "mont-blanc": "northern-alps", // Argentière/Chamonix cluster, folded into the full Alpes du Nord region
  "serre-chevalier": "southern-alps",
  "queyras": "southern-alps",
};

// Origin groups cut outright (2026-07), with no absorbing replacement --
// unlike RETIRED_GATEWAY_IDS these can't remap to a wider set, they're just
// gone. validateOriginAssignments() (src/validate-airports.mjs) must treat a
// stored quote against one of these ids as expected historical data, not an
// "unknown origin group" failure -- otherwise every CI run fails forever on
// old rows we deliberately chose to keep rather than delete.
export const RETIRED_ORIGIN_GROUP_IDS = new Set(["ch"]); // Basel, single airport BSL

export const DEST_AIRPORTS = [...new Set(AIRPORT_GATEWAYS.flatMap((gateway) => gateway.airports))];
export const ORIGIN_AIRPORTS = ORIGIN_GROUPS.flatMap((group) => group.airports);
// Fingerprints origins, gateways, transfer durations, band policy, and any
// overrides: editing any of them invalidates the flight_search freshness
// ledger, so the next refresh automatically re-quotes with the new rules.
export const AIRPORT_CONFIG_KEY = [
  `search:roundtrip-v6:market=${FLIGHT_SEARCH_MARKET}:max-stops=${MAX_FLIGHT_STOPS}:same-day-arrival`,
  ORIGIN_GROUPS.map((group) => `${group.id}:${group.airports.join(",")}`).join(";"),
  ...AIRPORT_GATEWAYS.map((gateway) =>
    `${gateway.id}:${gateway.airports.map((a) => {
      const override = gateway.overrides?.[a];
      return `${a}=${gateway.transferHours[a]}${override ? `(${override.latestArrival}/${override.earliestReturnDeparture})` : ""}`;
    }).join(",")}`
  ),
  `bands:${TRANSFER_BANDS.map((b) => `${b.maxHours}<${b.latestArrival}>${b.earliestReturnDeparture}`).join(",")}`,
].join("|");

function windowFor(gatewayId, airportId) {
  const gateway = BY_ID.get(gatewayId);
  const hours = gateway?.transferHours?.[airportId];
  if (hours == null) {
    throw new Error(`No transfer duration for airport ${airportId} in gateway ${gatewayId}`);
  }
  const override = gateway.overrides?.[airportId];
  if (override) return override;
  return TRANSFER_BANDS.find((band) => hours <= band.maxHours);
}

/** Latest viable landing time ("HH:MM") for a flight into this gateway. */
export function latestArrivalFor(gatewayId, airportId) {
  return windowFor(gatewayId, airportId).latestArrival;
}

/** Earliest viable departure time ("HH:MM") for the flight home. */
export function earliestReturnDepartureFor(gatewayId, airportId) {
  return windowFor(gatewayId, airportId).earliestReturnDeparture;
}

/** A resort's gateway is entirely a function of its catalogue region --
 *  see the AIRPORT_GATEWAYS comment above for why. */
export function gatewayForRegion(region) {
  return BY_REGION.get(region) ?? null;
}

export function gatewayById(id) {
  return BY_ID.get(id) ?? BY_ID.get(RETIRED_GATEWAY_IDS[id]) ?? null;
}

export function originGroupById(id) {
  return BY_ORIGIN_GROUP_ID.get(id) ?? null;
}

export function gatewayCaseSql(column) {
  const clauses = AIRPORT_GATEWAYS.map((gateway) =>
    `WHEN '${gateway.region.replaceAll("'", "''")}' THEN '${gateway.id}'`
  );
  return `(CASE ${column} ${clauses.join(" ")} ELSE NULL END)`;
}

/** True when airportColumn is on gatewayColumn's *current* allowed list --
 *  the SQL twin of validateResortAirportAssignments' airport check. Lets a
 *  view accept an older-fingerprint quote as still policy-compliant (its
 *  config_key predates a tuning change, e.g. ZRH's cut, but its actual
 *  airport was never affected) without matching config_key byte-for-byte. */
export function gatewayAirportAllowedSql(gatewayColumn, airportColumn) {
  const clauses = AIRPORT_GATEWAYS.map((gateway) =>
    `WHEN '${gateway.id}' THEN (${airportColumn} IN (${gateway.airports.map((a) => `'${a}'`).join(",")}))`
  );
  return `(CASE ${gatewayColumn} ${clauses.join(" ")} ELSE 0 END)`;
}

/** Origin-side twin of gatewayAirportAllowedSql. */
export function originGroupAirportAllowedSql(originGroupColumn, airportColumn) {
  const clauses = ORIGIN_GROUPS.map((group) =>
    `WHEN '${group.id}' THEN (${airportColumn} IN (${group.airports.map((a) => `'${a}'`).join(",")}))`
  );
  return `(CASE ${originGroupColumn} ${clauses.join(" ")} ELSE 0 END)`;
}

/** Departure-side twin of validateResortAirportAssignments: a quote's
 *  outbound must depart from -- and its return must land at -- an airport
 *  inside its own origin group, or a UK fare has bled into an NL cell. */
export function validateOriginAssignments(quotes = []) {
  const issues = [];
  for (const quote of quotes) {
    if (RETIRED_ORIGIN_GROUP_IDS.has(quote.origin_group)) continue;
    const group = originGroupById(quote.origin_group);
    if (!group) {
      issues.push(`unknown origin group: ${quote.origin_group ?? "missing"}`);
      continue;
    }
    if (quote.dep_airport && !group.airports.includes(quote.dep_airport)) {
      issues.push(`${quote.origin_group}: ${quote.dep_airport} is not allowed (${group.airports.join(",")})`);
    }
    if (quote.return_arr_airport && !group.airports.includes(quote.return_arr_airport)) {
      issues.push(`${quote.origin_group}: return lands at ${quote.return_arr_airport}, not allowed (${group.airports.join(",")})`);
    }
  }
  return issues;
}

/** Returns { issues, warnings }. `resortRegions` is an array of
 *  { resort, region } -- the resort name is only for readable messages, the
 *  region is what actually decides the gateway. A region nobody has covered
 *  yet is a warning, not an issue: runFlightRefresh() skips its weeks and no
 *  quote can be attached to it, so the catalogue is incomplete rather than
 *  wrong. A quote pointing at the wrong gateway or an airport outside it is
 *  the real failure -- that one is a mis-assignment, and stays an issue. */
export function validateResortAirportAssignments(resortRegions, quotes = []) {
  const issues = [];
  const warnings = [];
  for (const { resort, region } of resortRegions) {
    if (!gatewayForRegion(region)) warnings.push(`unmapped region (no flight quotes): ${resort} [${region}]`);
  }
  for (const quote of quotes) {
    const gateway = gatewayForRegion(quote.region);
    if (!gateway) continue;
    if (quote.gateway !== gateway.id) {
      // Structurally guaranteed by the catalog.mjs join (a quote only ever
      // reaches a resort's flight_quotes when its own gateway equals that
      // resort's region-implied one) -- this firing at all would mean the
      // join itself is broken, not a stale-policy artifact, so it's always
      // a hard issue regardless of config_key.
      issues.push(`${quote.resort}: quote gateway ${quote.gateway ?? "missing"} should be ${gateway.id}`);
    }
    // An airport dropped from a gateway (as ZRH was) or a gateway merged
    // into a wider one leaves airports on old, already-fetched quotes that
    // no longer fit the *current* definition. That's expected of a fallback
    // still on display only because quota hasn't allowed a fresh requote --
    // a warning, not a failure. A quote fetched under today's policy failing
    // its own gateway's airport list would be a real bug, so that stays an issue.
    const report = (message) => (quote.config_key === AIRPORT_CONFIG_KEY ? issues : warnings).push(message);
    if (quote.arr_airport && !gateway.airports.includes(quote.arr_airport)) {
      report(`${quote.resort}: ${quote.arr_airport} is not allowed (${gateway.airports.join(",")})`);
    }
    if (quote.return_dep_airport && !gateway.airports.includes(quote.return_dep_airport)) {
      report(`${quote.resort}: return departs ${quote.return_dep_airport}, not allowed (${gateway.airports.join(",")})`);
    }
  }
  return { issues, warnings };
}
