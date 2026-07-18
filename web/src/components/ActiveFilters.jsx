import { monthLabel } from "../formatters";

// One row per active filter value, each removable on its own, plus a
// "Clear all". Reads the same `filters` object FilterPanel edits and calls
// the same `onChange` App.jsx already passes it -- this is just another
// view onto that state, not a second source of truth.
const LIST_GROUPS = [
  { key: "month", group: "Month", label: monthLabel },
  { key: "resort", group: "Resort" },
  { key: "activity", group: "Activity" },
  { key: "tier", group: "Level" },
  { key: "instructionType", group: "Instruction" },
];

export default function ActiveFilters({ filters, onChange, favOnly, onFavOnlyChange, onClearAll }) {
  const chips = [];

  for (const { key, group, label } of LIST_GROUPS) {
    for (const val of filters[key]) {
      chips.push({
        id: `${key}-${val}`,
        group,
        label: label ? label(val) : val,
        remove: () => onChange({ ...filters, [key]: filters[key].filter((v) => v !== val) }),
      });
    }
  }

  if (filters.minPrice || filters.maxPrice) {
    chips.push({
      id: "price",
      group: "Price",
      label: `€${filters.minPrice || "0"}–${filters.maxPrice || "∞"}`,
      remove: () => onChange({ ...filters, minPrice: "", maxPrice: "" }),
    });
  }

  if (filters.age) {
    chips.push({
      id: "age",
      group: "Age",
      label: filters.age,
      remove: () => onChange({ ...filters, age: "" }),
    });
  }

  if (favOnly) {
    chips.push({ id: "favorites", group: "View", label: "Favorites", remove: () => onFavOnlyChange(false) });
  }

  if (chips.length === 0) return null;

  return (
    <div className="active-filters">
      <span className="active-filters-label">Active</span>
      {chips.map((chip) => (
        <button type="button" key={chip.id} className="chip-pill" onClick={chip.remove}>
          <span className="chip-pill-group">{chip.group}</span>
          <span>{chip.label}</span>
          <span className="chip-pill-close" aria-hidden="true">×</span>
        </button>
      ))}
      <button type="button" className="clear-all-button" onClick={onClearAll}>Clear all</button>
    </div>
  );
}
