import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Schema design
//
// The single most important decision here: separate the *product* (what UCPA
// sells: "Snowboard Pack Plein-temps at Val d'Isere", code sfavisn03) from the
// *observation* (what it cost when you looked). UCPA reuses product codes
// season after season -- sfavisn03 was the same product last winter. That makes
// year-over-year comparison free, which is the thing the website itself will
// never let you do.
//
// observation is append-only. Never UPDATE a price; INSERT a new row. Storage
// is trivial (~100 rows/run) and you get the price curve for nothing.
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS product (
  code                TEXT PRIMARY KEY,
  site_code           TEXT,
  url                 TEXT,
  title               TEXT,
  activity            TEXT,
  level               TEXT,
  age_min             INTEGER,
  age_max             INTEGER,
  country             TEXT,
  resort              TEXT,
  region              TEXT,
  days                INTEGER,
  nights              INTEGER,
  transport_included  INTEGER,
  -- Package composition, from src/details.mjs. includes/excludes/options are
  -- JSON arrays (TEXT) -- SQLite has no array type and none of this needs
  -- SQL-side querying, just display/filter logic in JS.
  includes             TEXT,
  excludes             TEXT,
  options              TEXT,
  accommodation        TEXT,
  encadrement          TEXT,
  instructor_hours     INTEGER,
  -- Derived from instructor_hours in src/details.mjs: none / half-day / full
  -- coaching. Real hours cluster cleanly into three groups with no ambiguous
  -- values, see classifyInstruction() there.
  instruction_type     TEXT,
  first_seen          TEXT,
  last_seen           TEXT
);

CREATE TABLE IF NOT EXISTS run (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  source_url  TEXT,
  n_products  INTEGER,
  notes       TEXT
);

CREATE TABLE IF NOT EXISTS observation (
  run_id            INTEGER NOT NULL REFERENCES run(id),
  code              TEXT NOT NULL REFERENCES product(code),
  observed_at       TEXT NOT NULL,
  list_price        REAL,
  price             REAL,
  discount_pct      INTEGER,
  first_week        TEXT,
  PRIMARY KEY (run_id, code)
);
CREATE INDEX IF NOT EXISTS idx_obs_code ON observation(code, observed_at);

-- Tier 2: per-date weeks, from the product page's reserve-state API. A
-- "week" is one specific bookable date range of a product -- distinct from
-- an actual flight departure (src/flights.mjs), a separate concept this
-- codebase also tracks now, hence the deliberately different name.
-- Append-only like observation -- one row per (code, start_date, observed_at),
-- never UPDATE a price. price/list_price/discount_pct are always hors
-- transport (matches the listing cards) -- UCPA's own bundled-transport
-- prices live in week_transport below, one row per pickup city.
CREATE TABLE IF NOT EXISTS week (
  code                TEXT NOT NULL,
  start_date          TEXT NOT NULL,
  end_date            TEXT,
  price               REAL,
  list_price          REAL,
  discount_pct        INTEGER,
  status              TEXT,
  seats_left          INTEGER,
  booked              INTEGER,
  observed_at         TEXT NOT NULL,
  PRIMARY KEY (code, start_date, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_week_code ON week(code, start_date);

-- Your watchlist. Gets joined into the report.
CREATE TABLE IF NOT EXISTS watch (
  code        TEXT PRIMARY KEY,
  target_eur  REAL,
  note        TEXT
);

-- Tier 3: round-trip flight quotes (Google Flights via SerpApi, see
-- src/flights.mjs). Append-only like observation/week: one row per
-- search, never UPDATEd. Keyed on the (outbound, return) date pair rather
-- than a product -- every product sharing the same week shares one quote.
-- price NULL means "searched, Google had nothing for these dates"; the row
-- is inserted anyway so the freshness check treats the pair as covered
-- instead of re-burning API quota on it every refresh.
CREATE TABLE IF NOT EXISTS flight_price (
  origins        TEXT NOT NULL,   -- query as sent, e.g. "AMS,RTM"
  dests          TEXT NOT NULL,   -- e.g. "LYS,ZRH"
  outbound_date  TEXT NOT NULL,   -- = week.start_date
  return_date    TEXT NOT NULL,   -- = week.end_date
  fetched_at     TEXT NOT NULL,
  price          REAL,            -- cheapest round-trip total, EUR
  dep_airport    TEXT,            -- the cheapest itinerary's actual airports
  arr_airport    TEXT,
  airline        TEXT,
  stops          INTEGER,         -- outbound leg; 0 = direct
  duration_min   INTEGER,         -- outbound leg, minutes
  price_level    TEXT,            -- Google's own read: low / typical / high
  PRIMARY KEY (origins, dests, outbound_date, return_date, fetched_at)
);
CREATE INDEX IF NOT EXISTS idx_flight_dates ON flight_price(outbound_date, return_date);
`;

// Views hold no data of their own -- just saved queries -- so unlike the
// tables above they're dropped and recreated on every open(), not
// IF-NOT-EXISTS'd. An edited view definition here otherwise silently
// wouldn't take effect against an existing DB file (bit us twice already
// with the table schema and then v_week_delta before this got fixed).
const VIEWS = `
-- Latest observation per product, flattened for querying.
CREATE VIEW v_current AS
SELECT p.*, o.price, o.list_price, o.discount_pct, o.first_week, o.observed_at
FROM product p
JOIN observation o ON o.code = p.code
WHERE o.run_id = (SELECT MAX(run_id) FROM observation o2 WHERE o2.code = p.code);

-- Price moves between the two most recent observations of each product.
CREATE VIEW v_delta AS
WITH ranked AS (
  SELECT code, price, discount_pct, observed_at,
         ROW_NUMBER() OVER (PARTITION BY code ORDER BY run_id DESC) AS rn
  FROM observation
)
SELECT p.code, p.title, p.resort, p.activity, p.level,
       cur.price AS price_now, prev.price AS price_prev,
       ROUND(cur.price - prev.price, 2) AS delta_eur,
       cur.discount_pct, cur.observed_at
FROM ranked cur
JOIN ranked prev ON prev.code = cur.code AND prev.rn = 2
JOIN product p   ON p.code = cur.code
WHERE cur.rn = 1 AND cur.price IS NOT prev.price;

-- Latest scrape of each week -- re-scraping the same week on a later day
-- appends a new row (that's the whole point, see week's own comment above),
-- so anything reading "the current calendar" needs the max observed_at per
-- (code, start_date), not the raw table.
CREATE VIEW v_week_current AS
SELECT w.*
FROM week w
WHERE w.observed_at = (
  SELECT MAX(w2.observed_at) FROM week w2
  WHERE w2.code = w.code AND w2.start_date = w.start_date
);

-- Day-scoped, not scrape-scoped: with 2-3 scrapes a day, comparing against
-- the immediately-previous scrape would badge-then-unbadge within the same
-- day as a value wiggles and settles. Instead "prev" is always the last
-- observation from the most recent *earlier calendar day* -- every scrape
-- today compares against last known state as of end of yesterday (or
-- whenever it was last seen before today), so a change found at 8am still
-- shows at the 8pm scrape, and everything resets cleanly at the first scrape
-- of a new day. date() reads observed_at (UTC ISO) as a UTC calendar day.
CREATE VIEW v_week_delta AS
SELECT
  cur.code, cur.start_date,
  cur.price AS price_now, base.price AS price_prev,
  ROUND(cur.price - base.price, 2) AS delta_eur,
  cur.seats_left AS seats_now, base.seats_left AS seats_prev,
  (cur.seats_left - base.seats_left) AS seats_delta
FROM v_week_current cur
JOIN week base
  ON base.code = cur.code AND base.start_date = cur.start_date
 AND date(base.observed_at) < date(cur.observed_at)
 AND base.observed_at = (
   SELECT MAX(b2.observed_at) FROM week b2
   WHERE b2.code = cur.code AND b2.start_date = cur.start_date
     AND date(b2.observed_at) < date(cur.observed_at)
 )
WHERE cur.price IS NOT base.price OR cur.seats_left IS NOT base.seats_left;

-- Same day-scoping: "new" means no observation exists from any calendar day
-- before this week's latest one -- stays NEW across every same-day rescrape,
-- and debadges itself the moment a later day's scrape confirms it was
-- already known. Guarded on having 2+ distinct scrape days of history so
-- day one doesn't flag the whole catalogue as new against nothing.
CREATE VIEW v_week_new AS
SELECT w.code, w.start_date
FROM v_week_current w
WHERE (SELECT COUNT(DISTINCT date(started_at)) FROM run) > 1
  AND NOT EXISTS (
    SELECT 1 FROM week w2
    WHERE w2.code = w.code AND w2.start_date = w.start_date
      AND date(w2.observed_at) < date(w.observed_at)
  );

-- One row per (product, specific week) -- what the frontend actually lists.
-- Each week is its own listing ("Half-time Snowboard Package - week of
-- 06 Dec 2026"), not rolled up into a product summary, so this is a plain
-- join rather than an aggregate.
CREATE VIEW v_week_listing AS
SELECT
  w.code, w.start_date, w.end_date, w.price, w.list_price, w.discount_pct,
  w.status, w.seats_left, w.booked, w.observed_at,
  p.url, p.title, p.activity, p.level, p.age_min, p.age_max,
  p.country, p.resort, p.region, p.days, p.nights,
  p.includes, p.excludes, p.options, p.accommodation,
  p.instructor_hours, p.instruction_type
FROM v_week_current w
JOIN product p ON p.code = w.code;

-- Latest flight quote per (outbound, return) date pair -- same collapse as
-- v_week_current. Deliberately NOT keyed on origins/dests: if the
-- airport lists in src/flights.mjs ever change, fresh quotes should simply
-- supersede the old ones, not coexist with them.
CREATE VIEW v_flight_current AS
SELECT f.*
FROM flight_price f
WHERE f.fetched_at = (
  SELECT MAX(f2.fetched_at) FROM flight_price f2
  WHERE f2.outbound_date = f.outbound_date AND f2.return_date = f.return_date
);
`;

const VIEW_NAMES = ["v_current", "v_delta", "v_week_current", "v_week_delta", "v_week_new", "v_week_listing", "v_flight_current"];

// One-time migration for DB files created before the departure->week rename
// (this codebase used to call a week a "departure", which read as a literal
// flight departure once src/flights.mjs started tracking actual ones --
// hence the rename). Renaming the table preserves its scraped history
// instead of losing it to a fresh CREATE TABLE IF NOT EXISTS under the new
// name; the old view names are dropped outright since views hold no data.
function migrateLegacyNames(db) {
  const hasTable = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (hasTable("departure") && !hasTable("week")) {
    db.exec("ALTER TABLE departure RENAME TO week");
    db.exec("DROP INDEX IF EXISTS idx_departure_code");
  }
  if (hasTable("observation")) {
    const cols = db.prepare("PRAGMA table_info(observation)").all().map((c) => c.name);
    if (cols.includes("first_departure") && !cols.includes("first_week")) {
      db.exec("ALTER TABLE observation RENAME COLUMN first_departure TO first_week");
    }
  }
  // week.price_lyon (a single Lyon-only column) was superseded by
  // week_transport (every pickup city UCPA offers, Lyon included) -- see
  // that table's own comment. Drop it from DBs that predate the change;
  // the history it held isn't worth preserving since week_transport's own
  // scrape will re-populate Lyon (and everything else) going forward.
  if (hasTable("week")) {
    const cols = db.prepare("PRAGMA table_info(week)").all().map((c) => c.name);
    if (cols.includes("price_lyon")) {
      db.exec("ALTER TABLE week DROP COLUMN price_lyon");
    }
  }
  for (const name of ["v_departure_current", "v_departure_delta", "v_departure_new", "v_departure_listing"]) {
    db.exec(`DROP VIEW IF EXISTS ${name}`);
  }
  db.exec("DROP VIEW IF EXISTS v_week_transport_current");
}

export function open(path = "ucpa.db") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  // Views dropped before migrateLegacyNames, not after -- SQLite validates a
  // dependent view's column references at ALTER TABLE time, so a stale view
  // still referencing a column a migration is about to drop (e.g.
  // v_week_listing referencing week.price_lyon) blocks that migration until
  // the view is gone. Recreated below either way, so dropping early costs
  // nothing.
  for (const name of VIEW_NAMES) db.exec(`DROP VIEW IF EXISTS ${name}`);
  migrateLegacyNames(db);
  db.exec(SCHEMA);
  db.exec(VIEWS);
  return db;
}

export function startRun(db, sourceUrl, notes = null) {
  db.prepare("INSERT INTO run (started_at, source_url, notes) VALUES (?, ?, ?)").run(
    new Date().toISOString(),
    sourceUrl,
    notes
  );
  return db.prepare("SELECT last_insert_rowid() AS id").get().id;
}

export function upsert(db, runId, r) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO product (code, site_code, url, title, activity, level, age_min, age_max,
                          country, resort, region, days, nights, transport_included,
                          first_seen, last_seen)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET
       title=excluded.title, activity=excluded.activity, level=excluded.level,
       resort=excluded.resort, region=excluded.region, days=excluded.days,
       nights=excluded.nights, transport_included=excluded.transport_included,
       last_seen=excluded.last_seen`
  ).run(
    r.code, r.site_code, r.url, r.title, r.activity, r.level, r.age_min, r.age_max,
    r.country, r.resort, r.region, r.days, r.nights, r.transport_included ? 1 : 0,
    now, now
  );

  db.prepare(
    `INSERT OR REPLACE INTO observation
       (run_id, code, observed_at, list_price, price, discount_pct, first_week)
     VALUES (?,?,?,?,?,?,?)`
  ).run(runId, r.code, now, r.list_price, r.price, r.discount_pct, r.first_week_dm);
}

export function upsertWeek(db, r) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO week
       (code, start_date, end_date, price, list_price, discount_pct,
        status, seats_left, booked, observed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    r.code, r.start_date, r.end_date, r.price, r.list_price, r.discount_pct,
    r.status, r.seats_left, r.booked, now
  );
}

/** One flight quote per SerpApi search, append-only (same discipline as
 *  week). r.price null = "searched, no flights found" -- stored anyway
 *  so the freshness check in src/flights.mjs covers no-result dates too. */
export function insertFlightPrice(db, r) {
  db.prepare(
    `INSERT INTO flight_price
       (origins, dests, outbound_date, return_date, fetched_at,
        price, dep_airport, arr_airport, airline, stops, duration_min, price_level)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    r.origins, r.dests, r.outbound_date, r.return_date, new Date().toISOString(),
    r.price, r.dep_airport, r.arr_airport, r.airline, r.stops, r.duration_min, r.price_level
  );
}

/** Package composition (src/details.mjs) -- static per-product, so a plain
 *  UPDATE rather than an append-only insert. */
export function setProductDetails(db, code, d) {
  db.prepare(
    `UPDATE product SET includes=?, excludes=?, options=?, accommodation=?,
                         encadrement=?, instructor_hours=?, instruction_type=?
     WHERE code=?`
  ).run(
    JSON.stringify(d.includes ?? []), JSON.stringify(d.excludes ?? []),
    JSON.stringify(d.options ?? []), d.accommodation, d.encadrement,
    d.instructor_hours, d.instruction_type, code
  );
}

export function finishRun(db, runId, n) {
  db.prepare("UPDATE run SET n_products = ? WHERE id = ?").run(n, runId);
}
