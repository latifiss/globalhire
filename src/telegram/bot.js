import { config } from "../config/env.js";
import { db, getStats } from "../database/index.js";
import { logger } from "../config/logger.js";
import { sendTelegramMessage, telegramRequest } from "./client.js";
import { formatStats, helpMessage } from "./messages.js";

let running = false;
let offset = 0;

function getCompaniesMessage() {
  const rows = db.prepare(`
    SELECT name, domain, eligibility_status, remote_policy
    FROM companies
    ORDER BY updated_at DESC
    LIMIT 10
  `).all();

  if (!rows.length) return "No companies indexed yet. Add candidate domains to seeds/seed-domains.txt.";

  return ["🏢 Latest indexed companies", "", ...rows.map((row, index) =>
    `${index + 1}. ${row.name || row.domain}\n   ${row.domain}\n   Status: ${row.eligibility_status} · Remote: ${row.remote_policy}`
  )].join("\n");
}

function getJobsMessage() {
  const rows = db.prepare(`
    SELECT j.title, j.job_url, j.location_text, j.ghana_eligible, j.posted_at, j.first_seen_at, c.name AS company_name
    FROM jobs j
    JOIN companies c ON c.id = j.company_id
    WHERE j.status = 'open' AND j.role_match_score > 0
    ORDER BY COALESCE(j.posted_at, j.first_seen_at) DESC
    LIMIT 10
  `).all();

  if (!rows.length) return "No matching jobs indexed yet.";

  return ["💼 Latest matching jobs", "", ...rows.map((job, index) =>
    `${index + 1}. ${job.title}\n   ${job.company_name}\n   ${job.posted_at ? `Posted: ${new Date(job.posted_at).toISOString().slice(0, 10)}` : `First seen: ${job.first_seen_at}`}\n   ${job.ghana_eligible ? "Ghana eligibility: evidence found" : "Ghana eligibility: unconfirmed"}\n   ${job.job_url}`
  )].join("\n");
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message?.text) return;

  const chatId = String(message.chat.id);
  if (config.telegramChatId && chatId !== String(config.telegramChatId)) return;

  const command = message.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();

  if (command === "/crawl") {
    await sendTelegramMessage(chatId, "🔄 Manual crawl cycle requested. I will discover companies first, then monitor their jobs. Check /stats and the terminal logs for progress.");
    void import("../scheduler/index.js").then(({ runCycle }) => runCycle()).catch(error => {
      logger.error({ error: error.message }, "Manual crawl cycle failed");
    });
    return;
  }

  const replies = {
    "/start": helpMessage,
    "/help": helpMessage,
    "/stats": () => formatStats(getStats()),
    "/companies": getCompaniesMessage,
    "/jobs": getJobsMessage,
    "/chatid": () => `Your Telegram chat ID is: ${chatId}\nAdd this value to TELEGRAM_CHAT_ID in your .env file, then restart GlobalHire.`
  };

  const makeReply = replies[command];
  if (!makeReply) return;

  await sendTelegramMessage(chatId, makeReply());
}

export async function startTelegramBot() {
  if (!config.telegramBotToken) {
    logger.warn("Telegram bot disabled: TELEGRAM_BOT_TOKEN is empty");
    return;
  }

  if (running) return;
  running = true;

  try {
    await telegramRequest("deleteWebhook", { drop_pending_updates: false });
    logger.info("Telegram long-polling bot started");
  } catch (error) {
    logger.error({ error: error.message }, "Could not initialize Telegram polling");
    running = false;
    return;
  }

  while (running) {
    try {
      const updates = await telegramRequest("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message"]
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await handleUpdate(update);
        } catch (error) {
          logger.error({ error: error.message }, "Telegram update handler failed");
        }
      }
    } catch (error) {
      logger.error({ error: error.message }, "Telegram polling failed");
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

export async function sendJobAlert(job) {
  const chatId = config.telegramChatId;
  if (!config.telegramBotToken || !chatId) {
    logger.warn("Job alert skipped: Telegram token or chat ID is missing");
    return false;
  }

  const text = [
    "🆕 MATCHING REMOTE JOB",
    "",
    `Role: ${job.title}`,
    `Company: ${job.companyName}`,
    `Location: ${job.locationText || "Not specified"}`,
    `Ghana eligibility: ${job.ghanaEligible ? "Evidence found" : "Needs verification"}`,
    `Match score: ${job.matchScore ?? 0}/100`,
    "",
    job.jobUrl
  ].join("\n");

  await sendTelegramMessage(chatId, text);
  return true;
}
