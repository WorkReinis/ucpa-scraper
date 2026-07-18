import { fileURLToPath } from "node:url";
import { open } from "./db.mjs";
import { getWeeksData } from "./catalog.mjs";
import {
  AIRPORT_GATEWAYS, gatewayById, gatewayForResort, validateResortAirportAssignments,
} from "./airports.mjs";

export function validateAirportPairings(db) {
  const listings = getWeeksData(db);
  const resorts = [...new Set(listings.map((row) => row.resort).filter(Boolean))].sort();
  const pairedQuotes = listings
    .filter((row) => row.flight_gateway)
    .map((row) => ({
      resort: row.resort,
      gateway: row.flight_gateway,
      arr_airport: row.flight_arr,
    }));
  const issues = validateResortAirportAssignments(resorts, pairedQuotes);

  const storedQuotes = db.prepare(
    `SELECT gateway, arr_airport FROM v_flight_current WHERE gateway != 'legacy'`
  ).all();
  for (const quote of storedQuotes) {
    const gateway = gatewayById(quote.gateway);
    if (!gateway) issues.push(`unknown stored gateway: ${quote.gateway}`);
    else if (quote.arr_airport && !gateway.airports.includes(quote.arr_airport)) {
      issues.push(`${quote.gateway}: stored arrival ${quote.arr_airport} is outside ${gateway.airports.join(",")}`);
    }
  }

  return {
    issues: [...new Set(issues)],
    resorts: resorts.map((resort) => {
      const gateway = gatewayForResort(resort);
      return {
        resort,
        gateway: gateway?.id ?? null,
        airports: gateway?.airports ?? [],
        pairedListings: pairedQuotes.filter((row) => row.resort === resort).length,
      };
    }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = open();
  const result = validateAirportPairings(db);
  for (const row of result.resorts) {
    console.log(`${row.resort}: ${row.airports.join(",")} [${row.gateway}] (${row.pairedListings} paired listings)`);
  }
  console.log(`Validated ${result.resorts.length} resorts across ${AIRPORT_GATEWAYS.length} airport gateways.`);
  if (result.issues.length) {
    for (const issue of result.issues) console.error(`  ! ${issue}`);
    process.exitCode = 1;
  }
}
