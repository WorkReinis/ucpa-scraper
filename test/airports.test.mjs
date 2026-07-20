import test from "node:test";
import assert from "node:assert/strict";
import {
  AIRPORT_CONFIG_KEY, AIRPORT_GATEWAYS, DEST_AIRPORTS, ORIGIN_AIRPORTS, ORIGIN_GROUPS,
  TRANSFER_BANDS, earliestReturnDepartureFor, gatewayForResort, latestArrivalFor,
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

test("every airport gateway has unique resorts and valid IATA codes", () => {
  const resorts = AIRPORT_GATEWAYS.flatMap((gateway) => gateway.resorts);
  assert.equal(new Set(resorts).size, resorts.length);
  assert.ok(DEST_AIRPORTS.every((code) => /^[A-Z]{3}$/.test(code)));
  assert.deepEqual(gatewayForResort("Saint-Lary Soulan").airports, ["LDE", "TLS"]);
  assert.deepEqual(gatewayForResort("Chamonix").airports, ["GVA", "LYS"]);
  assert.deepEqual(gatewayForResort("Queyras").airports, ["MRS", "TRN", "LYS"]);
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
  assert.equal(latestArrivalFor("mont-blanc", "GVA"), "21:00");        // 1.25h
  assert.equal(earliestReturnDepartureFor("mont-blanc", "GVA"), "10:00");
  assert.equal(latestArrivalFor("northern-alps", "ZRH"), "18:30");     // 4.5h -> floor
  assert.equal(earliestReturnDepartureFor("northern-alps", "ZRH"), "12:30");
  assert.equal(latestArrivalFor("mont-blanc", "LYS"), "20:00");        // 2.5h boundary lands in <=2.5
  assert.equal(latestArrivalFor("northern-alps", "GVA"), "19:00");     // 3.0h
  assert.throws(() => latestArrivalFor("northern-alps", "XXX"), /No transfer duration/);
  assert.throws(() => earliestReturnDepartureFor("nope", "GVA"), /No transfer duration/);
  // Editing durations or bands must invalidate the freshness ledger.
  assert.ok(AIRPORT_CONFIG_KEY.includes("bands:"));
  assert.ok(AIRPORT_CONFIG_KEY.includes("ZRH=4.5"));
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
    gateway: "northern-alps", dests: ["CMF", "GNB", "GVA", "LYS", "ZRH"],
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
    gateway: "northern-alps", dests: ["CMF", "GNB", "GVA", "LYS", "ZRH"],
  });
  assert.equal(cell.price, 152);
  assert.equal(cell.window_dropped, 1);

  // The same 19:30 landing dies for northern-alps/LYS (19:00) but lives for
  // mont-blanc/LYS (20:00) -- per-(gateway, airport) windows, not global.
  const border = {
    search_parameters: { engine: "google_flights" },
    best_flights: [itinerary("LYS", 99, "AMS", { arriveAt: "2026-12-05 19:30" })],
  };
  assert.equal(parseFlightResponse(border, {
    outboundDate: "2026-12-05", returnDate: "2026-12-12",
    gateway: "northern-alps", dests: ["CMF", "GNB", "GVA", "LYS", "ZRH"],
  }).price, null);
  assert.equal(parseFlightResponse(border, {
    outboundDate: "2026-12-05", returnDate: "2026-12-12",
    gateway: "mont-blanc", dests: ["GVA", "LYS"],
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
    gateway: "northern-alps", dests: ["CMF", "GNB", "GVA", "LYS", "ZRH"],
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
    gateway: "northern-alps", dests: ["CMF", "GNB", "GVA", "LYS", "ZRH"],
  });
  assert.equal(cell.price, 120);
  assert.equal(cell.window_dropped, 0);
});

test("airport validation rejects cross-region flight assignments", () => {
  const issues = validateResortAirportAssignments(["Saint-Lary Soulan"], [{
    resort: "Saint-Lary Soulan", gateway: "northern-alps", arr_airport: "LYS",
  }]);
  assert.equal(issues.length, 2);
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
  const issues = validateResortAirportAssignments(["Saint-Lary Soulan"], [{
    resort: "Saint-Lary Soulan", gateway: "pyrenees", arr_airport: "TLS", return_dep_airport: "LYS",
  }]);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /return departs LYS/);
});
