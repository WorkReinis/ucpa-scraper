// Run me FIRST:  node src/probe.mjs
//
// I could not run this from my sandbox (no egress to ucpa.com), so the fetch
// path below is unverified against the live site -- the parser is not, it is
// tested against real captured markup. Probe tells you three things in one shot:
//   1. Does the server-rendered HTML actually contain the cards? (I believe yes.)
//   2. What does a card's real DOM look like?
//   3. Is there an internal JSON API hiding in the bundle?
// Everything it finds gets written to ./probe/ so you can grep it.

import { writeFileSync, mkdirSync } from "node:fs";
import * as cheerio from "cheerio";
import { parseCard } from "./parse.mjs";

const URL_ = process.argv[2] || "https://www.ucpa.com/activites/semaine/sejour-snowboard";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const html = await fetch(URL_, {
  headers: { "user-agent": UA, "accept-language": "fr-FR,fr;q=0.9,en;q=0.8" },
}).then((r) => {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
});

mkdirSync("probe", { recursive: true });
writeFileSync("probe/listing.html", html);
console.log(`saved probe/listing.html (${(html.length / 1024).toFixed(0)} KB)\n`);

const $ = cheerio.load(html);

// --- 1. total result count (UCPA prints it in the H2) ----------------------
const total = html.match(/Nombre de résultats trouvés\s*:?\s*(\d+)/);
console.log("advertised results :", total ? total[1] : "not found");

// --- 2. the cards ----------------------------------------------------------
const links = $('a[href*="/sejour/"]').toArray();
const uniq = new Map();
for (const el of links) {
  const href = $(el).attr("href");
  const text = $(el).text();
  if (text.length > 80) uniq.set(href, text); // skip nav / "you may also like"
}
console.log("card-like <a> found:", uniq.size, "of", links.length, "total /sejour/ links\n");

if (uniq.size) {
  const [href, text] = [...uniq][0];
  console.log("--- first card, real DOM ---");
  const el = $(`a[href="${href}"]`).first();
  console.log($.html(el).slice(0, 700), "\n");
  console.log("--- first card, parsed ---");
  console.log(parseCard(href, text), "\n");
}

// --- 3. hunt for the JSON API ---------------------------------------------
// The detail page's price/date widget is client-side; its endpoint is in here
// somewhere. Same for whatever "voir plus de séjours" calls.
const scripts = $("script").toArray().map((s) => $(s).html() || "").join("\n");
writeFileSync("probe/inline-scripts.js", scripts);

const endpoints = new Set();
for (const m of (html + scripts).matchAll(
  /["'`](https?:\/\/[^"'`\s]*?(?:api|search|algolia|graphql)[^"'`\s]*|\/(?:api|_next|graphql)\/[^"'`\s]*)["'`]/gi
)) {
  endpoints.add(m[1]);
}
console.log("--- candidate endpoints in page source ---");
[...endpoints].slice(0, 40).forEach((e) => console.log("  ", e));
if (!endpoints.size) console.log("   none inline -- check the bundle, see below");

// --- 4. bundle files worth grepping ---------------------------------------
const bundles = $('script[src]').map((_, s) => $(s).attr("src")).toArray()
  .filter((s) => /\.js(\?|$)/.test(s));
console.log("\n--- JS bundles (grep these for 'disponibilit', 'tarif', 'session') ---");
bundles.slice(0, 15).forEach((b) => console.log("  ", b));

// --- 5. framework state blobs ---------------------------------------------
for (const key of ["__NEXT_DATA__", "__NUXT__", "__APOLLO_STATE__", "window.__INITIAL"]) {
  if (html.includes(key)) console.log(`\n!! found ${key} -- the whole dataset may be in there`);
}
