import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { runCompanyDiscovery } from "../discovery/company.js";

let companyDiscoveryRunning = false;

export async function runCycle() {
  if (companyDiscoveryRunning) {
    logger.warn("Skipping discovery cycle because a previous cycle is still running");
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
}

export function startScheduler() {
  const intervalMs = config.discoveryIntervalMinutes * 60 * 1000;
  logger.info(`🔁 Continuous company discovery enabled | next cycle every ${config.discoveryIntervalMinutes} minutes`);
  void runCycle();
  const timer = setInterval(() => void runCycle(), intervalMs);
  timer.unref();
  return timer;
}
