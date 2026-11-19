# GlobalHire

GlobalHire is a personal job-discovery and monitoring tool. It indexes small companies, checks their public careers pages, evaluates whether their roles may be available to someone based in Ghana, and sends matching job alerts through Telegram.

## Current functionality

- Node.js ES modules with environment-based configuration
- SQLite database for companies, jobs, crawl history, and discovery sources
- Telegram bot commands: /start, /help, /stats, /companies, /jobs, /chatid
- Role-family matcher for product design, design engineering, frontend engineering, and product/full-stack engineering
- Candidate-domain discovery from public directories, optional seed domains, and a paginated Wikidata company dataset
- Persistent, deduplicated discovery queue with retry tracking and resumable processing
- Discovery queue statistics exposed through `/status`
- Careers-page detection and scheduled monitoring of indexed careers pages and matching job pages
- Evidence-based Ghana eligibility checks; unknown policies remain unconfirmed
- Health and status endpoints at /health and /status
- Initial automated tests for role matching

Company discovery currently combines configured public directories, seed domains, and a paginated Wikidata SPARQL adapter. Candidate domains are normalized and stored in a persistent SQLite queue before website inspection, so interrupted runs can resume instead of losing the candidate batch. Wikidata advances by 500 results per scheduled run and cycles back to the beginning after reaching the end. This is a scalable foundation, not a guarantee of thousands of verified or eligible employers: directory coverage, dataset relevance, site accessibility, and company verification still determine the final yield. Search-engine HTML scraping was removed because the configured queries returned no usable results.

## Requirements

- Node.js 22 or newer
- npm

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Set `TELEGRAM_BOT_TOKEN` in `.env`. Start the service:

```powershell
npm run dev
```

Open your bot in Telegram and send `/start`, then `/chatid`. Copy the returned ID into `TELEGRAM_CHAT_ID` in `.env` and restart GlobalHire. Never commit `.env` or your bot token.

Add candidate domains to `seeds/seed-domains.txt`, one domain per line. Add or disable directory sources in `seeds/discovery-sources.json`. The `/status` endpoint includes pending, processing, completed, and failed discovery queue counts.

Check the local health endpoint at http://localhost:3000/health and database statistics at http://localhost:3000/status.

Run the role matcher tests:

```powershell
npm test
```

Print database statistics:

```powershell
npm run stats
```

## Telegram commands

- `/stats` — current company and job counts
- `/companies` — latest indexed companies
- `/jobs` — latest matching jobs
- `/chatid` — display your numeric chat ID for configuration

This version uses long polling, so a public domain or webhook endpoint is not required for local development. The computer running the process must stay on and connected to the internet to receive alerts.

## Eligibility rules

A company being remote-first is not enough to qualify. GlobalHire stores evidence separately for company-wide hiring regions and each job's restrictions. Unknown or ambiguous policies remain marked for review rather than being assumed to allow Ghana.

## Responsible crawling

Only crawl publicly accessible pages, respect robots.txt and each source's terms, rate-limit requests, identify the crawler where appropriate, and stop when a site blocks automated access. Do not bypass logins, paywalls, CAPTCHAs, or other access controls.
