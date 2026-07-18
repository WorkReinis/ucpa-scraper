export function matchesCatalogFilters(row, filters) {
  if (filters.resort?.length && !filters.resort.includes(row.resort)) return false;
  if (filters.activity?.length && !filters.activity.some((group) => row.activity_groups?.includes(group))) return false;
  if (filters.tier?.length && !filters.tier.includes(row.tier)) return false;
  if (filters.instructionType?.length && !filters.instructionType.includes(row.instruction_type)) return false;
  if (filters.month?.length && !filters.month.includes(row.start_date?.slice(0, 7))) return false;
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

  return [...rows].sort((a, b) => {
    const availabilityOrder = Number(isSoldOut(a)) - Number(isSoldOut(b));
    if (availabilityOrder !== 0) return availabilityOrder;
    if (sort === "soonest") return a.start_date.localeCompare(b.start_date);
    if (sort === "price_asc" || sort === "price_desc") {
      return direction * (priceOf(a) - priceOf(b));
    }
    return 0;
  });
}
