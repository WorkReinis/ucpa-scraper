import { useEffect, useRef, useState } from "react";
import { getFilters, getWeeks } from "./api";
import FilterPanel from "./components/FilterPanel";
import ActiveFilters from "./components/ActiveFilters";
import WeekListing from "./components/WeekListing";
import TicketWeekListing from "./components/TicketWeekListing";
import ChangelogPanel from "./components/ChangelogPanel";
import FilterSheet from "./components/FilterSheet";
import useFavorites from "./useFavorites";
import { filterFavoriteWeeks, resolveFlightQuote, sortCatalogForDisplay } from "./staticCatalog";
import { IconLayoutCompact, IconLayoutDetailed, IconPeak, IconPlane, IconSearch } from "./icons";
import "./App.css";

function fmtTimestamp(iso) {
  if (!iso) return "never";
  return new Date(iso).toLocaleString(undefined, {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function localClockParts(value, timeZone) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(value).filter(({ type }) => type !== "literal").map(({ type, value: part }) => [type, Number(part)])
  );
}

function formatScheduledDay(day, time) {
  const date = new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(day));
  return `${date}, ${time}`;
}

function nextDailyRefresh(now = new Date(), time = "07:15", timeZone = "Europe/Riga") {
  const parts = localClockParts(now, timeZone);
  const [runHour, runMinute] = time.split(":").map(Number);
  const localDay = Date.UTC(parts.year, parts.month - 1, parts.day);
  const hasRunToday = parts.hour > runHour || (parts.hour === runHour && parts.minute >= runMinute);
  return formatScheduledDay(localDay + (hasRunToday ? 86_400_000 : 0), time);
}

function nextFlightRefresh(lastRefresh, now = new Date(), cadenceDays = 6, time = "07:15", timeZone = "Europe/Riga") {
  if (!lastRefresh) return nextDailyRefresh(now, time, timeZone);

  const current = localClockParts(now, timeZone);
  const latest = localClockParts(new Date(lastRefresh), timeZone);
  const [runHour, runMinute] = time.split(":").map(Number);
  const today = Date.UTC(current.year, current.month - 1, current.day);
  const dueDay = Date.UTC(latest.year, latest.month - 1, latest.day) + cadenceDays * 86_400_000;
  const hasRunToday = current.hour > runHour || (current.hour === runHour && current.minute >= runMinute);
  const nextDay = dueDay > today ? dueDay : (!hasRunToday ? today : today + 86_400_000);
  return formatScheduledDay(nextDay, time);
}

function weekKey(d) {
  return `${d.code}-${d.start_date}`;
}

const DEFAULT_FILTERS = {
  resort: [],
  activity: [],
  tier: [],
  instructionType: [],
  ageGroup: [],
  minPrice: "",
  maxPrice: "",
  month: [],
  sort: "price_asc",
  // Flight-quote selection, not data filters: every row carries all
  // (origin x arrival mode) quotes, so these never trigger a re-fetch --
  // deliberately excluded from dataFilterKey below.
  originGroup: "nl",
  earlyArrival: false,
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
    filters.ageGroup.length > 0 ||
    Boolean(filters.minPrice) ||
    Boolean(filters.maxPrice) ||
    filters.earlyArrival ||
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
  const [showChangelog, setShowChangelog] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    getFilters().then(setMeta).catch((e) => setError(e.message));
  }, []);

  const dataFilterKey = JSON.stringify({
    resort: filters.resort,
    activity: filters.activity,
    tier: filters.tier,
    instructionType: filters.instructionType,
    ageGroup: filters.ageGroup,
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

  function handleClearAll() {
    // Where you fly from is a viewing preference, not a filter -- clearing
    // filters shouldn't teleport the user back to the default origin.
    setFilters({ ...DEFAULT_FILTERS, originGroup: filters.originGroup });
    setFavOnly(false);
  }

  const resolvedWeeks = weeks.map((row) => resolveFlightQuote(row, filters.originGroup, filters.earlyArrival));
  const sortedWeeks = sortCatalogForDisplay(resolvedWeeks, filters.sort, includeFlightCosts);
  const favFilteredWeeks = filterFavoriteWeeks(sortedWeeks, favorites, favOnly);
  const displayedWeeks = favFilteredWeeks.slice(0, visibleWeeks);
  const remainingWeeks = Math.max(favFilteredWeeks.length - displayedWeeks.length, 0);
  const showSkeleton = loading && weeks.length === 0;
  const showEmpty = !loading && favFilteredWeeks.length === 0;
  const filtersActive = hasActiveFilters(filters, favOnly);
  // Matches the chip count ActiveFilters renders: one per selected value, plus
  // one each for a set price range, early arrival, and the favorites view.
  const activeFilterCount =
    filters.resort.length +
    filters.activity.length +
    filters.tier.length +
    filters.instructionType.length +
    filters.month.length +
    filters.ageGroup.length +
    (filters.minPrice || filters.maxPrice ? 1 : 0) +
    (filters.earlyArrival ? 1 : 0) +
    (favOnly ? 1 : 0);
  const refreshSchedule = meta?.refreshSchedule ?? {
    time: "07:15",
    timeZone: "Europe/Riga",
    catalogueDays: 1,
    flightDays: 6,
  };

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
            <div className="brand-copy">
              <span className="brand-text">UCPA Tracker</span>
              <span className="brand-tagline">Ski, board, and the flight to get there</span>
            </div>
          </div>
          <button type="button" className="changelog-nav-button" onClick={() => setShowChangelog(true)}>
            <span className="changelog-nav-icon" aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path d="M8 2.25a5.75 5.75 0 1 1-5.3 3.52" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                <path d="M2.2 2.5v3.7h3.7M8 4.8v3.45l2.25 1.35" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span>What&apos;s new</span>
            {(meta?.changelog?.[0]?.summary.total ?? 0) > 0 && (
              <span className="changelog-nav-badge">{meta.changelog[0].summary.total}</span>
            )}
          </button>
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
                  {meta
                    ? <>{displayedWeeks.length} of {favFilteredWeeks.length}<span className="count-unit"> listings</span></>
                    : "Loading…"}
                </div>
              </div>
              <div className="toolbar-controls">
                {/* Phone-only: filter controls live in a bottom sheet instead
                    of the sidebar/rail. Hidden by CSS above 720px. */}
                <button type="button" className="filters-trigger" onClick={() => setShowFilters(true)}>
                  Filters{activeFilterCount > 0 && <span className="filters-trigger-count">{activeFilterCount}</span>}
                </button>
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
                earlyArrival: filters.earlyArrival,
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

      <footer className="app-footer">
        <div className="app-footer-row">
          <section className="refresh-tracker" aria-label="UCPA package refresh schedule">
            <span className="refresh-tracker-icon">{IconPeak}</span>
            <div className="refresh-tracker-copy">
              <div className="refresh-tracker-head">
                <strong>UCPA packages</strong>
                <span className="refresh-cadence">Daily</span>
              </div>
              <div className="refresh-tracker-times">
                <span>Updated <b>{fmtTimestamp(meta?.lastScrapedAt)}</b></span>
                <span>Next <b>{nextDailyRefresh(new Date(), refreshSchedule.time, refreshSchedule.timeZone)}</b></span>
              </div>
            </div>
          </section>
          <section className="refresh-tracker" aria-label="Flight price refresh schedule">
            <span className="refresh-tracker-icon refresh-tracker-icon-flight">{IconPlane}</span>
            <div className="refresh-tracker-copy">
              <div className="refresh-tracker-head">
                <strong>Flight prices</strong>
                <span className="refresh-cadence">Every {refreshSchedule.flightDays} days</span>
              </div>
              <div className="refresh-tracker-times">
                <span>Checked <b>{fmtTimestamp(meta?.lastFlightsRefreshAt)}</b></span>
                <span>Next <b>{nextFlightRefresh(meta?.lastFlightsRefreshAt, new Date(), refreshSchedule.flightDays, refreshSchedule.time, refreshSchedule.timeZone)}</b></span>
              </div>
            </div>
          </section>
          <div className="footer-brand">
            <div className="footer-brand-copy">
              <strong>Your next mountain week, made simpler.</strong>
              <span>
                Independent planner · Data from <a href="https://www.ucpa.com/" target="_blank" rel="noreferrer">UCPA</a> · Flights via Google Flights
              </span>
              <span className="footer-brand-attribution">
                Independent project by Reinis <i aria-hidden="true">·</i> Data from <a href="https://www.ucpa.com/" target="_blank" rel="noreferrer">UCPA</a> and flight partners <i aria-hidden="true">·</i> Figures by <a href="https://fontawesome.com/" target="_blank" rel="noreferrer">Font Awesome</a>
              </span>
            </div>
          </div>
        </div>
      </footer>

      <ChangelogPanel
        open={showChangelog}
        onClose={() => setShowChangelog(false)}
        days={meta?.changelog ?? []}
      />

      <FilterSheet
        open={showFilters}
        onClose={() => setShowFilters(false)}
        count={activeFilterCount}
        resultCount={favFilteredWeeks.length}
        onClearAll={handleClearAll}
      >
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
      </FilterSheet>

    </div>
  );
}
