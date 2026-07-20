// The /api/* route logic, shared between the two ways this app gets served:
// src/server.mjs (production -- serves web/dist, needs `npm run build` first)
// and web/dev-server.mjs (day-to-day dev -- Vite in middleware mode, hot
// reload, no build step). Both just call createApiApp() and mount whatever
// serves the frontend after it.

import express from "express";
import { open } from "./db.mjs";
import { runScrape } from "./scrape.mjs";
import { runFlightRefresh } from "./flights.mjs";
import { getFiltersData, getWeeksData } from "./catalog.mjs";
import { configuredProviders } from "./providers/index.mjs";

// Reads ucpa.db directly on every request -- there's no caching layer because
// there's no need for one: a few hundred rows, one scrape a day.
export function createApiApp() {
  const db = open();
  const app = express();

  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    next();
  });

  // Distinct filter values, grouped where the frontend groups them (resorts by
  // mountain range, levels by skill tier) so it doesn't have to re-derive the
  // grouping itself -- built from what's actually in the DB, not a hardcoded
  // list that drifts as UCPA adds/removes products.
  app.get("/api/filters", (req, res) => {
    res.json(getFiltersData(db, { flightsConfigured: configuredProviders().length > 0 }));
  });

  // The primary listing: one row per (product, specific week), not grouped by
  // product -- filters apply directly against each week's own price/date/seats.
  // Explicit zero-stock weeks are returned after bookable weeks so the UI can
  // show genuine sell-outs. We do not infer sold-out from a missing offer.
  app.get("/api/weeks", (req, res) => {
    res.json(getWeeksData(db, req.query));
  });

  // Runs the real scraper against the live site (~1-2 minutes for the current
  // catalogue, same DELAY_MS-paced requests as the CLI -- see src/scrape.mjs).
  // One at a time: `scraping` guards against a double-click firing two
  // overlapping scrapes, which would both hammer UCPA and race on SQLite
  // writes. The request just blocks until it's done -- simplest thing that
  // works for a single-user tool, no job queue or websocket needed.
  let scraping = false;
  app.post("/api/scrape", async (req, res) => {
    if (scraping) return res.status(409).json({ error: "a scrape is already running" });
    scraping = true;
    try {
      const result = await runScrape({ db });
      res.json(result);
    } catch (e) {
      console.error("scrape failed:", e);
      res.status(500).json({ error: e.message });
    } finally {
      scraping = false;
    }
  });

  // Same shape as /api/scrape: one at a time, request blocks until done.
  // ~25-40 SerpApi searches on a cold season. The rolling six-day freshness
  // window and monthly quota in src/flights.mjs do the real throttling.
  let refreshingFlights = false;
  app.post("/api/flights/refresh", async (req, res) => {
    if (refreshingFlights) return res.status(409).json({ error: "a flight refresh is already running" });
    refreshingFlights = true;
    try {
      const result = await runFlightRefresh({ db });
      res.json(result);
    } catch (e) {
      console.error("flight refresh failed:", e);
      res.status(500).json({ error: e.message });
    } finally {
      refreshingFlights = false;
    }
  });

  return app;
}
