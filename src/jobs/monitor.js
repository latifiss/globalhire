import { createHash } from "node:crypto";
import { db } from "../database/index.js";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { fetchPage, parseHtml, absoluteUrl, pageText } from "../crawler/http.js";
import { matchRole } from "../roles/matcher.js";
import { sendJobAlert } from "../telegram/bot.js";
import { evaluateHiringPolicy } from "../eligibility/policy.js";
import { detectAtsBoard, fetchAtsBoardJobs } from "./ats.js";

const jobLinkHint = /job|career|opening|position|role|greenhouse|lever\.co|ashbyhq|workable/i;

function jobEligibility(text) {
  return evaluateHiringPolicy(text, "Ghana");
}

function contentHash(title, description, location) {
  return createHash("sha256").update(`${title}\n${description}\n${location}`).digest("hex");
}

function looksLikeJobUrl(url, label) {
  return jobLinkHint.test(`${url} ${label}`) && !/privacy|terms|blog|news|about-us/i.test(url);
}

async function parseJobPage(url, fallbackTitle) {
  const page = await fetchPage(url);
  if (!page?.html || page.status >= 400) {
    logger.debug({ url, status: page?.status ?? null, reason: "job_page_fetch_failed" }, "Rejected job page candidate");
    return null;
  }

  const $ = parseHtml(page.html);
  const title = $("h1").first().text().trim()
    || $("meta[property='og:title']").attr("content")
    || $("title").first().text().trim()
    || fallbackTitle;
  const description = [
    $("meta[name='description']").attr("content") ?? "",
    $("[class*='description'], [id*='description'], [class*='job-details'], main").text()
  ].join(" ").replace(/\s+/g, " ").trim().slice(0, 30000);
  const text = pageText($);
  const locationText = text.match(/(?:location|workplace|remote location)\s*[:\-]?\s*([^.!]{1,100})/i)?.[1]?.trim() ?? "";
  const role = matchRole(title, description);
  if (!title || title.length < 3) {
    logger.debug({ url: page.url, title, reason: "job_title_missing" }, "Rejected job page candidate");
    return null;
  }
  if (!role.matched) {
    logger.debug({ url: page.url, title, reason: "role_not_matched" }, "Rejected job page candidate");
    return null;
  }

  const eligibility = jobEligibility(`${title} ${description} ${locationText}`);
  const postedText = $("time[datetime]").first().attr("datetime") ?? null;
  const applyLink = $("a[href]").filter((_, el) => /apply|submit application/i.test($(el).text())).first().attr("href");
  const applicationUrl = applyLink ? absoluteUrl(applyLink, page.url) : page.url;

  return {
    title: title.slice(0, 240),
    description,
    jobUrl: page.url,
    applicationUrl,
    locationText: locationText.slice(0, 240),
    eligible: eligibility.status === "eligible",
    eligibilityPolicy: eligibility.policy,
    eligibilityEvidence: eligibility.evidence,
    roleFamilies: role.families,
    roleScore: role.score,
    postedAt: postedText && !Number.isNaN(Date.parse(postedText)) ? new Date(postedText).toISOString() : null,
    hash: contentHash(title, description, locationText)
  };
}

async function fetchAtsJobs(pageUrl) {
  const page = await fetchPage(pageUrl);
  const boards = new Map();
  const directBoard = detectAtsBoard(pageUrl);
  if (directBoard) boards.set(directBoard.provider + "/" + directBoard.host + "/" + (directBoard.slug ?? directBoard.url), directBoard);

  if (page?.html && page.status < 400) {
    const $ = parseHtml(page.html);
    $("a[href]").each((_, element) => {
      const url = absoluteUrl($(element).attr("href"), page.url);
      const board = url && detectAtsBoard(url);
      if (board) boards.set(board.provider + "/" + board.host + "/" + (board.slug ?? board.url), board);
    });
  }

  const jobs = [];
  for (const board of boards.values()) {
    const result = await fetchAtsBoardJobs(board, { timeoutMs: config.requestTimeoutMs });
    logger.info({
      companyPage: pageUrl,
      provider: board.provider,
      boardUrl: board.url,
      endpoint: result.endpoint,
      status: result.status,
      jobsReturned: result.jobs.length,
      error: result.error
    }, "ATS board checked");

    for (const item of result.jobs) {
      const role = matchRole(item.title, item.description);
      if (!role.matched) {
        logger.debug({ provider: board.provider, url: item.jobUrl, title: item.title, reason: "role_not_matched" }, "Rejected ATS job");
        continue;
      }
      const eligibility = jobEligibility(item.title + " " + item.description + " " + item.location);
      const postedAt = item.postedAt && !Number.isNaN(Date.parse(item.postedAt)) ? new Date(item.postedAt).toISOString() : null;
      jobs.push({
        title: item.title.slice(0, 240),
        description: item.description,
        jobUrl: item.jobUrl,
        applicationUrl: item.applicationUrl,
        locationText: item.location.slice(0, 240),
        eligible: eligibility.status === "eligible",
        eligibilityPolicy: eligibility.policy,
        eligibilityEvidence: eligibility.evidence,
        roleFamilies: role.families,
        roleScore: role.score,
        postedAt,
        hash: contentHash(item.title, item.description, item.location)
      });
    }
  }
  return jobs;
}

function recordJobEvidence(jobUrl, parsed) {
  const job = db.prepare("SELECT id FROM jobs WHERE job_url = ?").get(jobUrl);
  if (!job) return;
  db.prepare(`
    INSERT OR IGNORE INTO job_revisions (job_id, content_hash, title, description, location_text, hiring_policy)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(job.id, parsed.hash, parsed.title, parsed.description, parsed.locationText, parsed.eligibilityPolicy);
  const insertEvidence = db.prepare(`
    INSERT OR IGNORE INTO job_evidence (job_id, evidence_type, evidence_text, source_url, confidence)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const item of parsed.eligibilityEvidence ?? []) {
    insertEvidence.run(job.id, item.type, item.signal, jobUrl, item.type === "missing_evidence" ? 0.2 : 0.85);
  }
}

async function saveJob(company, parsed) {
  const effective = company.eligibility_status === "ineligible"
    ? {
        ...parsed,
        eligible: false,
        eligibilityPolicy: "conflicting_company_and_job_evidence",
        eligibilityEvidence: [...(parsed.eligibilityEvidence ?? []), {
          type: "company_country_exclusion",
          signal: "Company-level policy explicitly excludes Ghana"
        }]
      }
    : parsed;
  const previous = db.prepare("SELECT id FROM jobs WHERE job_url = ?").get(parsed.jobUrl);
  db.prepare(`
    INSERT INTO jobs (
      company_id, title, description, job_url, application_url, location_text,
      remote_policy, hiring_policy, posted_at, role_families, role_match_score, ghana_eligible,
      content_hash, last_seen_at, updated_at, status
    ) VALUES (
      @companyId, @title, @description, @jobUrl, @applicationUrl, @locationText,
      @remotePolicy, @hiringPolicy, @postedAt, @roleFamilies, @roleScore, @eligible,
      @hash, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'open'
    )
    ON CONFLICT(job_url) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      application_url = excluded.application_url,
      location_text = excluded.location_text,
      remote_policy = excluded.remote_policy,
      hiring_policy = excluded.hiring_policy,
      posted_at = COALESCE(excluded.posted_at, jobs.posted_at),
      role_families = excluded.role_families,
      role_match_score = excluded.role_match_score,
      ghana_eligible = excluded.ghana_eligible,
      content_hash = excluded.content_hash,
      last_seen_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP,
      status = 'open'
  `).run({
    companyId: company.id,
    title: parsed.title,
    description: parsed.description,
    jobUrl: parsed.jobUrl,
    applicationUrl: parsed.applicationUrl,
    locationText: parsed.locationText,
    remotePolicy: effective.eligibilityPolicy,
    hiringPolicy: effective.eligibilityPolicy,
    postedAt: parsed.postedAt,
    roleFamilies: JSON.stringify(parsed.roleFamilies),
    roleScore: parsed.roleScore,
    eligible: effective.eligible ? 1 : 0,
    hash: parsed.hash
  });
  recordJobEvidence(parsed.jobUrl, effective);

  if (!previous && effective.eligible) {
    const sent = await sendJobAlert({
      title: parsed.title,
      companyName: company.name || company.domain,
      locationText: parsed.locationText,
      ghanaEligible: effective.eligible,
      matchScore: parsed.roleScore,
      jobUrl: parsed.jobUrl
    }).catch(error => {
      logger.error({ url: parsed.jobUrl, error: error.message }, "Could not send job alert");
      return false;
    });
    if (sent) db.prepare("UPDATE jobs SET alert_sent_at = CURRENT_TIMESTAMP WHERE job_url = ?").run(parsed.jobUrl);
    return sent ? 1 : 0;
  }
  return 0;
}

async function checkCompany(company) {
  let pageUrl = company.careers_url || company.website_url;
  if (!pageUrl) {
    logger.info({ company: company.domain, reason: "no_website_or_careers_url" }, "Skipped company job check");
    return { pages: 0, jobs: 0, alerts: 0 };
  }

  let careersPage = await fetchPage(pageUrl);
  if (!careersPage?.html || careersPage.status >= 400 || !company.careers_url) {
    for (const candidatePath of ["/careers", "/jobs", "/company/careers", "/about/careers", "/join-us"]) {
      const candidateUrl = new URL(candidatePath, company.website_url || pageUrl).href;
      if (candidateUrl === pageUrl) continue;
      const probe = await fetchPage(candidateUrl);
      if (!probe?.html || probe.status >= 400) continue;
      const probe$ = parseHtml(probe.html);
      const hasJobLinks = probe$("a[href]").toArray().some(element => {
        const label = probe$(element).text().trim();
        const href = probe$(element).attr("href") ?? "";
        const absolute = absoluteUrl(href, probe.url);
        return looksLikeJobUrl(href, label) || Boolean(absolute && atsBoardFromUrl(absolute));
      });
      if (hasJobLinks || /career|job opening|open roles|join our team|vacanc/i.test(pageText(probe$))) {
        careersPage = probe;
        pageUrl = probe.url;
        break;
      }
    }
  }
  if (!careersPage?.html || careersPage.status >= 400) {
    logger.info({ company: company.domain, pageUrl, reason: "careers_page_fetch_failed" }, "Company job check could not fetch page");
    db.prepare("UPDATE companies SET last_job_check_at = CURRENT_TIMESTAMP WHERE id = ?").run(company.id);
    return { pages: 1, jobs: 0, alerts: 0 };
  }

  const atsPageUrls = [...new Set([company.website_url, company.careers_url, pageUrl].filter(Boolean))];
  const atsJobMap = new Map();
  for (const atsPageUrl of atsPageUrls) {
    for (const parsed of await fetchAtsJobs(atsPageUrl)) atsJobMap.set(parsed.jobUrl, parsed);
  }
  const atsJobs = [...atsJobMap.values()];
  let jobs = 0;
  let alerts = 0;
  for (const parsed of atsJobs) {
    alerts += await saveJob(company, parsed);
    jobs += 1;
  }

  const $ = parseHtml(careersPage.html);
  const links = [];
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    const label = $(element).text().trim().replace(/\s+/g, " ");
    const url = absoluteUrl(href, careersPage.url);
    const board = url && detectAtsBoard(url);
    if (url && (looksLikeJobUrl(url, label) || board)) links.push({ url, label, provider: board?.provider ?? null });
  });

  const candidates = [...new Map(links.map(link => [link.url, link])).values()].slice(0, config.maxPagesPerDomain);
  logger.debug({ company: company.domain, pageUrl, candidateLinks: candidates }, "Job candidate links extracted");

  for (const candidate of candidates) {
    const board = detectAtsBoard(candidate.url);
    if (board) continue;
    const parsed = await parseJobPage(candidate.url, candidate.label);
    if (!parsed) continue;

    const effective = company.eligibility_status === "ineligible"
      ? {
          ...parsed,
          eligible: false,
          eligibilityPolicy: "conflicting_company_and_job_evidence",
          eligibilityEvidence: [...(parsed.eligibilityEvidence ?? []), {
            type: "company_country_exclusion",
            signal: "Company-level policy explicitly excludes Ghana"
          }]
        }
      : parsed;
    const previous = db.prepare("SELECT id, content_hash, alert_sent_at FROM jobs WHERE job_url = ?").get(parsed.jobUrl);
    db.prepare(`
      INSERT INTO jobs (
        company_id, title, description, job_url, application_url, location_text,
        remote_policy, hiring_policy, posted_at, role_families, role_match_score, ghana_eligible,
        content_hash, last_seen_at, updated_at, status
      ) VALUES (
        @companyId, @title, @description, @jobUrl, @applicationUrl, @locationText,
        @remotePolicy, @hiringPolicy, @postedAt, @roleFamilies, @roleScore, @eligible,
        @hash, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'open'
      )
      ON CONFLICT(job_url) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        application_url = excluded.application_url,
        location_text = excluded.location_text,
        remote_policy = excluded.remote_policy,
      hiring_policy = excluded.hiring_policy,
        posted_at = COALESCE(excluded.posted_at, jobs.posted_at),
        role_families = excluded.role_families,
        role_match_score = excluded.role_match_score,
        ghana_eligible = excluded.ghana_eligible,
        content_hash = excluded.content_hash,
        last_seen_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP,
        status = 'open'
    `).run({
      companyId: company.id,
      title: parsed.title,
      description: parsed.description,
      jobUrl: parsed.jobUrl,
      applicationUrl: parsed.applicationUrl,
      locationText: parsed.locationText,
      remotePolicy: effective.eligibilityPolicy,
    hiringPolicy: effective.eligibilityPolicy,
      postedAt: parsed.postedAt,
      roleFamilies: JSON.stringify(parsed.roleFamilies),
      roleScore: parsed.roleScore,
      eligible: effective.eligible ? 1 : 0,
      hash: parsed.hash
    });
    recordJobEvidence(parsed.jobUrl, effective);
    jobs += 1;

    if (!previous && effective.eligible) {
      const sent = await sendJobAlert({
        title: parsed.title,
        companyName: company.name || company.domain,
        locationText: parsed.locationText,
        ghanaEligible: effective.eligible,
        matchScore: parsed.roleScore,
        jobUrl: parsed.jobUrl
      }).catch(error => {
        logger.error({ url: parsed.jobUrl, error: error.message }, "Could not send job alert");
        return false;
      });

      if (sent) {
        db.prepare("UPDATE jobs SET alert_sent_at = CURRENT_TIMESTAMP WHERE job_url = ?").run(parsed.jobUrl);
        alerts += 1;
      }
    }
  }

  db.prepare("UPDATE companies SET last_job_check_at = CURRENT_TIMESTAMP WHERE id = ?").run(company.id);
  logger.info({
    company: company.domain,
    pageUrl,
    atsJobs: atsJobs.length,
    candidateLinks: candidates.length,
    jobsFound: jobs,
    alertsSent: alerts
  }, "Company job check completed");
  return { pages: candidates.length + atsPageUrls.length, jobs, alerts };
}

export async function runJobMonitoring() {
  const run = db.prepare("INSERT INTO crawl_runs (crawler, status) VALUES (?, ?)").run("job-monitor", "running");
  let pagesChecked = 0;
  let jobsFound = 0;
  let alertsSent = 0;

  try {
    const companies = db.prepare(`
      SELECT id, name, domain, website_url, careers_url, eligibility_status
      FROM companies
      WHERE ((careers_url IS NOT NULL AND careers_url != '')
         OR (website_url IS NOT NULL AND website_url != ''))
        AND domain NOT IN ('github.community', 'githubstatus.com', 'github.careers', 'github.blog', 'calendly.com', 'twitch.tv', 'trust.wellfound.ai')
      ORDER BY COALESCE(last_job_check_at, '') ASC
    `).all();

    for (const company of companies) {
      const result = await checkCompany(company);
      pagesChecked += result.pages;
      jobsFound += result.jobs;
      alertsSent += result.alerts;
    }

    db.prepare(`
      UPDATE crawl_runs SET status = 'success', finished_at = CURRENT_TIMESTAMP,
        pages_checked = ?, records_found = ? WHERE id = ?
    `).run(pagesChecked, jobsFound, run.lastInsertRowid);

    logger.info({ companies: companies.length, pagesChecked, jobsFound, alertsSent }, "Job monitoring run completed");
    return { companies: companies.length, pagesChecked, jobsFound, alertsSent };
  } catch (error) {
    db.prepare(`
      UPDATE crawl_runs SET status = 'failed', finished_at = CURRENT_TIMESTAMP,
        pages_checked = ?, records_found = ?, error = ? WHERE id = ?
    `).run(pagesChecked, jobsFound, error.message, run.lastInsertRowid);
    logger.error({ error: error.message }, "Job monitoring run failed");
    throw error;
  }
}
