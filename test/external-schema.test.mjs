import test from "node:test";
import assert from "node:assert/strict";
import { parseOffers } from "../src/weeks.mjs";
import {
  cellNeedsTargetedRetry, combineDirections, mergeOriginCoverage,
  originGroupsMissingCoverage, parseFlightResponse,
} from "../src/flights.mjs";

test("availability parser rejects unknown payload shapes and invalid offers", () => {
  assert.throws(() => parseOffers({}, "abc"), /offersInfo/);
  assert.throws(() => parseOffers({ offersInfo: [] }, "abc"), /no offers/);
  assert.throws(
    () => parseOffers({ offersInfo: [{ transInc: 0, dF: "2026-12-05", price: 900 }] }, "abc"),
    /invalid offer date/
  );
});

test("availability parser validates and rounds package offers", () => {
  const { weeks } = parseOffers({
    offersInfo: [{
      transInc: 0, dF: "05/12/2026", pN: 7, price: 944.2, prePrice: 1050,
      promo: 10, available_stock: 4, booked_stock: 12, status: { message: "Available" },
    }],
  }, "abc");
  assert.equal(weeks[0].price, 945);
  assert.equal(weeks[0].start_date, "2026-12-05");
  assert.equal(weeks[0].end_date, "2026-12-12");
});

test("flight parser preserves every segment and airline of the chosen one-way", () => {
  const row = parseFlightResponse({
    search_parameters: { engine: "google_flights" },
    best_flights: [{
      price: 174.2,
      total_duration: 155,
      flights: [
        {
          departure_airport: { id: "AMS", time: "2026-12-05 08:00" },
          arrival_airport: { id: "CDG", time: "2026-12-05 09:20" },
          airline: "KLM", flight_number: "KL123", duration: 80,
        },
        {
          departure_airport: { id: "CDG", time: "2026-12-05 10:00" },
          arrival_airport: { id: "LYS", time: "2026-12-05 11:15" },
          airline: "Air France", flight_number: "AF456", duration: 75,
        },
      ],
    }],
  }, { outboundDate: "2026-12-05", returnDate: "2026-12-12" });

  assert.equal(row.price, 175);
  assert.equal(row.airline, "KLM + Air France");
  assert.equal(row.segments.length, 2);
  assert.equal(row.direction, "outbound");
  assert.equal(row.candidate_count, 1);
});

test("flight parser rejects overnight arrivals and itineraries with more than one stop", () => {
  const response = {
    search_parameters: { engine: "google_flights" },
    best_flights: [
      itineraryFor("AMS", "LYS", 90, "2026-12-05 14:30", "2026-12-06 09:10"),
      {
        price: 100,
        total_duration: 300,
        flights: [
          ...itineraryFor("AMS", "CDG", 100, "2026-12-05 07:00", "2026-12-05 08:00").flights,
          ...itineraryFor("CDG", "FRA", 100, "2026-12-05 09:00", "2026-12-05 10:00").flights,
          ...itineraryFor("FRA", "LYS", 100, "2026-12-05 11:00", "2026-12-05 12:00").flights,
        ],
      },
      itineraryFor("AMS", "LYS", 130, "2026-12-05 08:00", "2026-12-05 09:35"),
    ],
  };
  const row = parseFlightResponse(response, {
    outboundDate: "2026-12-05", returnDate: "2026-12-12",
    gateway: "northern-alps", dests: ["CMF", "GNB", "GVA", "LYS", "ZRH"],
  });
  assert.equal(row.price, 130);
  assert.equal(row.candidate_count, 3);
  assert.equal(row.date_dropped, 1);
  assert.equal(row.stops_dropped, 1);
  assert.equal(row.window_dropped, 0);
});

test("missing origin markets are identified and recovered without replacing covered cells", () => {
  const gateways = [{ id: "northern-alps" }, { id: "pyrenees" }];
  const groups = [
    { id: "nl" },
    { id: "uk" },
    { id: "ch" },
  ];
  const broad = new Map([
    ["nl|northern-alps", { candidate_count: 2, price: 90 }],
    ["nl|pyrenees", { candidate_count: 1, price: 120 }],
    ["uk|northern-alps", { candidate_count: 3, price: 70 }],
    ["uk|pyrenees", { candidate_count: 1, price: 110 }],
    ["ch|northern-alps", { candidate_count: 0, price: null }],
    ["ch|pyrenees", { candidate_count: 0, price: null }],
  ]);

  assert.deepEqual(originGroupsMissingCoverage(broad, gateways, groups).map((g) => g.id), ["ch"]);

  const recovered = new Map([
    ["ch|northern-alps", { candidate_count: 2, price: 64 }],
    ["ch|pyrenees", { candidate_count: 1, price: 98 }],
  ]);
  const merged = mergeOriginCoverage(broad, recovered, groups[2], gateways);
  assert.equal(merged.get("ch|northern-alps").price, 64);
  assert.equal(merged.get("nl|northern-alps").price, 90);
  assert.deepEqual(originGroupsMissingCoverage(merged, gateways, groups), []);
});

test("a cell with candidates but no viable fare earns one focused retry", () => {
  assert.equal(cellNeedsTargetedRetry({ candidate_count: 4, price: null, window_dropped: 4 }), true);
  assert.equal(cellNeedsTargetedRetry({ candidate_count: 0, price: null }), true);
  assert.equal(cellNeedsTargetedRetry({ candidate_count: 4, price: 190, window_dropped: 3 }), false);
});

test("separate one-way fares are added only when both exact schedules exist", () => {
  const outbound = parseFlightResponse({
    search_parameters: { engine: "google_flights" },
    best_flights: [itineraryFor("AMS", "LYS", 214, "2026-12-05 09:00", "2026-12-05 10:35")],
  }, {
    outboundDate: "2026-12-05", returnDate: "2026-12-12",
    gateway: "northern-alps", dests: ["CMF", "GNB", "GVA", "LYS", "ZRH"],
  });
  const ret = parseFlightResponse({
    search_parameters: { engine: "google_flights" },
    best_flights: [itineraryFor("LYS", "RTM", 124, "2026-12-12 12:10", "2026-12-12 13:45")],
  }, {
    outboundDate: "2026-12-12", returnDate: "2026-12-12", direction: "return",
    gateway: "northern-alps", dests: ["CMF", "GNB", "GVA", "LYS", "ZRH"],
  });

  const combined = combineDirections(outbound, ret, { pricingMode: "separate" });
  assert.equal(combined.price, 338);
  assert.equal(combined.price_outbound, 214);
  assert.equal(combined.price_return, 124);
  assert.equal(combined.pricing_mode, "separate");
  assert.equal(combined.dep_airport, "AMS");
  assert.equal(combined.return_dep_airport, "LYS");
  assert.equal(combined.return_arr_airport, "RTM");
  assert.equal(combined.details_scope, "both");
  assert.equal(combined.outbound_segments.length, 1);
  assert.equal(combined.return_segments.length, 1);

  // A viable outbound with no viable return is not a bookable trip.
  const noReturn = { ...ret, price: null, segments: [] };
  assert.equal(combineDirections(outbound, noReturn, { pricingMode: "separate" }).price, null);
  assert.equal(combineDirections(outbound, noReturn, { pricingMode: "separate" }).price_outbound, 214);

  // Token-confirmed legacy/imported round trips can still preserve their
  // single total, but production never uses this with an independent return.
  const confirmed = combineDirections(outbound, ret, { pricingMode: "roundtrip" });
  assert.equal(confirmed.price, 214);
  assert.equal(confirmed.price_outbound, null);
  assert.equal(confirmed.price_return, null);
  assert.equal(confirmed.pricing_mode, "roundtrip");
});

function itineraryFor(from, to, price, departAt, arriveAt) {
  return {
    price,
    total_duration: 95,
    flights: [{
      departure_airport: { id: from, time: departAt },
      arrival_airport: { id: to, time: arriveAt },
      airline: "Example Air",
      duration: 95,
    }],
  };
}

test("an apify actor dataset item parses identically to a SerpApi response", () => {
  // The actor mirrors SerpApi's google_flights schema; the known differences
  // are price_insights: null and extra top-level keys (all_flights,
  // booking_options). parseFlightResponse must consume it unchanged --
  // this fixture locks that provider-agnostic guarantee.
  const apifyItem = {
    search_parameters: { engine: "google_flights" },
    search_metadata: { status: "Success" },
    search_timestamp: "2026-07-19T12:00:00Z",
    page_number: 1,
    price_insights: null,
    all_flights: [],
    booking_options: [],
    best_flights: [{
      price: 224,
      total_duration: 95,
      flights: [{
        departure_airport: { id: "AMS", time: "2026-12-18 09:35" },
        arrival_airport: { id: "LYS", time: "2026-12-18 11:10" },
        airline: "KLM", flight_number: "KL 1427", duration: 95,
      }],
    }],
    other_flights: [{
      price: 133,
      total_duration: 105,
      flights: [{
        departure_airport: { id: "LTN", time: "2026-12-18 07:00" },
        arrival_airport: { id: "LYS", time: "2026-12-18 09:45" },
        airline: "Wizz Air", flight_number: "W9 5425", duration: 105,
      }],
    }],
  };
  const nl = parseFlightResponse(apifyItem, {
    outboundDate: "2026-12-18", returnDate: "2026-12-27",
    gateway: "northern-alps", dests: ["CMF", "GNB", "GVA", "LYS", "ZRH"],
    originGroup: "nl", originAirports: ["AMS", "RTM"],
  });
  assert.equal(nl.price, 224);
  assert.equal(nl.dep_airport, "AMS");
  assert.equal(nl.price_level, null); // price_insights is null on Apify rows
  const uk = parseFlightResponse(apifyItem, {
    outboundDate: "2026-12-18", returnDate: "2026-12-27",
    gateway: "northern-alps", dests: ["CMF", "GNB", "GVA", "LYS", "ZRH"],
    originGroup: "uk", originAirports: ["LHR", "LGW", "LTN", "STN", "LCY"],
  });
  assert.equal(uk.price, 133);
  assert.equal(uk.airline, "Wizz Air");
});

test("flight parser rejects an unrecognized or structurally broken response", () => {
  assert.throws(
    () => parseFlightResponse({}, { outboundDate: "2026-12-05", returnDate: "2026-12-12" }),
    /not recognizable/
  );
  assert.throws(
    () => parseFlightResponse({ best_flights: {} }, {
      outboundDate: "2026-12-05", returnDate: "2026-12-12",
    }),
    /not an array/
  );
  assert.throws(
    () => parseFlightResponse({ best_flights: [{ price: 100, flights: [{}] }] }, {
      outboundDate: "2026-12-05", returnDate: "2026-12-12",
    }),
    /expected schema/
  );
});
