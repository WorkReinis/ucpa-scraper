// Airport groups are tied to realistic ground-transfer routes, not merely
// geographic distance. A quote may only be attached to a resort when its
// final arrival airport belongs to that resort's validated gateway.
export const AIRPORT_GATEWAYS = [
  {
    id: "mont-blanc",
    airports: ["GVA", "LYS"],
    resorts: ["Argentière", "Chamonix"],
    evidence: "https://www.ucpa.com/destination/village-sportif/argentiere-vallee-de-chamonix",
  },
  {
    id: "northern-alps",
    airports: ["CMF", "GNB", "GVA", "LYS", "ZRH"],
    resorts: ["Les Arcs Portes de la Vanoise", "Tignes", "Val Thorens", "Val d'Isère", "Valloire"],
    evidence: "https://www.valdisere.com/en/prepare-for-your-stay/how-do-i-get-there/",
  },
  {
    id: "serre-chevalier",
    airports: ["TRN", "GNB", "GVA", "LYS"],
    resorts: ["Grand Serre Chevalier"],
    evidence: "https://www.serre-chevalier.com/en/resort/mobility-and-transport/plane",
  },
  {
    id: "queyras",
    airports: ["MRS", "TRN", "LYS"],
    resorts: ["Queyras"],
    evidence: "https://www.queyras-locations.fr/en/access-queyras",
  },
  {
    id: "pyrenees",
    airports: ["LDE", "TLS"],
    resorts: ["Saint-Lary Soulan"],
    evidence: "https://www.ucpa.com/destination/village-sportif/saint-lary-soulan",
  },
];

const BY_RESORT = new Map(
  AIRPORT_GATEWAYS.flatMap((gateway) => gateway.resorts.map((resort) => [resort, gateway]))
);
const BY_ID = new Map(AIRPORT_GATEWAYS.map((gateway) => [gateway.id, gateway]));

export const DEST_AIRPORTS = [...new Set(AIRPORT_GATEWAYS.flatMap((gateway) => gateway.airports))];
export const ORIGIN_AIRPORTS = ["AMS", "RTM"];
export const AIRPORT_CONFIG_KEY = [
  ORIGIN_AIRPORTS.join(","),
  ...AIRPORT_GATEWAYS.map((gateway) => `${gateway.id}:${gateway.airports.join(",")}`),
].join("|");

export function gatewayForResort(resort) {
  return BY_RESORT.get(resort) ?? null;
}

export function gatewayById(id) {
  return BY_ID.get(id) ?? null;
}

export function gatewayCaseSql(column) {
  const clauses = AIRPORT_GATEWAYS.flatMap((gateway) => gateway.resorts.map((resort) =>
    `WHEN '${resort.replaceAll("'", "''")}' THEN '${gateway.id}'`
  ));
  return `(CASE ${column} ${clauses.join(" ")} ELSE NULL END)`;
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
  }
  return issues;
}
