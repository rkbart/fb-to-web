# fb-to-web

A Claude Code skill that turns any **public Facebook page** into a generated website.

```
FB page URL  →  scripts/scrape.js (headless Chromium)  →  content JSON  →  website
```

> Skill repo: https://github.com/rkbart/fb-to-web · Skill ZIP: `fb-to-web-skill.zip`

## Install

Point your skill harness at this repo (or drop the folder into your skills directory):

```bash
git clone https://github.com/rkbart/fb-to-web ~/.claude/skills/fb-to-web
```

Then use it whenever the user shares a `facebook.com` page URL and wants a website or landing page.

## Prerequisites

- **Node.js** (the skill is a Claude Code skill: `node scripts/scrape.js`)
- **Playwright + Chromium** for the scraper:
  ```bash
  npx playwright install chromium
  ```
- (Optional) System Chromium path override: `FBWEB_CHROME=/usr/bin/chromium`

## Usage

```bash
node scripts/scrape.js "<facebook_page_url>" --posts 8 --out fb-content.json
```

See `SKILL.md` for the full workflow — scrape → review/enrich → generate site → verify, plus the failure-modes table, audience legalese, and a `Step 2.5` portability note for reusing the proven storefront scaffold on a second page.

## Repo layout

```
fb-to-web/
├── SKILL.md          # Skill instructions (name, description, workflow, failure modes, limitations)
└── scripts/
    └── scrape.js     # Headless Chromium scraper (Playwright) → content JSON
```
