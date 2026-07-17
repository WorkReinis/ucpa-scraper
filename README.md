# ucpa-tracker

Scrapes the UCPA catalogue into SQLite so you can filter it like an adult,
watch prices move over the season, and see it all in a small React app.

## What the site actually is

| Layer | Rendering | Scrapable? |
|---|---|---|
| Listing cards (title, resort, level, age, "from" price, discount, first bookable week, duration) | **Server-rendered HTML** | Yes, trivially |
| Product page prose (includes/excludes, instructor hours, accommodation, transfer info) | **Server-rendered HTML** | Yes — `src/details.mjs` |
| Per-date week prices + availability | **Client-side XHR** | Yes — `src/weeks.mjs` |
| "Voir plus de séjours" pagination | **Probably XHR** | Not solved, see below |

The per-date calendar (the thing that actually makes this app useful — exact
price and real remaining seats for each week, Nov through April) comes from
one endpoint every product page embeds:

```
<amp-state id="reserve" src="/api/product/{internal_id}?agency=1-1-1&...">
```

Plain unauthenticated GET, no cookies. `src/weeks.mjs` fetches the
product page, regexes out that URL, and fetches it — no per-product DevTools
work needed, it's fully automatic. The `"Bouhhh... C'est complet !"` text you
sometimes see server-rendered on a product page is that widget's empty state
before the fetch fires, not a real sold-out flag; the JSON is authoritative
(`available_stock` is the live remaining-seats count — UCPA's own "Plus que 2
places disponibles" warning fires exactly when it hits 2).

Listing pagination (`?page=2`) is still inert — it's XHR-backed and not
reverse-engineered. Not a problem in practice: each of the three source
listings (snowboard / hors-piste / splitboard) fits on one page.

## Quickstart

```bash
npm install
node seed.mjs           # loads 9 real cards I captured, no network — sanity check
node src/report.mjs     # see the filtering work
rm ucpa.db              # then go live:
node src/scrape.mjs --dry
node src/scrape.mjs     # writes a run into ucpa.db, incl. weeks + package details
```

Then daily:

```bash
0 7 * * *  cd /path/to/ucpa-tracker && node src/scrape.mjs >> scrape.log 2>&1
```

`node src/report.mjs --moves` shows what changed since the previous run.

## Frontend

```bash
npm run server           # API on http://localhost:8787, reads ucpa.db directly
npm run web               # Vite dev server, proxies /api to the server above
```

Filter by resort, activity, level, age, price (hors transport), start
month, "has an open week", "has a Lyon transport option". Each result expands
into its full week calendar (price/seats per week) and what's actually
included (equipment, meals, instructor hours, accommodation).

For a single deployable process: `npm run build --prefix web`, then
`npm run server` alone serves both the API and the built site.

## GitHub Pages hosting

The hosted app is a static snapshot: GitHub Actions runs the same SQLite
scraper, exports `catalog.json` and `filters.json`, then deploys the React
build to GitHub Pages. Filtering, sorting, favorites, and the 20-row load-more
pagination happen in the browser. The SQLite database itself is never
published.

One-time setup after creating a public GitHub repository:

1. Push the application to the repository's `main` branch.
2. Run `npm run data:init` locally to seed the rolling `data` branch from the
   current `ucpa.db` history.
3. Add `SERPAPI_KEY` under repository **Settings > Secrets and variables >
   Actions**.
4. Under **Settings > Pages**, choose **GitHub Actions** as the source and run
   the **Deploy GitHub Pages** workflow once.

`refresh.yml` runs daily at 07:15 Europe/Riga from August through April and
weekly from May through July. Its manual menu supports catalogue-only,
flight-only, both, and a non-publishing dry run. A failed scrape or build never
replaces the last deployed site or the rolling database. Successful databases
are also retained as workflow artifacts for 14 days.

For a local preview of the exact hosted data path:

```bash
npm run export:static
npm run verify:static
$env:VITE_STATIC_DATA="1"; npm run build --prefix web
```

### Flight prices (Trip cost tab)

The frontend's second tab shows each week's true cost from the Netherlands:
package price + the cheapest round-trip flight (Amsterdam/Rotterdam →
Lyon/Geneva/Zurich/Turin/Toulouse, flying out the day before each week
starts), quoted from Google Flights via [SerpApi](https://serpapi.com) —
free tier, 250 searches/month.

Put the key in `.env` at the repo root (gitignored; Node loads it natively
via `--env-file-if-exists`, no dotenv package — needs Node ≥ 22.9):

```
SERPAPI_KEY=your-key-here
```

```bash
npm run server    # picks up .env; tab's "Refresh flights" button now works
npm run flights   # same refresh from the CLI
```

One search prices the whole airport cross-product (2 origins × 5
destinations) for one (start, end) date pair at once, and every product
sharing that week shares the quote — the current catalogue is 22 distinct
weeks across the whole Nov–Apr season, so ~11 full refreshes fit in a free
month.
Quotes are append-only in `flight_price` (price history for free, like
everything else here); pairs quoted within the last 24h are skipped, so the
button is safe to spam. Without `SERPAPI_KEY` the tab still renders with
package-only prices and a banner.

Zurich caveat: UCPA never offers Swiss pickups and no shuttle company serves
these resorts from Zurich (`src/airports.mjs`), so a ZRH-arriving quote is
flagged "own transfer needed" — cheapest flight ≠ cheapest door-to-door.
Geneva/Turin/Toulouse don't need that flag: each is a real shuttle-served
airport for at least one current resort, with actual scheduled AMS/RTM
service confirmed live — Geneva (Chamonix, Val d'Isère, Tignes, Val Thorens,
Les Arcs), Turin (Grand Serre Chevalier, via direct KLM flights + Linkbus'
Turin–Briançon–Serre Chevalier shuttle), Toulouse (Saint-Lary Soulan, via
KLM/Transavia/budget carriers + the seasonal "SkiGo" ski-shuttle coach).
Grenoble was the other Serre-Chevalier-area candidate — it has a real
shuttle market too, but it's a UK/Poland charter airport with no
Amsterdam/Rotterdam service, so it's not in `DEST_AIRPORTS`.

## Why the schema looks like that

**`product` vs `observation` vs `week` is the whole design.** UCPA
reuses product codes across seasons — `sfavisn03` is the same Val d'Isère
full-time snowboard week it was last winter. Keep the code as the primary key
and you get year-over-year comparison for free, which is the one thing the
website will never give you. (A "week" here is a specific bookable date
range of a product -- deliberately not called a "departure" anymore, since
that word now also means a literal flight departure once the Trip cost tab
started tracking real ones; see below.)

`observation` (one row per product per scrape) and `week` (one row per
product **per specific week** per scrape) are both **append-only**. Never
`UPDATE` a price. Storage is trivial and you get the whole price curve, per
week, as a side effect. That's what makes "is -10% Early Booking actually
good, or does it go to -25% in January, and did that specific week ever sell
out?" an answerable question — the real reason to build this. `v_current` and
`v_week_current` give you the latest snapshot of each without thinking
about it; `v_product_summary` (what the frontend queries) rolls each
product's weeks up into "cheapest open week / how many sold out /
soonest available."

The code itself decomposes: `sfa` + 3-letter site + variant. `sfa`**`vis`**`n03`
= Val d'Isère, `sfa`**`sla`**`n07` = Saint-Lary, `sfa`**`vth`**`ne5` = Val
Thorens. That's inferred from ~12 samples, not documented — `site_code` is stored
but treat it as a hint. `se`/`ne` in the variant seems to mark the discounted
"Happy Winter" / special-offer SKUs.

**Every UCPA transport pickup city is captured, not just Lyon.** UCPA
bundles optional transport from ~20 cities — French domestic (Paris, Lyon,
Clermont-Ferrand, Mulhouse, Toulouse...) plus occasional Belgian/
Luxembourgish ones (Brussels, Luxembourg) — one priced offer per city per
date, each a complete "package + that city's transport" total, not a
supplement on top. `week_transport` (`src/db.mjs`) holds one row per
(product, week, city); Zurich is never one of them (UCPA doesn't run Swiss
pickups at all). Brussels/Luxembourg are the interesting ones for a
Netherlands traveler — close enough that the sensible way there is the train
UCPA already bundles, not a flight, so they need no `flights.mjs` support at
all to be useful.

## Parsing

`parse.mjs` deliberately ignores CSS classes and anchors on the href plus stable
French label text (`à partir de`, `dès le`, `hors transport`, `France`). UCPA's
class names are machine-generated and will churn; the copy won't. Tested
against real captured cards (`src/fixture.mjs`) and handles the traps:

- `dès le 29/117 jours` — no separator between date and duration, so a naive
  `/(\d+) jours/` reads the duration as **117**.
- `Ski - initié à experti Ski - ...` — the tooltip marker is a bare `i`, and
  "Ski" itself ends in `i `. Needs a backreference to find the real boundary.
- `France - Saint-Lary Soulan - Pyrénées` — split on spaced hyphens only.
- Two different card layouts exist: "Pack" cards read TITLE, age, TITLE
  (again), location; hors-piste/Découverte cards read age, TITLE (once),
  location — no repeated title at all. Anchoring on the literal `France`
  breadcrumb instead of the (sometimes absent) repeated title handles both.

If the site redesigns, `probe.mjs` prints a parsed card next to its real DOM so
you can see what broke in one look.

## Two things the filters already caught

**The loud discounts are age-gated.** The -43% and -39% headline offers at Val
d'Isère are `18-25 ans` ("Happy Winter"). At 33 you're not eligible, so the real
menu is the `18-40` products at a flat -10% Early Booking. The report prints this
as a footnote rather than silently dropping them.

**Rankings by package price are fiction.** Every UCPA price is *hors transport*.
Saint-Lary at 499 € looks like it beats Val d'Isère at 837 € by a mile; add a
Pyrenees transfer from Den Haag (~420 €) against rail-to-Bourg-St-Maurice
(~260 €) and it's 960 vs 998 — a rounding error. Fill in `TRAVEL_FROM_NL` in
`report.mjs` with real quotes and the sort order starts meaning something.
(`week_transport` is the piece of this UCPA prices for you directly, for
every city it offers a pickup from — and the Trip cost tab now automates the
flight half with live Google Flights quotes, see above.)

Also note `Ski ou snowboard Pack Mini` is filed under `activity = Ski alpin` but
takes boarders — filtering on the activity column alone loses it. The filter
matches on title too.

## Manners

Rate limited to 1 req/1.5s. A full run is ~3 listing requests plus 2 requests
per product (page + reserve-state JSON) — around 50 requests for the current
~22-product snowboard/splitboard catalogue, spread over roughly a minute.
That's still less traffic than one person browsing product-by-product. Keep
it there: don't parallelise, don't poll more than daily, don't redistribute
the data. This is personal price monitoring of public pages, but UCPA's CGI
are the CGI — worth a skim if you ever plan to make it public.
