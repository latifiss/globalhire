const endpoint = "https://query.wikidata.org/sparql";
const pageSize = 100;
const requestTimeoutMs = 20000;
const maxAttempts = 3;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function fetchWikidataCompanies(offset = 0) {
  const safeOffset = Math.max(0, Number(offset) || 0);
  const query = `SELECT ?company ?companyLabel ?website WHERE {
    ?company wdt:P31/wdt:P279* wd:Q4830453;
             wdt:P856 ?website.
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  }
  ORDER BY ?company
  LIMIT ${pageSize}
  OFFSET ${safeOffset}`;

  const url = new URL(endpoint);
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/sparql-results+json",
          "user-agent": "GlobalHire/1.0 (public company discovery; https://github.com/latifiss/globalhire)"
        },
        signal: AbortSignal.timeout(requestTimeoutMs)
      });

      if (!response.ok) {
        if (response.status === 429 || response.status >= 500) {
          throw new Error(`Wikidata temporarily returned HTTP ${response.status}`);
        }
        throw new Error(`Wikidata returned HTTP ${response.status}`);
      }

      const payload = await response.json();
      const rows = payload.results?.bindings ?? [];
      const companies = rows.map(row => ({
        name: row.companyLabel?.value?.trim() || null,
        websiteUrl: row.website?.value || null,
        entityUrl: row.company?.value || null
      })).filter(company => company.websiteUrl);

      return {
        companies,
        count: rows.length,
        nextOffset: rows.length === pageSize ? safeOffset + pageSize : 0
      };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await delay(attempt * 3000);
    }
  }

  throw lastError;
}
