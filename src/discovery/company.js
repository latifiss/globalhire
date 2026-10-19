import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../database/index.js";
import { fetchPage, parseHtml, absoluteUrl, normalizeDomain, pageText } from "../crawler/http.js";
import { logger } from "../config/logger.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(currentDir, "../..");

const careerHints = /career|jobs|join[- ]?us|work[- ]?with[- ]?us|open[- ]?roles|vacanc|greenhouse|lever\.co|ashbyhq|workable/i;
const ignoredDomains = new Set([
  "linkedin.com", "twitter.com", "x.com", "facebook.com", "instagram.com",
  "youtube.com", "tiktok.com", "github.com", "wellfound.com", "producthunt.com",
  "google.com", "youtube-nocookie.com", "crunchbase.com", "wikipedia.org"
]);

function getCompanyName($, domain) {
  const value = $("meta[property='og:site_name']").attr("content")
    || $("meta[name='application-name']").attr("content")
    || $("title").first().text()
    || domain;
  return value.replace(/\s*[|—–:-].*$/, "").replace(/\s+/g, " ").trim().slice(0, 160) || domain;
}

function eligibilityFrom(text) {
  const evidence = [];
  const worldwide = /worldwide|anywhere in the world|work from anywhere|remote[- ]?first.{0,40}global|globally distributed|remote from any country|international contractors|contractors worldwide/i;
  const africa = /hire.{0,35}(africa|ghana)|africa.{0,35}(eligible|hiring|remote)|african countries|work from africa/i;
  const restriction = /must be based in (the )?(united states|u\.?s\.?|canada|united kingdom|uk|europe)|only hiring in|residents of (the )?(united states|canada|uk|united kingdom)|not available in (ghana|africa)/i;

  if (worldwide.test(text)) evidence.push("Public website contains an explicit worldwide/any-country hiring signal");
  if (africa.test(text)) evidence.push("Public website contains an Africa/Ghana hiring signal");
  if (restriction.test(text)) evidence.push("Public website contains a geographic hiring restriction");

  if (evidence.some(item => item.includes("restriction"))) return { status: "review", policy: "restricted_or_ambiguous", evidence };
  if (evidence.some(item => item.includes("worldwide") || item.includes("Africa/Ghana"))) {
    return { status: "eligible", policy: "explicit_global_or_africa", evidence };
  }
  return { status: "review", policy: "unknown", evidence: ["No clear public evidence that hiring is available from Ghana"] };
}

function employeeRange(text) {
  const match = text.match(/(?:team of|company of|employees|employee range|company size)[^\d]{0,20}(\d{1,4})\s*(?:-|–|to)\s*(\d{1,4})/i)
    || text.match(/(\d{1,4})\s*(?:-|–|to)\s*(\d{1,4})\s+employees/i);
  if (!match) return { min: null, max: null };
  return { min: Number(match[1]), max: Number(match[2]) };
}

async function inspectCompany(websiteUrl, source) {
  const domain = normalizeDomain(websiteUrl);
  if (!domain || ignoredDomains.has(domain)) return null;

  const rootUrl = `https://${domain}`;
  const page = await fetchPage(rootUrl);
  if (!page?.html || page.status >= 400) return null;

  const $ = parseHtml(page.html);
  const text = pageText($);
  const name = getCompanyName($, domain);
  const links = [];

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    const label = $(element).text().trim();
    const url = absoluteUrl(href, page.url);
    if (url && careerHints.test(`${label} ${url}`)) links.push(url);
  });

  const careersUrl = [...new Set(links)][0] ?? null;
  const policy = eligibilityFrom(text);
  const range = employeeRange(text);
  const linkedinUrl = $("a[href*='linkedin.com/company/']").first().attr("href") ?? null;
  const eligibleSize = range.max !== null && range.max <= 50;
  const evidence = [...policy.evidence];

  if (range.max !== null) evidence.push(`Detected public team size range: ${range.min}-${range.max}`);
  if (!eligibleSize) evidence.push("Company size has not been verified as 50 employees or fewer");

  const eligibilityStatus = policy.status === "eligible" && eligibleSize ? "eligible" : "review";

  db.prepare(`
    INSERT INTO companies (
      name, domain, website_url, careers_url, linkedin_url,
      employee_count_min, employee_count_max, remote_policy, hiring_regions,
      eligibility_status, eligibility_evidence, discovery_source, last_checked_at,
      last_http_status, updated_at
    ) VALUES (
      @name, @domain, @websiteUrl, @careersUrl, @linkedinUrl,
      @employeeMin, @employeeMax, @remotePolicy, @hiringRegions,
      @eligibilityStatus, @evidence, @source, CURRENT_TIMESTAMP,
      @status, CURRENT_TIMESTAMP
    )
    ON CONFLICT(domain) DO UPDATE SET
      name = excluded.name,
      website_url = excluded.website_url,
      careers_url = COALESCE(excluded.careers_url, companies.careers_url),
      linkedin_url = COALESCE(excluded.linkedin_url, companies.linkedin_url),
      employee_count_min = COALESCE(excluded.employee_count_min, companies.employee_count_min),
      employee_count_max = COALESCE(excluded.employee_count_max, companies.employee_count_max),
      remote_policy = excluded.remote_policy,
      hiring_regions = excluded.hiring_regions,
      eligibility_status = excluded.eligibility_status,
      eligibility_evidence = excluded.eligibility_evidence,
      discovery_source = COALESCE(companies.discovery_source, excluded.discovery_source),
      last_checked_at = CURRENT_TIMESTAMP,
      last_http_status = excluded.last_http_status,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    name,
    domain,
    websiteUrl: rootUrl,
    careersUrl,
    linkedinUrl,
    employeeMin: range.min,
    employeeMax: range.max,
    remotePolicy: policy.policy,
    hiringRegions: policy.status === "eligible" ? "explicit_global_or_africa" : "unknown",
    eligibilityStatus,
    evidence: JSON.stringify(evidence),
    source,
    status: page.status
  });

  return { domain, name, careersUrl, eligibilityStatus };
}

function sourceDomains() {
  const domainsFile = path.join(rootDir, "seeds", "seed-domains.txt");
  const raw = fs.existsSync(domainsFile) ? fs.readFileSync(domainsFile, "utf8") : "";
  return raw.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
}

export async function runCompanyDiscovery() {
  const run = db.prepare("INSERT INTO crawl_runs (crawler, status) VALUES (?, ?)").run("company-discovery", "running");
  let found = 0;
  let pagesChecked = 0;

  try {
    const domains = [...new Set(sourceDomains())];
    for (const candidate of domains) {
      const url = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
      pagesChecked += 1;
      const result = await inspectCompany(url, "seed-domains.txt");
      if (result) found += 1;
    }

    db.prepare(`
      UPDATE crawl_runs SET status = 'success', finished_at = CURRENT_TIMESTAMP,
        pages_checked = ?, records_found = ? WHERE id = ?
    `).run(pagesChecked, found, run.lastInsertRowid);

    logger.info({ pagesChecked, found }, "Company discovery run completed");
    return { pagesChecked, found };
  } catch (error) {
    db.prepare(`
      UPDATE crawl_runs SET status = 'failed', finished_at = CURRENT_TIMESTAMP,
        pages_checked = ?, records_found = ?, error = ? WHERE id = ?
    `).run(pagesChecked, found, error.message, run.lastInsertRowid);
    logger.error({ error: error.message }, "Company discovery run failed");
    throw error;
  }
}
