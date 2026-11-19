const endpoint = "https://query.wikidata.org/sparql";
const pageSize = 500;

export async function fetchWikidataCompanies(offset = 0) {
  const query = `SELECT ?company ?companyLabel ?website WHERE {
    ?company wdt:P31/wdt:P279* wd:Q4830453;
             wdt:P856 ?website.
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  }
  ORDER BY ?company
  LIMIT ${pageSize}
  OFFSET ${Math.max(0, Number(offset) || 0)}`;

  const url = new URL(endpoint);
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");

  const response = await fetch(url, {
    headers: {
      accept: "application/sparql-results+json",
      "user-agent": "GlobalHire/1.0 (public company discovery; contact: github.com/latifiss/globalhire)"
    },
    signal: AbortSignal.timeout(45000)
  });

  if (!response.ok) {
    throw new Error(`Wikidata returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  const rows = payload.results?.bindings ?? [];

  return {
    companies: rows.map(row => ({
      name: row.companyLabel?.value?.trim() || null,
      websiteUrl: row.website?.value || null,
      entityUrl: row.company?.value || null
    })).filter(company => company.websiteUrl),
    count: rows.length,
    nextOffset: rows.length === pageSize ? Number(offset) + pageSize : 0
  };
}
