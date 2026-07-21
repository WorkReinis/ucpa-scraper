import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { open } from "./db.mjs";
import { getWeeksData } from "./catalog.mjs";
import { flightQuoteIssues } from "./validation.mjs";
import {
  AIRPORT_CONFIG_KEY, AIRPORT_GATEWAYS, ORIGIN_GROUPS, gatewayById, gatewayForRegion,
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
    `SELECT DISTINCT w.start_date, w.end_date, p.resort, p.region
     FROM v_week_current w JOIN product p ON p.code = w.code
     WHERE w.seats_left > 0 AND w.end_date IS NOT NULL
       AND w.start_date > date('now') AND w.start_date <= date('now', ?)`
  ).all(`+${FLIGHT_MONTHS_AHEAD} months`);
  const expected = new Map();
  for (const week of weekRows) {
    const gateway = gatewayForRegion(week.region);
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
  // getWeeksData()'s rows have already been through translateListing(), so
  // row.region is the display string ("Northern Alps") -- gatewayForRegion()
  // is keyed on UCPA's own raw region value ("Alpes du Nord"), the same one
  // AIRPORT_GATEWAYS is written in. Read it straight from `product` instead
  // of off the translated listings, or every resort looks unmapped.
  const regionByResort = new Map(
    db.prepare("SELECT resort, region FROM product WHERE resort IS NOT NULL").all()
      .map((row) => [row.resort, row.region])
  );
  // Every non-null cell of every listing's flight_quotes matrix gets the
  // gateway check (arrival airport inside the region's gateway) and the
  // origin check (departure airport inside its own origin group).
  const pairedQuotes = [];
  const issues = [];
  const warnings = [];
  for (const row of listings) {
    for (const [originGroup, modes] of Object.entries(row.flight_quotes ?? {})) {
      for (const quote of Object.values(modes)) {
        if (!quote?.gateway) continue;
        issues.push(...flightQuoteIssues(quote).map((issue) => `${row.resort}: ${issue}`));
        pairedQuotes.push({
          resort: row.resort,
          region: regionByResort.get(row.resort),
          gateway: quote.gateway,
          config_key: quote.config_key,
          arr_airport: quote.arr_airport,
          dep_airport: quote.dep_airport,
          return_dep_airport: quote.return_dep_airport,
          return_arr_airport: quote.return_arr_airport,
          origin_group: originGroup,
        });
      }
    }
  }
  const resortRegions = resorts.map((resort) => ({ resort, region: regionByResort.get(resort) }));
  const resortAssignments = validateResortAirportAssignments(resortRegions, pairedQuotes);
  issues.push(...resortAssignments.issues);
  warnings.push(...resortAssignments.warnings);
  issues.push(...validateOriginAssignments(pairedQuotes));

  const storedQuotes = db.prepare(
    `SELECT gateway, arr_airport, dep_airport, return_dep_airport, return_arr_airport, origin_group, config_key
     FROM v_flight_current WHERE gateway != 'legacy'`
  ).all();
  for (const quote of storedQuotes) {
    const gateway = gatewayById(quote.gateway);
    // A row fetched under the currently-active policy that still lands
    // outside its own gateway's airports would be a real bug in the quoting
    // code -- that stays an issue. A row from an older policy generation
    // (a dropped airport, a since-merged gateway) failing the *current*
    // airport list is expected and temporary: it's still on display only
    // because it's the best fallback until quota allows a fresh requote, not
    // because anything is broken right now.
    const isCurrentPolicy = quote.config_key === AIRPORT_CONFIG_KEY;
    const report = (message) => (isCurrentPolicy ? issues : warnings).push(message);
    if (!gateway) report(`unknown stored gateway: ${quote.gateway}`);
    else {
      if (quote.arr_airport && !gateway.airports.includes(quote.arr_airport)) {
        report(`${quote.gateway}: stored arrival ${quote.arr_airport} is outside ${gateway.airports.join(",")}`);
      }
      if (quote.return_dep_airport && !gateway.airports.includes(quote.return_dep_airport)) {
        report(`${quote.gateway}: stored return departure ${quote.return_dep_airport} is outside ${gateway.airports.join(",")}`);
      }
    }
  }
  issues.push(...validateOriginAssignments(storedQuotes).map((issue) => `stored ${issue}`));

  return {
    issues: [...new Set(issues)],
    warnings: [...new Set(warnings)],
    resorts: resorts.map((resort) => {
      const region = regionByResort.get(resort);
      const gateway = gatewayForRegion(region);
      return {
        resort,
        region,
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
  for (const gateway of AIRPORT_GATEWAYS) {
    console.log(`${gateway.region} [${gateway.id}]: ${gateway.airports.join(", ")}`);
  }
  for (const row of result.resorts) {
    console.log(`  ${row.resort} (${row.region}): ${row.airports.join(",")} [${row.gateway}] (${row.pairedListings} paired listings)`);
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
  for (const warning of result.warnings) console.warn(`  ~ ${warning}`);
  const issues = [...result.issues, ...coverageIssues];
  if (issues.length) {
    for (const issue of issues) console.error(`  ! ${issue}`);
    process.exitCode = 1;
  }
}
