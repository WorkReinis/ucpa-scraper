import test from "node:test";
import assert from "node:assert/strict";
import { open } from "../src/db.mjs";
import { AIRPORT_CONFIG_KEY } from "../src/airports.mjs";
import { runFlightRefresh } from "../src/flights.mjs";

// The provider's round-trip price is already the whole bundled fare -- these
// fixtures use `price` directly as that bundle total, not a one-way half.
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
  const endDate = daysFromNow(66);

  const calls = [];
  const searchProvider = async ({ originIds, destIds, outboundDate, returnDate }) => {
    calls.push({ originIds, destIds, outboundDate, returnDate });
    const isUkOnly = originIds === "LHR,LGW,LTN,STN";
    const flights = isUkOnly
      ? [itinerary("LTN", "LYS", 130, outboundDate, "07:15", "08:50")]
      : [itinerary("AMS", "LYS", 170, outboundDate, "07:00", "08:35")];
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
    // This test is about uk-market recovery, not the separate
    // thinnest-gateway-airport pass -- the fixture's mock only ever routes
    // through LYS, which would otherwise trip that unrelated check too.
    checkThinAirports: false,
  });

  assert.equal(summary.failed, 0);
  assert.equal(summary.status, "success");
  assert.equal(summary.complete, true);
  assert.equal(summary.modesDue, 2);
  assert.equal(summary.modesCompleted, 2);
  // 2 origin groups (nl, uk) x 1 gateway x 2 arrival modes.
  assert.equal(summary.cellsDue, 4);
  assert.equal(summary.cellsStored, 4);
  assert.equal(summary.cellsMissing, 0);
  // One narrow uk retry per arrival mode -- no separate return leg to
  // recover any more, so half as many recoveries as the old two-search model.
  assert.equal(summary.recoverySearches, 2);
  assert.equal(calls.length, 4);
  assert.equal(calls.filter((call) => call.originIds === "LHR,LGW,LTN,STN").length, 2);
  assert.ok(calls.every((call) => !call.originIds.includes("TLS") && !call.destIds.includes("TLS")));
  assert.ok(calls.filter((call) => call.originIds === "LHR,LGW,LTN,STN")
    .every((call) => call.destIds === "GNB,GVA,LYS"));
  // Every search is a genuine round trip now -- returnDate always the
  // package's end date, never omitted.
  assert.ok(calls.every((call) => call.returnDate === endDate));

  const rows = db.prepare(
    `SELECT origin_group, arrival_mode, price, price_outbound, price_return, pricing_mode, config_key
     FROM v_flight_current ORDER BY origin_group, arrival_mode`
  ).all();
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.filter((row) => row.origin_group === "nl").map((row) => row.price), [170, 170]);
  assert.deepEqual(rows.filter((row) => row.origin_group === "uk").map((row) => row.price), [130, 130]);
  assert.ok(rows.every((row) => row.pricing_mode === "roundtrip"));
  assert.ok(rows.every((row) => row.price_outbound == null && row.price_return == null));
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
  // uk is entirely absent from the broad response and its own recovery
  // search always fails -- nl is fully healthy throughout. recoverMissingCoverage()
  // used to re-throw on any single cell's retry failure, which unwound the
  // whole function before `return covered`, discarding nl's already-good
  // prices along with uk's. Fixed to catch per cell: only uk ends up
  // unresolved, nl still gets stored.
  const db = fixtureDb();
  let calls = 0;
  const searchProvider = async ({ originIds, destIds, outboundDate }) => {
    calls++;
    if (originIds === "LHR,LGW,LTN,STN") throw new Error("fixture provider failure");
    return {
      provider: "apify",
      secrets: [],
      raw: {
        search_parameters: { engine: "google_flights" },
        best_flights: [itinerary("AMS", "LYS", 170, outboundDate, "07:00", "08:35")],
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
    // otherwise also trip that unrelated check for GNB/GVA.
    checkThinAirports: false,
  });

  // 2 broad round-trip searches (standard, early) + one uk-only retry per
  // mode, each of which fails and is isolated to uk's own cell rather
  // than aborting anything else.
  assert.equal(calls, 4);
  assert.equal(summary.failed, 2);
  assert.equal(summary.status, "partial");
  assert.equal(summary.complete, false); // failed > 0 keeps this honest, even though every cell got attempted
  assert.equal(summary.modesDue, 2);
  assert.equal(summary.modesCompleted, 2); // neither leg aborted -- both ran to completion
  assert.equal(summary.cellsDue, 4);
  assert.equal(summary.cellsStored, 4); // every cell got a row, priced or not
  assert.equal(summary.cellsUnpriced, 2); // exactly uk's two modes
  assert.equal(summary.cellsMissing, 0); // nothing was ever abandoned outright
  assert.ok(summary.errors.every((error) => /fixture provider failure/.test(error)));

  const rows = db.prepare(
    "SELECT origin_group, price FROM v_flight_current ORDER BY origin_group, arrival_mode"
  ).all();
  assert.deepEqual(rows.filter((row) => row.origin_group === "nl").map((row) => row.price), [170, 170]);
  assert.deepEqual(rows.filter((row) => row.origin_group === "uk").map((row) => row.price), [null, null]);
  db.close();
});

test("refresh can target uk without re-querying other origin markets", async () => {
  const db = fixtureDb();
  const calls = [];
  const searchProvider = async ({ originIds, destIds, outboundDate, returnDate }) => {
    calls.push({ originIds, destIds, outboundDate, returnDate });
    return {
      provider: "serpapi",
      secrets: [],
      raw: {
        search_parameters: { engine: "google_flights" },
        best_flights: [itinerary("LTN", "LYS", 240, outboundDate, "07:30", "09:05")],
        other_flights: [],
      },
    };
  };

  const summary = await runFlightRefresh({
    db,
    providerNames: ["serpapi"],
    originGroupIds: ["uk"],
    searchProvider,
    delay: async () => {},
    // About uk-only targeting, not the thinnest-gateway-airport pass -- this
    // fixture's minimal one-itinerary mock would otherwise trip it too.
    checkThinAirports: false,
  });

  assert.equal(summary.complete, true);
  assert.deepEqual(summary.originGroups, ["uk"]);
  assert.equal(summary.cellsDue, 2);
  assert.equal(summary.cellsStored, 2);
  // One round-trip search per arrival mode -- restricting to uk alone means
  // the broad matrix search already only spans uk's airports, so no
  // separate narrow retry is needed.
  assert.equal(calls.length, 2);
  assert.equal(summary.broadSearches, 2);
  assert.equal(summary.targetedRetries, 0);
  assert.ok(calls.every((call) => call.originIds === "LHR,LGW,LTN,STN"));
  assert.ok(calls.every((call) => !call.originIds.includes("AMS") && !call.destIds.includes("AMS")));
  assert.ok(calls.every((call) => !call.originIds.includes("TLS") && !call.destIds.includes("TLS")));
  const rows = db.prepare(
    "SELECT origin_group, arrival_mode, price FROM v_flight_current ORDER BY arrival_mode"
  ).all();
  assert.deepEqual(rows.map((row) => row.origin_group), ["uk", "uk"]);
  assert.deepEqual(rows.map((row) => row.price), [240, 240]);
  db.close();
});

test("refresh retries a deeper exact route when broad flights all miss the window", async () => {
  const db = fixtureDb();
  const calls = [];
  const searchProvider = async ({ originIds, outboundDate, exhaustive }) => {
    calls.push({ originIds, outboundDate, exhaustive });
    const flight = exhaustive
      ? itinerary("AMS", "LYS", 170, outboundDate, "07:00", "08:35")
      : itinerary("AMS", "LYS", 260, outboundDate, "20:30", "22:05");
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
  assert.equal(summary.broadSearches, 2);
  assert.equal(summary.targetedRetries, 2);
  assert.equal(summary.recoverySearches, 2);
  assert.equal(calls.filter((call) => call.exhaustive).length, 2);
  assert.equal(calls.filter((call) => !call.exhaustive).length, 2);
  const rows = db.prepare(
    "SELECT price, price_outbound, price_return, pricing_mode FROM v_flight_current ORDER BY arrival_mode"
  ).all();
  assert.deepEqual(rows.map((row) => row.price), [170, 170]);
  assert.ok(rows.every((row) => row.price_outbound == null && row.price_return == null));
  assert.ok(rows.every((row) => row.pricing_mode === "roundtrip"));
  db.close();
});

test("a thin gateway airport recovers a real, cheaper fare the broad search dropped", async () => {
  // Mirrors the real 2026-07 measurement for Val d'Isere's gateway
  // (northern-alps: GNB, GVA, LYS): a broad multi-airport search comes back
  // GVA-dominant, with GNB entirely absent even though a real, cheaper
  // Grenoble fare exists -- confirmed live via an isolated single-airport
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
    // The narrow single-airport retry this test is about: GNB, isolated.
    if (destIds === "GNB") {
      return apifyRaw([itinerary("AMS", "GNB", 230, outboundDate, "07:00", "08:35")]);
    }
    // Broad round-trip search: GVA-dominant, GNB entirely absent.
    return apifyRaw([
      itinerary("AMS", "GVA", 280, outboundDate, "08:00", "09:35"),
      itinerary("AMS", "GVA", 290, outboundDate, "10:00", "11:35"),
      itinerary("AMS", "LYS", 300, outboundDate, "09:00", "10:35"),
    ]);
  };

  const summary = await runFlightRefresh({
    db, providerNames: ["apify"], originGroupIds: ["nl"], searchProvider, delay: async () => {},
  });

  assert.equal(summary.complete, true);
  // One narrow GNB retry per arrival mode (standard + early).
  const narrowCalls = calls.filter((call) => call.destIds === "GNB");
  assert.equal(narrowCalls.length, 2);
  assert.equal(summary.recoverySearches, 2);

  const rows = db.prepare(
    "SELECT price, dep_airport, arr_airport, price_outbound, price_return, pricing_mode FROM v_flight_current ORDER BY arrival_mode"
  ).all();
  assert.equal(rows.length, 2);
  // 230 (recovered GNB round trip), not 280+ from the GVA-dominant broad
  // response the thin-airport pass corrected.
  assert.ok(rows.every((row) => row.price === 230));
  assert.ok(rows.every((row) => row.dep_airport === "AMS" && row.arr_airport === "GNB"));
  assert.ok(rows.every((row) => row.price_outbound == null && row.price_return == null));
  assert.ok(rows.every((row) => row.pricing_mode === "roundtrip"));
  db.close();
});

test("checkThinAirports: false skips the thin-airport pass entirely", async () => {
  const db = fixtureDb();
  const calls = [];
  const searchProvider = async ({ destIds, outboundDate }) => {
    calls.push({ destIds });
    return {
      provider: "apify",
      secrets: [],
      raw: {
        search_parameters: { engine: "google_flights" },
        best_flights: [itinerary("AMS", "GVA", 280, outboundDate, "08:00", "09:35")],
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
  assert.ok(calls.every((call) => call.destIds !== "GNB"));
  db.close();
});

test("fallback requests are ledgered against the provider that was actually called", async () => {
  const db = fixtureDb();
  const searchProvider = async ({ outboundDate }, provider) => {
    if (provider === "apify") throw new Error("fixture Apify outage");
    return {
      provider: "serpapi", secrets: [],
      raw: {
        search_parameters: { engine: "google_flights" },
        best_flights: [
          itinerary("AMS", "LYS", 170, outboundDate, "07:00", "08:35"),
          itinerary("LHR", "LYS", 130, outboundDate, "07:15", "08:50"),
        ],
        other_flights: [],
      },
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
  // One round-trip search per arrival mode (no separate return leg any more).
  assert.equal(summary.searched, 2);
  assert.equal(summary.providerAttempts, 4);
  assert.equal(summary.providerAttemptFailures, 2);
  assert.equal(summary.providerFallbacks, 2);
  const ledger = db.prepare(
    "SELECT provider, status, COUNT(*) n FROM flight_search GROUP BY provider, status ORDER BY provider, status"
  ).all().map((row) => ({ ...row }));
  assert.deepEqual(ledger, [
    { provider: "apify", status: "failed", n: 2 },
    { provider: "serpapi", status: "success", n: 2 },
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
  // Each arrival mode is now an independent round-trip search -- one mode's
  // providers being exhausted no longer skips the other mode entirely, so
  // both modes get their own full (apify, serpapi) attempt.
  assert.equal(failed.providerAttempts, 4);
  assert.equal(failed.status, "partial");

  const calls = [];
  const recovered = await runFlightRefresh({
    db,
    providerNames: ["apify", "serpapi"],
    originGroupIds: ["nl"],
    searchProvider: async ({ outboundDate }, provider) => {
      calls.push({ provider });
      return {
        provider,
        secrets: [],
        raw: {
          search_parameters: { engine: "google_flights" },
          best_flights: [itinerary("AMS", "LYS", 170, outboundDate, "07:00", "08:35")],
          other_flights: [],
        },
      };
    },
    delay: async () => {},
    // About exhaustion/fallback recovery, not the separate
    // thinnest-gateway-airport pass -- this fixture's LYS-only mock would
    // otherwise also trip that unrelated check too.
    checkThinAirports: false,
  });

  assert.equal(recovered.complete, true);
  assert.equal(recovered.providerAttempts, 2);
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
