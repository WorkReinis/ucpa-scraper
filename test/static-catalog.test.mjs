import test from "node:test";
import assert from "node:assert/strict";
import {
  filterCatalog, filterFavoriteWeeks, matchesCatalogFilters,
  resolveFlightQuote, selectFlightQuote, sortCatalogForDisplay,
} from "../web/src/staticCatalog.js";

const rows = [
  {
    code: "ski1", resort: "Tignes", activity_groups: ["Ski", "Ski touring"],
    tier: "Advanced", instruction_type: "full-day", start_date: "2026-12-06", price: 945,
    age_min: 18, age_max: 55,
  },
  {
    code: "snow1", resort: "Les Arcs", activity_groups: ["Snowboard"],
    tier: "Beginner", instruction_type: "half-day", start_date: "2027-01-10", price: 700,
    age_min: 18, age_max: 25,
  },
];

test("static filtering matches every hosted filter dimension", () => {
  const filters = {
    resort: ["Tignes"], activity: ["Ski touring"], tier: ["Advanced"],
    instructionType: ["full-day"], month: ["2026-12"], ageGroup: ["18-55"], minPrice: "900", maxPrice: "1000",
  };
  assert.equal(matchesCatalogFilters(rows[0], filters), true);
  assert.equal(matchesCatalogFilters(rows[1], filters), false);
  assert.deepEqual(filterCatalog(rows, filters).map((row) => row.code), ["ski1"]);
});

test("empty filters retain the complete catalogue in stable order", () => {
  assert.deepEqual(filterCatalog(rows, {}).map((row) => row.code), ["ski1", "snow1"]);
});

test("package-price filters do not include flight cost", () => {
  const withFlight = { ...rows[1], flight_price: 500 };
  assert.equal(matchesCatalogFilters(withFlight, { minPrice: "800" }), false);
});

test("age-group filtering matches UCPA's advertised brackets exactly", () => {
  assert.deepEqual(filterCatalog(rows, { ageGroup: ["18-55"] }).map((row) => row.code), ["ski1"]);
  assert.deepEqual(filterCatalog(rows, { ageGroup: ["18-25", "18-55"] }).map((row) => row.code), ["ski1", "snow1"]);
});

test("favorites can reveal a listing beyond the first 20 results", () => {
  const manyRows = Array.from({ length: 25 }, (_, index) => ({
    code: `trip${index}`,
    start_date: "2027-01-10",
  }));
  const result = filterFavoriteWeeks(manyRows, ["trip24-2027-01-10"], true);
  assert.deepEqual(result.map((row) => row.code), ["trip24"]);
});

test("flight quote selection is null-safe across origin and arrival mode", () => {
  const row = {
    price: 700,
    flight_quotes: {
      nl: { standard: { price: 224, dep_airport: "AMS", outbound_segments: [] }, early: null },
      uk: { standard: { price: 133, pricing_mode: "roundtrip", dep_airport: "LTN", outbound_segments: [] }, early: null },
    },
  };
  assert.equal(selectFlightQuote(row).price, 224);
  assert.equal(selectFlightQuote(row, "uk").price, 133);
  assert.equal(selectFlightQuote(row, "nl", true), null);   // early cell not quoted
  assert.equal(selectFlightQuote(row, "ch"), null);          // group absent entirely
  assert.equal(selectFlightQuote({ price: 700 }), null);     // no flight_quotes at all

  const resolved = resolveFlightQuote(row, "uk");
  assert.equal(resolved.flight_price, 133);
  assert.equal(resolved.flight_pricing_mode, "roundtrip");
  assert.equal(resolved.flight_dep, "LTN");
  const unquoted = resolveFlightQuote(row, "nl", true);
  assert.equal(unquoted.flight_price, null);
  assert.deepEqual(unquoted.flight_outbound_segments, []);
});

test("total-price sort order follows the selected origin's quotes", () => {
  const quotes = (nl, uk) => ({
    nl: { standard: { price: nl }, early: null },
    uk: { standard: { price: uk }, early: null },
  });
  // From NL, a is the cheaper trip; from London, b is.
  const a = { code: "a", start_date: "2026-12-06", price: 500, seats_left: 5, flight_quotes: quotes(100, 400) };
  const b = { code: "b", start_date: "2026-12-13", price: 500, seats_left: 5, flight_quotes: quotes(300, 50) };

  const order = (originGroup) => sortCatalogForDisplay(
    [a, b].map((row) => resolveFlightQuote(row, originGroup)), "price_asc", true
  ).map((row) => row.code);
  assert.deepEqual(order("nl"), ["a", "b"]);
  assert.deepEqual(order("uk"), ["b", "a"]);
});

test("explicit sold-out listings always sort after bookable listings", () => {
  const bookable = { code: "available", start_date: "2027-02-01", price: 1000, seats_left: 1 };
  const soldOutCheap = { code: "sold-cheap", start_date: "2026-12-01", price: 100, seats_left: 0 };
  const soldOutPricy = { code: "sold-pricy", start_date: "2027-01-01", price: 200, seats_left: 0 };

  for (const sort of ["price_asc", "price_desc", "soonest"]) {
    const result = sortCatalogForDisplay([soldOutCheap, bookable, soldOutPricy], sort, true);
    assert.equal(result[0].code, "available");
    assert.deepEqual(new Set(result.slice(1).map((row) => row.code)), new Set(["sold-cheap", "sold-pricy"]));
  }
});
