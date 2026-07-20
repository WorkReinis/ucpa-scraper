import { fileURLToPath } from "node:url";
import { open } from "./db.mjs";
import { getWeeksData } from "./catalog.mjs";
import { flightQuoteIssues } from "./validation.mjs";
import {
  AIRPORT_GATEWAYS, gatewayById, gatewayForResort,
  validateOriginAssignments, validateResortAirportAssignments,
} from "./airports.mjs";

export function validateAirportPairings(db) {
  const listings = getWeeksData(db);
  const resorts = [...new Set(listings.map((row) => row.resort).filter(Boolean))].sort();
  // Every non-null cell of every listing's flight_quotes matrix gets the
  // gateway check (arrival airport inside the resort's gateway) and the
  // origin check (departure airport inside its own origin group).
  const pairedQuotes = [];
  const issues = [];
  for (const row of listings) {
    for (const [originGroup, modes] of Object.entries(row.flight_quotes ?? {})) {
      for (const quote of Object.values(modes)) {
        if (!quote?.gateway) continue;
        issues.push(...flightQuoteIssues(quote).map((issue) => `${row.resort}: ${issue}`));
        pairedQuotes.push({
          resort: row.resort,
          gateway: quote.gateway,
          arr_airport: quote.arr_airport,
          dep_airport: quote.dep_airport,
          return_dep_airport: quote.return_dep_airport,
          return_arr_airport: quote.return_arr_airport,
          origin_group: originGroup,
        });
      }
    }
  }
  issues.push(...validateResortAirportAssignments(resorts, pairedQuotes));
  issues.push(...validateOriginAssignments(pairedQuotes));

  const storedQuotes = db.prepare(
    `SELECT gateway, arr_airport, dep_airport, return_dep_airport, return_arr_airport, origin_group
     FROM v_flight_current WHERE gateway != 'legacy'`
  ).all();
  for (const quote of storedQuotes) {
    const gateway = gatewayById(quote.gateway);
    if (!gateway) issues.push(`unknown stored gateway: ${quote.gateway}`);
    else {
      if (quote.arr_airport && !gateway.airports.includes(quote.arr_airport)) {
        issues.push(`${quote.gateway}: stored arrival ${quote.arr_airport} is outside ${gateway.airports.join(",")}`);
      }
      if (quote.return_dep_airport && !gateway.airports.includes(quote.return_dep_airport)) {
        issues.push(`${quote.gateway}: stored return departure ${quote.return_dep_airport} is outside ${gateway.airports.join(",")}`);
      }
    }
  }
  issues.push(...validateOriginAssignments(storedQuotes).map((issue) => `stored ${issue}`));

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
