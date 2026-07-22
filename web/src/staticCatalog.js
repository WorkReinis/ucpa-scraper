export function matchesCatalogFilters(row, filters) {
  if (filters.resort?.length && !filters.resort.includes(row.resort)) return false;
  if (filters.activity?.length && !filters.activity.some((group) => row.activity_groups?.includes(group))) return false;
  if (filters.tier?.length && !filters.tier.includes(row.tier)) return false;
  if (filters.instructionType?.length && !filters.instructionType.includes(row.instruction_type)) return false;
  if (filters.month?.length && !filters.month.includes(row.start_date?.slice(0, 7))) return false;
  if (filters.ageGroup?.length && !filters.ageGroup.includes(`${row.age_min}-${row.age_max}`)) return false;
  if (filters.minPrice && row.price < Number(filters.minPrice)) return false;
  if (filters.maxPrice && row.price > Number(filters.maxPrice)) return false;
  return true;
}

export function filterCatalog(rows, filters) {
  return rows.filter((row) => matchesCatalogFilters(row, filters));
}

export function filterFavoriteWeeks(rows, favorites, enabled) {
  if (!enabled) return rows;
  const wanted = new Set(favorites);
  return rows.filter((row) => wanted.has(`${row.code}-${row.start_date}`));
}

/** The flight_quotes cell for an origin group + arrival mode. Null when that
 *  combination hasn't been quoted (or found nothing). */
export function selectFlightQuote(row, originGroup = "nl", earlyArrival = false) {
  return row.flight_quotes?.[originGroup]?.[earlyArrival ? "early" : "standard"] ?? null;
}

/** Flatten the selected quote back onto the row as the flight_* fields the
 *  card components read. Selection is pure client-side -- every row already
 *  carries all (origin x arrival mode) quotes nested in flight_quotes, so
 *  toggling origin or early-arrival never re-fetches. */
export function resolveFlightQuote(row, originGroup = "nl", earlyArrival = false) {
  const quote = selectFlightQuote(row, originGroup, earlyArrival);
  return {
    ...row,
    flight_price: quote?.price ?? null,
    flight_price_outbound: quote?.price_outbound ?? null,
    flight_price_return: quote?.price_return ?? null,
    flight_pricing_mode: quote?.pricing_mode ?? null,
    flight_dep: quote?.dep_airport ?? null,
    flight_arr: quote?.arr_airport ?? null,
    flight_gateway: quote?.gateway ?? null,
    flight_airline: quote?.airline ?? null,
    flight_stops: quote?.stops ?? null,
    flight_duration_min: quote?.duration_min ?? null,
    flight_fetched_at: quote?.fetched_at ?? null,
    flight_outbound_segments: quote?.outbound_segments ?? [],
    flight_return_dep: quote?.return_dep_airport ?? null,
    flight_return_arr: quote?.return_arr_airport ?? null,
    flight_return_airline: quote?.return_airline ?? null,
    flight_return_stops: quote?.return_stops ?? null,
    flight_return_duration_min: quote?.return_duration_min ?? null,
    flight_return_segments: quote?.return_segments ?? [],
    flight_details_scope: quote?.details_scope ?? null,
    flight_depart_date: quote?.outbound_date ?? null,
    flight_return_date: quote?.return_date ?? null,
  };
}

function totalPrice(row) {
  return row.price + (Number.isFinite(row.flight_price) ? row.flight_price : 0);
}

export function isSoldOut(row) {
  return Number.isFinite(Number(row.seats_left)) && Number(row.seats_left) <= 0;
}

// Sold-out weeks remain visible evidence, but never outrank a bookable week,
// regardless of the selected price/date sort.
export function sortCatalogForDisplay(rows, sort, includeFlightCosts) {
  const priceOf = includeFlightCosts ? totalPrice : (row) => row.price;
  const direction = sort === "price_desc" ? -1 : 1;
  const byPrice = sort === "price_asc" || sort === "price_desc";

  return [...rows].sort((a, b) => {
    const availabilityOrder = Number(isSoldOut(a)) - Number(isSoldOut(b));
    if (availabilityOrder !== 0) return availabilityOrder;
    // A week with no flight quote yet isn't a €0 flight -- treating it as one
    // made unquoted weeks look like the cheapest trips in the catalogue and
    // flood the top of "Price ↑". Unknown cost sorts after every known total,
    // in both price directions, the same way sold-out already outranks nothing.
    if (byPrice && includeFlightCosts) {
      const missingOrder = Number(!Number.isFinite(a.flight_price)) - Number(!Number.isFinite(b.flight_price));
      if (missingOrder !== 0) return missingOrder;
    }
    if (sort === "soonest") return a.start_date.localeCompare(b.start_date);
    if (byPrice) return direction * (priceOf(a) - priceOf(b));
    return 0;
  });
}
