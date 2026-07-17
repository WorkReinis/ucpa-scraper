import { useState } from "react";

const MONTH_NAMES = {
  "01": "Jan", "02": "Feb", "03": "Mar", "04": "Apr", "05": "May", "06": "Jun",
  "07": "Jul", "08": "Aug", "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dec",
};

export function monthLabel(ym) {
  const [y, m] = ym.split("-");
  return `${MONTH_NAMES[m] ?? m} ${y}`;
}

// Collapsed by default -- the panel grows to fit whatever the user opens
// instead of scrolling internally, so starting every group closed keeps it
// short until they actually go looking for something.
function Collapsible({ label, activeCount, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="filter-group">
      <button type="button" className="filter-group-header" onClick={() => setOpen(!open)}>
        <span className="filter-group-title">
          {label}
          {activeCount > 0 && <span className="filter-group-count">{activeCount}</span>}
        </span>
        <span className={`chevron${open ? " open" : ""}`}>&#9662;</span>
      </button>
      {open && <div className="filter-group-content">{children}</div>}
    </div>
  );
}

function Checkbox({ checked, onChange, count, children }) {
  return (
    <label className="checkbox-row">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span className="checkbox-label">{children}</span>
      {count != null && <span className="checkbox-count">{count}</span>}
    </label>
  );
}

// A real checkbox underneath, just recolored to look like a switch -- kept
// as a native input on purpose (focusable, spacebar-toggleable, announced
// correctly by screen readers), not a clickable div.
function Toggle({ checked, onChange, children }) {
  return (
    <label className="switch-row">
      <span>{children}</span>
      <input type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export default function FilterPanel({
  meta, value, onChange,
  includeFlightCosts, onIncludeFlightCostsChange,
  showFlightToggle = true,
  favOnly, onFavOnlyChange, favCount,
}) {
  const set = (patch) => onChange({ ...value, ...patch });
  const wholePrice = (key, raw) => set({ [key]: raw.replace(/\D/g, "") });
  const toggleIn = (key, opt) => {
    const list = value[key];
    set({ [key]: list.includes(opt) ? list.filter((v) => v !== opt) : [...list, opt] });
  };
  const countOf = (counts, key) => counts?.[key] ?? 0;

  return (
    <aside className="filter-panel">
      <h2>Filters</h2>

      <Collapsible label="Start month" activeCount={value.month.length}>
        {meta.months.map((m) => (
          <Checkbox key={m} checked={value.month.includes(m)} onChange={() => toggleIn("month", m)}>
            {monthLabel(m)}
          </Checkbox>
        ))}
      </Collapsible>

      <Collapsible label="Resort" activeCount={value.resort.length}>
        {Object.entries(meta.resortsByRegion).map(([region, resorts]) => (
          <div className="subgroup" key={region}>
            <div className="subgroup-label">{region}</div>
            {resorts.map((r) => (
              <Checkbox key={r} checked={value.resort.includes(r)} onChange={() => toggleIn("resort", r)} count={countOf(meta.resortCounts, r)}>
                {r}
              </Checkbox>
            ))}
          </div>
        ))}
      </Collapsible>

      <Collapsible label="Activity" activeCount={value.activity.length}>
        {meta.activities.map((a) => (
          <Checkbox key={a} checked={value.activity.includes(a)} onChange={() => toggleIn("activity", a)} count={countOf(meta.activityCounts, a)}>
            {a}
          </Checkbox>
        ))}
      </Collapsible>

      <Collapsible label="Level" activeCount={value.tier.length}>
        {meta.tiers.map((t) => (
          <Checkbox key={t} checked={value.tier.includes(t)} onChange={() => toggleIn("tier", t)} count={countOf(meta.tierCounts, t)}>
            {t}
          </Checkbox>
        ))}
      </Collapsible>

      <Collapsible label="Instruction" activeCount={value.instructionType.length}>
        {meta.instructionTypes.map((t) => (
          <Checkbox key={t} checked={value.instructionType.includes(t)} onChange={() => toggleIn("instructionType", t)} count={countOf(meta.instructionTypeCounts, t)}>
            {t}
          </Checkbox>
        ))}
      </Collapsible>

      <Collapsible label="Price" activeCount={value.minPrice || value.maxPrice ? 1 : 0}>
        <div className="range-row">
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder={meta.priceRange?.min != null ? Math.ceil(meta.priceRange.min) : "min"}
            value={value.minPrice}
            onChange={(e) => wholePrice("minPrice", e.target.value)}
          />
          <span>–</span>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder={meta.priceRange?.max != null ? Math.ceil(meta.priceRange.max) : "max"}
            value={value.maxPrice}
            onChange={(e) => wholePrice("maxPrice", e.target.value)}
          />
        </div>
      </Collapsible>

      <div className="filter-panel-switches">
        {showFlightToggle && <Toggle checked={includeFlightCosts} onChange={onIncludeFlightCostsChange}>
          Include flight costs
        </Toggle>}
        <Toggle checked={favOnly} onChange={onFavOnlyChange}>
          Favorites only{favCount > 0 && <span className="switch-count">{favCount}</span>}
        </Toggle>
      </div>
    </aside>
  );
}
