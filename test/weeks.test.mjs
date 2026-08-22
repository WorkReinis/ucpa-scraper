import test from "node:test";
import assert from "node:assert/strict";
import { extractReserveUrl, hasNoOffersState } from "../src/weeks.mjs";

test("a normal product page's reserve widget yields a fetchable URL", () => {
  const html = `<amp-state id="reserve" src="/api/product/123?agency=1-1-1&amp;a=b"></amp-state>`;
  assert.equal(extractReserveUrl(html), "https://www.ucpa.com/api/product/123?agency=1-1-1&a=b");
  assert.equal(hasNoOffersState(html), false);
});

test("a product with no current offers inlines its state instead of a src", () => {
  const html = '<amp-state id="reserve" class="i-amphtml-layout-container">'
    + '<script type="application/json">{"noOffersState":"complete"}</script></amp-state>';
  assert.equal(extractReserveUrl(html), null);
  assert.equal(hasNoOffersState(html), true);
});

test("a page missing the reserve widget entirely is neither case", () => {
  assert.equal(extractReserveUrl("<html></html>"), null);
  assert.equal(hasNoOffersState("<html></html>"), false);
});
