import { IconCalendar, IconPin, IconLevel, IconClock, IconPlane } from "../icons";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}

function fmtMinutes(minutes) {
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining ? `${hours}h${String(remaining).padStart(2, "0")}` : `${hours}h`;
}

function fmtAgo(iso) {
  const hours = (Date.now() - new Date(iso).getTime()) / 3600e3;
  if (hours < 1) return "just now";
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function totalOf(d) {
  return d.flight_price != null ? d.price + d.flight_price : Infinity;
}

function fmtPrice(price) {
  return `€${Math.ceil(price)}`;
}

function googleFlightsUrl(d) {
  if (d.flight_price == null) return null;
  const q = `Flights from ${d.flight_dep} to ${d.flight_arr} on ${d.flight_depart_date} returning ${d.flight_return_date}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

function FlightLine({ d }) {
  if (d.flight_fetched_at == null) return <div className="muted small">no flight data yet</div>;
  if (d.flight_price == null) return <div className="muted small">no flights found for these dates · checked {fmtAgo(d.flight_fetched_at)}</div>;

  return (
    <div className="muted small">
      {IconPlane} Fly out {fmtDate(d.flight_depart_date)} · {d.flight_dep} → {d.flight_arr} · {d.flight_airline} outbound
      {d.flight_stops != null && <> · {d.flight_stops === 0 ? "direct" : `${d.flight_stops} stop${d.flight_stops === 1 ? "" : "s"}`}</>}
      {d.flight_duration_min != null && <> · {fmtMinutes(d.flight_duration_min)}</>}
      {" "}· {d.flight_pricing_mode === "separate" ? "separate tickets" : "round trip"} {fmtPrice(d.flight_price)} · quoted {fmtAgo(d.flight_fetched_at)}
    </div>
  );
}

export default function TripCost({ weeks, meta }) {
  const configured = Boolean(meta?.flightsConfigured);
  const rows = [...weeks].sort((a, b) => totalOf(a) - totalOf(b) || a.price - b.price);

  return (
    <>
      <div className="results-toolbar"><div className="muted small">{rows.length} trips priced</div></div>
      {!configured && <p className="flight-banner">Flight quotes need a provider key. Set <code>APIFY_KEY_1</code> (apify.com) or <code>SERPAPI_KEY</code> (serpapi.com) in the server&apos;s environment and restart it.</p>}
      {rows.length === 0 && <p className="muted">No weeks match these filters.</p>}

      {rows.map((d) => (
        <article className="week-card" key={`${d.code}-${d.start_date}`}>
          <div className="card-head">
            <div className="head-row">
              <h3 className="title"><span>{d.title}</span></h3>
              <div className="price-block stacked">
                <div className="price-line"><span className="price">{fmtPrice(d.flight_price != null ? d.price + d.flight_price : d.price)}</span></div>
                <div className="muted small">{d.flight_price != null ? `${fmtPrice(d.price)} package + ${fmtPrice(d.flight_price)} flight` : "package only"}</div>
              </div>
            </div>
          </div>

          <div className="meta-row">
            <span className="meta-item">{IconCalendar}<span>week of {fmtDate(d.start_date)}</span></span>
            <span className="meta-item">{IconPin}<span>{d.resort}</span></span>
            <span className="meta-item">{IconLevel}<span>{d.level}</span></span>
            <span className="meta-item">{IconClock}<span>{d.days}d / {d.nights}n</span></span>
          </div>

          <div className="trip-extra">
            <FlightLine d={d} />
            <div className="trip-links">
              <a href={d.url} target="_blank" rel="noreferrer" className="product-link">View on ucpa.com →</a>
              {googleFlightsUrl(d) && <a href={googleFlightsUrl(d)} target="_blank" rel="noreferrer" className="product-link">Search on Google Flights →</a>}
            </div>
          </div>
        </article>
      ))}
    </>
  );
}
