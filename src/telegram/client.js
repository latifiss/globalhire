import { config } from "../config/env.js";

const apiBase = config.telegramBotToken
  ? `https://api.telegram.org/bot${config.telegramBotToken}`
  : null;

export async function telegramRequest(method, payload = {}) {
  if (!apiBase) throw new Error("TELEGRAM_BOT_TOKEN is not configured");

  const timeout = method === "getUpdates" ? 35000 : 15000;
  const response = await fetch(`${apiBase}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout)
  });

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(result.description ?? `Telegram API request failed: ${response.status}`);
  }

  return result.result;
}

export async function sendTelegramMessage(chatId, text, options = {}) {
  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...options
  });
}
