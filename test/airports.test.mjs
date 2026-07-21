import test from "node:test";
import assert from "node:assert/strict";
import {
  AIRPORT_CONFIG_KEY, AIRPORT_GATEWAYS, DEST_AIRPORTS, ORIGIN_AIRPORTS, ORIGIN_GROUPS,
  TRANSFER_BANDS, earliestReturnDepartureFor, gatewayForRegion, latestArrivalFor,
  originGroupById, validateOriginAssignments, validateResortAirportAssignments,
} from "../src/airports.mjs";
import { parseFlightResponse } from "../src/flights.mjs";

function itinerary(to, price, from = "AMS", { departAt = "2026-12-05 08:00", arriveAt = "2026-12-05 10:00" } = {}) {
  return {
    price,
    total_duration: 120,
    flights: [{
      departure_airport: { id: from, time: departAt },
      arrival_airport: { id: to, time: arriveAt },
      airline: "Example Air",
      duration: 120,
    }],
  };
}

test("every airport gateway covers exactly one region and has valid IATA codes", () => {
  const regions = AIRPORT_GATEWAYS.map((gateway) => gateway.region);
  assert.equal(new Set(regions).size, regions.length);
  assert.ok(DEST_AIRPORTS.every((code) => /^[A-Z]{3}$/.test(code)));
  // Every resort in a region shares that region's gateway -- there is no
  // per-resort lookup any more, only per-region.
  assert.deepEqual(gatewayForRegion("Pyrénées").airports, ["LDE", "TLS"]);
  assert.deepEqual(gatewayForRegion("Alpes du Nord").airports, ["CMF", "GNB", "GVA", "LYS"]);
  assert.deepEqual(gatewayForRegion("Alpes du Sud").airports, ["GNB", "TRN", "MRS", "GVA", "LYS"]);
  assert.equal(gatewayForRegion("nope"), null);
});

test("origin groups are disjoint and flatten into ORIGIN_AIRPORTS", () => {
  const airports = ORIGIN_GROUPS.flatMap((group) => group.airports);
  assert.equal(new Set(airports).size, airports.length);
  assert.ok(airports.every((code) => /^[A-Z]{3}$/.test(code)));
  assert.deepEqual(ORIGIN_AIRPORTS, airports);
  assert.deepEqual(originGroupById("nl").airports, ["AMS", "RTM"]);
  assert.deepEqual(originGroupById("uk").airports, ["LHR", "LGW", "LTN", "STN", "LCY"]);
  assert.deepEqual(originGroupById("ch").airports, ["BSL"]);
  assert.equal(originGroupById("nope"), null);
});

test("transfer bands are complete, monotone, and floor-terminated", () => {
  // Every gateway airport carries a positive transfer duration.
  for (const gateway of AIRPORT_GATEWAYS) {
    for (const airport of gateway.airports) {
      const hours = gateway.transferHours[airport];
      assert.ok(Number.isFinite(hours) && hours > 0, `${gateway.id}/${airport} needs transferHours`);
    }
  }
  // Bands: durations ascend, latest arrival descends, earliest return
  // ascends, and the table terminates in the Infinity floor band.
  const times = (band) => [band.latestArrival, band.earliestReturnDeparture];
  for (const band of TRANSFER_BANDS) {
    assert.ok(times(band).every((value) => /^\d{2}:\d{2}$/.test(value)));
  }
  for (let i = 1; i < TRANSFER_BANDS.length; i++) {
    assert.ok(TRANSFER_BANDS[i].maxHours > TRANSFER_BANDS[i - 1].maxHours);
    assert.ok(TRANSFER_BANDS[i].latestArrival < TRANSFER_BANDS[i - 1].latestArrival);
    assert.ok(TRANSFER_BANDS[i].earliestReturnDeparture > TRANSFER_BANDS[i - 1].earliestReturnDeparture);
  }
  assert.equal(TRANSFER_BANDS.at(-1).maxHours, Infinity);
  assert.equal(TRANSFER_BANDS.at(-1).latestArrival, "18:30"); // the user-set floor
});

test("viability windows derive from transfer duration through the bands", () => {
  assert.equal(latestArrivalFor("northern-alps", "GVA"), "19:00");     // 3.0h
  assert.equal(earliestReturnDepartureFor("northern-alps", "GVA"), "11:30");
  // ZRH was cut from northern-alps (2026-07): too far a transfer, and not on
  // the established GVA/LYS ski-shuttle network. Confirm it's really gone,
  // not just unlisted.
  assert.throws(() => latestArrivalFor("northern-alps", "ZRH"), /No transfer duration/);
  // Same physical airport, two different regions: GVA is a 3.0h transfer for
  // the northern-alps gateway but a 4.0h one for southern-alps, so it gets a
  // stricter cutoff there -- the window is per (gateway, airport), grouping
  // by region doesn't collapse that back to one global number per airport.
  assert.equal(latestArrivalFor("southern-alps", "GVA"), "18:30");    // 4.0h -> floor
  assert.equal(latestArrivalFor("pyrenees", "LDE"), "21:00");         // 1.25h
  assert.throws(() => latestArrivalFor("northern-alps", "XXX"), /No transfer duration/);
  assert.throws(() => earliestReturnDepartureFor("nope", "GVA"), /No transfer duration/);
  // Editing durations or bands must invalidate the freshness ledger.
  assert.ok(AIRPORT_CONFIG_KEY.includes("bands:"));
  assert.ok(AIRPORT_CONFIG_KEY.includes("GNB=2.25"));
});

test("one multi-airport response is partitioned into resort-safe gateway quotes", () => {
  const response = {
    search_parameters: { engine: "google_flights" },
    best_flights: [itinerary("LYS", 150), itinerary("TLS", 210), itinerary("LDE", 230)],
  };
  const pyrenees = parseFlightResponse(response, {
    outboundDate: "2026-12-05",
    returnDate: "2026-12-12",
    gateway: "pyrenees",
    dests: ["LDE", "TLS"],
  });
  assert.equal(pyrenees.arr_airport, "TLS");
  assert.equal(pyrenees.price, 210);
  assert.equal(pyrenees.gateway, "pyrenees");
});

test("a mixed-origin response is split by origin group, not just gateway", () => {
  const response = {
    search_parameters: { engine: "google_flights" },
    best_flights: [
      itinerary("LYS", 133, "LTN"),
      itinerary("LYS", 224, "AMS"),
      itinerary("LYS", 199, "BSL"),
    ],
  };
  const cell = (originGroup) => parseFlightResponse(response, {
    outboundDate: "2026-12-05", returnDate: "2026-12-12",
    gateway: "northern-alps", dests: ["CMF", "GNB", "GVA", "LYS"],
    originGroup, originAirports: originGroupById(originGroup).airports,
  });
  const nl = cell("nl");
  assert.equal(nl.price, 224);
  assert.equal(nl.dep_airport, "AMS");
  assert.equal(nl.origin_group, "nl");
  assert.equal(nl.origins, "AMS,RTM");
  const uk = cell("uk");
  assert.equal(uk.price, 133);
  assert.equal(uk.dep_airport, "LTN");
  const ch = cell("ch");
  assert.equal(ch.price, 199);
  assert.equal(ch.dep_airport, "BSL");
});

test("late landings are dropped per that airport's own window", () => {
  // northern-alps: LYS cutoff 19:00 (3.0h). The cheaper 21:05 landing must
  // lose to the pricier 15:40 one, and the drop is counted for the log.
  const response = {
    search_parameters: { engine: "google_flights" },
    best_flights: [
      itinerary("LYS", 89, "AMS", { arriveAt: "2026-12-05 21:05" }),
      itinerary("LYS", 152, "AMS", { arriveAt: "2026-12-05 15:40" }),
    ],
  };
  const cell = parseFlightResponse(response, {
    outboundDate: "2026-12-05", returnDate: "2026-12-12",
    gateway: "northern-alps", dests: ["CMF", "GNB", "GVA", "LYS"],
  });
  assert.equal(cell.price, 152);
  assert.equal(cell.window_dropped, 1);

  // The same LYS airport is a 3.0h transfer for northern-alps (cutoff 19:00)
  // but a 4.0h one for southern-alps (cutoff 18:30, the floor band) -- the
  // window is per (gateway, airport), not a single global number per airport,
  // even though grouping is now by region rather than by individual resort.
  // An 18:45 landing lives for the looser gateway and dies for the stricter one.
  const border = {
    search_parameters: { engine: "google_flights" },
    best_flights: [itinerary("LYS", 99, "AMS", { arriveAt: "2026-12-05 18:45" })],
  };
  assert.equal(parseFlightResponse(border, {
    outboundDate: "2026-12-05", returnDate: "2026-12-12",
    gateway: "southern-alps", dests: ["GNB", "TRN", "MRS", "GVA", "LYS"],
  }).price, null);
  assert.equal(parseFlightResponse(border, {
    outboundDate: "2026-12-05", returnDate: "2026-12-12",
    gateway: "northern-alps", dests: ["CMF", "GNB", "GVA", "LYS"],
  }).price, 99);
});

test("return direction mirrors airports and drops too-early departures", () => {
  // Return leg: departs the gateway, lands in the origin group. GVA return
  // window for northern-alps is 11:30 (3.0h) -- the 07:40 departure dies,
  // the 11:55 one wins even though pricier.
  const response = {
    search_parameters: { engine: "google_flights" },
    best_flights: [
      itinerary("AMS", 45, "GVA", { departAt: "2026-12-12 07:40" }),
      itinerary("AMS", 72, "GVA", { departAt: "2026-12-12 11:55" }),
    ],
  };
  const cell = parseFlightResponse(response, {
    outboundDate: "2026-12-12", returnDate: "2026-12-12", direction: "return",
    gateway: "northern-alps", dests: ["CMF", "GNB", "GVA", "LYS"],
  });
  assert.equal(cell.price, 72);
  assert.equal(cell.dep_airport, "GVA");
  assert.equal(cell.arr_airport, "AMS");
  assert.equal(cell.window_dropped, 1);
});

test("itineraries with missing leg times survive the window filter", () => {
  const response = {
    search_parameters: { engine: "google_flights" },
    best_flights: [{
      price: 120,
      total_duration: 100,
      flights: [{
        departure_airport: { id: "AMS" },  // no time fields at all
        arrival_airport: { id: "LYS" },
        airline: "Example Air",
      }],
    }],
  };
  const cell = parseFlightResponse(response, {
    outboundDate: "2026-12-05", returnDate: "2026-12-12",
    gateway: "northern-alps", dests: ["CMF", "GNB", "GVA", "LYS"],
  });
  assert.equal(cell.price, 120);
  assert.equal(cell.window_dropped, 0);
});

test("airport validation rejects cross-region flight assignments", () => {
  // config_key: AIRPORT_CONFIG_KEY marks this as a freshly-fetched quote, so
  // a bad assignment here is a real bug (an issue), not a stale-policy
  // fallback (a warning) -- see the "legacy fallback" test below for that case.
  const { issues } = validateResortAirportAssignments(
    [{ resort: "Saint-Lary Soulan", region: "Pyrénées" }],
    [{
      resort: "Saint-Lary Soulan", region: "Pyrénées",
      gateway: "northern-alps", arr_airport: "LYS", config_key: AIRPORT_CONFIG_KEY,
    }]
  );
  assert.equal(issues.length, 2);
});

test("a legacy-fallback quote failing the current airport list warns instead of failing", () => {
  // Same bad pairing as above, but with no config_key (as a row predating
  // this field, or from a retired policy generation, would have) -- this is
  // exactly what happens when an airport is cut from a gateway (ZRH here):
  // old fallback rows still on display no longer fit the trimmed list.
  const { issues, warnings } = validateResortAirportAssignments(
    [{ resort: "Tignes", region: "Alpes du Nord" }],
    [{ resort: "Tignes", region: "Alpes du Nord", gateway: "northern-alps", arr_airport: "ZRH" }]
  );
  assert.deepEqual(issues, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ZRH is not allowed/);
});

test("an unmapped region warns without failing, a mis-mapped one still fails", () => {
  // Nothing can attach a quote to a region with no gateway -- runFlightRefresh
  // skips it -- so incomplete coverage must not read as a corrupt catalogue.
  // "Alpes du Nord/Sud/Pyrénées" are the only regions UCPA's catalogue
  // currently uses, all three covered, so a genuinely unmapped case needs a
  // region that doesn't exist in the live data.
  const unmapped = validateResortAirportAssignments(
    [{ resort: "Nowhere Peak", region: "Alpes du Milieu" }], []
  );
  assert.deepEqual(unmapped.issues, []);
  assert.equal(unmapped.warnings.length, 1);
  assert.match(unmapped.warnings[0], /unmapped region/);

  const mapped = validateResortAirportAssignments(
    [{ resort: "Saint-Lary Soulan", region: "Pyrénées" }], []
  );
  assert.deepEqual(mapped.issues, []);
  assert.deepEqual(mapped.warnings, []);
});

test("origin validation rejects a departure outside its own group", () => {
  assert.deepEqual(validateOriginAssignments([
    { origin_group: "nl", dep_airport: "AMS", return_arr_airport: "RTM" },
  ]), []);
  const issues = validateOriginAssignments([
    { origin_group: "nl", dep_airport: "LTN" },
    { origin_group: "unknown-group", dep_airport: "AMS" },
    { origin_group: "nl", dep_airport: "AMS", return_arr_airport: "LGW" },
  ]);
  assert.equal(issues.length, 3);
  assert.match(issues[0], /LTN is not allowed/);
  assert.match(issues[1], /unknown origin group/);
  assert.match(issues[2], /return lands at LGW/);
});

test("gateway validation rejects a return departing outside the gateway", () => {
  const { issues } = validateResortAirportAssignments(
    [{ resort: "Saint-Lary Soulan", region: "Pyrénées" }],
    [{
      resort: "Saint-Lary Soulan", region: "Pyrénées", config_key: AIRPORT_CONFIG_KEY,
      gateway: "pyrenees", arr_airport: "TLS", return_dep_airport: "LYS",
    }]
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0], /return departs LYS/);
});
