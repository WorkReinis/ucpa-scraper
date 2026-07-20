import { useEffect, useRef } from "react";

// Phone-only bottom sheet that hosts the real FilterPanel. Modeled on
// ChangelogPanel (backdrop click / Escape to close, role=dialog), but adds the
// two things a filter modal needs that the changelog drawer skips: it locks
// body scroll while open and returns focus to whatever opened it on close.
export default function FilterSheet({ open, onClose, title = "Filters", count = 0, resultCount, onClearAll, children }) {
  const panelRef = useRef(null);
  const lastFocused = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    lastFocused.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      lastFocused.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="filter-sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="filter-sheet" role="dialog" aria-modal="true" aria-label={title} ref={panelRef} tabIndex={-1}>
        <div className="filter-sheet-grab" aria-hidden="true" />
        <header className="filter-sheet-head">
          <span className="filter-sheet-title">
            {title}
            {count > 0 && <span className="filter-sheet-count">{count}</span>}
          </span>
          <button type="button" className="changelog-close" onClick={onClose} aria-label="Close filters">×</button>
        </header>

        <div className="filter-sheet-body">{children}</div>

        <footer className="filter-sheet-foot">
          <button type="button" className="filter-sheet-clear" onClick={onClearAll}>Clear all</button>
          <button type="button" className="filter-sheet-apply" onClick={onClose}>
            {resultCount == null ? "Show results" : `Show ${resultCount} result${resultCount === 1 ? "" : "s"}`}
          </button>
        </footer>
      </aside>
    </div>
  );
}
