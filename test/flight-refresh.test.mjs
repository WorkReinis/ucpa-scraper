import test from "node:test";
import assert from "node:assert/strict";
import { open } from "../src/db.mjs";
import { AIRPORT_CONFIG_KEY } from "../src/airports.mjs";
import { runFlightRefresh } from "../src/flights.mjs";

function itinerary(from, to, price, date, departure, arrival) {
  return {
    price,
    total_duration: 95,
    flights: [{
      departure_airport: { id: from, time: `${date} ${departure}` },
      arrival_airport: { id: to, time: `${date} ${arrival}` },
      airline: "Fixture Air",
      duration: 95,
    }],
  };
}

function daysFromNow(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function fixtureDb() {
  const db = open(":memory:");
  db.prepare(
    `INSERT INTO product (code, resort, region, first_seen, last_seen)
     VALUES ('fixture', 'Val d''Isère', 'Alpes du Nord', datetime('now'), datetime('now'))`
  ).run();
  db.prepare(
    `INSERT INTO week
       (code, start_date, end_date, price, status, seats_left, booked, observed_at)
     VALUES ('fixture', ?, ?, 700, 'Available', 5, 0, datetime('now'))`
  ).run(daysFromNow(60), daysFromNow(66));
  return db;
}

test("refresh recovers an origin market omitted by the broad flight matrix", async () => {
  const db = fixtureDb();

  const calls = [];
  const searchProvider = async ({ originIds, destIds, outboundDate, returnDate }) => {
    calls.push({ originIds, destIds, outboundDate, returnDate });
    const isReturn = originIds.includes("LYS") && !originIds.includes("AMS");
    const isBaselOnly = originIds === "BSL" || destIds === "BSL";
    let flights;
    if (isReturn && isBaselOnly) {
      flights = [itinerary("LYS", "BSL", 75, outboundDate, "14:00", "15:35")];
    } else if (isReturn) {
      flights = [
        itinerary("LYS", "AMS", 80, outboundDate, "14:00", "15:35"),
        itinerary("LYS", "LHR", 60, outboundDate, "14:15", "15:50"),
      ];
    } else if (isBaselOnly) {
      flights = [itinerary("BSL", "LYS", 65, outboundDate, "07:30", "09:05")];
    } else {
      flights = [
        itinerary("AMS", "LYS", 90, outboundDate, "07:00", "08:35"),
        itinerary("LHR", "LYS", 70, outboundDate, "07:15", "08:50"),
      ];
    }
    return {
      provider: "apify",
      secrets: [],
      raw: {
        search_parameters: { engine: "google_flights" },
        best_flights: flights,
        other_flights: [],
      },
    };
  };

  const summary = await runFlightRefresh({
    db,
    providerNames: ["apify"],
    searchProvider,
    delay: async () => {},
    // This test is about Basel-market recovery, not the separate
    // thinnest-gateway-airport pass -- the fixture's mock only ever routes
    // through LYS, which would otherwise trip that unrelated check too.
    checkThinAirports: false,
  });

  assert.equal(summary.failed, 0);
  assert.equal(summary.status, "success");
  assert.equal(summary.complete, true);
  assert.equal(summary.modesDue, 2);
  assert.equal(summary.modesCompleted, 2);
  assert.equal(summary.cellsDue, 6);
  assert.equal(summary.cellsStored, 6);
  assert.equal(summary.cellsMissing, 0);
  assert.equal(summary.recoverySearches, 3);
  assert.equal(calls.length, 6);
  assert.equal(calls.filter((call) => call.originIds === "BSL").length, 2);
  assert.equal(calls.filter((call) => call.destIds === "BSL").length, 1);
  assert.ok(calls.every((call) => !call.originIds.includes("TLS") && !call.destIds.includes("TLS")));
  assert.ok(calls.filter((call) => call.originIds === "BSL")
    .every((call) => call.destIds === "CMF,GNB,GVA,LYS"));
  assert.ok(calls.filter((call) => call.destIds === "BSL")
    .every((call) => call.originIds === "CMF,GNB,GVA,LYS"));
  assert.ok(calls.every((call) => call.returnDate == null));

  const rows = db.prepare(
    `SELECT origin_group, arrival_mode, price, price_outbound, price_return, pricing_mode, config_key
     FROM v_flight_current ORDER BY origin_group, arrival_mode`
  ).all();
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.filter((row) => row.origin_group === "nl").map((row) => row.price), [170, 170]);
  assert.deepEqual(rows.filter((row) => row.origin_group === "ch").map((row) => row.price), [140, 140]);
  assert.ok(rows.every((row) => row.pricing_mode === "separate"));
  assert.ok(rows.every((row) => row.price_outbound != null && row.price_return != null));
  assert.ok(rows.every((row) => row.config_key === AIRPORT_CONFIG_KEY));
  const freshSummary = await runFlightRefresh({
    db,
    providerNames: ["apify"],
    searchProvider: async () => { throw new Error("fresh quotes must not search"); },
    delay: async () => {},
  });
  assert.equal(freshSummary.status, "fresh");
  assert.equal(freshSummary.modesDue, 0);
  assert.equal(freshSummary.searched, 0);
  db.close();
});

test("one cell's failed recovery search doesn't cost every other cell in the same leg", async () => {
  // Basel (ch) is entirely absent from the broad response and its own
  // recovery search always fails -- nl and uk are fully healthy throughout.
  // recoverMissingCoverage() used to re-throw on any single cell's retry
  // failure, which unwound the whole function before `return covered`,
  // discarding nl and uk's already-good prices along with Basel's. Fixed to
  // catch per cell: only Basel ends up unresolved, nl/uk still get stored.
  const db = fixtureDb();
  let calls = 0;
  const searchProvider = async ({ originIds, destIds, outboundDate }) => {
    calls++;
    if (originIds === "BSL" || destIds === "BSL") throw new Error("fixture provider failure");
    const isReturn = originIds.includes("LYS") && !originIds.includes("AMS");
    return {
      provider: "apify",
      secrets: [],
      raw: {
        search_parameters: { engine: "google_flights" },
        best_flights: isReturn
          ? [
              itinerary("LYS", "AMS", 80, outboundDate, "14:00", "15:35"),
              itinerary("LYS", "LHR", 60, outboundDate, "14:15", "15:50"),
            ]
          : [
              itinerary("AMS", "LYS", 90, outboundDate, "07:00", "08:35"),
              itinerary("LHR", "LYS", 70, outboundDate, "07:15", "08:50"),
            ],
        other_flights: [],
      },
    };
  };

  const summary = await runFlightRefresh({
    db,
    providerNames: ["apify"],
    searchProvider,
    delay: async () => {},
    // About leg-level failure isolation, not the separate
    // thinnest-gateway-airport pass -- this fixture's LYS-only mock would
    // otherwise also trip that unrelated check for CMF/GNB/GVA.
    checkThinAirports: false,
  });

  // 3 broad searches (return, standard outbound, early outbound) + one
  // Basel-only retry per leg, each of which fails and is isolated to
  // Basel's own cell rather than aborting anything else.
  assert.equal(calls, 6);
  assert.equal(summary.failed, 3);
  assert.equal(summary.status, "partial");
  assert.equal(summary.complete, false); // failed > 0 keeps this honest, even though every cell got attempted
  assert.equal(summary.modesDue, 2);
  assert.equal(summary.modesCompleted, 2); // neither leg aborted -- both ran to completion
  assert.equal(summary.cellsDue, 6);
  assert.equal(summary.cellsStored, 6); // every cell got a row, priced or not
  assert.equal(summary.cellsUnpriced, 2); // exactly Basel's two modes
  assert.equal(summary.cellsMissing, 0); // nothing was ever abandoned outright
  assert.ok(summary.errors.every((error) => /fixture provider failure/.test(error)));

  const rows = db.prepare(
    "SELECT origin_group, price FROM v_flight_current ORDER BY origin_group, arrival_mode"
  ).all();
  assert.deepEqual(rows.filter((row) => row.origin_group === "nl").map((row) => row.price), [170, 170]);
  assert.deepEqual(rows.filter((row) => row.origin_group === "uk").map((row) => row.price), [130, 130]);
  assert.deepEqual(rows.filter((row) => row.origin_group === "ch").map((row) => row.price), [null, null]);
  db.close();
});

test("refresh can target Basel without re-querying other origin markets", async () => {
  const db = fixtureDb();
  const calls = [];
  const searchProvider = async ({ originIds, destIds, outboundDate, returnDate }) => {
    calls.push({ originIds, destIds, outboundDate, returnDate });
    const isReturn = originIds.includes("LYS");
    return {
      provider: "serpapi",
      secrets: [],
      raw: {
        search_parameters: { engine: "google_flights" },
        best_flights: [isReturn
          ? itinerary("LYS", "BSL", 75, outboundDate, "14:00", "15:35")
          : itinerary("BSL", "LYS", 165, outboundDate, "07:30", "09:05")],
        other_flights: [],
      },
    };
  };

  const summary = await runFlightRefresh({
    db,
    providerNames: ["serpapi"],
    originGroupIds: ["ch"],
    searchProvider,
    delay: async () => {},
    // About Basel-only targeting, not the thinnest-gateway-airport pass --
    // this fixture's minimal one-itinerary mock would otherwise trip it too.
    checkThinAirports: false,
  });

  assert.equal(summary.complete, true);
  assert.deepEqual(summary.originGroups, ["ch"]);
  assert.equal(summary.cellsDue, 2);
  assert.equal(summary.cellsStored, 2);
  assert.equal(calls.length, 3);
  assert.equal(summary.broadSearches, 3);
  assert.equal(summary.targetedRetries, 0);
  assert.equal(summary.returnCacheHits, 0);
  assert.ok(calls.every((call) => call.originIds === "BSL" || call.destIds === "BSL"));
  assert.ok(calls.every((call) => !call.originIds.includes("AMS") && !call.destIds.includes("AMS")));
  assert.ok(calls.every((call) => !call.originIds.includes("TLS") && !call.destIds.includes("TLS")));
  const rows = db.prepare(
    "SELECT origin_group, arrival_mode, price FROM v_flight_current ORDER BY arrival_mode"
  ).all();
  assert.deepEqual(rows.map((row) => row.origin_group), ["ch", "ch"]);
  assert.deepEqual(rows.map((row) => row.price), [240, 240]);

  // Expiring only the combined fare rows still reuses a current return fare,
  // so a second cycle needs only the two outbound one-way searches.
  db.exec("UPDATE flight_price SET fetched_at = datetime('now', '-7 days')");
  const cachedSummary = await runFlightRefresh({
    db,
    providerNames: ["serpapi"],
    originGroupIds: ["ch"],
    searchProvider,
    delay: async () => {},
    checkThinAirports: false,
  });
  assert.equal(cachedSummary.complete, true);
  assert.equal(cachedSummary.returnCacheHits, 1);
  assert.equal(cachedSummary.returnCellsReused, 1);
  assert.equal(cachedSummary.searched, 2);
  assert.equal(cachedSummary.broadSearches, 2);
  assert.equal(cachedSummary.targetedRetries, 0);
  assert.equal(calls.length, 5);
  assert.ok(calls.slice(3).every((call) => call.originIds === "BSL" && call.returnDate == null));
  db.close();
});

test("refresh retries a deeper exact route when broad flights all miss the window", async () => {
  const db = fixtureDb();
  const calls = [];
  const searchProvider = async ({ originIds, outboundDate, exhaustive }) => {
    calls.push({ originIds, outboundDate, exhaustive });
    const isReturn = originIds.includes("LYS");
    const flight = isReturn
      ? itinerary("LYS", "AMS", exhaustive ? 80 : 60, outboundDate,
          exhaustive ? "14:00" : "09:00", exhaustive ? "15:35" : "10:35")
      : itinerary("AMS", "LYS", exhaustive ? 90 : 70, outboundDate,
          exhaustive ? "07:00" : "20:30", exhaustive ? "08:35" : "22:05");
    return {
      provider: "apify",
      secrets: [],
      raw: {
        search_parameters: { engine: "google_flights" },
        best_flights: [flight],
        other_flights: [],
      },
    };
  };

  const summary = await runFlightRefresh({
    db,
    providerNames: ["apify"],
    originGroupIds: ["nl"],
    searchProvider,
    delay: async () => {},
    // About the deep-window targeted retry, not the separate
    // thinnest-gateway-airport pass -- this fixture's single-itinerary mock
    // would otherwise trip that unrelated check too.
    checkThinAirports: false,
  });

  assert.equal(summary.complete, true);
  assert.equal(summary.broadSearches, 3);
  assert.equal(summary.targetedRetries, 3);
  assert.equal(summary.recoverySearches, 3);
  assert.equal(calls.filter((call) => call.exhaustive).length, 3);
  assert.equal(calls.filter((call) => !call.exhaustive).length, 3);
  const rows = db.prepare(
    "SELECT price, price_outbound, price_return, pricing_mode FROM v_flight_current ORDER BY arrival_mode"
  ).all();
  assert.deepEqual(rows.map((row) => row.price), [170, 170]);
  assert.ok(rows.every((row) => row.price_outbound === 90 && row.price_return === 80));
  assert.ok(rows.every((row) => row.pricing_mode === "separate"));
  db.close();
});

test("a thin gateway airport recovers a real, cheaper fare the broad search dropped", async () => {
  // Mirrors the real 2026-07 measurement for Val d'Isere's gateway
  // (northern-alps: CMF, GNB, GVA, LYS): a broad multi-airport search comes
  // back GVA-dominant, with CMF entirely absent even though a real, cheaper
  // Chambery fare exists -- confirmed live via an isolated single-airport
  // search that removed GVA/LYS from competition.
  const db = fixtureDb();
  const calls = [];
  const apifyRaw = (best_flights) => ({
    provider: "apify",
    secrets: [],
    raw: { search_parameters: { engine: "google_flights" }, best_flights, other_flights: [] },
  });
  const searchProvider = async ({ originIds, destIds, outboundDate }) => {
    calls.push({ originIds, destIds, outboundDate });
    // The narrow single-airport retry this test is about: CMF, isolated.
    if (destIds === "CMF") {
      return apifyRaw([itinerary("AMS", "CMF", 150, outboundDate, "07:00", "08:35")]);
    }
    // Return leg (broad, and its own would-be narrow retry): deliberately
    // balanced across every gateway airport, so only the outbound leg here
    // is thin -- exactly 2 itineraries per airport, right at the default
    // minCandidates floor, so none of them get flagged either.
    if (originIds === "CMF,GNB,GVA,LYS" || originIds === "CMF") {
      return apifyRaw(["CMF", "GNB", "GVA", "LYS"].flatMap((airport) => [
        itinerary(airport, "AMS", 80, outboundDate, "14:00", "15:35"),
        itinerary(airport, "AMS", 85, outboundDate, "14:10", "15:45"),
      ]));
    }
    // Broad outbound search: GVA-dominant, CMF/GNB entirely absent.
    return apifyRaw([
      itinerary("AMS", "GVA", 200, outboundDate, "08:00", "09:35"),
      itinerary("AMS", "GVA", 210, outboundDate, "10:00", "11:35"),
      itinerary("AMS", "LYS", 220, outboundDate, "09:00", "10:35"),
    ]);
  };

  const summary = await runFlightRefresh({
    db, providerNames: ["apify"], originGroupIds: ["nl"], searchProvider, delay: async () => {},
  });

  assert.equal(summary.complete, true);
  // One narrow CMF retry per arrival mode (standard + early); the balanced
  // return leg never earns one.
  const narrowCalls = calls.filter((call) => call.destIds === "CMF");
  assert.equal(narrowCalls.length, 2);
  assert.equal(summary.recoverySearches, 2);

  const rows = db.prepare(
    "SELECT price, dep_airport, arr_airport, price_outbound, price_return FROM v_flight_current ORDER BY arrival_mode"
  ).all();
  assert.equal(rows.length, 2);
  // 150 (recovered CMF outbound) + 80 (return) -- not 200+80 from the
  // GVA-dominant broad response the thin-airport pass corrected.
  assert.ok(rows.every((row) => row.price === 230));
  assert.ok(rows.every((row) => row.dep_airport === "AMS" && row.arr_airport === "CMF"));
  assert.ok(rows.every((row) => row.price_outbound === 150 && row.price_return === 80));
  db.close();
});

test("checkThinAirports: false skips the thin-airport pass entirely", async () => {
  const db = fixtureDb();
  const calls = [];
  const searchProvider = async ({ originIds, destIds, outboundDate }) => {
    calls.push({ destIds });
    const isReturn = originIds === "CMF,GNB,GVA,LYS";
    return {
      provider: "apify",
      secrets: [],
      raw: {
        search_parameters: { engine: "google_flights" },
        best_flights: [isReturn
          ? itinerary("GVA", "AMS", 80, outboundDate, "14:00", "15:35")
          : itinerary("AMS", "GVA", 200, outboundDate, "08:00", "09:35")],
        other_flights: [],
      },
    };
  };

  const summary = await runFlightRefresh({
    db, providerNames: ["apify"], originGroupIds: ["nl"], searchProvider, delay: async () => {},
    checkThinAirports: false,
  });

  assert.equal(summary.complete, true);
  assert.equal(summary.recoverySearches, 0);
  assert.ok(calls.every((call) => call.destIds !== "CMF" && call.destIds !== "GNB"));
  db.close();
});

test("failed return searches are throttled on their actual return-date ledger key", async () => {
  const db = fixtureDb();
  const endDate = daysFromNow(66);
  const insert = db.prepare(
    `INSERT INTO flight_search
       (outbound_date, return_date, attempted_at, week_key, billing_month, config_key,
        arrival_mode, provider, direction, status, error)
     VALUES (?, ?, datetime('now'), 'fixture', strftime('%Y-%m', 'now'), ?,
             'standard', 'apify', 'return', 'failed', 'fixture failure')`
  );
  insert.run(endDate, endDate, AIRPORT_CONFIG_KEY);
  insert.run(endDate, endDate, AIRPORT_CONFIG_KEY);

  const summary = await runFlightRefresh({
    db,
    providerNames: ["apify"],
    searchProvider: async () => { throw new Error("return retry should have been throttled"); },
    delay: async () => {},
  });
  assert.equal(summary.searched, 0);
  assert.equal(summary.providerAttempts, 0);
  assert.equal(summary.recentAttemptSkipped, 1);
  assert.equal(summary.status, "partial");
  db.close();
});

test("fallback requests are ledgered against the provider that was actually called", async () => {
  const db = fixtureDb();
  const searchProvider = async ({ originIds, outboundDate }, provider) => {
    if (provider === "apify") throw new Error("fixture Apify outage");
    const isReturn = originIds.includes("LYS") && !originIds.includes("AMS");
    const flights = isReturn
      ? [
          itinerary("LYS", "AMS", 80, outboundDate, "14:00", "15:35"),
          itinerary("LYS", "LHR", 60, outboundDate, "14:15", "15:50"),
          itinerary("LYS", "BSL", 75, outboundDate, "14:30", "16:05"),
        ]
      : [
          itinerary("AMS", "LYS", 90, outboundDate, "07:00", "08:35"),
          itinerary("LHR", "LYS", 70, outboundDate, "07:15", "08:50"),
          itinerary("BSL", "LYS", 65, outboundDate, "07:30", "09:05"),
        ];
    return {
      provider: "serpapi", secrets: [],
      raw: { search_parameters: { engine: "google_flights" }, best_flights: flights, other_flights: [] },
    };
  };

  const summary = await runFlightRefresh({
    // About provider-fallback ledgering, not the separate
    // thinnest-gateway-airport pass -- this fixture's LYS-only mock would
    // otherwise trip that unrelated check too.
    db, providerNames: ["apify", "serpapi"], searchProvider, delay: async () => {},
    checkThinAirports: false,
  });
  assert.equal(summary.complete, true);
  assert.equal(summary.searched, 3);
  assert.equal(summary.providerAttempts, 6);
  assert.equal(summary.providerAttemptFailures, 3);
  assert.equal(summary.providerFallbacks, 3);
  const ledger = db.prepare(
    "SELECT provider, status, COUNT(*) n FROM flight_search GROUP BY provider, status ORDER BY provider, status"
  ).all().map((row) => ({ ...row }));
  assert.deepEqual(ledger, [
    { provider: "apify", status: "failed", n: 3 },
    { provider: "serpapi", status: "success", n: 3 },
  ]);
  db.close();
});

test("an exhausted fallback does not turn a transient primary failure into global exhaustion", async () => {
  const db = fixtureDb();
  const failed = await runFlightRefresh({
    db,
    providerNames: ["apify", "serpapi"],
    originGroupIds: ["nl"],
    searchProvider: async (_params, provider) => {
      if (provider === "apify") throw new Error("HTTP 502 fixture");
      throw new Error("Your account has run out of searches.");
    },
    delay: async () => {},
  });

  assert.equal(failed.quotaExhausted, false);
  assert.equal(failed.providerAttempts, 2);
  assert.equal(failed.status, "partial");

  const calls = [];
  const recovered = await runFlightRefresh({
    db,
    providerNames: ["apify", "serpapi"],
    originGroupIds: ["nl"],
    searchProvider: async ({ originIds, outboundDate }, provider) => {
      calls.push({ originIds, provider });
      const isReturn = originIds.includes("LYS");
      return {
        provider,
        secrets: [],
        raw: {
          search_parameters: { engine: "google_flights" },
          best_flights: [isReturn
            ? itinerary("LYS", "AMS", 80, outboundDate, "14:00", "15:35")
            : itinerary("AMS", "LYS", 90, outboundDate, "07:00", "08:35")],
          other_flights: [],
        },
      };
    },
    delay: async () => {},
    // About exhaustion/fallback recovery, not the separate
    // thinnest-gateway-airport pass -- this fixture's LYS-only mock would
    // otherwise trip that unrelated check too.
    checkThinAirports: false,
  });

  assert.equal(recovered.complete, true);
  assert.equal(recovered.providerAttempts, 3);
  assert.ok(calls.every((call) => call.provider === "apify"));
  db.close();
});

test("SerpApi's own exhaustion response suppresses retries for the billing month", async () => {
  const db = fixtureDb();
  let calls = 0;
  await runFlightRefresh({
    db,
    providerNames: ["serpapi"],
    originGroupIds: ["nl"],
    searchProvider: async () => {
      calls++;
      throw new Error("Your account has run out of searches.");
    },
    delay: async () => {},
  });
  assert.equal(calls, 1);

  const second = await runFlightRefresh({
    db,
    providerNames: ["serpapi"],
    originGroupIds: ["nl"],
    searchProvider: async () => {
      calls++;
      throw new Error("exhausted provider must not be retried");
    },
    delay: async () => {},
  });
  assert.equal(calls, 1);
  assert.equal(second.quotaUsed, 225);
  assert.equal(second.quotaRemaining, 0);
  db.close();
});
