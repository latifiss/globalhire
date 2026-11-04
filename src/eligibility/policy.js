const countryNames = {
  ghana: ["ghana"],
  nigeria: ["nigeria"],
  kenya: ["kenya"],
  southafrica: ["south africa"]
};

const worldwidePatterns = [
  /\bworldwide\b/i,
  /\banywhere in the world\b/i,
  /\banywhere globally\b/i,
  /\bfrom any country\b/i,
  /\bopen to candidates from all countries\b/i,
  /\bopen to applicants from all countries\b/i,
  /\bremote from any country\b/i,
  /\binternational contractors\b/i,
  /\bcontractors worldwide\b/i,
  /\bwork from anywhere\b/i
];

const africaPatterns = [
  /\bcandidates? based in africa\b/i,
  /\bapplicants? based in africa\b/i,
  /\bhire(?:s|d|ing)? .{0,35}africa\b/i,
  /\bafrica.{0,35}(?:eligible|hiring|candidates|applicants|remote|work from)\b/i,
  /\bwork from africa\b/i,
  /\bafrican countries\b/i
];

const exclusionPatterns = [
  /\bnot (?:available|open|eligible) (?:to|for|in|from) candidates? (?:based )?in ghana\b/i,
  /\bcannot hire (?:in|from) ghana\b/i,
  /\bcannot (?:hire|employ) .{0,70}(?:based|located|resident) in ghana\b/i,
  /\bdo not (?:hire|employ) .{0,70}(?:based|located|resident) in ghana\b/i,
  /\bwill not (?:hire|employ) .{0,70}(?:based|located|resident) in ghana\b/i,
  /\bnot hiring (?:in|from) ghana\b/i,
  /\bghana is (?:not|excluded)\b/i,
  /\bexcluding ghana\b/i
];

const regionRestrictionPatterns = [
  /\bonly (?:hire|hiring|accept|consider|employ) (?:people|candidates|applicants|employees|contractors)?\s*(?:who are )?(?:based|located|resident)?\s*(?:in|within) (?:the )?(?:united states|u\.?s\.?|canada|united kingdom|uk|europe|european union|north america)\b/i,
  /\bmust be (?:based|located|resident) in (?:the )?(?:united states|u\.?s\.?|canada|united kingdom|uk|europe|european union)\b/i,
  /\bcurrently hiring (?:only )?in (?:the )?(?:united states|u\.?s\.?|canada|united kingdom|uk|europe)\b/i,
  /\b(?:this|the) (?:position|role|job) .{0,100}(?:requires|require) .{0,60}(?:based|located|resident) in (?:the )?(?:united states|u\.?s\.?|canada|united kingdom|uk|europe|european union)\b/i,
  /\brequires? candidates? to be based in (?:the )?(?:united states|u\.?s\.?|canada|united kingdom|uk|europe|european union)\b/i,
  /\beligible to work in (?:the )?(?:united states|u\.?s\.?|canada|united kingdom|uk)\b/i
];

function matchingEvidence(text, patterns, type) {
  return patterns.flatMap(pattern => {
    const match = text.match(pattern);
    return match ? [{ type, signal: match[0].trim() }] : [];
  });
}

export function evaluateHiringPolicy(value = "", country = "Ghana") {
  const text = String(value).replace(/\s+/g, " ").trim().slice(0, 100000);
  const normalizedCountry = String(country).toLowerCase().replace(/[^a-z]/g, "");
  const aliases = countryNames[normalizedCountry] ?? [String(country).toLowerCase()];
  const countryPatterns = aliases.map(alias => new RegExp(
    "(?:based|located|living|residing|working|work|candidates?|applicants?|employees?|contractors?|hiring|hire|eligible|open to).{0,55}\\b" + alias + "\\b|\\b" + alias + "\\b.{0,55}(?:eligible|hiring|candidates?|applicants?|employees?|contractors?|work|remote|open)",
    "i"
  ));

  const directCountry = matchingEvidence(text, countryPatterns, "country_allowed");
  const worldwide = matchingEvidence(text, worldwidePatterns, "worldwide");
  const africa = matchingEvidence(text, africaPatterns, "africa_allowed");
  const exclusions = matchingEvidence(text, exclusionPatterns, "country_excluded");
  const regionalRestrictions = matchingEvidence(text, regionRestrictionPatterns, "region_restricted");
  const positive = [...directCountry, ...worldwide, ...africa];
  const restrictive = [...exclusions, ...regionalRestrictions];

  if (exclusions.length) {
    return { status: "ineligible", policy: "explicit_country_exclusion", evidence: [...positive, ...restrictive] };
  }

  if (positive.length && restrictive.length) {
    return { status: "review", policy: "conflicting_hiring_evidence", evidence: [...positive, ...restrictive] };
  }

  if (regionalRestrictions.length) {
    return { status: "ineligible", policy: "region_restricted", evidence: regionalRestrictions };
  }

  if (positive.length) {
    const policyType = directCountry.length ? "explicit_country_allowed" : africa.length ? "africa_allowed" : "worldwide";
    return { status: "eligible", policy: policyType, evidence: positive };
  }

  return {
    status: "review",
    policy: "unknown",
    evidence: [{ type: "missing_evidence", signal: "No explicit public hiring evidence found for " + country }]
  };
}
