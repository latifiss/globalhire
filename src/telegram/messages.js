export function formatStats(stats) {
  const companies = stats.companies;
  const jobs = stats.jobs;
  const queue = stats.discoveryQueue ?? {};

  return [
    "📊 GlobalHire status",
    "",
    "COMPANIES",
    `Indexed: ${companies.total ?? 0}`,
    `Eligible: ${companies.eligible ?? 0}`,
    `Needs review: ${companies.review ?? 0}`,
    `Ineligible: ${companies.ineligible ?? 0}`,
    "",
    "DISCOVERY QUEUE",
    `Total candidates: ${queue.total ?? 0}`,
    `Pending: ${queue.pending ?? 0}`,
    `Processed: ${queue.done ?? 0}`,
    `Failed: ${queue.failed ?? 0}`,
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
    "I discover companies and assess their public remote-hiring policies. Job monitoring is currently paused.",
    "",
    "/stats — indexed companies and job counts",
    "/companies — latest indexed companies",
    "/jobs — latest matching jobs",
    "/crawl — run company discovery now",
    "/chatid — show your Telegram chat ID for setup",
    "/help — show this message",
    "",
    "Remote does not automatically mean worldwide hiring. Unconfirmed policies are labelled for review."
  ].join("\n");
}
