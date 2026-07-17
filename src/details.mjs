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
  if (!h4.length) return [];
  return h4
    .siblings("ul")
    .find("li")
    .map((_, li) => $(li).text().trim())
    .get();
}

export function parseDetails(html) {
  const $ = cheerio.load(html);

  const includes = listAfterHeading($, "Inclus");
  const excludes = listAfterHeading($, "Non Inclus");
  const options = listAfterHeading($, "En option");

  const accomH2 = $("#hebergement-section h2").first();
  const accommodation = accomH2.next("p").text().trim() || null;

  const encadrementH4 = exactHeading($, "h4", "Encadrement").first();
  const encadrement = encadrementH4.next("div").text().trim() || null;
  const hoursM = encadrement?.match(/(\d+)\s*h\b/);
  const instructor_hours = hoursM ? parseInt(hoursM[1], 10) : null;

  return {
    includes, excludes, options, accommodation, encadrement, instructor_hours,
    instruction_type: classifyInstruction(instructor_hours),
  };
}

/**
 * Real hours observed across the current 22-product catalogue cluster
 * cleanly into three groups with no ambiguous middle values: none (Pack
 * Mini-style "en autonomie" products), 12h ("Mi-temps" packages), and
 * 23-25h (full week-long coaching, including mountain-guide-led hors-piste
 * and splitboard programs). The 15h cutoff sits in the gap between them.
 */
function classifyInstruction(hours) {
  if (hours == null) return "Individual (no coaching)";
  if (hours <= 15) return "Half-day coaching";
  return "Full coaching";
}
