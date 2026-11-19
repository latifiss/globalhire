import { config } from "./env.js";

const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = levels[config.logLevel] ?? levels.info;
const icons = { debug: "🔹", info: "ℹ️", warn: "⚠️", error: "❌" };

function write(level, first, second) {
  if (levels[level] < threshold) return;
  const fields = first && typeof first === "object" ? first : {};
  const message = typeof second === "string" ? second : typeof first === "string" ? first : level;
  const details = [];
  if (fields.source) details.push(fields.source);
  if (fields.domain) details.push(fields.domain);
  if (fields.company) details.push(fields.company);
  if (fields.candidatesFound !== undefined) details.push(`${fields.candidatesFound} companies`);
  if (fields.pagesChecked !== undefined) details.push(`${fields.pagesChecked} pages`);
  if (fields.candidates !== undefined) details.push(`${fields.candidates} candidates`);
  if (fields.found !== undefined) details.push(`${fields.found} saved`);
  if (fields.status !== undefined) details.push(`HTTP ${fields.status}`);
  if (fields.error) details.push(fields.error);
  const suffix = details.length ? ` | ${details.join(" | ")}` : "";
  const prefix = /^\p{Extended_Pictographic}/u.test(message) ? "" : `${icons[level]} `;
  const line = `${prefix}${message}${suffix}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = Object.fromEntries(
  Object.keys(levels).map(level => [level, (first, second) => write(level, first, second)])
);
