import { useId, useState } from "react";
import { IconCalendar, IconPin, IconLevel, IconCoaching, IconSeat, IconPlane, IconClock, IconTicket, IconHeart } from "../icons";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}

function fmtMinutes(minutes) {
  if (minutes == null) return null;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours}h${String(mins).padStart(2, "0")}` : `${hours}h`;
}

function fmtPrice(price) {
  return `€${Math.ceil(price)}`;
}

function googleFlightsUrl(d) {
  if (!Number.isFinite(d.flight_price)) return null;
  const q = `Flights from ${d.flight_dep} to ${d.flight_arr} on ${d.flight_depart_date} returning ${d.flight_return_date}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

function levelTier(level) {
  if (!level) return level;
  const parts = level.split(" - ");
  return parts.length > 1 ? parts.at(-1) : level;
}

function priceBadge(d) {
  if (!d.delta_eur) return null;
  return {
    cls: d.delta_eur > 0 ? "up" : "down",
    label: `${d.delta_eur > 0 ? "▲" : "▼"} €${Math.ceil(Math.abs(d.delta_eur))}`,
    title: `Was ${fmtPrice(d.price_prev)}`,
  };
}

function isRedundantStatus(status) {
  return /^Only \d+ spot\(s\) left$/i.test(status);
}

export default function WeekListing({ d, includeFlightCosts = false, compact = false, favorited = false, onToggleFavorite }) {
  const [open, setOpen] = useState(false);
  const [pulse, setPulse] = useState(false);
  const detailsId = useId();
  const pBadge = priceBadge(d);
  const seatsTier = d.seats_left <= 2 ? "critical" : d.seats_left <= 5 ? "low" : "ok";
  const hasFlight = Number.isFinite(d.flight_price);
  const totalPrice = hasFlight ? d.price + d.flight_price : d.price;
  const googleFlights = googleFlightsUrl(d);
  const flightInfo = [
    { icon: IconCalendar, label: fmtDate(d.flight_depart_date) },
    { icon: IconPlane, label: d.flight_dep && d.flight_arr ? `${d.flight_dep} → ${d.flight_arr}` : null },
    { icon: IconTicket, label: d.flight_airline },
    { icon: IconClock, label: fmtMinutes(d.flight_duration_min) },
  ].filter((item) => item.label);

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
    <article className={`week-card${open ? " open" : ""}${compact ? " compact" : ""}${favorited ? " favorited" : ""}`}>
      <div
        className="card-summary"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        }}
      >
        <div className="card-head">
          <div className="head-row">
            <h3 className="title">
              {Boolean(d.is_new) && <span className="chip chip-new">New</span>}
              <span>{d.title}</span>
            </h3>
            <div className="head-actions">
              <div className="price-block">
                <div className="price-line">
                  {!includeFlightCosts && pBadge && <s className="was">{fmtPrice(d.price_prev)}</s>}
                  {includeFlightCosts && hasFlight && (
                    <span className="trip-price-breakdown">{fmtPrice(d.price)} package + {fmtPrice(d.flight_price)} flight</span>
                  )}
                  <span className="price">{fmtPrice(includeFlightCosts ? totalPrice : d.price)}</span>
                  {!includeFlightCosts && pBadge && <span className={`chip chip-${pBadge.cls}`} title={pBadge.title}>{pBadge.label}</span>}
                </div>
              </div>
              <button
                type="button"
                className={`fav-button${favorited ? " active" : ""}${pulse ? " pulse" : ""}`}
                onClick={handleFavoriteClick}
                aria-pressed={favorited}
                title={favorited ? "Remove from favorites" : "Save to favorites"}
              >
                {IconHeart(favorited)}
              </button>
            </div>
          </div>
        </div>

        <div className="meta-row">
          <span className={`meta-item seats seats-${seatsTier}`}>{IconSeat}<span>{d.seats_left} seat{d.seats_left === 1 ? "" : "s"}</span></span>
          <span className="meta-item">{IconCalendar}<span>{fmtDate(d.start_date)}</span></span>
          <span className="meta-item">{IconPin}<span>{d.resort} · {d.region}</span></span>
          <span className="meta-item">{IconLevel}<span>{levelTier(d.level)}</span></span>
          <span className="meta-item">{IconCoaching}<span>{d.instruction_type}</span></span>
          <a
            className="product-link meta-link"
            href={d.url}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            View on ucpa.com →
          </a>
        </div>

        {includeFlightCosts && (
          <div className="flight-summary">
            <span className="flight-section-icon">{IconPlane}</span>
            {hasFlight
              ? flightInfo.map((item) => (
                <span className="flight-detail" key={item.label}>
                  {item.icon}
                  <span>{item.label}</span>
                </span>
              ))
              : <span>Flight price unavailable</span>}
            {googleFlights && (
              <a
                className="flight-link"
                href={googleFlights}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => event.stopPropagation()}
              >
                Google Flights ↗
              </a>
            )}
          </div>
        )}
      </div>

      <div className="card-details" id={detailsId} inert={!open}>
        <div className="clip">
          <div className="details-inner">
            <div className="spec-inline">
              <div className="kv"><span className="label">Activity</span><span className="value">{d.activity}</span></div>
              <div className="kv"><span className="label">Ages</span><span className="value">{d.age_min}–{d.age_max}</span></div>
              <div className="kv"><span className="label">Length</span><span className="value">{d.days} days · {d.nights} nights</span></div>
              {d.instructor_hours != null && <div className="kv"><span className="label">Instruction</span><span className="value">{d.instructor_hours}h with an instructor</span></div>}
              {d.status && !isRedundantStatus(d.status) && <div className="kv"><span className="label">Status</span><span className="value">{d.status}</span></div>}
            </div>

            <div className="detail-cols">
              {d.includes.length > 0 && <div><h4>Included</h4><ul className="includes">{d.includes.map((item) => <li key={item}>{item}</li>)}</ul></div>}
              {d.excludes.length > 0 && <div><h4>Not included</h4><ul>{d.excludes.map((item) => <li key={item}>{item}</li>)}</ul></div>}
              {d.options.length > 0 && <div><h4>Add-on options</h4><ul>{d.options.map((item) => <li key={item}>{item}</li>)}</ul></div>}
              {d.accommodation && <div><h4>Accommodation</h4><p>{d.accommodation}</p></div>}
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
