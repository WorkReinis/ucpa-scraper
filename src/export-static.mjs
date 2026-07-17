import fs from "node:fs";
import path from "node:path";
import { open } from "./db.mjs";
import { getFiltersData, getWeeksData } from "./catalog.mjs";

function arg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const outDir = path.resolve(arg("out", "web/public/data"));
const summaryPath = path.resolve(arg("summary-file", ".refresh-summary.json"));
const db = open(arg("db", "ucpa.db"));
const catalog = getWeeksData(db, {});
const filters = getFiltersData(db, { flightsConfigured: false });

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "catalog.json"), `${JSON.stringify(catalog)}\n`);
fs.writeFileSync(path.join(outDir, "filters.json"), `${JSON.stringify(filters)}\n`);

const summary = {
  products: new Set(catalog.map((row) => row.code)).size,
  listings: catalog.length,
  lastScrapedAt: filters.lastScrapedAt,
  lastFlightsRefreshAt: filters.lastFlightsRefreshAt,
  unknownCategoryGroups: Object.keys(filters.unknownCategories ?? {}).length,
  flightQuota: filters.flightQuota,
};
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));
