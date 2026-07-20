import { useEffect } from "react";

function formatDay(day) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: "UTC",
  }).format(new Date(`${day}T12:00:00Z`));
}

function formatWeek(startDate) {
  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit", month: "short", year: "numeric", timeZone: "UTC",
  }).format(new Date(`${startDate}T12:00:00Z`));
}

function eventCopy(event) {
  if (event.kind === "new") return `New departure · €${event.price}`;
  if (event.kind === "sold_out") return "Sold out";
  if (event.kind === "restocked") return `Available again · ${event.seats} seats`;
  const parts = [];
  if (event.priceChanged) parts.push(`€${event.previousPrice} → €${event.price}`);
  if (event.seatsChanged) parts.push(`${event.previousSeats} → ${event.seats} seats`);
  return parts.join(" · ");
}

function EventIcon({ kind }) {
  if (kind === "new") return <span aria-hidden="true">+</span>;
  if (kind === "sold_out") return <span aria-hidden="true">×</span>;
  if (kind === "restocked") return <span aria-hidden="true">↗</span>;
  if (kind === "price") return <span aria-hidden="true">€</span>;
  return <span aria-hidden="true">↕</span>;
}

export default function ChangelogPanel({ open, onClose, days = [] }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="changelog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="changelog-panel" role="dialog" aria-modal="true" aria-labelledby="changelog-title">
        <header className="changelog-head">
          <div>
            <span className="changelog-eyebrow">Daily catalogue watch</span>
            <h2 id="changelog-title">What&apos;s new</h2>
            <p>New departures, prices and availability found by each UCPA scrape.</p>
          </div>
          <button type="button" className="changelog-close" onClick={onClose} aria-label="Close changelog">×</button>
        </header>

        <div className="changelog-scroll">
          {days.map((day) => (
            <section className="changelog-day" key={day.day}>
              <div className="changelog-day-head">
                <div>
                  <strong>{formatDay(day.day)}</strong>
                  <span>{day.productCount} products checked</span>
                </div>
                <div className="changelog-counts" aria-label={`${day.summary.total} changes`}>
                  {day.summary.newListings > 0 && <span className="change-count change-count-new">+{day.summary.newListings} new</span>}
                  {day.summary.priceChanges > 0 && <span className="change-count">{day.summary.priceChanges} price</span>}
                  {day.summary.availabilityChanges > 0 && <span className="change-count">{day.summary.availabilityChanges} seats</span>}
                  {day.summary.total === 0 && <span className="change-count change-count-quiet">No changes</span>}
                </div>
              </div>

              {day.events.length > 0 && (
                <div className="changelog-events">
                  {day.events.slice(0, 50).map((event) => (
                    <article className={`changelog-event changelog-event-${event.kind}`} key={`${event.code}-${event.startDate}`}>
                      <span className="changelog-event-icon"><EventIcon kind={event.kind} /></span>
                      <div className="changelog-event-copy">
                        <strong>{event.title}</strong>
                        <span>{event.resort} · {formatWeek(event.startDate)}</span>
                        <em>{eventCopy(event)}</em>
                      </div>
                    </article>
                  ))}
                  {day.events.length > 50 && (
                    <div className="changelog-more">+{day.events.length - 50} more changes from this scrape</div>
                  )}
                </div>
              )}
            </section>
          ))}
        </div>
      </aside>
    </div>
  );
}
