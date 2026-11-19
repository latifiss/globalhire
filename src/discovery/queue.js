import { db } from "../database/index.js";
import { normalizeDomain } from "../crawler/http.js";

const enqueue = db.prepare(`
  INSERT INTO discovery_queue (domain, website_url, source, status)
  VALUES (?, ?, ?, 'pending')
  ON CONFLICT(domain) DO UPDATE SET
    website_url = excluded.website_url,
    source = CASE WHEN discovery_queue.source = '' THEN excluded.source ELSE discovery_queue.source END,
    status = CASE WHEN discovery_queue.status = 'failed' THEN 'pending' ELSE discovery_queue.status END,
    updated_at = CURRENT_TIMESTAMP
`);

export function enqueueCompanies(candidates) {
  let added = 0;
  for (const candidate of candidates) {
    const url = candidate.websiteUrl || candidate.url;
    const domain = normalizeDomain(url);
    if (!domain || !url) continue;
    const result = enqueue.run(domain, url, candidate.source || "unknown");
    added += Number(result.changes > 0);
  }
  return added;
}

export function resetStaleQueueItems() {
  return db.prepare(`
    UPDATE discovery_queue
    SET status = 'pending', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'processing' AND updated_at < datetime('now', '-2 hours')
  `).run().changes;
}

export function claimNextCompany() {
  const item = db.prepare(`
    SELECT id, domain, website_url, source
    FROM discovery_queue
    WHERE status = 'pending'
    ORDER BY id
    LIMIT 1
  `).get();

  if (!item) return null;

  const claimed = db.prepare(`
    UPDATE discovery_queue
    SET status = 'processing', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'pending'
  `).run(item.id);

  return claimed.changes ? item : null;
}

export function completeCompany(id) {
  db.prepare(`
    UPDATE discovery_queue
    SET status = 'done', processed_at = CURRENT_TIMESTAMP, last_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);
}

export function failCompany(id, error) {
  db.prepare(`
    UPDATE discovery_queue
    SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END,
        last_error = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(String(error).slice(0, 1000), id);
}

export function getDiscoveryQueueStats() {
  return db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM discovery_queue
  `).get();
}
