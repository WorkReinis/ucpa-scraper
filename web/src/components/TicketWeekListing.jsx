import { useId, useState } from "react";
import { IconHeart, IconPlane, IconTicket } from "../icons";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtDate(iso) {
  if (!iso) return "";
  const [year, month, day] = iso.split("-");
  return `${day} ${MONTHS[Number(month) - 1]} ${year}`;
}

function fmtShortDate(iso, includeYear = false) {
  if (!iso) return "";
  const [year, month, day] = iso.split("-");
  return `${day} ${MONTHS[Number(month) - 1]}${includeYear ? ` ${year}` : ""}`;
}

function fmtPrice(price) {
  return `€${Math.ceil(price)}`;
}

function fmtMinutes(minutes) {
  if (minutes == null) return null;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours}h${String(mins).padStart(2, "0")}` : `${hours}h`;
}

function levelTier(level) {
  if (!level) return "—";
  const parts = level.split(" - ");
  return parts.length > 1 ? parts.at(-1) : level;
}

function googleFlightsUrl(d) {
  if (!Number.isFinite(d.flight_price)) return null;
  const query = `Flights from ${d.flight_dep} to ${d.flight_arr} on ${d.flight_depart_date} returning ${d.flight_return_date}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(query)}`;
}

function barcodeCode(d) {
  const resort = (d.resort || d.code || "UCPA").replace(/[^a-z0-9]/gi, "").slice(0, 3).toUpperCase();
  const [year = "", month = "", day = ""] = (d.start_date || "").split("-");
  return `${resort} · ${day}${MONTHS[Number(month) - 1]?.toUpperCase() || ""}${year.slice(-2)}`;
}

export default function TicketWeekListing({ d, includeFlightCosts = false, favorited = false, onToggleFavorite }) {
  const [open, setOpen] = useState(false);
  const [pulse, setPulse] = useState(false);
  const detailsId = useId();
  const hasFlight = Number.isFinite(d.flight_price);
  const totalPrice = d.price + (hasFlight ? d.flight_price : 0);
  const seatsTier = d.seats_left <= 2 ? "critical" : d.seats_left <= 5 ? "low" : "ok";
  const googleFlights = googleFlightsUrl(d);
  const compactFlightLine = [
    `${fmtShortDate(d.flight_depart_date)} – ${fmtShortDate(d.flight_return_date, true)}`,
    d.flight_dep && d.flight_arr ? `${d.flight_dep} ⇄ ${d.flight_arr}` : null,
    d.flight_airline,
    fmtMinutes(d.flight_duration_min),
  ].filter(Boolean).join(" · ");

  function toggle() {
    setOpen((value) => !value);
  }

  function handleFavoriteClick(event) {
    event.stopPropagation();
    if (!favorited) {
      setPulse(true);
      setTimeout(() => setPulse(false), 400);
    }
    onToggleFavorite();
  }

  return (
    <article className={`ticket-week-card${open ? " open" : ""}${favorited ? " favorited" : ""}`}>
      <div className="ticket-main" role="button" tabIndex={0} aria-expanded={open} aria-controls={detailsId} onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        }}>
        <div className="ticket-image-wrap">
          {d.image_url
            ? <img src={d.image_url} alt="" loading="lazy" />
            : <div className="ticket-image-fallback" aria-hidden="true"><span>{d.resort}</span></div>}
          <button type="button" className={`ticket-fav${favorited ? " active" : ""}${pulse ? " pulse" : ""}`}
            onClick={handleFavoriteClick} aria-pressed={favorited} title={favorited ? "Remove from favorites" : "Save to favorites"}>
            {IconHeart(favorited)}
          </button>
        </div>
        <div className="ticket-perf-v ticket-perf-image" aria-hidden="true"><span className="ticket-notch ticket-notch-top" /><span className="ticket-notch ticket-notch-end" /></div>
        <div className="ticket-trip">
          <div className="ticket-eyebrow-row">
            <span className="ticket-eyebrow">{d.title}</span>
            {Boolean(d.is_new) && <span className="ticket-stamp">New</span>}
          </div>
          <div className="ticket-hero">
            <div>
              <h3 className="ticket-resort">{d.resort}</h3>
              <div className="ticket-region">{d.region}</div>
            </div>
            <div className="ticket-when">
              <span className="ticket-label">Week of</span>
              <span className="ticket-date">{fmtDate(d.start_date)}</span>
            </div>
          </div>
          <div className="ticket-facts">
            <div><span className="ticket-label">Level</span><span className="ticket-value">{levelTier(d.level)}</span></div>
            <div><span className="ticket-label">Coaching</span><span className="ticket-value">{d.instruction_type || "Independent"}{d.instructor_hours != null ? ` · ${d.instructor_hours}h` : ""}</span></div>
            <div><span className="ticket-label">Stay</span><span className="ticket-value">{d.days}d / {d.nights}n{includeFlightCosts && hasFlight ? " (+1)" : ""}</span></div>
          </div>
        </div>

        <div className="ticket-perf-v" aria-hidden="true"><span className="ticket-notch ticket-notch-top" /><span className="ticket-notch ticket-notch-end" /></div>

        <div className="ticket-stub">
          <div>
            <div className="ticket-price-row">
              <span className="ticket-price">{fmtPrice(includeFlightCosts ? totalPrice : d.price)}</span>
              {!includeFlightCosts && d.price_prev != null && d.delta_eur !== 0 && <span className="ticket-was">{fmtPrice(d.price_prev)}</span>}
            </div>
            {includeFlightCosts && hasFlight && <div className="ticket-price-breakdown">{fmtPrice(d.price)} package + {fmtPrice(d.flight_price)} flight</div>}
            {includeFlightCosts && !hasFlight && <div className="ticket-price-breakdown">Flight price unavailable</div>}
          </div>
          <div className="ticket-seat-block">
            <div className={`ticket-seats ticket-seats-${seatsTier}`}>{d.seats_left} seat{d.seats_left === 1 ? "" : "s"} left</div>
          </div>
          <div className="ticket-barcode" aria-hidden="true"><span className="ticket-bars" /><span className="ticket-barcode-code">{barcodeCode(d)}</span></div>
        </div>
      </div>

      <div className="ticket-tear" aria-hidden="true"><span className="ticket-notch ticket-notch-left" /><span className="ticket-notch ticket-notch-right" /></div>

      <div className="ticket-foot">
        <div className="ticket-foot-row" role="button" tabIndex={0} aria-label="Toggle trip details" aria-expanded={open} aria-controls={detailsId}
          onClick={toggle}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              toggle();
            }
          }}>
          {includeFlightCosts && (
            <div className="ticket-flight-summary">
              {hasFlight ? <>{IconPlane}<span>{compactFlightLine}</span></> : <span>Flight price unavailable</span>}
            </div>
          )}
          <div className="ticket-links">
            {googleFlights && <a className="ticket-link-button" href={googleFlights} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>{IconPlane}<span>Google Flights</span></a>}
            <a className="ticket-link-button" href={d.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>{IconTicket}<span>View UCPA</span></a>
          </div>
        </div>

        <div className="ticket-details" id={detailsId} inert={!open}>
          <div className="ticket-details-clip">
            <div className="ticket-details-grid">
              <div className="ticket-detail-column"><h4>Trip</h4><p>{d.activity}</p>{d.accommodation && <p className="ticket-dim">{d.accommodation}</p>}</div>
              {d.includes?.length > 0 && <div className="ticket-detail-column"><h4>Included</h4><ul>{d.includes.map((item) => <li key={item}>{item}</li>)}</ul></div>}
              {d.excludes?.length > 0 && <div className="ticket-detail-column"><h4>Not included</h4><ul>{d.excludes.map((item) => <li key={item}>{item}</li>)}</ul></div>}
              {d.options?.length > 0 && <div className="ticket-detail-column"><h4>Add-on options</h4><ul>{d.options.map((item) => <li key={item}>{item}</li>)}</ul></div>}
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
