import { createHash } from "node:crypto";
import { db } from "../database/index.js";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { fetchPage, parseHtml, absoluteUrl, pageText } from "../crawler/http.js";
import { matchRole } from "../roles/matcher.js";
import { sendJobAlert } from "../telegram/bot.js";

const jobLinkHint = /job|career|opening|position|role|greenhouse|lever\.co|ashbyhq|workable/i;
const globalEvidence = /worldwide|anywhere in the world|work from anywhere|remote from any country|global remote|international contractors|contractors worldwide|open to candidates across (the )?world/i;
const africaEvidence = /hire.{0,35}(africa|ghana)|africa.{0,35}(eligible|hiring|remote)|african countries|work from africa/i;
const restrictiveEvidence = /must be based in (the )?(united states|u\.?s\.?|canada|united kingdom|uk|europe)|only hiring in|residents of (the )?(united states|canada|uk|united kingdom)|not available in (ghana|africa)|cannot hire in (ghana|africa)/i;

const atsHosts = new Set(["boards.greenhouse.io", "job-boards.greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com"]);

function atsBoardFromUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\\./, "");
    if (!atsHosts.has(host)) return null;
    const slug = url.pathname.split("/").filter(Boolean)[0];
    return slug ? { host, slug } : null;
  } catch {
    return null;
  }
}

function jobEligibility(text) {
  if (restrictiveEvidence.test(text)) return false;
  return globalEvidence.test(text) || africaEvidence.test(text);
}

function contentHash(title, description, location) {
  return createHash("sha256").update(`${title}\n${description}\n${location}`).digest("hex");
}

function looksLikeJobUrl(url, label) {
  return jobLinkHint.test(`${url} ${label}`) && !/privacy|terms|blog|news|about-us/i.test(url);
}

async function parseJobPage(url, fallbackTitle) {
  const page = await fetchPage(url);
  if (!page?.html || page.status >= 400) return null;

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
  if (!role.matched) return null;

  const eligible = jobEligibility(`${title} ${description} ${locationText}`);
  const postedText = $("time[datetime]").first().attr("datetime") ?? null;
  const applyLink = $("a[href]").filter((_, el) => /apply|submit application/i.test($(el).text())).first().attr("href");
  const applicationUrl = applyLink ? absoluteUrl(applyLink, page.url) : page.url;

  return {
    title: title.slice(0, 240),
    description,
    jobUrl: page.url,
    applicationUrl,
    locationText: locationText.slice(0, 240),
    eligible,
    roleFamilies: role.families,
    roleScore: role.score,
    postedAt: postedText && !Number.isNaN(Date.parse(postedText)) ? new Date(postedText).toISOString() : null,
    hash: contentHash(title, description, locationText)
  };
}

async function fetchAtsJobs(careersUrl) {
  const page = await fetchPage(careersUrl);
  if (!page?.html || page.status >= 400) return [];
  const $ = parseHtml(page.html);
  const boards = new Map();

  $("a[href]").each((_, element) => {
    const url = absoluteUrl($(element).attr("href"), page.url);
    const board = url && atsBoardFromUrl(url);
    if (board) boards.set(`${board.host}/${board.slug}`, board);
  });

  const jobs = [];
  for (const board of boards.values()) {
    const endpoint = board.host.includes("greenhouse")
      ? `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.slug)}/jobs?content=true`
      : board.host === "jobs.lever.co"
        ? `https://api.lever.co/v0/postings/${encodeURIComponent(board.slug)}?mode=json`
        : `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board.slug)}?includeCompensation=true`;

    try {
      const response = await fetch(endpoint, {
        headers: { "user-agent": "GlobalHireBot/1.0 (+public career-page monitor; respectful crawling)", accept: "application/json" },
        signal: AbortSignal.timeout(config.requestTimeoutMs)
      });
      if (!response.ok) continue;
      const data = await response.json();
      const rows = board.host.includes("greenhouse") ? data.jobs ?? []
        : board.host === "jobs.lever.co" ? data ?? []
        : data.jobs ?? [];

      for (const item of rows) {
        const title = item.title ?? item.text ?? "";
        const description = (item.content ?? item.descriptionHtml ?? item.description ?? "").replace(/<[^>]*>/g, " ").replace(/\\s+/g, " ").trim().slice(0, 30000);
        const role = matchRole(title, description);
        if (!role.matched) continue;
        const locationValue = item.location?.name ?? item.categories?.location ?? item.location ?? "";
        const location = typeof locationValue === "string" ? locationValue : JSON.stringify(locationValue);
        const eligible = jobEligibility(`${title} ${description} ${location}`);
        const jobUrl = item.absolute_url ?? item.hostedUrl ?? item.url ?? item.applyUrl;
        if (!jobUrl) continue;
        const postedValue = item.updated_at ?? item.createdAt ?? item.created_at ?? item.publishedAt ?? null;
        jobs.push({
          title: title.slice(0, 240),
          description,
          jobUrl,
          applicationUrl: item.applyUrl ?? jobUrl,
          locationText: location.slice(0, 240),
          eligible,
          roleFamilies: role.families,
          roleScore: role.score,
          postedAt: postedValue && !Number.isNaN(Date.parse(postedValue)) ? new Date(postedValue).toISOString() : null,
          hash: contentHash(title, description, location)
        });
      }
    } catch (error) {
      logger.debug({ url: endpoint, error: error.message }, "Public ATS feed request failed");
    }
  }
  return jobs;
}

async function saveJob(company, parsed) {
  const previous = db.prepare("SELECT id FROM jobs WHERE job_url = ?").get(parsed.jobUrl);
  db.prepare(`
    INSERT INTO jobs (
      company_id, title, description, job_url, application_url, location_text,
      remote_policy, posted_at, role_families, role_match_score, ghana_eligible,
      content_hash, last_seen_at, updated_at, status
    ) VALUES (
      @companyId, @title, @description, @jobUrl, @applicationUrl, @locationText,
      @remotePolicy, @postedAt, @roleFamilies, @roleScore, @eligible,
      @hash, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'open'
    )
    ON CONFLICT(job_url) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      application_url = excluded.application_url,
      location_text = excluded.location_text,
      remote_policy = excluded.remote_policy,
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
    remotePolicy: parsed.eligible ? "explicit_global_or_africa" : "unknown",
    postedAt: parsed.postedAt,
    roleFamilies: JSON.stringify(parsed.roleFamilies),
    roleScore: parsed.roleScore,
    eligible: parsed.eligible ? 1 : 0,
    hash: parsed.hash
  });

  if (!previous && parsed.eligible) {
    const sent = await sendJobAlert({
      title: parsed.title,
      companyName: company.name || company.domain,
      locationText: parsed.locationText,
      ghanaEligible: parsed.eligible,
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
  if (!company.careers_url) return { pages: 0, jobs: 0, alerts: 0 };

  const careersPage = await fetchPage(company.careers_url);
  if (!careersPage?.html || careersPage.status >= 400) {
    db.prepare("UPDATE companies SET last_job_check_at = CURRENT_TIMESTAMP WHERE id = ?").run(company.id);
    return { pages: 1, jobs: 0, alerts: 0 };
  }

  const atsJobs = await fetchAtsJobs(company.careers_url);
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
    if (url && looksLikeJobUrl(url, label)) links.push({ url, label });
  });

  const candidates = [...new Map(links.map(link => [link.url, link])).values()].slice(0, config.maxPagesPerDomain);

  for (const candidate of candidates) {
    const parsed = await parseJobPage(candidate.url, candidate.label);
    if (!parsed) continue;

    const previous = db.prepare("SELECT id, content_hash, alert_sent_at FROM jobs WHERE job_url = ?").get(parsed.jobUrl);
    db.prepare(`
      INSERT INTO jobs (
        company_id, title, description, job_url, application_url, location_text,
        remote_policy, posted_at, role_families, role_match_score, ghana_eligible,
        content_hash, last_seen_at, updated_at, status
      ) VALUES (
        @companyId, @title, @description, @jobUrl, @applicationUrl, @locationText,
        @remotePolicy, @postedAt, @roleFamilies, @roleScore, @eligible,
        @hash, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'open'
      )
      ON CONFLICT(job_url) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        application_url = excluded.application_url,
        location_text = excluded.location_text,
        remote_policy = excluded.remote_policy,
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
      remotePolicy: parsed.eligible ? "explicit_global_or_africa" : "unknown",
      postedAt: parsed.postedAt,
      roleFamilies: JSON.stringify(parsed.roleFamilies),
      roleScore: parsed.roleScore,
      eligible: parsed.eligible ? 1 : 0,
      hash: parsed.hash
    });
    jobs += 1;

    if (!previous && parsed.eligible) {
      const sent = await sendJobAlert({
        title: parsed.title,
        companyName: company.name || company.domain,
        locationText: parsed.locationText,
        ghanaEligible: parsed.eligible,
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
  return { pages: candidates.length + 1, jobs, alerts };
}

export async function runJobMonitoring() {
  const run = db.prepare("INSERT INTO crawl_runs (crawler, status) VALUES (?, ?)").run("job-monitor", "running");
  let pagesChecked = 0;
  let jobsFound = 0;
  let alertsSent = 0;

  try {
    const companies = db.prepare(`
      SELECT id, name, domain, careers_url
      FROM companies
      WHERE careers_url IS NOT NULL AND careers_url != ''
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
