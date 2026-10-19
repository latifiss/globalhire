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

async function checkCompany(company) {
  if (!company.careers_url) return { pages: 0, jobs: 0, alerts: 0 };

  const careersPage = await fetchPage(company.careers_url);
  if (!careersPage?.html || careersPage.status >= 400) {
    db.prepare("UPDATE companies SET last_job_check_at = CURRENT_TIMESTAMP WHERE id = ?").run(company.id);
    return { pages: 1, jobs: 0, alerts: 0 };
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
  let jobs = 0;
  let alerts = 0;

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
