import { useEffect, useRef, useState } from "react";
import { getFilters, getWeeks, triggerScrape, triggerFlightRefresh } from "./api";
import FilterPanel from "./components/FilterPanel";
import ActiveFilters from "./components/ActiveFilters";
import WeekListing from "./components/WeekListing";
import TicketWeekListing from "./components/TicketWeekListing";
import TaskPanel from "./components/TaskPanel";
import useFavorites from "./useFavorites";
import { IconLayoutCompact, IconLayoutDetailed, IconSearch } from "./icons";
import "./App.css";

function fmtTimestamp(iso) {
  if (!iso) return "never";
  return new Date(iso).toLocaleString(undefined, {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// { activity: [...], level: [...], region: [...] } (src/categories.mjs) ->
// ", 2 new level(s) not yet classified" or "" when clean.
function unknownCategoriesNote(unknown) {
  if (!unknown || Object.keys(unknown).length === 0) return "";
  return `, ${Object.entries(unknown).map(([col, vals]) => `${vals.length} new ${col}(s)`).join(", ")} not yet classified`;
}

function weekKey(d) {
  return `${d.code}-${d.start_date}`;
}

// Package price alone, same fallback WeekListing uses when there's no flight
// quote yet: the flight cost just contributes nothing rather than the whole
// week dropping out of a price sort.
function totalPrice(d) {
  return d.price + (Number.isFinite(d.flight_price) ? d.flight_price : 0);
}

// Sorting never changes which weeks belong in the result set, so keep it
// entirely client-side. Besides making combined package+flight sorting
// accurate, this avoids a redundant request/loading flash on every sort.
function sortForDisplay(list, sort, includeFlightCosts) {
  if (sort === "soonest") {
    return [...list].sort((a, b) => a.start_date.localeCompare(b.start_date));
  }
  if (sort === "price_asc" || sort === "price_desc") {
    const priceOf = includeFlightCosts ? totalPrice : (week) => week.price;
    const direction = sort === "price_desc" ? -1 : 1;
    return [...list].sort((a, b) => direction * (priceOf(a) - priceOf(b)));
  }
  return list;
}

const DEFAULT_FILTERS = {
  resort: [],
  activity: [],
  tier: [],
  instructionType: [],
  minPrice: "",
  maxPrice: "",
  month: [],
  sort: "price_asc",
};

const SORTS = [
  { value: "price_asc", label: "Price ↑" },
  { value: "price_desc", label: "Price ↓" },
  { value: "soonest", label: "Soonest" },
];

const LISTINGS_PER_PAGE = 20;
// Ticket cards are now the product UI. The legacy card and its selector stay
// wired behind this flag so the comparison view can be restored without
// reconstructing it.
const SHOW_CARD_VIEW_SWITCH = false;
const SHOW_FLIGHT_COST_TOGGLE = false;

function hasActiveFilters(filters, favOnly) {
  return (
    filters.resort.length > 0 ||
    filters.activity.length > 0 ||
    filters.tier.length > 0 ||
    filters.instructionType.length > 0 ||
    filters.month.length > 0 ||
    Boolean(filters.minPrice) ||
    Boolean(filters.maxPrice) ||
    favOnly
  );
}

export default function App() {
  const [meta, setMeta] = useState(null);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [weeks, setWeeks] = useState([]);
  const [visibleWeeks, setVisibleWeeks] = useState(LISTINGS_PER_PAGE);
  const [includeFlightCosts, setIncludeFlightCosts] = useState(true);
  const [favorites, toggleFavorite] = useFavorites();
  const [favOnly, setFavOnly] = useState(false);
  const [layout, setLayout] = useState("compact");
  const [cardView, setCardView] = useState("ticket");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tasks, setTasks] = useState([]);
  const requestId = useRef(0);
  const taskIdRef = useRef(0);

  useEffect(() => {
    getFilters().then(setMeta).catch((e) => setError(e.message));
  }, []);

  const dataFilterKey = JSON.stringify({
    resort: filters.resort,
    activity: filters.activity,
    tier: filters.tier,
    instructionType: filters.instructionType,
    minPrice: filters.minPrice,
    maxPrice: filters.maxPrice,
    month: filters.month,
  });

  useEffect(() => {
    const id = ++requestId.current;
    // Debounced so a burst of changes (typing a price, clicking several
    // checkboxes in a row) settles into one request instead of one per
    // keystroke/click -- that spam of quick requests landing out of order
    // was the actual source of the flicker, not the loading indicator itself.
    const t = setTimeout(() => {
      setLoading(true);
      getWeeks({ ...JSON.parse(dataFilterKey), sort: "price_asc" })
        .then((data) => {
          if (id === requestId.current) setWeeks(data);
        })
        .catch((e) => {
          if (id === requestId.current) setError(e.message);
        })
        .finally(() => {
          if (id === requestId.current) setLoading(false);
        });
    }, 200);
    return () => clearTimeout(t);
  }, [dataFilterKey]);

  // A changed filter, sort, or the favorites-only view starts the listing
  // from the top again. This avoids carrying a previously expanded result
  // count into a new search.
  useEffect(() => {
    setVisibleWeeks(LISTINGS_PER_PAGE);
  }, [filters, favOnly]);

  // A fresh scrape or flight refresh can add data the filter panel doesn't
  // know about yet (resorts/months, lastFlightsRefreshAt), and definitely
  // changes the listing itself.
  async function reloadData() {
    const [freshMeta, freshWeeks] = await Promise.all([getFilters(), getWeeks(filters)]);
    setMeta(freshMeta);
    setWeeks(freshWeeks);
  }

  // Shared task tray for the two long-running operations (scrape, flight
  // refresh) -- both take ~1-2 min, so a disabled button alone isn't enough
  // feedback. `fn` resolves to the summary string shown once done; a done
  // task clears itself, an error sticks around until the user dismisses it
  // (missing SERPAPI_KEY etc. shouldn't just vanish after 6 seconds).
  function runTask(kind, label, fn) {
    const id = ++taskIdRef.current;
    setTasks((ts) => [...ts, { id, kind, label, status: "running", detail: null }]);
    fn()
      .then((detail) => {
        setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, status: "done", detail } : t)));
        setTimeout(() => setTasks((ts) => ts.filter((t) => t.id !== id)), 6000);
      })
      .catch((e) => {
        setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, status: "error", detail: e.message } : t)));
      });
  }

  function dismissTask(id) {
    setTasks((ts) => ts.filter((t) => t.id !== id));
  }

  function handleClearAll() {
    setFilters(DEFAULT_FILTERS);
    setFavOnly(false);
  }

  const scraping = tasks.some((t) => t.kind === "scrape" && t.status === "running");
  const flightsRefreshing = tasks.some((t) => t.kind === "flights" && t.status === "running");
  const flightsConfigured = Boolean(meta?.flightsConfigured);
  const sortedWeeks = sortForDisplay(weeks, filters.sort, includeFlightCosts);
  const favFilteredWeeks = favOnly ? sortedWeeks.filter((d) => favorites.includes(weekKey(d))) : sortedWeeks;
  const displayedWeeks = favFilteredWeeks.slice(0, visibleWeeks);
  const remainingWeeks = Math.max(favFilteredWeeks.length - displayedWeeks.length, 0);
  const showSkeleton = loading && weeks.length === 0;
  const showEmpty = !loading && favFilteredWeeks.length === 0;
  const filtersActive = hasActiveFilters(filters, favOnly);

  function handleScrape() {
    runTask("scrape", "Scraping UCPA catalogue", async () => {
      const result = await triggerScrape();
      await reloadData();
      return `${result.products} products, ${result.weeks} weeks${unknownCategoriesNote(result.unknownCategories)}`;
    });
  }

  function handleFlightsRefresh() {
    runTask("flights", "Refreshing flight prices", async () => {
      const r = await triggerFlightRefresh();
      await reloadData();
      return (
        `${r.searched} searched, ${r.skipped} still fresh` +
        (r.noResult ? `, ${r.noResult} without flights` : "") +
        (r.failed ? `, ${r.failed} failed` : "")
      );
    });
  }

  if (error) return <div className="error">Failed to load: {error}</div>;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-row">
          <div className="brand">
            <span className="logo-mark">
              <svg width="18" height="18" viewBox="0 0 32 32" fill="none" aria-hidden="true">
                <path d="M3.5 24.5 12.7 9.8l4.7 7.1 3.1-4.3 8 11.9h-25Z" fill="#fff" fillOpacity="0.96" />
                <path d="m9.8 14.4 2.9-4.6 3.1 4.7-3-1.6-3 1.5Z" fill="#b8d7ff" />
                <path d="m17.4 16.9 3.1-4.3 3 4.5-3-1.5-3.1 1.3Z" fill="#b8d7ff" />
              </svg>
            </span>
            <span className="brand-text">UCPA Tracker</span>
          </div>
          <div className="scrape-controls">
            <div className="scrape-meta">
              <span className="nav-meta">Last scrape <span>{fmtTimestamp(meta?.lastScrapedAt)}</span></span>
              <span className="nav-meta">Last flight check <span>{fmtTimestamp(meta?.lastFlightsRefreshAt)}</span></span>
            </div>
            <div className="scrape-buttons">
              <button type="button" className="nav-button" onClick={handleFlightsRefresh} disabled={flightsRefreshing || !flightsConfigured}
                title={flightsConfigured ? undefined : "Needs a SERPAPI_KEY in the server's environment"}>
                {flightsRefreshing ? "Refreshing…" : "Refresh flights"}
              </button>
              <button type="button" className="nav-button nav-button-primary" onClick={handleScrape} disabled={scraping}>
                {scraping ? "Scraping…" : "Scrape now"}
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="app">
        {meta?.unknownCategories && Object.keys(meta.unknownCategories).length > 0 && (
          <p className="notice-banner">
            UCPA catalogue has values this tracker doesn&apos;t classify yet:{" "}
            {Object.entries(meta.unknownCategories)
              .map(([col, vals]) => `${col} — ${vals.join(", ")}`)
              .join(" · ")}
            . Shown as-is (untranslated / grouped under &quot;Unrated&quot;) until added to{" "}
            <code>src/levels.mjs</code> / <code>src/categories.mjs</code>.
          </p>
        )}

        {meta && (
          <ActiveFilters
            filters={filters}
            onChange={setFilters}
            favOnly={favOnly}
            onFavOnlyChange={setFavOnly}
            onClearAll={handleClearAll}
          />
        )}

        <div className="app-body">
          {meta && (
            <FilterPanel
              meta={meta}
              value={filters}
              onChange={setFilters}
              includeFlightCosts={includeFlightCosts}
              onIncludeFlightCostsChange={setIncludeFlightCosts}
              showFlightToggle={SHOW_FLIGHT_COST_TOGGLE}
              favOnly={favOnly}
              onFavOnlyChange={setFavOnly}
              favCount={favorites.length}
            />
          )}

          <main className={`results${loading ? " results-loading" : ""}`}>
            {/* Old results stay on screen (just dimmed) while a new request is
                in flight -- only show a skeleton/empty state when there's truly
                nothing to show yet, so results never flash to empty and back. */}
            <div className="results-toolbar">
              <div className="results-toolbar-left">
                {SHOW_CARD_VIEW_SWITCH && <div className="results-view-tabs" role="tablist" aria-label="Card design">
                  <button type="button" role="tab" aria-selected={cardView === "standard"} className={cardView === "standard" ? "active" : ""} onClick={() => setCardView("standard")}>Standard</button>
                  <button type="button" role="tab" aria-selected={cardView === "ticket"} className={cardView === "ticket" ? "active" : ""} onClick={() => setCardView("ticket")}>Tickets</button>
                </div>}
                <div className="muted small">
                  {meta ? `${displayedWeeks.length} of ${favFilteredWeeks.length} listings` : "Loading…"}
                </div>
              </div>
              <div className="toolbar-controls">
                {cardView === "standard" && <div className="seg-control seg-control-icons">
                  <button type="button" className={`seg-icon-button${layout === "compact" ? " active" : ""}`} onClick={() => setLayout("compact")} title="Compact rows">
                    {IconLayoutCompact}
                  </button>
                  <button type="button" className={`seg-icon-button${layout === "detailed" ? " active" : ""}`} onClick={() => setLayout("detailed")} title="Detailed cards">
                    {IconLayoutDetailed}
                  </button>
                </div>}
                <div className="seg-control">
                  {SORTS.map((s) => (
                    <button
                      key={s.value}
                      type="button"
                      className={`seg-button${filters.sort === s.value ? " active" : ""}`}
                      onClick={() => setFilters({ ...filters, sort: s.value })}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {showSkeleton && (
              <div className="skeleton-list">
                {Array.from({ length: 5 }).map((_, i) => <div className="skeleton-card" key={i} />)}
              </div>
            )}

            {showEmpty && (
              <div className="empty-state">
                <div className="empty-state-icon">{IconSearch}</div>
                <div className="empty-state-title">
                  {favOnly && favorites.length === 0 ? "No favorites yet" : "No weeks match"}
                </div>
                <div className="empty-state-body">
                  {favOnly && favorites.length === 0
                    ? "Tap the heart on any listing to save it here for later."
                    : "Try loosening a filter or two to see more of the season."}
                </div>
                {filtersActive && (
                  <button type="button" className="clear-all-button" onClick={handleClearAll}>Clear filters</button>
                )}
              </div>
            )}

            {!showSkeleton && !showEmpty && displayedWeeks.map((d) => {
              const sharedProps = {
                d,
                includeFlightCosts,
                favorited: favorites.includes(weekKey(d)),
                onToggleFavorite: () => toggleFavorite(weekKey(d)),
              };
              return cardView === "ticket"
                ? <TicketWeekListing key={weekKey(d)} {...sharedProps} />
                : <WeekListing key={weekKey(d)} {...sharedProps} compact={layout === "compact"} />;
            })}
            {remainingWeeks > 0 && (
              <button
                type="button"
                className="load-more-button"
                onClick={() => setVisibleWeeks((count) => count + LISTINGS_PER_PAGE)}
              >
                Load more ({Math.min(remainingWeeks, LISTINGS_PER_PAGE)} more)
              </button>
            )}
          </main>
        </div>
      </div>

      <TaskPanel tasks={tasks} onDismiss={dismissTask} />
    </div>
  );
}
