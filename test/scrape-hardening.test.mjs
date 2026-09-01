import test from "node:test";
import assert from "node:assert/strict";

import { getWeeksData } from "../src/catalog.mjs";
import {
  finishRun, insertScrapeIssue, markProductDetailsFailure, open, setProductDetails,
  startRun, upsert, upsertWeek,
} from "../src/db.mjs";
import { parseDetails } from "../src/details.mjs";
import { compareLatestRuns } from "../scripts/pull-data.mjs";

const product = {
  code: "missinglevel1",
  site_code: "vis",
  url: "https://www.ucpa.com/sejour/missinglevel1-example",
  title: "Touring circuit",
  activity: "Ski de randonnée",
  level: null,
  age_min: 18,
  age_max: 55,
  country: "France",
  resort: "Val d'Isère",
  region: "Alpes du Nord",
  days: 7,
  nights: 6,
  transport_included: false,
  list_price: 1000,
  price: 900,
  discount_pct: 10,
  first_week_dm: "06/12",
};

test("detail parser reports which partial fields were genuinely present", () => {
  const parsed = parseDetails(`
    <html><head><meta property="og:image" content="https://img.example/card.jpg"></head>
    <body>
      <h4>Inclus</h4><ul><li>Guide</li></ul>
      <h4>Non Inclus</h4><ul></ul>
      <h4>Encadrement</h4><div>23h avec un guide</div>
    </body></html>
  `);
  assert.deepEqual(parsed.includes, ["Guide"]);
  assert.equal(parsed.accommodation, null);
  assert.equal(parsed.instruction_type, "Full coaching");
  assert.deepEqual(parsed.field_presence, {
    image_url: true,
    includes: true,
    excludes: true,
    options: false,
    accommodation: false,
    encadrement: true,
  });
});

test("coaching without stated hours is not mislabeled as individual", () => {
  const guideLed = parseDetails("<h4>Encadrement</h4><div>Guide de Haute Montagne.</div>");
  assert.equal(guideLed.instruction_type, null);
  const selfGuided = parseDetails("<h4>Encadrement</h4><div>Programme en autonomie</div>");
  assert.equal(selfGuided.instruction_type, "Individual (no coaching)");
});

test("detail parser supports circuit and partner accommodation layouts", () => {
  const circuit = parseDetails(`
    <h4>Hébergement</h4><div><div>2 nights in a lodge.<br>3 nights in a refuge.</div></div>
  `);
  assert.equal(circuit.accommodation, "2 nights in a lodge.\n3 nights in a refuge.");
  assert.equal(circuit.field_presence.accommodation, true);

  const partner = parseDetails(`
    <div class="custom-color">Other notes<br><br>HÉBERGEMENT : comfortable twin room<br><br>CONTACT:<br>0123</div>
  `);
  assert.equal(partner.accommodation, "comfortable twin room");
  assert.equal(partner.field_presence.accommodation, true);
});

test("partial details preserve older good fields and issues remain queryable", () => {
  const db = open(":memory:");
  const runId = startRun(db, "fixture");
  upsert(db, runId, product);
  finishRun(db, runId, 1);

  const allPresent = {
    image_url: "https://img.example/old.jpg",
    includes: ["Board"], excludes: [], options: [],
    accommodation: "Chalet", encadrement: "23h", instructor_hours: 23,
    instruction_type: "Full coaching",
    field_presence: {
      image_url: true, includes: true, excludes: true, options: true,
      accommodation: true, encadrement: true,
    },
  };
  setProductDetails(db, product.code, allPresent);
  setProductDetails(db, product.code, {
    ...allPresent,
    image_url: "https://img.example/new.jpg",
    includes: [], accommodation: null,
    field_presence: {
      image_url: true, includes: false, excludes: false, options: false,
      accommodation: false, encadrement: false,
    },
  }, ["missing included items", "missing accommodation"]);
  insertScrapeIssue(db, runId, {
    code: product.code, stage: "details", severity: "warning",
    message: "missing included items; missing accommodation",
  });

  let stored = db.prepare(
    "SELECT image_url, includes, accommodation, details_status, details_error FROM product WHERE code=?"
  ).get(product.code);
  assert.equal(stored.image_url, "https://img.example/new.jpg");
  assert.equal(stored.includes, '["Board"]');
  assert.equal(stored.accommodation, "Chalet");
  assert.equal(stored.details_status, "partial");
  assert.match(stored.details_error, /missing accommodation/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM scrape_issue").get().n, 1);

  markProductDetailsFailure(db, product.code, "HTTP 503");
  stored = db.prepare(
    "SELECT image_url, accommodation, details_status, details_error FROM product WHERE code=?"
  ).get(product.code);
  assert.equal(stored.image_url, "https://img.example/new.jpg");
  assert.equal(stored.accommodation, "Chalet");
  assert.equal(stored.details_status, "failed");
  assert.equal(stored.details_error, "HTTP 503");
  db.close();
});

test("catalogue explicitly labels missing levels and computes sold-out status", () => {
  const db = open(":memory:");
  const runId = startRun(db, "fixture");
  upsert(db, runId, product);
  upsertWeek(db, {
    code: product.code,
    start_date: "2027-01-17",
    end_date: "2027-01-23",
    price: 900,
    list_price: 1000,
    discount_pct: 10,
    status: null,
    seats_left: 0,
    booked: 5,
  });
  finishRun(db, runId, 1);

  const [listing] = getWeeksData(db);
  assert.equal(listing.level, "Not specified");
  assert.equal(listing.tier, "Unrated");
  assert.equal(listing.status, "Sold out");
  assert.equal(listing.availability_status, "sold_out");
  assert.equal(db.prepare("SELECT status FROM week").get().status, null);
  db.close();
});

test("safe data pull only replaces an older local scrape", () => {
  const local = { id: 10, started_at: "2026-08-30T10:00:00Z" };
  assert.equal(compareLatestRuns(local, { id: 11, started_at: "2026-08-31T10:00:00Z" }), "remote-newer");
  assert.equal(compareLatestRuns(local, { id: 10, started_at: local.started_at }), "same");
  assert.equal(compareLatestRuns(local, { id: 9, started_at: "2026-08-29T10:00:00Z" }), "local-newer");
  assert.equal(compareLatestRuns(null, local), "remote-newer");
  assert.throws(() => compareLatestRuns(local, null), /no completed scrape/);
});
