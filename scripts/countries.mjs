/**
 * Maps the country names Wikipedia puts in flag-icon alt text to ISO codes and
 * flag emoji. Covers the 55 UEFA associations plus the aliases the article uses
 * interchangeably (Turkey/Türkiye, Czechia/Czech Republic, Ireland/Republic of…).
 */

const ISO = {
  albania: "AL", andorra: "AD", armenia: "AM", austria: "AT", azerbaijan: "AZ",
  belarus: "BY", belgium: "BE", "bosnia and herzegovina": "BA", bulgaria: "BG",
  croatia: "HR", cyprus: "CY", czechia: "CZ", denmark: "DK", estonia: "EE",
  "faroe islands": "FO", finland: "FI", france: "FR", georgia: "GE",
  germany: "DE", gibraltar: "GI", greece: "GR", hungary: "HU", iceland: "IS",
  israel: "IL", italy: "IT", kazakhstan: "KZ", kosovo: "XK", latvia: "LV",
  liechtenstein: "LI", lithuania: "LT", luxembourg: "LU", malta: "MT",
  moldova: "MD", montenegro: "ME", netherlands: "NL", "north macedonia": "MK",
  norway: "NO", poland: "PL", portugal: "PT", ireland: "IE", romania: "RO",
  russia: "RU", "san marino": "SM", serbia: "RS", slovakia: "SK",
  slovenia: "SI", spain: "ES", sweden: "SE", switzerland: "CH", turkey: "TR",
  ukraine: "UA",
};

/** The UK home nations use subdivision tag sequences, not two-letter codes. */
const SUBDIVISIONS = {
  england: "gb-eng",
  scotland: "gb-sct",
  wales: "gb-wls",
  "northern ireland": "gb-nir", // no emoji exists; falls back to the code
};

const ALIASES = {
  "czech republic": "czechia",
  "republic of ireland": "ireland",
  "the republic of ireland": "ireland",
  holland: "netherlands",
  "bosnia-herzegovina": "bosnia and herzegovina",
  "bosnia & herzegovina": "bosnia and herzegovina",
  türkiye: "turkey",
  turkiye: "turkey",
  macedonia: "north macedonia",
  "fyr macedonia": "north macedonia",
  "faroe island": "faroe islands",
  "great britain": "england",
  "georgia country": "georgia", // alt text disambiguates from the US state
};

/** No flag emoji is assigned to these, so the UI shows the code instead. */
const NO_EMOJI = new Set(["XK", "gb-nir"]);

const normalize = (name) =>
  (name ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics, so u-umlaut -> u
    .toLowerCase()
    .replace(/[^a-z\s&-]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const REGIONAL_A = 0x1f1e6;
const TAG_BASE = 0xe0000;

function toEmoji(code) {
  if (!code || NO_EMOJI.has(code)) return null;

  if (code.includes("-")) {
    // e.g. gb-sct -> 🏴 + tag chars for "gbsct" + cancel tag
    const letters = code.replace("-", "");
    return (
      "\u{1F3F4}" +
      [...letters].map((c) => String.fromCodePoint(TAG_BASE + c.charCodeAt(0))).join("") +
      "\u{E007F}"
    );
  }
  return [...code]
    .map((c) => String.fromCodePoint(REGIONAL_A + c.charCodeAt(0) - 65))
    .join("");
}

/** @returns {{name:string, code:string|null, flag:string|null}} */
export function lookup(countryName) {
  const key = normalize(countryName);
  const resolved = ALIASES[key] ?? key;
  const code = SUBDIVISIONS[resolved] ?? ISO[resolved] ?? null;
  return {
    name: countryName ?? null,
    code,
    flag: toEmoji(code),
  };
}
