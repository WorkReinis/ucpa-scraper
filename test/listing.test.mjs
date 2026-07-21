import test from "node:test";
import assert from "node:assert/strict";
import {
  activityFilterFromUrl, isOutOfScope, listingApiUrl, parseApiItem,
} from "../src/listing.mjs";
import { productIssues } from "../src/validation.mjs";

// Shape copied from a real /api/products item, trimmed to the fields the
// mapping reads.
const item = {
  url: "/sejour/sfavisn37-ski-pack-plein-temps-vacances",
  product_name: "Ski Pack Plein-temps",
  product_age_min: 18,
  product_age_max: 40,
  product_days_duration_including_transportation: 7,
  product_nights_duration: 6,
  expertise_level: "Ski - initié à expert",
  center_or_destination_name: "France - Val d'Isère",
  geographical_landscape: "Alpes du Nord",
  activity_name: "Ski alpin",
  price: 837,
  prediscountPrice: 930,
  discount_percentage: 10,
  transport_included: 0,
  start_date: "29/11",
};

test("a listing URL becomes the duration/activity filter behind it", () => {
  assert.deepEqual(
    activityFilterFromUrl("https://www.ucpa.com/activites/semaine/sejour-ski-alpin"),
    { duration: "semaine", activity: "ski-alpin" }
  );
  const url = listingApiUrl({ duration: "semaine", activity: "ski-alpin", start: 9 });
  const filters = JSON.parse(decodeURIComponent(new URL(url).searchParams.get("filters")));
  assert.deepEqual(filters.duration, ["semaine"]);
  assert.deepEqual(filters.activity_label, ["ski-alpin"]);
  assert.equal(new URL(url).searchParams.get("start"), "9");
  assert.throws(() => activityFilterFromUrl("https://www.ucpa.com/activites"), /cannot derive/);
});

test("an API item maps to a product row the catalogue already accepts", () => {
  const row = parseApiItem(item);
  assert.deepEqual(productIssues(row), []);
  assert.equal(row.code, "sfavisn37");
  assert.equal(row.url, "https://www.ucpa.com/sejour/sfavisn37-ski-pack-plein-temps-vacances");
  // Only the country prefix is stripped, and the landscape is its own field.
  assert.equal(row.resort, "Val d'Isère");
  assert.equal(row.region, "Alpes du Nord");
  assert.equal(row.transport_included, false);
});

test("resort names keep the spaced hyphens they contain", () => {
  for (const [destination, resort] of [
    ["France - Argentière - Vallée du Mont Blanc", "Argentière - Vallée du Mont Blanc"],
    ["France - Les Contamines - Pays du Mont Blanc", "Les Contamines - Pays du Mont Blanc"],
    ["Queyras", "Queyras"], // no country prefix at all
  ]) {
    assert.equal(parseApiItem({ ...item, center_or_destination_name: destination }).resort, resort);
  }
});

test("cent-precision fares are rounded to whole euros before storage", () => {
  const row = parseApiItem({ ...item, price: 859.5, prediscountPrice: 955.01 });
  assert.equal(row.price, 860);
  assert.equal(row.list_price, 956);
  assert.deepEqual(productIssues(row), []);
});

test("a product URL separated by a slash still yields its code", () => {
  // /sejour/44103/revival-monoski-vacances -- a hyphen-only pattern drops these.
  const row = parseApiItem({ ...item, url: "/sejour/44103/revival-monoski-vacances" });
  assert.equal(row.code, "44103");
  assert.equal(parseApiItem({ ...item, url: "/about/who-we-are" }), null);
});

test("family stays are out of scope, adult stays are not", () => {
  assert.equal(isOutOfScope(parseApiItem({ ...item, product_age_min: 3, product_age_max: 77 })), true);
  assert.equal(isOutOfScope(parseApiItem(item)), false);
  // Out of scope is not the same as malformed: the row itself is still valid.
  const family = parseApiItem({ ...item, product_age_min: 3, product_age_max: 77 });
  assert.deepEqual(productIssues(family), []);
});
