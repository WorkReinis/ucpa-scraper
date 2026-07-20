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

// Airport groups are tied to realistic ground-transfer routes, not merely
// geographic distance. A quote may only be attached to a resort when its
// final arrival airport belongs to that resort's validated gateway.
//
// transferHours: typical airport -> farthest-common-resort transfer time,
// feeding TRANSFER_BANDS. Sources (2026-07): Altibus/Alpskibus GVA & LYS
// coach schedules (last GVA->Bourg-St-Maurice ~18:30, ~4h ride), Ben's Bus
// GNB/GVA/LYS Saturday services, GVA->Chamonix buses to ~20:35
// (FlixBus/easyBus), Linkbus TRN<->Serre Chevalier Saturday line, ZOU
// Marseille->Guillestre reserved shuttle (Queyras is reservation-only --
// noted, not overridden), liO 963 + SkiGo for Saint-Lary. Transfer service
// availability is deliberately assumed; only these time windows are applied.
// overrides: per-airport { latestArrival, earliestReturnDeparture } escape
// hatch for pairs the bands can't express. Empty at launch.
export const AIRPORT_GATEWAYS = [
  {
    id: "mont-blanc",
    airports: ["GVA", "LYS"],
    transferHours: { GVA: 1.25, LYS: 2.5 },
    resorts: ["Argentière", "Chamonix"],
    evidence: "https://www.ucpa.com/destination/village-sportif/argentiere-vallee-de-chamonix",
  },
  {
    id: "northern-alps",
    airports: ["CMF", "GNB", "GVA", "LYS", "ZRH"],
    transferHours: { CMF: 2.0, GNB: 2.25, GVA: 3.0, LYS: 3.0, ZRH: 4.5 },
    resorts: ["Les Arcs Portes de la Vanoise", "Tignes", "Val Thorens", "Val d'Isère", "Valloire"],
    evidence: "https://www.valdisere.com/en/prepare-for-your-stay/how-do-i-get-there/",
  },
  {
    id: "serre-chevalier",
    airports: ["TRN", "GNB", "GVA", "LYS"],
    transferHours: { TRN: 2.0, GNB: 2.5, GVA: 4.0, LYS: 3.75 },
    resorts: ["Grand Serre Chevalier"],
    evidence: "https://www.serre-chevalier.com/en/resort/mobility-and-transport/plane",
  },
  {
    id: "queyras",
    airports: ["MRS", "TRN", "LYS"],
    transferHours: { MRS: 3.25, TRN: 3.0, LYS: 4.0 },
    resorts: ["Queyras"],
    evidence: "https://www.queyras-locations.fr/en/access-queyras",
  },
  {
    id: "pyrenees",
    airports: ["LDE", "TLS"],
    transferHours: { LDE: 1.25, TLS: 2.0 },
    resorts: ["Saint-Lary Soulan"],
    evidence: "https://www.ucpa.com/destination/village-sportif/saint-lary-soulan",
  },
];

// Departure-side counterpart to AIRPORT_GATEWAYS: airports a traveller from
// each home base would realistically fly out of. All groups first go into one
// provider search (departure_id takes a comma-separated list); the response
// is partitioned back into per-group quotes. If Google omits a market from
// that flexible search, flights.mjs makes a narrower recovery request.
export const ORIGIN_GROUPS = [
  { id: "nl", label: "Netherlands", airports: ["AMS", "RTM"] },
  { id: "uk", label: "London", airports: ["LHR", "LGW", "LTN", "STN", "LCY"] },
  { id: "ch", label: "Basel", airports: ["BSL"] },
];
export const DEFAULT_ORIGIN_GROUP = "nl";

const BY_RESORT = new Map(
  AIRPORT_GATEWAYS.flatMap((gateway) => gateway.resorts.map((resort) => [resort, gateway]))
);
const BY_ID = new Map(AIRPORT_GATEWAYS.map((gateway) => [gateway.id, gateway]));
const BY_ORIGIN_GROUP_ID = new Map(ORIGIN_GROUPS.map((group) => [group.id, group]));

export const DEST_AIRPORTS = [...new Set(AIRPORT_GATEWAYS.flatMap((gateway) => gateway.airports))];
export const ORIGIN_AIRPORTS = ORIGIN_GROUPS.flatMap((group) => group.airports);
// Fingerprints origins, gateways, transfer durations, band policy, and any
// overrides: editing any of them invalidates the flight_search freshness
// ledger, so the next refresh automatically re-quotes with the new rules.
export const AIRPORT_CONFIG_KEY = [
  `search:separate-one-way-pair-v5:market=${FLIGHT_SEARCH_MARKET}:max-stops=${MAX_FLIGHT_STOPS}:same-day-arrival`,
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

export function gatewayForResort(resort) {
  return BY_RESORT.get(resort) ?? null;
}

export function gatewayById(id) {
  return BY_ID.get(id) ?? null;
}

export function originGroupById(id) {
  return BY_ORIGIN_GROUP_ID.get(id) ?? null;
}

export function gatewayCaseSql(column) {
  const clauses = AIRPORT_GATEWAYS.flatMap((gateway) => gateway.resorts.map((resort) =>
    `WHEN '${resort.replaceAll("'", "''")}' THEN '${gateway.id}'`
  ));
  return `(CASE ${column} ${clauses.join(" ")} ELSE NULL END)`;
}

/** Departure-side twin of validateResortAirportAssignments: a quote's
 *  outbound must depart from -- and its return must land at -- an airport
 *  inside its own origin group, or a UK fare has bled into an NL cell. */
export function validateOriginAssignments(quotes = []) {
  const issues = [];
  for (const quote of quotes) {
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

export function validateResortAirportAssignments(resorts, quotes = []) {
  const issues = [];
  for (const resort of resorts) {
    if (!gatewayForResort(resort)) issues.push(`unmapped resort: ${resort}`);
  }
  for (const quote of quotes) {
    const gateway = gatewayForResort(quote.resort);
    if (!gateway) continue;
    if (quote.gateway !== gateway.id) {
      issues.push(`${quote.resort}: quote gateway ${quote.gateway ?? "missing"} should be ${gateway.id}`);
    }
    if (quote.arr_airport && !gateway.airports.includes(quote.arr_airport)) {
      issues.push(`${quote.resort}: ${quote.arr_airport} is not allowed (${gateway.airports.join(",")})`);
    }
    if (quote.return_dep_airport && !gateway.airports.includes(quote.return_dep_airport)) {
      issues.push(`${quote.resort}: return departs ${quote.return_dep_airport}, not allowed (${gateway.airports.join(",")})`);
    }
  }
  return issues;
}
