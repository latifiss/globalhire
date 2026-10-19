import * as cheerio from "cheerio";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";

const robotsCache = new Map();
const lastRequestAt = new Map();
const userAgent = "GlobalHireBot/1.0 (+public career-page monitor; respectful crawling)";

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hostOf(url) {
  return new URL(url).host;
}

async function canFetch(url) {
  const parsed = new URL(url);
  const origin = parsed.origin;
  let rules = robotsCache.get(origin);

  if (!rules) {
    try {
      const response = await fetch(new URL("/robots.txt", origin), {
        headers: { "user-agent": userAgent },
        signal: AbortSignal.timeout(config.requestTimeoutMs)
      });
      const text = response.ok ? await response.text() : "";
      rules = text.split(/\r?\n/).reduce((state, line) => {
        const clean = line.replace(/#.*/, "").trim();
        if (/^user-agent:\s*\*/i.test(clean)) state.active = true;
        else if (/^user-agent:/i.test(clean)) state.active = false;
        else if (state.active && /^disallow:/i.test(clean)) {
          const value = clean.split(":").slice(1).join(":").trim();
          if (value) state.disallow.push(value);
        }
        return state;
      }, { active: false, disallow: [] }).disallow;
    } catch {
      rules = [];
    }
    robotsCache.set(origin, rules);
  }

  return !rules.some(rule => parsed.pathname.startsWith(rule));
}

export async function fetchPage(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) return null;
  if (!(await canFetch(url))) {
    logger.debug({ url }, "Skipped URL disallowed by robots.txt");
    return null;
  }

  const host = hostOf(url);
  const previous = lastRequestAt.get(host) ?? 0;
  const waitFor = 1200 - (Date.now() - previous);
  if (waitFor > 0) await delay(waitFor);

  try {
    lastRequestAt.set(host, Date.now());
    const response = await fetch(url, {
      headers: {
        "user-agent": userAgent,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(config.requestTimeoutMs)
    });

    if (!response.ok) {
      logger.debug({ url, status: response.status }, "Page fetch returned a non-success status");
      return { url: response.url || url, status: response.status, html: "", contentType: response.headers.get("content-type") ?? "" };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!/html|xhtml|xml/i.test(contentType)) return null;

    return {
      url: response.url || url,
      status: response.status,
      html: (await response.text()).slice(0, 2_000_000),
      contentType
    };
  } catch (error) {
    logger.debug({ url, error: error.message }, "Page fetch failed");
    return null;
  }
}

export function parseHtml(html) {
  return cheerio.load(html);
}

export function absoluteUrl(href, baseUrl) {
  try {
    const url = new URL(href, baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function normalizeDomain(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function pageText($) {
  const body = $("body").clone();
  body.find("script, style, noscript, svg, nav, footer").remove();
  return body.text().replace(/\s+/g, " ").trim().slice(0, 100000);
}
