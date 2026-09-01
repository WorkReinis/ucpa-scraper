// Package composition: what's actually in the box.
//
// All of this is server-rendered prose on the product page -- same page
// weeks.mjs already fetches to find the reserve-state URL, so this adds
// zero extra requests. The one wrinkle: UCPA renders several sections twice
// (a desktop version and a mobile-accordion version with a different tag),
// same trap as the level field in parse.mjs. Anchor on the desktop tag
// (h4/h2) and take the first match to dedupe.

import * as cheerio from "cheerio";

function exactHeading($, tag, text) {
  return $(tag).filter((_, el) => $(el).text().trim() === text);
}

function listAfterHeading($, text) {
  const h4 = exactHeading($, "h4", text).first();
  if (!h4.length) return { found: false, items: [] };
  return {
    found: true,
    items: h4
    .siblings("ul")
    .find("li")
    .map((_, li) => $(li).text().trim())
    .get(),
  };
}

function textWithBreaks(element) {
  const withLines = (element.html() || "").replace(/<br\s*\/?\s*>/gi, "\n");
  const parsed = cheerio.load(`<div>${withLines}</div>`);
  return parsed("body > div").first().text().trim();
}

function accommodationDetails($) {
  const standardHeading = $("#hebergement-section h2").first();
  const standard = standardHeading.next("p").text().trim();
  if (standard) return { found: true, value: standard };

  // Circuit/itinerant products use an accordion rather than the standard
  // sports-centre section. Its content is a div nested immediately after an
  // exact "Hébergement" h4.
  const circuitHeading = exactHeading($, "h4", "Hébergement").first();
  const circuit = textWithBreaks(circuitHeading.next("div"));
  if (circuit) return { found: true, value: circuit };

  // A few partner-run circuits only carry one accommodation sentence inside
  // "Informations importantes". Preserve that useful sentence without
  // treating the entire contact/parking block as accommodation prose.
  const partnerBlock = $("div.custom-color").filter((_, element) => {
    const ownText = $(element).clone().children().remove().end().text();
    return /HÉBERGEMENT\s*:/i.test(ownText);
  }).first();
  if (partnerBlock.length) {
    const text = textWithBreaks(partnerBlock);
    const match = text.match(/HÉBERGEMENT\s*:\s*([^\n]+)/i);
    if (match?.[1]?.trim()) return { found: true, value: match[1].trim() };
  }

  return { found: false, value: null };
}

export function parseDetails(html) {
  const $ = cheerio.load(html);

  const scrapedImageUrl = $('meta[property="og:image"]').first().attr("content")
    || $('meta[name="twitter:image"]').first().attr("content")
    || null;
  // Keep Cloudinary's original asset path, not UCPA's generic t_UCPA
  // rendition. The card requests its own desktop/mobile sizes from that
  // original, so a tiny preset is never stretched and every browser can get
  // WebP/AVIF through f_auto.
  const image_url = scrapedImageUrl?.replace("/image/upload/f_auto/t_UCPA/", "/image/upload/") ?? null;

  const includedSection = listAfterHeading($, "Inclus");
  const excludedSection = listAfterHeading($, "Non Inclus");
  const optionsSection = listAfterHeading($, "En option");
  const includes = includedSection.items;
  const excludes = excludedSection.items;
  const options = optionsSection.items;

  const accommodationField = accommodationDetails($);
  const accommodation = accommodationField.value;

  const encadrementH4 = exactHeading($, "h4", "Encadrement").first();
  const encadrement = encadrementH4.next("div").text().trim() || null;
  const hoursM = encadrement?.match(/(\d+)\s*h\b/);
  const instructor_hours = hoursM ? parseInt(hoursM[1], 10) : null;

  return {
    includes, excludes, options, accommodation, encadrement, instructor_hours, image_url,
    instruction_type: classifyInstruction(instructor_hours, encadrement),
    // Keep section presence separate from parsed values. An empty optional
    // list can be real, while a missing heading means this page used a layout
    // we did not parse. The DB updater uses these flags to save good partial
    // fields without erasing older known-good values on a parser regression.
    field_presence: {
      image_url: Boolean(scrapedImageUrl),
      includes: includedSection.found && includes.length > 0,
      excludes: excludedSection.found,
      options: optionsSection.found,
      accommodation: accommodationField.found,
      encadrement: Boolean(encadrement),
    },
  };
}

/**
 * Real hours observed across the current 22-product catalogue cluster
 * cleanly into three groups with no ambiguous middle values: none (Pack
 * Mini-style "en autonomie" products), 12h ("Mi-temps" packages), and
 * 23-25h (full week-long coaching, including mountain-guide-led hors-piste
 * and splitboard programs). The 15h cutoff sits in the gap between them.
 */
function classifyInstruction(hours, description) {
  if (hours == null) {
    return /pas d'encadrement|en autonomie/i.test(description || "")
      ? "Individual (no coaching)"
      : null;
  }
  if (hours <= 15) return "Half-day coaching";
  return "Full coaching";
}
