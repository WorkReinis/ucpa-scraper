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
