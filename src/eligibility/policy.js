const worldwidePatterns = [
  /\bworldwide\b/i,
  /\banywhere in the world\b/i,
  /\banywhere globally\b/i,
  /\bfrom any country\b/i,
  /\bopen to candidates from all countries\b/i,
  /\bopen to applicants from all countries\b/i,
  /\bremote from any country\b/i,
  /\bwork from anywhere\b/i,
  /\banywhere on the planet\b/i,
  /\bglobally remote\b/i,
  /\bremote globally\b/i,
  /\bglobal remote team\b/i,
  /\bno geographic restrictions\b/i,
  /\bno location restrictions\b/i,
  /\bdistributed globally\b/i,
  /\b(?:hire|hiring|employ) (?:people|talent|team members|employees|contractors) (?:from|in) (?:any|all) countries\b/i,
  /\bcontractors worldwide\b/i,
  /\binternational contractors\b/i,
  /\bglobal contractor(?:s| hiring)?\b/i
];

const africaPatterns = [
  /\bremote across africa\b/i,
  /\b(?:hire|hiring|employ) remotely (?:in|across|from) africa\b/i,
  /\b(?:hire|hiring|employ) (?:people|talent|team members|employees|contractors) remotely (?:in|across|from) africa\b/i,
  /\bremote (?:roles|positions|opportunities) across africa\b/i,
  /\bremote in africa\b/i,
  /\bwork from africa\b/i,
  /\bcandidates? based in africa\b/i,
  /\bapplicants? based in africa\b/i,
  /\bafrican countries\b/i,
  /\b(?:hire|hiring|employ) (?:in|across|from) africa\b/i,
  /\bafrica.{0,50}(?:eligible|hiring|candidates|applicants|remote|work from)\b/i
];

const regionalPatterns = [
  { region: "EMEA", patterns: [/\bEMEA\b/i, /\bEurope, Middle East and Africa\b/i] },
  { region: "Europe", patterns: [/\bremote in europe\b/i, /\bremote across europe\b/i, /\b(?:hire|hiring) in europe\b/i, /\bEuropean countries\b/i] },
  { region: "LATAM", patterns: [/\bLATAM\b/i, /\bLatin America\b/i, /\bremote across latin america\b/i] },
  { region: "APAC", patterns: [/\bAPAC\b/i, /\bAsia Pacific\b/i] },
  { region: "Americas", patterns: [/\bAmericas\b/i, /\bNorth and South America\b/i] },
  { region: "North America", patterns: [/\bNorth America\b/i, /\bremote across north america\b/i] }
];

const countryNames = { ghana: ["ghana"] };

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
  const regional = regionalPatterns.flatMap(({region,patterns}) => matchingEvidence(text, patterns, "regional").map(item=>({...item,region})));
  const exclusions = matchingEvidence(text, exclusionPatterns, "country_excluded");
  const regionalRestrictions = matchingEvidence(text, regionRestrictionPatterns, "region_restricted");
  const positive = [...directCountry, ...worldwide, ...africa];
  const restrictive = [...exclusions, ...regionalRestrictions];

  if (exclusions.length) return { status: "ineligible", policy: "explicit_country_exclusion", evidence: [...positive, ...regional, ...restrictive], regions: regional.map(item=>item.region) };
  if (positive.length && restrictive.length) return { status: "review", policy: "conflicting_hiring_evidence", evidence: [...positive, ...regional, ...restrictive], regions: regional.map(item=>item.region) };
  if (regionalRestrictions.length) return { status: "ineligible", policy: "region_restricted", evidence: [...regional, ...regionalRestrictions], regions: regional.map(item=>item.region) };
  if (directCountry.length) return { status: "eligible", policy: "explicit_country_allowed", evidence: [...directCountry, ...regional], regions: regional.map(item=>item.region) };
  if (worldwide.length) return { status: "eligible", policy: "worldwide", evidence: [...worldwide, ...regional], regions: regional.map(item=>item.region) };
  if (africa.length) return { status: "eligible", policy: "africa_allowed", evidence: [...africa, ...regional], regions: regional.map(item=>item.region) };
  if (regional.length) return { status: "review", policy: "regional_scope_requires_verification", evidence: regional, regions: regional.map(item=>item.region) };

  const infrastructure = matchingEvidence(text, [/\b(?:deel|remote\.com|oyster|papaya global)\b/i], "international_employment_infrastructure");
  const contractor = matchingEvidence(text, [/\b(?:hire|hiring|work) (?:global|international) contractors\b/i, /\bcontractors? (?:in|from) multiple countries\b/i], "contractor_support");
  return {
    status: "review",
    policy: infrastructure.length || contractor.length ? "supporting_international_signals" : "unknown",
    evidence: [...infrastructure, ...contractor, { type: "missing_evidence", signal: "No explicit public hiring evidence found for " + country }]
  };
}
