# GlobalHire

GlobalHire is a personal job-discovery and monitoring tool. It indexes small companies, checks their public careers pages, evaluates whether their roles may be available to someone based in Ghana, and sends matching job alerts through Telegram.

## Current functionality

- Node.js ES modules with environment-based configuration
- SQLite database for companies, jobs, crawl history, and discovery sources
- Telegram bot commands: /start, /help, /stats, /companies, /jobs
- Role-family matcher for product design, design engineering, frontend engineering, and product/full-stack engineering
- Seed-domain company inspection with careers-page detection
- Scheduled monitoring of indexed careers pages and matching job pages
- Evidence-based Ghana eligibility checks; unknown policies remain unconfirmed
- Health and status endpoints at /health and /status
- Initial automated tests for role matching

Company discovery currently starts from domains you place in `seeds/seed-domains.txt`. Broader discovery-source adapters and more robust career-site parsers are still needed to expand the index automatically across public directories.

## Requirements

- Node.js 22 or newer
- npm

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env` if you want alerts and bot commands. Never commit `.env` or your bot token.

Add candidate domains to `seeds/seed-domains.txt`, one domain per line, then start the service:

```powershell
npm run dev
```

Check the local health endpoint at http://localhost:3000/health and database statistics at http://localhost:3000/status.

Run the role matcher tests:

```powershell
npm test
```

Print database statistics:

```powershell
npm run stats
```

## Telegram setup

1. Create a bot using Telegram's official BotFather and copy its token into `TELEGRAM_BOT_TOKEN`.
2. Open your bot in Telegram and send `/start`.
3. Obtain your numeric chat ID and set `TELEGRAM_CHAT_ID` in `.env`.
4. Restart the service.

This version uses long polling, so a public domain or webhook endpoint is not required for local development. The computer running the process must stay on and connected to the internet to receive alerts.

## Eligibility rules

A company being remote-first is not enough to qualify. GlobalHire stores evidence separately for company-wide hiring regions and each job's restrictions. Unknown or ambiguous policies remain marked for review rather than being assumed to allow Ghana.

## Responsible crawling

Only crawl publicly accessible pages, respect robots.txt and each source's terms, rate-limit requests, identify the crawler where appropriate, and stop when a site blocks automated access. Do not bypass logins, paywalls, CAPTCHAs, or other access controls.
