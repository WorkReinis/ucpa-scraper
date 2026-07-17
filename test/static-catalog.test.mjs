import test from "node:test";
import assert from "node:assert/strict";
import { filterCatalog, filterFavoriteWeeks, matchesCatalogFilters } from "../web/src/staticCatalog.js";

const rows = [
  {
    code: "ski1", resort: "Tignes", activity_groups: ["Ski", "Ski touring"],
    tier: "Advanced", instruction_type: "full-day", start_date: "2026-12-06", price: 945,
  },
  {
    code: "snow1", resort: "Les Arcs", activity_groups: ["Snowboard"],
    tier: "Beginner", instruction_type: "half-day", start_date: "2027-01-10", price: 700,
  },
];

test("static filtering matches every hosted filter dimension", () => {
  const filters = {
    resort: ["Tignes"], activity: ["Ski touring"], tier: ["Advanced"],
    instructionType: ["full-day"], month: ["2026-12"], minPrice: "900", maxPrice: "1000",
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

test("favorites can reveal a listing beyond the first 20 results", () => {
  const manyRows = Array.from({ length: 25 }, (_, index) => ({
    code: `trip${index}`,
    start_date: "2027-01-10",
  }));
  const result = filterFavoriteWeeks(manyRows, ["trip24-2027-01-10"], true);
  assert.deepEqual(result.map((row) => row.code), ["trip24"]);
});
