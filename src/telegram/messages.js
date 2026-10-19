export function formatStats(stats) {
  const companies = stats.companies;
  const jobs = stats.jobs;

  return [
    "📊 GlobalHire status",
    "",
    "COMPANIES",
    `Indexed: ${companies.total ?? 0}`,
    `Eligible: ${companies.eligible ?? 0}`,
    `Needs review: ${companies.review ?? 0}`,
    `Ineligible: ${companies.ineligible ?? 0}`,
    "",
    "JOBS",
    `Total tracked: ${jobs.total ?? 0}`,
    `Open: ${jobs.open ?? 0}`,
    `Open and Ghana-eligible: ${jobs.eligible_open ?? 0}`,
    `Alerts sent: ${jobs.alerts_sent ?? 0}`,
    "",
    stats.lastRun
      ? `Last run: ${stats.lastRun.crawler} — ${stats.lastRun.status} (${stats.lastRun.started_at})`
      : "Last run: not yet started"
  ].join("\n");
}

export function helpMessage() {
  return [
    "👋 Welcome to GlobalHire.",
    "I track small companies and alert you when relevant remote jobs appear.",
    "",
    "/stats — indexed companies and job counts",
    "/companies — latest indexed companies",
    "/jobs — latest matching jobs",
    "/chatid — show your Telegram chat ID for setup",
    "/help — show this message",
    "",
    "Remote does not automatically mean worldwide hiring. Unconfirmed policies are labelled for review."
  ].join("\n");
}
