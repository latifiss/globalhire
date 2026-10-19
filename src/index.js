import express from "express";
import { config } from "./config/env.js";
import { logger } from "./config/logger.js";
import { db, getStats } from "./database/index.js";
import { startTelegramBot } from "./telegram/bot.js";
import { startScheduler } from "./scheduler/index.js";

const app = express();

app.get("/health", (_request, response) => {
  response.json({ status: "ok", service: "globalhire", time: new Date().toISOString() });
});

app.get("/status", (_request, response) => {
  response.json(getStats());
});

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, "GlobalHire service started");
});

startTelegramBot().catch(error => {
  logger.error({ error: error.message }, "Telegram bot stopped unexpectedly");
});

startScheduler();

function shutdown(signal) {
  logger.info({ signal }, "Shutting down GlobalHire");
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
