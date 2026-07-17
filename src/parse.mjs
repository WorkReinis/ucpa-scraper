// Parses UCPA result cards.
//
// Design note: we deliberately do NOT depend on CSS class names. UCPA's markup
// is machine-generated and its classes churn. Instead we anchor on:
//   - the href (gives the immutable product code)
//   - stable French label text ("à partir de", "dès le", "hors transport")
// This survives a redesign as long as the copy stays put.

export const ACTIVITIES = [
  "Snowboard hors-piste",
  "Ski hors-piste",
  "Ski de randonnée",
  "Multi-activités Montagne",
  "Multi activités Montagne",
  "Ski alpin",
  "Splitboard",
  "Snowboard",
  "Raquettes",
  "Biathlon",
];

const num = (s) =>
  s == null
    ? null
    : Math.ceil(parseFloat(
        String(s)
          .replace(/[\s\u00a0\u202f]/g, "")
          .replace(",", ".")
      ));

/** "29/11" + a season anchor -> ISO date. Nov/Dec belong to the earlier year. */
export function resolveDate(dd, mm, seasonStartYear) {
  const m = parseInt(mm, 10);
  const year = m >= 9 ? seasonStartYear : seasonStartYear + 1;
  return `${year}-${mm}-${dd}`;
}

export function parseCard(href, rawText, titleOverride = null) {
  const text = rawText.replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ").trim();

  const codeM = href.match(/\/sejour\/([a-z0-9]+)-/i);
  if (!codeM) return null;
  const code = codeM[1].toLowerCase();

  const ageM = text.match(/(\d{1,2})\s*-\s*(\d{1,2})\s*ans/);
  if (!ageM) return null;

  // Two card layouts exist: "Pack" cards read TITLE, age, TITLE (again),
  // location; hors-piste/Découverte cards read age, TITLE (once), location
  // -- no title before the age badge at all. Rather than guess which layout
  // this card uses, anchor on "France" (the country breadcrumb is always
  // present and always literal) to find where the title block ends, however
  // many times it was repeated.
  const beforeAge = text.slice(0, ageM.index).trim();
  let rest = text.slice(ageM.index + ageM[0].length).trim();
  const franceIdx = rest.indexOf("France");
  const inferredTitle = (beforeAge || (franceIdx === -1 ? rest : rest.slice(0, franceIdx).trim()))
    .replace(/^Nouveauté\s*/, ""); // "new" badge, glued onto the title with no separator
  // The visible card text can contain an accessibility copy of its entire
  // content before the age badge. When available, the listing's JSON-LD
  // Product name is the canonical, title-only value (see scrape.mjs).
  const title = titleOverride?.trim() || inferredTitle;
  if (franceIdx !== -1) rest = rest.slice(franceIdx);

  // Location runs until the first activity label.
  let actIdx = Infinity;
  let activity = null;
  for (const a of ACTIVITIES) {
    const i = rest.indexOf(a);
    if (i !== -1 && i < actIdx) {
      actIdx = i;
      activity = a;
    }
  }
  let location = actIdx === Infinity ? null : rest.slice(0, actIdx).trim();
  // Circuit cards concatenate the title and location in their visible text.
  // JSON-LD gives us the exact title, so remove that prefix before parsing
  // the location fields.
  if (titleOverride && location?.startsWith(titleOverride)) {
    location = location.slice(titleOverride.length).trim();
  }
  const afterAct = actIdx === Infinity ? "" : rest.slice(actIdx + activity.length).trim();

  // UCPA's own activity breadcrumb says "Ski alpin" for the "Ski ou
  // snowboard Pack Mini" products, but the title says otherwise and the
  // included-gear line backs it up ("Matériel de ski ou de snowboard" --
  // ski OR snowboard gear). Retag so a snowboard filter doesn't silently
  // lose a product that's explicitly usable as one.
  if (/^Ski ou snowboard\b/i.test(title)) activity = "Ski ou snowboard";

  // Level label. The DOM renders it twice: "<label>i <label> <long tooltip>".
  // The backreference finds the real boundary -- a naive /(.+?)i\s/ truncates
  // "Ski - initié a expert" to "Sk" because "Ski" itself ends in "i ".
  const lvlM = afterAct.match(/^(.+?)i\s+\1/);
  const level = lvlM ? lvlM[1].trim() : (afterAct.split(/\s{2,}|Niveau technique/)[0] || null);

  // "-10%à partir de930 €837 €"  |  "à partir de555,00 €"
  const twoPrice = text.match(/à partir de\s*([\d.,\s]+?)\s*€\s*([\d.,\s]+?)\s*€/);
  const onePrice = text.match(/à partir de\s*([\d.,\s]+?)\s*€/);
  const listPrice = twoPrice ? num(twoPrice[1]) : onePrice ? num(onePrice[1]) : null;
  const nowPrice = twoPrice ? num(twoPrice[2]) : listPrice;

  const discM = text.match(/-\s*(\d{1,2})\s*%\s*à partir de/);
  const dateM = text.match(/dès le\s*(\d{2})\/(\d{2})/);

  // Duration MUST be matched after the date is consumed: "dès le 29/117 jours"
  // has no separator, so a bare /(\d+) jours/ reads the duration as 117.
  const afterDate = dateM ? text.slice(dateM.index + dateM[0].length) : text;
  const durM = afterDate.match(/(\d+)\s*jours?,\s*(\d+)\s*nuits?/);

  // Most cards include "France - resort - region". Circuit cards omit the
  // country, so their two segments are resort and region, not country and
  // resort. Split on spaced hyphens only -- "Saint-Lary Soulan" contains a
  // bare one.
  const locationParts = (location || "").split(/\s+-\s+/);
  const [country, resort, region] = locationParts.length === 2
    ? ["France", ...locationParts]
    : locationParts;

  return {
    code,
    site_code: code.length >= 6 ? code.slice(3, 6) : null, // sfa|VIS|n03 -> Val d'Isère
    url: href.startsWith("http") ? href : `https://www.ucpa.com${href}`,
    title,
    age_min: parseInt(ageM[1], 10),
    age_max: parseInt(ageM[2], 10),
    location,
    country: country ?? null,
    resort: resort ?? null,
    region: region ?? null,
    activity,
    level,
    list_price: listPrice,
    price: nowPrice,
    discount_pct: discM ? parseInt(discM[1], 10) : 0,
    first_week_dm: dateM ? `${dateM[1]}/${dateM[2]}` : null,
    days: durM ? parseInt(durM[1], 10) : null,
    nights: durM ? parseInt(durM[2], 10) : null,
    transport_included: !/hors transport/.test(text),
  };
}
