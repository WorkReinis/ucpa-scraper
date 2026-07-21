// Best-effort French -> English for display text. Not a translation service:
// an ordered phrase-substitution list, ordered longest/most-specific first so
// e.g. "Snowboard hors-piste" gets replaced whole before a shorter/looser
// rule could partially mangle it. Proper nouns (resort names, UCPA,
// equipment brand terms like DVA) are deliberately left alone -- both rule
// lists only cover strings actually observed in the scraped catalogue, not
// speculative ones.
//
// Applied at the API layer (src/server.mjs), not at scrape time -- the DB
// keeps the raw French UCPA actually served, so improving a translation
// later doesn't require a re-scrape.

// Activities, levels, regions, status messages -- short, exact-ish, and used
// as filter option labels, so correctness here matters more than for prose.
const CATEGORICAL_RULES = [
  [/Plus que (\d+) places? disponibles?/gi, "Only $1 spot(s) left"],
  ["Départ garanti", "Guaranteed to run"],

  ["Ski ou snowboard", "Ski or Snowboard"],
  ["Snowboard hors-piste", "Off-piste snowboard"],
  ["Ski hors-piste", "Off-piste ski"],
  ["Ski de randonnée", "Ski touring"],
  ["Multi-activités Montagne", "Multi-activity mountain"],
  ["Multi activités Montagne", "Multi-activity mountain"],
  ["Ski alpin", "Alpine ski"],
  ["Raquettes", "Snowshoeing"],
  ["Handiski (dual/tandem)", "Adaptive ski (dual/tandem)"],

  // Order matters: each rule runs against what earlier rules left behind, so
  // the longer label has to be listed before the prefix it contains.
  ["Tous niveaux dépublié", "All levels (unpublished)"],
  ["Tous niveaux", "All levels"],
  ["Initié à expert", "Intermediate to expert"],
  ["initié à expert", "intermediate to expert"],
  ["Débutant", "Beginner"],
  ["Découverte", "Discovery"],
  ["Niveau technique", "Skill level"],
  ["Déjà fait", "Previously attended"],
  ["Confirmé", "Proficient"],
  ["Maîtrise", "Mastery"],
  ["Initié", "Novice"],
  ["Niveau 1", "Level 1"],
  ["Niveau 2", "Level 2"],
  ["Niveau 3", "Level 3"],
  ["Niveau 4", "Level 4"],

  // UCPA transport pickup cities (src/weeks.mjs) -- almost all spelled the
  // same in French and English (Paris, Lyon, Nantes...); Brussels is the one
  // that isn't.
  ["Bruxelles", "Brussels"],

  ["Alpes du Nord", "Northern Alps"],
  ["Alpes du Sud", "Southern Alps"],
  ["Pyrénées", "Pyrenees"],
  ["Vallée du Mont Blanc", "Mont Blanc Valley"],
];

// Free-text prose: includes/excludes/options, accommodation, instruction
// descriptions, and titles. Filled in from the exact strings harvested from
// the live catalogue (see conversation notes) -- bulkier and lower-stakes
// than CATEGORICAL_RULES (display only, not filter keys), so best-effort
// coverage is the goal, not exhaustive NLP-grade translation.
const PHRASE_RULES = [
  ["Apprendre le snowboard en 7 jours - Happy Winter", "Learn Snowboard in 7 Days - Happy Winter"],
  ["Apprendre le snowboard en 7 jours", "Learn Snowboard in 7 Days"],
  ["Ski ou snowboard Pack Mini 3 Vallées", "Ski or Snowboard Mini Package 3 Valleys"],
  ["Ski ou snowboard Pack Mini", "Ski or Snowboard Mini Package"],
  ["Snowboard Pack Plein-temps", "Full-time Snowboard Package"],
  ["Snowboard Pack Mi-Temps - Happy Winter", "Half-time Snowboard Package - Happy Winter"],
  ["Snowboard Pack Mi-temps", "Half-time Snowboard Package"],
  ["Snowboard Pack Mi-Temps", "Half-time Snowboard Package"],
  ["Snowboard hors-piste expert Big Rides", "Off-piste Snowboard Expert Big Rides"],
  ["Snowboard hors-piste expert 3 Vallées", "Off-piste Snowboard Expert 3 Valleys"],
  ["Snowboard hors-piste Expert / Splitboard", "Off-piste Snowboard Expert / Splitboard"],
  ["Snowboard hors-piste expert", "Off-piste snowboard expert"],
  ["Snowboard hors-piste All Mountain", "Off-piste snowboard all-mountain"],
  ["Découverte du Snowboard hors-piste", "Snowboard Off-piste Discovery"],
  ["Découverte du snowboard hors-piste", "Snowboard off-piste discovery"],
  ["Splitboard première itinérance", "Splitboard first backcountry route"],
  ["Splitboard haute montagne", "Splitboard high mountain"],
  ["Pack Plein-temps", "Full-time Package"],
  ["Pack Mi-temps", "Half-time Package"],
  ["Pack Mini", "Mini Package"],
  ["3 Vallées", "3 Valleys"],
  ["première itinérance", "first backcountry route"],
  ["haute montagne", "high mountain"],

  ["Forfait Val d'Isère / Tignes jusqu'à la fin de votre stage", "Val d'Isère / Tignes lift pass valid until the end of your stay"],
  ["Forfait Val d'Isère / Tignes jusquà la fin de votre stage", "Val d'Isère / Tignes lift pass valid until the end of your stay"],
  ["Forfait Val d'Isère / Tignes jusqu'à la fin de ton séjour", "Val d'Isère / Tignes lift pass valid until the end of your stay"],
  ["Forfait Val d'Isère / Tignes jusqu'à la fin de ton stage", "Val d'Isère / Tignes lift pass valid until the end of your stay"],
  ["Forfait Val d'Isère - Tignes jusqu'à la fin de ton stage", "Val d'Isère - Tignes lift pass valid until the end of your stay"],
  ["Forfait Tignes / Val d'Isère valable jusqu'à la fin de ton stage", "Tignes / Val d'Isère lift pass valid until the end of your stay"],
  ["Forfait \"3 Vallées\" jusqu'à la fin de votre stage", "3 Valleys lift pass valid until the end of your stay"],
  ["Forfait 3 Vallées jusqu'à la fin de ton stage", "3 Valleys lift pass valid until the end of your stay"],
  ["Forfait Les Arcs jusqu'à la fin de ton séjour", "Les Arcs lift pass valid until the end of your stay"],
  ["Forfait Les Arcs valable jusqu'à la fin de ton séjour", "Les Arcs lift pass valid until the end of your stay"],
  ["Forfait valable jusqu'à la fin de votre stage", "Lift pass valid until the end of your stay"],
  ["Forfait valable jusqu'à la fin de ton stage", "Lift pass valid until the end of your stay"],
  ["Forfait 7 jours Paradiski", "7-day Paradiski lift pass"],
  ["Forfait 7 jours", "7-day lift pass"],
  ["Forfait de ski", "Ski lift pass"],
  ["Hébergement et pension complète", "Accommodation and full board"],

  ["Matériel de snowboard hors-piste Matériel de sécurité (DVA, pelle, sonde, sac à dos)", "Off-piste snowboard gear and safety equipment (DVA, shovel, probe, backpack)"],
  ["Matériel de snowboard hors-piste", "Off-piste snowboard gear"],
  ["Matériel de sécurité (DVA, pelle, sonde, sac à dos)", "Safety equipment (DVA, shovel, probe, backpack)"],
  ["Matériel de ski hors-piste", "Off-piste ski gear"],
  ["Matériel de snowboard spécifique \"débutant\"", "Beginner-specific snowboard gear"],
  ["Matériel de snowboard", "Snowboard gear"],
  ["Matériel de ski ou de snowboard", "Ski or snowboard gear"],
  ["Matériel de splitboard", "Splitboard gear"],

  ["9 séances, 23h avec moniteur", "9 sessions, 23 hours with instructor"],
  ["9 à 10 séances, 25h avec moniteur", "9-10 sessions, 25 hours with instructor"],
  ["9 séances, 25h avec moniteur", "9 sessions, 25 hours with instructor"],
  ["12h avec moniteur en 4 à 5 séances", "12 hours with instructor in 4-5 sessions"],
  ["4 à 5 séances, 12h avec moniteur", "4-5 sessions, 12 hours with instructor"],

  ["Matériel de ride : boots, 1 snowboard + 1 splitboard avec peaux, couteaux et bâtons télescopiques", "Ride gear: boots, 1 snowboard + 1 splitboard with skins, crampons, and telescopic poles"],

  ["2 nuits en refuge", "2 nights in mountain hut"],
  ["Forfaits du dimanche au samedi inclus", "Lift passes included Sunday through Saturday"],
  ["L'hébergement (draps fournis, mais pas le linge de toilette)", "Accommodation (bed sheets provided, but not towels)"],
  ["Le forfait de remontées mécaniques du dimanche matin au samedi 12h", "Lift pass from Sunday morning to Saturday 12pm"],
  ["La carte d'hôte (transport gratuits dans la vallée la journée)", "Local transport card (free valley transport during the day)"],
  ["La restauration", "Meals"],
  ["Les remontées mécaniques du dimanche matin au samedi 12h", "Lift passes from Sunday morning to Saturday 12pm"],
  ["Accès à l'Aiguille du Midi (3842 m) et au train de la Mer de Glace", "Access to Aiguille du Midi (3842 m) and Mer de Glace train"],

  ["Le transport (réservation d'un parking avant votre arrivée fortement conseillé)", "Transport (booking a parking spot before arrival strongly recommended)"],
  ["Le \"sac à viande\" pour les nuits en refuge", "Sleeping bag liner for mountain hut nights"],
  ["Le transport", "Transport"],
  ["L'équipement personnel", "Personal equipment"],
  ["Les assurances complémentaires", "Additional insurance"],
  ["Séances avec moniteur", "Instruction sessions"],
  ["Les boissons", "Drinks"],

  ["Hébergement à 2 en hébergement double", "Double room accommodation for 2"],
  ["Hébergement à 2 en chambre double", "Double room accommodation for 2"],
  ["Hébergement en chambre double pour 2 personnes", "Double room accommodation for 2 people"],
  ["Hébergement à 2 en chambre multiple", "Multiple room accommodation for 2"],
  ["Arrivée la veille", "Arrive the day before"],
  ["Bien-être", "Wellness"],
  ["Yoga (3 séances)", "Yoga (3 sessions)"],

  ["23h d'encadrement du lundi au vendredi (1 ou 2 séances par jour).Groupe constitué pour la semaine sur la base de votre niveau technique et de vos attentes.", "23 hours of instruction, Monday to Friday (1-2 sessions per day). Group formed for the week based on your skill level and goals."],
  ["d'encadrement du lundi au vendredi (1 ou 2 séances par jour).Groupe constitué pour la semaine sur la base de votre niveau technique et de vos attentes", "of instruction, Monday to Friday (1-2 sessions per day). Group formed for the week based on your skill level and goals"],
  ["d'encadrement du lundi au vendredi (1 ou 2 séances par jour).Groupe constitué pour la semaine sur la base de ton niveau technique", "of instruction, Monday to Friday (1-2 sessions per day). Group formed for the week based on your skill level"],
  ["d'encadrement du lundi au vendredi (1 ou 2 séances par jour).Si ton niveau ou ton expérience ne correspondent pas aux critères de ce programme, l'UCPA se réserve le droit de t'orienter sur un autre stage", "of instruction, Monday to Friday (1-2 sessions per day). If your level or experience doesn't match this program's criteria, UCPA reserves the right to move you to a different course"],
  ["d'encadrement du lundi au vendredi (1 ou 2 séances par jour).Groupe de 8 maximum constitué pour la semaine", "of instruction, Monday to Friday (1-2 sessions per day). Group of up to 8, formed for the week"],
  ["d'encadrement du lundi au vendredi (1 ou 2 séances par jour). Moniteur ou Guide de Haute Montagne.", "of instruction, Monday to Friday (1-2 sessions per day). Instructor or High Mountain Guide."],
  ["d'encadrement du lundi au vendrediGroupe constitué pour la semaine sur la base de ton niveau technique", "of instruction, Monday to FridayGroup formed for the week based on your skill level"],
  ["d'encadrement du lundi au vendrediGroupe constitué pour la semaine", "of instruction, Monday to FridayGroup formed for the week"],
  ["d'encadrement du lundi au vendrediUn moniteur breveté d'état ou un guide de haute montagne pour 5 personnes maximum", "of instruction, Monday to FridayA state-certified instructor or high mountain guide for up to 5 people"],
  ["d'encadrement du dimanche au vendredi (1 ou 2 séances par jour).Séance découverte de l'activité dès le dimanche après-midi", "of instruction, Sunday to Friday (1-2 sessions per day). Intro session starting Sunday afternoon"],
  ["d'encadrement du dimanche au vendredi (2 séances de 2h30 par jour sauf mercredi 1 séance de 3h) + la séance découverte du premier jour", "of instruction, Sunday to Friday (2 sessions of 2.5 hours per day except Wednesday 1 session of 3 hours) + the first-day intro session"],
  ["23h d'encadrement du lundi au vendredi (1 ou 2 séances par jour).Groupe constitué de 8 personnes maximum pour la semaine", "23 hours of instruction, Monday to Friday (1-2 sessions per day). Group of up to 8 people, formed for the week"],
  ["23h pour 8 ou 9 séances d'encadrement du lundi au vendredi.Groupe de 8 personnes maximum, constitué pour la semaine après test d'évolution en toutes neiges et tous terrains", "23 hours for 8-9 instruction sessions, Monday to Friday. Group of up to 8 people, formed for the week after an all-terrain, all-conditions skill assessment"],
  ["Pas d'encadrement. Formule fortement déconseillée aux débutants.Des conseils de nos équipes pour glisser aux bons endroits et en sécurité.", "No instruction. Strongly not recommended for beginners. Guidance from our team on where to ride safely."],
  ["Pas d'encadrement. Formule déconseillée aux débutants.Des conseils de nos équipes pour glisser aux bons endroits et en sécurité.", "No instruction. Not recommended for beginners. Guidance from our team on where to ride safely."],
  ["12h d'encadrement. 4 à 5 séances du lundi au vendredi.Groupes de niveaux homogènesAlternance de séances encadrées et de glisse en autonomie.", "12 hours of instruction. 4-5 sessions, Monday to Friday. Groups matched by skill level. Mix of guided sessions and riding on your own."],
  ["12h d'encadrement. 4 à 5 séances du lundi au vendredi avec 1 break en milieu de semaine.Groupe constitué pour la semaine sur la base de votre niveau technique et de vos attentes.", "12 hours of instruction. 4-5 sessions, Monday to Friday with a mid-week break. Group formed for the week based on your skill level and goals."],
  ["25h d'encadrement du dimanche au vendredi (1 ou 2 séances par jour).Séance découverte de l'activité dès le dimanche après-midi.", "25 hours of instruction, Sunday to Friday (1-2 sessions per day). Intro session starting Sunday afternoon."],
  ["Moniteur de snowboard diplômé ou guide de haute montagne.23h d'encadrement réparties sur 4,5 jours.", "Certified snowboard instructor or high mountain guide. 23 hours of instruction spread across 4.5 days."],
  ["Un moniteur de snowboard diplômé pour 8 personnes au maximum.23h d'encadrement, du lundi au vendredi.", "Certified snowboard instructor for up to 8 people. 23 hours of instruction, Monday to Friday."],
  ["Guide de Haute Montagne (1 guide pour 7).23h d'encadrement du lundi au vendredi.", "High Mountain Guide (1 guide for 7). 23 hours of instruction, Monday to Friday."],

  ["d'encadrement du lundi au vendredi", "of instruction, Monday to Friday"],
  ["d'encadrement du dimanche au vendredi", "of instruction, Sunday to Friday"],
  ["Groupe constitué pour la semaine sur la base de votre niveau technique et de vos attentes", "Group formed for the week based on your skill level and goals"],
  ["Groupe constitué pour la semaine sur la base de ton niveau technique", "Group formed for the week based on your skill level"],
  ["Groupe constitué pour la semaine", "Group formed for the week"],
  ["Si ton niveau ou ton expérience ne correspondent pas aux critères de ce programme, l'UCPA se réserve le droit de t'orienter sur un autre stage", "If your level or experience doesn't match this program's criteria, UCPA reserves the right to move you to a different course"],
  ["Pas d'encadrement", "No instruction"],
  ["Formule fortement déconseillée aux débutants", "Strongly not recommended for beginners"],
  ["Formule déconseillée aux débutants", "Not recommended for beginners"],
  ["Des conseils de nos équipes pour glisser aux bons endroits et en sécurité", "Guidance from our team on where to ride safely"],
  ["Moniteur de snowboard diplômé", "Certified snowboard instructor"],
  ["guide de haute montagne", "high mountain guide"],
  ["Un moniteur breveté d'état", "A state-certified instructor"],
  ["pour 5 personnes maximum", "for up to 5 people"],
  ["pour 8 personnes maximum", "for up to 8 people"],
  ["8 personnes maximum", "up to 8 people"],
  ["Groupe de 8 maximum constitué pour la semaine", "Group of up to 8, formed for the week"],
  ["après test d'évolution en toutes neiges et tous terrains", "after an all-terrain, all-conditions skill assessment"],
  ["Séance découverte de l'activité dès le dimanche après-midi", "Intro session starting Sunday afternoon"],
  ["la séance découverte du premier jour", "the first-day intro session"],
  ["Groupes de niveaux homogènes", "Groups matched by skill level"],
  ["Alternance de séances encadrées et de glisse en autonomie", "Mix of guided sessions and riding on your own"],
  ["avec 1 break en milieu de semaine", "with a mid-week break"],
  ["réparties sur 4,5 jours", "spread across 4.5 days"],
  ["(1 ou 2 séances par jour)", "(1-2 sessions per day)"],
  ["jusqu'à la fin de votre stage", "valid until the end of your stay"],
  ["jusqu'à la fin de ton séjour", "valid until the end of your stay"],
  ["jusqu'à la fin de ton stage", "valid until the end of your stay"],

  ["réparties dans 2 chalets", "split across 2 chalets"],
  ["réservé aux 13-17 ans", "reserved for ages 13-17"],
  ["disposant de leur propre salle de bains et WC", "with their own bathroom and toilet"],
  ["se situe au cœur des sites de pratique", "is located right at the practice areas"],
  ["fonctionnelles et confortables", "functional and comfortable"],
  ["avec douches et lavabos privatifs", "with private showers and sinks"],
  ["Douches et sanitaires collectifs à chaque étage", "Shared showers and bathrooms on each floor"],
  ["Pensez à apporter vos serviettes de toilette", "Remember to bring your own towels"],
  ["lits séparés", "twin beds"],
  ["d'accueil européen", "welcoming an international crowd"],
  ["lits répartis en chambres de", "beds split across rooms of"],
  ["personnes avec lavabos", "people with sinks"],
  ["chambres de", "rooms of"],
  ["avec douche et lavabo", "with shower and sink"],
  ["sanitaires communs", "shared bathrooms"],
  ["kit linge de lit fournis", "bed linen kit provided"],
  ["Village sportif", "Sports resort"],
  ["chambres confortables de", "comfortable rooms of"],
  ["avec douches et lavabos", "with showers and sinks"],
  ["Sanitaires aux étages", "Shared bathrooms on each floor"],
  ["Possibilité de réserver", "Option to book"],
  ["avec supplément", "for an extra fee"],
  ["uniquement sur les séjours de 7 jours", "7-day stays only"],
  ["équipées de lavabos", "fitted with sinks"],
  ["Moniteur ou Guide de Haute Montagne", "Instructor or High Mountain Guide"],
  ["ou un guide de haute montagne", "or a high mountain guide"],
  ["ou guide de haute montagne", "or a high mountain guide"],
  ["4 et 8", "4 and 8"],
  ["5 et 6", "5 and 6"],
];

// Whole-paragraph rules MUST run before every fragment rule above that could
// consume a piece of the same text first -- same ordering trap as
// PHRASE_RULES vs CATEGORICAL_RULES, just one level down. Longest/most
// specific always goes first, so these are prepended, not appended.
const PARAGRAPH_RULES = [
  ["L'hébergement en chambres de 2 à  4 personnes avec douche et lavabo, sanitaires communs (kit linge de lit fournis)",
    "Accommodation in rooms of 2 to 4 people, with shower and sink, shared bathrooms (bed linen kit provided)"],
  ["330 lits répartis en sas de 2 chambres de 4 personnes. Douches et sanitaires dans chaque sas.36 places en chambre double disposant de leur propre salle de bains et WC.",
    "330 beds split into units of 2 rooms of 4 people. Showers and bathrooms in each unit. 36 spots in double rooms with their own bathroom and toilet."],
  ["Chambres de 4 lits avec lavabos.", "Rooms with 4 beds and sinks."],
  ["Chambres confortables de 4, 5 ou 6 personnes avec douches et lavabos.Hébergement en chambre double uniquement pour les séjours de 7 jours.  Choisir l’option au moment de votre réservation ou appelez le 09 69 390 392 (prix d'un appel local).Sanitaires aux étages.",
    "Comfortable rooms of 4, 5, or 6 people with showers and sinks. Double room available for 7-day stays only. Choose this option when booking, or call 09 69 390 392 (local call rate). Shared bathrooms on each floor."],
  ["Village sportif d'accueil européen.330 places réparties dans 2 chalets dont 1 est réservé aux 13-17 ans. Modules de 2 chambres-cabines de 4 lits reliées par un sas commun comprenant un WC et douche pour 8 personnes.Si vous souhaitez partager la même chambre que d'autres personnes inscrites sur le séjour, merci de nous envoyer un mail à tignes@ucpa.asso.fr",
    "Sports resort welcoming an international crowd. 330 spots split across 2 chalets, one of which is reserved for ages 13-17. Units of 2 cabin-rooms with 4 beds each, connected by a shared entry area with a toilet and shower for 8 people. If you'd like to share a room with other people booked on the trip, please email tignes@ucpa.asso.fr"],
  ["Le village sportif de Serre Chevalier se situe au cœur des sites de pratique. Les chambres sont fonctionnelles et confortables. Elles comptent 4 ou 6 lits, avec douches et lavabos privatifs. Pensez à apporter vos serviettes de toilette.Possibilité de réserver une chambre de 2 au moment de l'inscription (avec supplément), uniquement sur les séjours de 7 jours.",
    "The Serre Chevalier sports resort is located right at the practice areas. The rooms are functional and comfortable, with 4 or 6 beds and private showers and sinks. Remember to bring your own towels. Option to book a room for 2 at the time of registration (for an extra fee), 7-day stays only."],
  ["En majorité, chambres de 4 personnes avec lavabos.Quelques chambres de 5 et 6 personnes, équipées de lavabos.Liseuses individuelles.Douches et sanitaires collectifs à chaque étage. Possibilité d'hébergement à 2 (lits séparés) pour les stages adultes de 7 jours sur village sportif à réserver au moment de l'inscription (avec supplément).",
    "Mostly rooms of 4 people with sinks. A few rooms of 5 and 6 people, also with sinks. Individual reading lights. Shared showers and bathrooms on each floor. Option for twin-bed accommodation for 2 on adult 7-day courses at the sports resort, to book at registration (for an extra fee)."],
  ["Moniteur de snowboard diplômé ou guide de haute montagne.23h d'encadrement réparties sur 4,5 jours.",
    "Certified snowboard instructor or high mountain guide. 23 hours of instruction spread across 4.5 days."],
  ["23h d'encadrement du lundi au vendrediUn moniteur breveté d'état ou un guide de haute montagne pour 5 personnes maximum.",
    "23 hours of instruction, Monday to Friday. A state-certified instructor or high mountain guide for up to 5 people."],
];

// PHRASE_RULES first: it holds the longer, more specific matches (whole
// titles, whole sentences). CATEGORICAL_RULES' short word-level rules run
// last as a fallback -- if they ran first they'd consume fragments like
// "Découverte" out of a longer phrase before the fuller, better translation
// in PHRASE_RULES ever got a chance to match.
const RULES = [...PARAGRAPH_RULES, ...PHRASE_RULES, ...CATEGORICAL_RULES];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Compiled once at module load, not per call -- translate() runs on 9 fields
// of every row of every /api/weeks response, and building a fresh RegExp per
// rule per call (there are 150+ rules) was costing over a second a request
// once the catalogue grew past a couple hundred rows. Reusing a global-flag
// regex across calls is safe: String.replace resets its lastIndex to 0 both
// before and after a full match pass, so nothing leaks between rows.
const COMPILED_RULES = RULES.map(([pattern, replacement]) => [
  pattern instanceof RegExp ? pattern : new RegExp(escapeRegExp(pattern), "g"),
  replacement,
]);

// Same handful of product titles/activities/levels/phrases recur across
// every week row of every product (a few hundred products, thousands of
// weeks), so caching by input text turns most calls into a Map lookup
// instead of another 190-rule pass. Safe to keep for the process lifetime:
// translate() is pure given the constant COMPILED_RULES, and the input
// domain is the scraped catalogue's own text, not unbounded user input.
const translateCache = new Map();

export function translate(text) {
  if (!text) return text;
  const cached = translateCache.get(text);
  if (cached !== undefined) return cached;
  let out = text;
  for (const [re, replacement] of COMPILED_RULES) {
    out = out.replace(re, replacement);
  }
  translateCache.set(text, out);
  return out;
}

export function translateList(list) {
  return (list ?? []).map(translate);
}
