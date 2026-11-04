const userAgent = "GlobalHireBot/1.0 (+public career-page monitor; respectful crawling)";

const providers = [
  { name: "greenhouse", hosts: ["boards.greenhouse.io", "job-boards.greenhouse.io"] },
  { name: "lever", hosts: ["jobs.lever.co"] },
  { name: "ashby", hosts: ["jobs.ashbyhq.com"] },
  { name: "workable", hosts: ["apply.workable.com"] },
  { name: "smartrecruiters", hosts: ["careers.smartrecruiters.com"] },
  { name: "recruitee", hosts: [] },
  { name: "zoho", hosts: [] }
];

export function detectAtsBoard(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\\./, "");
    const provider = providers.find(item => item.hosts.includes(host))
      ?? (host.endsWith(".recruitee.com") ? providers.find(item => item.name === "recruitee") : null)
      ?? (host.endsWith(".zohorecruit.com") ? providers.find(item => item.name === "zoho") : null);
    if (!provider) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const slug = provider.name === "smartrecruiters" ? parts[0]
      : provider.name === "zoho" ? null
      : provider.name === "recruitee" ? host.split(".")[0]
      : parts[0];
    return { provider: provider.name, host, slug: slug || null, url: url.href };
  } catch {
    return null;
  }
}

export function atsEndpoint(board) {
  if (!board?.slug) return null;
  const slug = encodeURIComponent(board.slug);
  if (board.provider === "greenhouse") return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
  if (board.provider === "lever") return `https://api.lever.co/v0/postings/${slug}?mode=json`;
  if (board.provider === "ashby") return `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
  if (board.provider === "workable") return `https://apply.workable.com/api/v1/accounts/${slug}/jobs?details=true`;
  if (board.provider === "smartrecruiters") return `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`;
  if (board.provider === "recruitee") return `https://${slug}.recruitee.com/api/offers`;
  return null;
}

export function normalizeAtsRows(board, data) {
  const rows = board.provider === "greenhouse" || board.provider === "ashby"
    ? data.jobs ?? []
    : board.provider === "lever"
      ? Array.isArray(data) ? data : []
      : board.provider === "workable"
        ? data.results ?? data.jobs ?? []
        : board.provider === "smartrecruiters"
          ? data.content ?? data.postings ?? []
          : board.provider === "recruitee"
            ? data.offers ?? []
            : [];

  return rows.map(item => {
    const locationValue = item.location?.name
      ?? item.location?.city
      ?? item.categories?.location
      ?? item.location
      ?? item.address?.city
      ?? "";
    const location = typeof locationValue === "string" ? locationValue : JSON.stringify(locationValue);
    const title = item.title ?? item.text ?? item.name ?? "";
    const descriptionValue = item.content ?? item.descriptionHtml ?? item.description ?? item.jobDescription ?? "";
    const description = String(descriptionValue).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\\s+/g, " ").trim().slice(0, 30000);
    const jobUrl = item.absolute_url ?? item.hostedUrl ?? item.url ?? item.applyUrl
      ?? item.applicationUrl ?? item.ref ?? (item.id && board.provider === "smartrecruiters" ? `https://careers.smartrecruiters.com/${board.slug}/${item.id}` : null);
    const postedAt = item.updated_at ?? item.createdAt ?? item.created_at ?? item.publishedAt ?? item.releasedDate ?? null;
    return { title, description, location, jobUrl, applicationUrl: item.applyUrl ?? item.applicationUrl ?? jobUrl, postedAt };
  }).filter(item => item.title && item.jobUrl);
}

export async function fetchAtsBoardJobs(board, { timeoutMs = 20000, fetchImpl = fetch } = {}) {
  const endpoint = atsEndpoint(board);
  if (!endpoint) return { status: "unsupported", endpoint: null, jobs: [] };
  try {
    const response = await fetchImpl(endpoint, {
      headers: { "user-agent": userAgent, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return { status: `http_${response.status}`, endpoint, jobs: [] };
    const data = await response.json();
    return { status: "success", endpoint, jobs: normalizeAtsRows(board, data) };
  } catch (error) {
    return { status: "error", endpoint, error: error.message, jobs: [] };
  }
}
