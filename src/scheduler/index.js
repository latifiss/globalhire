import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { runCompanyDiscovery } from "../discovery/company.js";
import { runJobMonitoring } from "../jobs/monitor.js";

let companyDiscoveryRunning = false;
let jobMonitoringRunning = false;

export async function runCycle() {
  if (companyDiscoveryRunning || jobMonitoringRunning) {
    logger.warn("Skipping crawl cycle because a previous cycle is still running");
    return;
  }

  companyDiscoveryRunning = true;
  try {
    await runCompanyDiscovery();
  } catch (error) {
    logger.error({ error: error.message }, "Company discovery cycle failed");
  } finally {
    companyDiscoveryRunning = false;
  }

  jobMonitoringRunning = true;
  try {
    await runJobMonitoring();
  } catch (error) {
    logger.error({ error: error.message }, "Job monitoring cycle failed");
  } finally {
    jobMonitoringRunning = false;
  }
}

export function startScheduler() {
  const intervalMs = config.crawlIntervalHours * 60 * 60 * 1000;
  logger.info({ intervalHours: config.crawlIntervalHours }, "Crawler scheduler started");
  void runCycle();
  const timer = setInterval(() => void runCycle(), intervalMs);
  timer.unref();
  return timer;
}
