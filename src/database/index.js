import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../config/env.js";
import { schema } from "./schema.js";

const databasePath = path.resolve(config.databasePath);
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

const migrate = db.transaction(() => {
  for (const statement of schema) db.exec(statement);
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)").run(1);
});

migrate();

export function getStats() {
  const companyCounts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN eligibility_status = 'eligible' THEN 1 ELSE 0 END) AS eligible,
      SUM(CASE WHEN eligibility_status = 'review' THEN 1 ELSE 0 END) AS review,
      SUM(CASE WHEN eligibility_status = 'ineligible' THEN 1 ELSE 0 END) AS ineligible
    FROM companies
  `).get();

  const jobCounts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN ghana_eligible = 1 AND status = 'open' THEN 1 ELSE 0 END) AS eligible_open,
      SUM(CASE WHEN alert_sent_at IS NOT NULL THEN 1 ELSE 0 END) AS alerts_sent
    FROM jobs
  `).get();

  const lastRun = db.prepare(
    "SELECT crawler, status, started_at, finished_at, error FROM crawl_runs ORDER BY id DESC LIMIT 1"
  ).get();

  return { companies: companyCounts, jobs: jobCounts, lastRun: lastRun ?? null };
}
