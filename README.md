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
3. Add `APIFY_KEY_1` (and optionally `APIFY_KEY_2..4` plus the `SERPAPI_KEY`
   fallback) under repository **Settings > Secrets and variables > Actions**.
4. Under **Settings > Pages**, choose **GitHub Actions** as the source and run
   the **Deploy GitHub Pages** workflow once.

`refresh.yml` runs daily at 07:15 Europe/Riga all year. The UCPA catalogue is
refreshed on every scheduled run; flight requests are made only when the last
quote for a date pair is six calendar days old. Its manual menu supports
catalogue-only, flight-only, both, and a non-publishing dry run. A failed scrape or build never
replaces the last deployed site or the rolling database. Successful databases
are also retained as workflow artifacts for 14 days. Flight refreshes have a
three-hour job allowance; partial provider runs do not block a fresh catalogue
deployment, but are explicitly marked partial with completed/missing cell
counts in the Actions summary.

### Import safety

Hosted catalogue refreshes validate all remote data before writing anything:

- every product card must produce a known activity, level, region, resort, title, and whole-euro price;
- each source is compared with its previous successful count, and a drop above 15% is rejected;
- any unparseable product card rejects the refresh;
- availability JSON must contain valid `offersInfo` dates, stock, duration, and whole-euro prices;
- missing images, included-item lists, or accommodation count as detail failures, with a maximum tolerated rate of 10%;
- anomalous public HTML/JSON and a scrape summary are retained as private workflow artifacts for 14 days;
- validated catalogue, week, detail, and source-count rows commit in one SQLite transaction.

Flight-provider responses (Apify actor or SerpApi) are schema-checked too.
Outbound and return are searched independently, and every segment and carrier
from both selected one-way itineraries is retained.

For a local preview of the exact hosted data path:

```bash
npm run export:static
npm run verify:static
$env:VITE_STATIC_DATA="1"; npm run build --prefix web
```

### Flight prices

Ticket prices combine the UCPA package with the cheapest viable flight pair
for the origin selected in the UI — Netherlands (AMS/RTM), London
(LHR/LGW/LTN/STN/LCY), or Basel (BSL) — to the resort's validated gateway
airports. By default the flight lands on the package's own start date
(Sunday check-in); the "Arrive a day early" toggle switches every card to a
Saturday flight for UCPA's paid early-arrival service, which also means a
whole extra riding day. Both variants of all three origins are quoted on
every refresh, so toggling in the UI is instant and never re-fetches.

Quotes come from Google Flights through an Apify actor (primary; ~$0.03 per
search, keys rotate across every `APIFY_KEY_*` by remaining free credit)
with [SerpApi](https://serpapi.com) as automatic fallback. Put keys in
`.env` at the repo root (gitignored; Node loads it natively via
`--env-file-if-exists`, no dotenv package — needs Node ≥ 22.9):

```
APIFY_KEY_1=your-apify-token
APIFY_KEY_2=...            # optional extra accounts; any APIFY_KEY_* is discovered locally
APIFY_KEY_5=...            # the hosted workflow currently exposes keys 1 through 5
SERPAPI_KEY=your-key-here  # optional fallback
```

`FLIGHT_PROVIDER=apify|serpapi` forces one provider — the rollback lever if
the actor breaks. `npm run apify:screen` shows per-account credit without
spending any.

Run `npm run flights` locally for a manual refresh. Hosted refreshes run from
the scheduled workflow; there are no public scrape or flight buttons.

Each arrival mode uses an outbound one-way search, and one shared return
one-way search supplies the shuttle-compatible return. The two prices are
added and stored as `separate`, so the card's schedule and total always refer
to the same two independently bookable tickets—even when the airlines or
airports differ. This avoids attaching an unrelated return to a round-trip
fare: the Apify actor returns Google departure tokens but cannot perform the
required follow-up request. Return rows use the same six-day freshness as
outbound fares. A full season is therefore about 105 base searches. Each date pair
queries only airports serving packages on those dates. If Google omits one
origin x resort-gateway cell—or returns candidates but none survive the
date, stop, and transfer-window filters—one deeper retry searches exactly
that cell. Apify reads a second results page; SerpApi enables hidden/deep
price-sorted results. The same feasibility rules are applied again, then the
cheapest surviving itinerary is used. Every product sharing that week shares
the resulting quote.

Searches use the Netherlands Google market, EUR prices, and at most one
connection. An outbound is rejected when it departs or arrives after the
searched calendar day, preventing an overnight itinerary from masquerading
as a valid same-day or early-arrival flight. Candidate and rejection counts
are stored with every quote so sparse broad-search results remain auditable.

Flights are only counted when their times fit the estimated resort-transfer
durations per (gateway, airport) map through shared bands
(`src/airports.mjs` `TRANSFER_BANDS`) to a latest viable landing time
(21:00 for ≤1.5 h transfers down to an 18:30 floor) and an earliest viable
return departure (10:00 up to 12:30). Availability of a transfer service is
assumed; no provider/day-of-week timetable is enforced. Editing a duration or
the band policy re-quotes automatically on the next refresh.

Quotes are append-only in `flight_price` (price history for free, like
everything else here); shared return fares and schedules live in
`flight_return_schedule`. Both halves stay fresh for six calendar days. The ledger
permits two failed attempts per actual provider-search key (including shared
return searches) in that rolling window and enforces a monthly ceiling per
provider (450 Apify runs, 225 SerpApi searches). Every fallback attempt gets
its own ledger row under the provider that was actually called.
Without a current quote, the ticket keeps its package price and links to a
manual Google Flights search.

`npm run validate:airports` reports current-policy coverage without failing
an ordinary catalogue-only deploy. `npm run validate:flights` is the strict
post-refresh gate: every expected current cell must exist and no stored
itinerary may cross the outbound date or exceed the stop policy.

## Why the schema looks like that

**`product` vs `observation` vs `week` is the whole design.** UCPA
reuses product codes across seasons — `sfavisn03` is the same Val d'Isère
full-time snowboard week it was last winter. Keep the code as the primary key
and you get year-over-year comparison for free, which is the one thing the
website will never give you. (A "week" here is a specific bookable date
range of a product -- deliberately not called a "departure" anymore, since
that word now also means a literal flight departure in the ticket data.)

`observation` (one row per product per scrape) and `week` (one row per
product **per specific week** per scrape) are both **append-only**. Never
`UPDATE` a price. Storage is trivial and you get the whole price curve, per
week, as a side effect. That's what makes "is -10% Early Booking actually
good, or does it go to -25% in January, and did that specific week ever sell
out?" an answerable question — the real reason to build this. `v_current` and
`v_week_current` give you the latest snapshot of each without thinking
about it; `v_week_listing` is the flattened product-and-week dataset exported
to the frontend.

The code itself decomposes: `sfa` + 3-letter site + variant. `sfa`**`vis`**`n03`
= Val d'Isère, `sfa`**`sla`**`n07` = Saint-Lary, `sfa`**`vth`**`ne5` = Val
Thorens. That's inferred from ~12 samples, not documented — `site_code` is stored
but treat it as a hint. `se`/`ne` in the variant seems to mark the discounted
"Happy Winter" / special-offer SKUs.

`flight_price` is separate and append-only. It is keyed by outbound and return
dates because every package sharing the same week can reuse one flight quote.

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
The tickets add the current Google Flights quote separately, while package
price filters remain based on the UCPA price alone.

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
