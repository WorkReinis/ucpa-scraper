import test from "node:test";
import assert from "node:assert/strict";
import {
  AIRPORT_GATEWAYS, DEST_AIRPORTS, ORIGIN_AIRPORTS, gatewayForResort,
  validateResortAirportAssignments,
} from "../src/airports.mjs";
import { parseFlightResponse } from "../src/flights.mjs";

function itinerary(to, price) {
  return {
    price,
    total_duration: 120,
    flights: [{
      departure_airport: { id: "AMS", time: "2026-12-05 08:00" },
      arrival_airport: { id: to, time: "2026-12-05 10:00" },
      airline: "Example Air",
      duration: 120,
    }],
  };
}

test("every airport gateway has unique resorts and valid IATA codes", () => {
  const resorts = AIRPORT_GATEWAYS.flatMap((gateway) => gateway.resorts);
  assert.equal(new Set(resorts).size, resorts.length);
  assert.ok(DEST_AIRPORTS.every((code) => /^[A-Z]{3}$/.test(code)));
  assert.deepEqual(ORIGIN_AIRPORTS, ["AMS", "RTM"]);
  assert.deepEqual(gatewayForResort("Saint-Lary Soulan").airports, ["LDE", "TLS"]);
  assert.deepEqual(gatewayForResort("Chamonix").airports, ["GVA", "LYS"]);
  assert.deepEqual(gatewayForResort("Queyras").airports, ["MRS", "TRN"]);
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

test("airport validation rejects cross-region flight assignments", () => {
  const issues = validateResortAirportAssignments(["Saint-Lary Soulan"], [{
    resort: "Saint-Lary Soulan", gateway: "northern-alps", arr_airport: "LYS",
  }]);
  assert.equal(issues.length, 2);
});
