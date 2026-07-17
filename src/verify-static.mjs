import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open } from "./db.mjs";
import { getFiltersData, getWeeksData } from "./catalog.mjs";
import { filterCatalog } from "../web/src/staticCatalog.js";

const dataDir = path.resolve(process.argv[2] ?? "web/public/data");
const db = open(process.argv[3] ?? "ucpa.db");
const staticCatalog = JSON.parse(fs.readFileSync(path.join(dataDir, "catalog.json"), "utf8"));
const staticFilters = JSON.parse(fs.readFileSync(path.join(dataDir, "filters.json"), "utf8"));

assert.deepEqual(staticCatalog, getWeeksData(db, {}), "catalog.json differs from the live API query");
assert.deepEqual(
  staticFilters,
  getFiltersData(db, { flightsConfigured: false }),
  "filters.json differs from the live API query"
);
const filterCases = [
  { activity: ["Ski touring"] },
  { tier: ["Advanced"] },
  { resort: ["Tignes"] },
  { instructionType: ["Full coaching"] },
  { month: ["2027-01"] },
  { minPrice: "700", maxPrice: "900" },
  { activity: ["Snowboard"], tier: ["Beginner"], month: ["2026-12"] },
];
for (const filters of filterCases) {
  assert.deepEqual(
    filterCatalog(staticCatalog, filters),
    getWeeksData(db, filters),
    `static filtering differs for ${JSON.stringify(filters)}`
  );
}
console.log(`static parity verified: ${staticCatalog.length} listings`);
