import dotenv from "dotenv";

dotenv.config();

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: numberFromEnv("PORT", 3000),
  databasePath: process.env.DATABASE_PATH ?? "./data/globalhire.db",
  logLevel: process.env.LOG_LEVEL ?? "info",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? "",
  userLocation: process.env.USER_LOCATION ?? "Ghana",
  crawlIntervalHours: numberFromEnv("CRAWL_INTERVAL_HOURS", 24),
  maxPagesPerDomain: numberFromEnv("MAX_PAGES_PER_DOMAIN", 30),
  requestTimeoutMs: numberFromEnv("REQUEST_TIMEOUT_MS", 15000),
  crawlConcurrency: numberFromEnv("CRAWL_CONCURRENCY", 3)
};
