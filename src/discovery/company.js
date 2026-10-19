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
  "google.com", "youtube-nocookie.com", "crunchbase.com", "wikipedia.org",
  "github.blog", "githubstatus.com", "github.community", "github.careers",
  "twitch.tv", "trust.wellfound.ai", "calendly.com"
]);

const ignoredHostPatterns = [
  /(^|\\.)(blog|status|community|support|help|docs|trust|investors|press|news|about)\\./i,
  /(^|\\.)(google|microsoft|apple|amazon|meta|twitch|github|linkedin|wellfound|producthunt)\\./i
];

function isIgnoredDomain(domain) {
  return ignoredDomains.has(domain)
    || [...ignoredDomains].some(ignored => domain.endsWith(`.${ignored}`))
    || ignoredHostPatterns.some(pattern => pattern.test(domain));
}

function isLikelyCompanyLink(label, url) {
  const text = `${label} ${url}`.toLowerCase();
  if (!label || label.length < 2) return false;
  if (/privacy|terms|cookie|status|documentation|support|help center|blog|press|newsroom|login|sign.?up|sign.?in|pricing|contact|about us|social media/i.test(text)) return false;
  return /company|startup|product|team|founder|website|visit|launch|maker|saas|software|platform|app|studio|labs|inc\\b|\\.io\\b|\\.ai\\b|\\.com\\b/i.test(text)
    && !/^(home|learn more|read more|click here|more|next|previous)$/i.test(label.trim());
}

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
  if (!domain || isIgnoredDomain(domain)) return null;

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

  let careersUrl = [...new Set(links)][0] ?? null;

  if (!careersUrl) {
    for (const candidate of ["/careers", "/jobs", "/company/careers", "/about/careers"]) {
      const probe = await fetchPage(new URL(candidate, rootUrl).href);
      if (probe?.html && probe.status < 400) {
        const probeText = pageText(parseHtml(probe.html));
        if (/career|job opening|open roles|join our team|positions/i.test(probeText)) {
          careersUrl = probe.url;
          break;
        }
      }
    }
  }
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

function discoverySources() {
  const sourceFile = path.join(rootDir, "seeds", "discovery-sources.json");
  if (!fs.existsSync(sourceFile)) return [];
  try {
    return JSON.parse(fs.readFileSync(sourceFile, "utf8")).filter(source => source.enabled && source.url);
  } catch (error) {
    logger.warn({ error: error.message }, "Could not parse discovery-sources.json");
    return [];
  }
}

async function findExternalCompanyDomains(source) {
  const page = await fetchPage(source.url);
  if (!page?.html || page.status >= 400) return [];
  const $ = parseHtml(page.html);
  const sourceDomain = normalizeDomain(source.url);
  const candidates = new Map();

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    const url = absoluteUrl(href, page.url);
    if (!url) return;
    const domain = normalizeDomain(url);
    if (!domain || domain === sourceDomain || domain.endsWith(`.${sourceDomain}`)) return;
    if ([...ignoredDomains].some(ignored => domain === ignored || domain.endsWith(`.${ignored}`))) return;
    if (/\.(png|jpe?g|gif|svg|webp|pdf|zip|css|js)(\?|$)/i.test(url)) return;
    if (domain.split(".").length < 2) return;
    candidates.set(domain, { domain, source: source.name, url });
  });

  return [...candidates.values()].slice(0, 25);
}

export async function runCompanyDiscovery() {
  const run = db.prepare("INSERT INTO crawl_runs (crawler, status) VALUES (?, ?)").run("company-discovery", "running");
  let found = 0;
  let pagesChecked = 0;

  try {
    const candidates = new Map();
    for (const domain of sourceDomains()) {
      const url = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
      const normalized = normalizeDomain(url);
      if (normalized) candidates.set(normalized, { url, source: "seed-domains.txt" });
    }

    for (const source of discoverySources()) {
      pagesChecked += 1;
      const externalCandidates = await findExternalCompanyDomains(source);
      for (const candidate of externalCandidates) {
        if (!candidates.has(candidate.domain)) {
          candidates.set(candidate.domain, { url: candidate.url, source: candidate.source });
        }
      }
    }

    for (const [domain, candidate] of candidates) {
      pagesChecked += 1;
      const result = await inspectCompany(candidate.url, candidate.source);
      if (result) found += 1;
    }

    db.prepare(`
      UPDATE crawl_runs SET status = 'success', finished_at = CURRENT_TIMESTAMP,
        pages_checked = ?, records_found = ? WHERE id = ?
    `).run(pagesChecked, found, run.lastInsertRowid);

    logger.info({ pagesChecked, candidates: candidates.size, found }, "Company discovery run completed");
    return { pagesChecked, candidates: candidates.size, found };
  } catch (error) {
    db.prepare(`
      UPDATE crawl_runs SET status = 'failed', finished_at = CURRENT_TIMESTAMP,
        pages_checked = ?, records_found = ?, error = ? WHERE id = ?
    `).run(pagesChecked, found, error.message, run.lastInsertRowid);
    logger.error({ error: error.message }, "Company discovery run failed");
    throw error;
  }
}
