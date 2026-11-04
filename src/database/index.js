import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config/env.js";
import { schema } from "./schema.js";

const databasePath = path.resolve(config.databasePath);
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

export const db = new DatabaseSync(databasePath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

function transaction(callback) {
  return (...args) => {
    db.exec("BEGIN");
    try {
      const result = callback(...args);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
}

const migrate = transaction(() => {
  for (const statement of schema) db.exec(statement);
  const applied = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version ?? 0;
  if (applied < 1) db.prepare("INSERT INTO schema_migrations (version) VALUES (1)").run();
  if (applied < 2) {
    const columns = new Set(db.prepare("PRAGMA table_info(jobs)").all().map(column => column.name));
    if (!columns.has("hiring_policy")) db.exec("ALTER TABLE jobs ADD COLUMN hiring_policy TEXT NOT NULL DEFAULT 'unknown'");
    db.prepare("INSERT INTO schema_migrations (version) VALUES (2)").run();
  }
  if (applied < 3) {
    const columns = new Set(db.prepare("PRAGMA table_info(companies)").all().map(column => column.name));
    if (!columns.has("company_size_status")) db.exec("ALTER TABLE companies ADD COLUMN company_size_status TEXT NOT NULL DEFAULT 'unknown'");
    db.prepare("INSERT INTO schema_migrations (version) VALUES (3)").run();
  }
});

migrate();

export function getStats() {
  const companyCounts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN eligibility_status = 'eligible' THEN 1 ELSE 0 END) AS eligible,
      SUM(CASE WHEN eligibility_status = 'review' THEN 1 ELSE 0 END) AS review,
      SUM(CASE WHEN eligibility_status = 'ineligible' THEN 1 ELSE 0 END) AS ineligible,
      SUM(CASE WHEN company_size_status = 'within_target' THEN 1 ELSE 0 END) AS within_target_size,
      SUM(CASE WHEN company_size_status = 'over_target' THEN 1 ELSE 0 END) AS over_target_size,
      SUM(CASE WHEN company_size_status = 'unknown' THEN 1 ELSE 0 END) AS unknown_size
    FROM companies
  `).get();

  const jobCounts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0) AS open,
      COALESCE(SUM(CASE WHEN ghana_eligible = 1 AND status = 'open' THEN 1 ELSE 0 END), 0) AS eligible_open,
      COALESCE(SUM(CASE WHEN alert_sent_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS alerts_sent
    FROM jobs
  `).get();

  db.prepare(`
    UPDATE crawl_runs
    SET status = 'failed', finished_at = CURRENT_TIMESTAMP,
        error = COALESCE(error, 'Run did not finish before the next application startup')
    WHERE status = 'running' AND started_at < datetime('now', '-2 hours')
  `).run();

  const lastRun = db.prepare(
    "SELECT crawler, status, started_at, finished_at, error FROM crawl_runs ORDER BY id DESC LIMIT 1"
  ).get();

  return { companies: companyCounts, jobs: jobCounts, lastRun: lastRun ?? null };
}
