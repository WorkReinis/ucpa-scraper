import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { open } from "./db.mjs";
import { getWeeksData } from "./catalog.mjs";
import { flightQuoteIssues } from "./validation.mjs";
import {
  AIRPORT_CONFIG_KEY, AIRPORT_GATEWAYS, ORIGIN_GROUPS, gatewayById, gatewayForResort,
  validateOriginAssignments, validateResortAirportAssignments,
} from "./airports.mjs";
import { ARRIVAL_MODES, FLIGHT_MONTHS_AHEAD } from "./flights.mjs";
import { MAX_FLIGHT_STOPS } from "./flight-config.mjs";

function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function segments(value) {
  try { return JSON.parse(value || "[]"); } catch { return []; }
}

export function flightCoverageReport(db, { originGroupIds } = {}) {
  const selectedOrigins = originGroupIds?.length
    ? ORIGIN_GROUPS.filter((group) => originGroupIds.includes(group.id))
    : ORIGIN_GROUPS;
  const weekRows = db.prepare(
    `SELECT DISTINCT w.start_date, w.end_date, p.resort
     FROM v_week_current w JOIN product p ON p.code = w.code
     WHERE w.seats_left > 0 AND w.end_date IS NOT NULL
       AND w.start_date > date('now') AND w.start_date <= date('now', ?)`
  ).all(`+${FLIGHT_MONTHS_AHEAD} months`);
  const expected = new Map();
  for (const week of weekRows) {
    const gateway = gatewayForResort(week.resort);
    if (!gateway) continue;
    for (const mode of ARRIVAL_MODES) {
      const outboundDate = addDays(week.start_date, mode.offsetDays);
      for (const origin of selectedOrigins) {
        const key = [origin.id, gateway.id, mode.id, outboundDate, week.end_date].join("|");
        expected.set(key, {
          originGroup: origin.id, gateway: gateway.id, arrivalMode: mode.id,
          outboundDate, returnDate: week.end_date,
        });
      }
    }
  }

  const liveRows = db.prepare("SELECT * FROM v_flight_current").all();
  const live = new Map(liveRows.map((row) => [[
    row.origin_group, row.gateway, row.arrival_mode, row.outbound_date, row.return_date,
  ].join("|"), row]));
  const currentRows = liveRows.filter((row) => row.config_key === AIRPORT_CONFIG_KEY);
  const current = new Map(currentRows.map((row) => [[
    row.origin_group, row.gateway, row.arrival_mode, row.outbound_date, row.return_date,
  ].join("|"), row]));
  const requiredRows = [...expected].map(([key, cell]) => ({ key, cell, row: current.get(key) }));
  const missing = requiredRows.filter(({ row }) => !row).map(({ cell }) => cell);
  const stored = requiredRows.filter(({ row }) => row).map(({ row }) => row);
  const invalidDates = [];
  const excessiveStops = [];
  for (const row of stored) {
    const outbound = segments(row.outbound_segments);
    const outboundArrival = outbound.at(-1)?.arrival_at;
    const outboundDeparture = outbound[0]?.departure_at;
    if (row.price != null && (
      (outboundArrival && outboundArrival.slice(0, 10) !== row.outbound_date) ||
      (outboundDeparture && outboundDeparture.slice(0, 10) !== row.outbound_date)
    )) {
      invalidDates.push({
        originGroup: row.origin_group, gateway: row.gateway, arrivalMode: row.arrival_mode,
        outboundDate: row.outbound_date, returnDate: row.return_date,
        departure: outboundDeparture ?? null, arrival: outboundArrival ?? null,
      });
    }
    if ((row.stops ?? 0) > MAX_FLIGHT_STOPS || (row.return_stops ?? 0) > MAX_FLIGHT_STOPS) {
      excessiveStops.push({
        originGroup: row.origin_group, gateway: row.gateway, arrivalMode: row.arrival_mode,
        outboundDate: row.outbound_date, stops: row.stops, returnStops: row.return_stops,
      });
    }
  }
  const sparseCandidates = stored.filter((row) =>
    row.candidate_count >= 0 && row.candidate_count < 2
  ).map((row) => ({
    originGroup: row.origin_group, gateway: row.gateway, arrivalMode: row.arrival_mode,
    outboundDate: row.outbound_date, candidates: row.candidate_count, price: row.price,
  }));
  const unknownDiagnostics = stored.filter((row) => row.candidate_count < 0).length;

  return {
    configKey: AIRPORT_CONFIG_KEY,
    originGroups: selectedOrigins.map((group) => group.id),
    expected: expected.size,
    current: stored.length,
    priced: stored.filter((row) => row.price != null).length,
    searchedUnpriced: stored.filter((row) => row.price == null).length,
    missing: missing.length,
    legacyFallbacks: [...expected.keys()].filter((key) => {
      const row = live.get(key);
      return row && row.config_key !== AIRPORT_CONFIG_KEY;
    }).length,
    sparseCandidateCells: sparseCandidates.length,
    unknownDiagnosticCells: unknownDiagnostics,
    invalidDateCells: invalidDates.length,
    excessiveStopCells: excessiveStops.length,
    complete: missing.length === 0 && invalidDates.length === 0 && excessiveStops.length === 0,
    missingCells: missing,
    invalidDates,
    excessiveStops,
    sparseCandidates,
  };
}

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
  const requestedOrigins = process.env.FLIGHT_ORIGIN_GROUPS
    ?.split(",").map((value) => value.trim()).filter(Boolean);
  const coverage = flightCoverageReport(db, { originGroupIds: requestedOrigins });
  for (const row of result.resorts) {
    console.log(`${row.resort}: ${row.airports.join(",")} [${row.gateway}] (${row.pairedListings} paired listings)`);
  }
  console.log(`Validated ${result.resorts.length} resorts across ${AIRPORT_GATEWAYS.length} airport gateways.`);
  console.log(
    `Flight coverage (${coverage.originGroups.join(",")}): ${coverage.current}/${coverage.expected} current-policy cells; ` +
    `${coverage.priced} priced, ${coverage.searchedUnpriced} searched without a viable quote, ` +
    `${coverage.missing} missing, ${coverage.sparseCandidateCells} sparse.`
  );
  writeFileSync(".flight-coverage.json", `${JSON.stringify(coverage, null, 2)}\n`);
  const strictCoverage = process.argv.includes("--require-current-flight-coverage");
  const coverageIssues = strictCoverage && !coverage.complete
    ? [`current flight coverage incomplete: ${coverage.missing} missing, ${coverage.invalidDateCells} invalid-date, ${coverage.excessiveStopCells} excessive-stop cells`]
    : [];
  const issues = [...result.issues, ...coverageIssues];
  if (issues.length) {
    for (const issue of issues) console.error(`  ! ${issue}`);
    process.exitCode = 1;
  }
}
