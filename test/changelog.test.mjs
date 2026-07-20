import test from "node:test";
import assert from "node:assert/strict";
import { open } from "../src/db.mjs";
import { getChangelogData } from "../src/catalog.mjs";

test("changelog groups new listings and daily price/seat changes", () => {
  const db = open(":memory:");
  db.exec(`
    INSERT INTO product (code, title, resort, first_seen, last_seen)
    VALUES
      ('known', 'Known package', 'Chamonix', '2026-07-15T07:00:00Z', '2026-07-16T07:00:00Z'),
      ('small', 'Small movement', 'Chamonix', '2026-07-15T07:00:00Z', '2026-07-16T07:00:00Z'),
      ('minor', 'Minor seat movement', 'Tignes', '2026-07-15T07:00:00Z', '2026-07-16T07:00:00Z'),
      ('restock', 'Back again', 'Tignes', '2026-07-15T07:00:00Z', '2026-07-16T07:00:00Z'),
      ('soldout', 'Now gone', 'Tignes', '2026-07-15T07:00:00Z', '2026-07-16T07:00:00Z'),
      ('new', 'New package', 'Tignes', '2026-07-16T07:00:00Z', '2026-07-16T07:00:00Z');
    INSERT INTO run (started_at, n_products) VALUES
      ('2026-07-15T07:00:00Z', 5),
      ('2026-07-16T07:00:00Z', 6);
    INSERT INTO week
      (code, start_date, end_date, price, seats_left, observed_at)
    VALUES
      ('known', '2027-01-03', '2027-01-09', 500, 5, '2026-07-15T07:00:00Z'),
      ('known', '2027-01-03', '2027-01-09', 520, 2, '2026-07-16T07:00:00Z'),
      ('small', '2027-01-10', '2027-01-16', 500, 5, '2026-07-15T07:00:00Z'),
      ('small', '2027-01-10', '2027-01-16', 509, 5, '2026-07-16T07:00:00Z'),
      ('minor', '2027-01-17', '2027-01-23', 500, 54, '2026-07-15T07:00:00Z'),
      ('minor', '2027-01-17', '2027-01-23', 500, 53, '2026-07-16T07:00:00Z'),
      ('restock', '2027-01-24', '2027-01-30', 500, 0, '2026-07-15T07:00:00Z'),
      ('restock', '2027-01-24', '2027-01-30', 500, 1, '2026-07-16T07:00:00Z'),
      ('soldout', '2027-01-31', '2027-02-06', 500, 1, '2026-07-15T07:00:00Z'),
      ('soldout', '2027-01-31', '2027-02-06', 500, 0, '2026-07-16T07:00:00Z'),
      ('new', '2027-02-07', '2027-02-13', 600, 8, '2026-07-16T07:00:00Z');
  `);

  const changelog = getChangelogData(db);
  assert.equal(changelog[0].day, "2026-07-16");
  assert.deepEqual(changelog[0].summary, {
    newListings: 1,
    priceChanges: 1,
    availabilityChanges: 2,
    total: 4,
  });
  assert.deepEqual(changelog[0].events.map((event) => event.kind), ["new", "sold_out", "restocked", "price"]);
  const knownEvent = changelog[0].events.find((event) => event.code === "known");
  assert.equal(knownEvent.previousPrice, 500);
  assert.equal(knownEvent.price, 520);
  assert.equal(knownEvent.previousSeats, 5);
  assert.equal(knownEvent.seats, 2);
  assert.equal(knownEvent.seatsChanged, false);
  assert.ok(!changelog[0].events.some((event) => event.code === "small"));
  assert.ok(!changelog[0].events.some((event) => event.code === "minor"));
  assert.equal(changelog[0].events.find((event) => event.code === "restock").seats, 1);
  assert.equal(changelog[0].events.find((event) => event.code === "soldout").seats, 0);
  assert.equal(changelog[1].summary.total, 0); // initial import is the baseline
  db.close();
});
