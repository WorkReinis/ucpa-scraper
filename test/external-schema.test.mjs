import test from "node:test";
import assert from "node:assert/strict";
import { parseOffers } from "../src/weeks.mjs";
import { parseFlightResponse } from "../src/flights.mjs";

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

test("flight parser preserves every outbound segment and airline without claiming return details", () => {
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
  assert.equal(row.outbound_segments.length, 2);
  assert.equal(row.details_scope, "outbound");
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
