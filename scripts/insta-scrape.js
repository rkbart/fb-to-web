#!/usr/bin/env node
/**
 * insta-scrape -- extract a public Instagram profile's content as JSON.
 *
 * Usage:
 *   node insta-scrape.js <instagram_page_url> [--posts 8] [--out file.json]
 *
 * Requires: playwright module + a Chromium/Chrome executable.
 * Resolves automatically; override with env INWEB_CHROME / INWEB_NODE_PATH.
 *
 * Notes: Instagram bot-detection policies change often. Targets
 * public business/creator profiles. Private/region-locked accounts emit
 * login-wall warnings rather than crashing.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/* ---------- resolve playwright ---------- */
function loadPlaywright() {
  try { return require('playwright'); } catch (_) { /* fall through */ }
  const envPath = process.env.INWEB_NODE_PATH;
  const candidates = [];
  if (envPath) candidates.push(envPath);
  try {
    const found = execSync(
      'find "$HOME/.local/share/mise/installs/npm-playwright" -maxdepth 6 -type d -name playwright 2>/dev/null | head -1',
      { shell: '/bin/bash', encoding: 'utf8' }
    ).trim();
    if (found) candidates.push(path.dirname(found));
  } catch (_) { /* ignore */ }
  for (const c of candidates) {
    try { return require(path.join(c, 'playwright')); } catch (_) { /* try next */ }
  }
  console.error('ERROR: playwright module not found. Install it or set INWEB_NODE_PATH to its node_modules dir.');
  process.exit(2);
}

function resolveChrome() {
  if (process.env.INWEB_CHROME && fs.existsSync(process.env.INWEB_CHROME)) return process.env.INWEB_CHROME;
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/* ------------------------------ helpers ---------------------------------- */
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = { posts: 8, out: null, url: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--posts') args.posts = Math.max(1, parseInt(argv[++i], 10) || 10);
    else if (a === '--out') args.out = argv[++i];
    else if (!a.startsWith('--') && !args.url) args.url = a;
  }
  if (!args.url) {
    console.error('Usage: node insta-scrape.js <instagram_page_url> [--posts N] [--out file.json]');
    process.exit(2);
  }
  return args;
}

function normalizePageUrl(raw) {
  let u;
  try { u = new URL(raw.trim()); } catch (_) {
    let s = raw.trim().replace(/^\//, '');
    s = s.replace(/\/$/, '');
    return 'https://www.instagram.com/' + s;
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Unsupported protocol: ' + u.protocol);
  const { hostname, pathname } = u;
  const parts = pathname.split('/').filter(Boolean);
  const name = parts[0] || '';
  if (!/^www\.|instagram\.com$/.test(hostname) || !name) {
    throw new Error('Not an Instagram URL: ' + raw);
  }
  return 'https://www.instagram.com/' + name.replace(/\/$/, '') + '/';
}

/* ------------------------ extraction (runs in page) ----------------------- */
const IN_PAGE_PROFILE = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const meta = (name) => {
    const el = document.querySelector('meta[name="' + name + '"]');
    return el ? el.getAttribute('content') : null;
  };
  const title = document.title ? document.title.replace(/^\s*- Instagram.*$/, '').trim() : '';
  const ogDesc = meta('description') || meta('og:description');
  const ogImg = meta('og:image') || meta('og:image:url');
  return {
    url: location.href.replace(/\/$/, ''),
    title: clean(title),
    description: clean(ogDesc),
    avatar: ogImg || meta('twitter:image') || null,
    cover: ogImg,
    followers: clean(meta('og:image:usename')) || null,
  };
};

const IN_PAGE_POSTS = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const getText = (el) => {
    if (!el) return '';
    const t = el.textContent || '';
    const lines = t.split(/\r?\n/).map(clean).filter(Boolean);
    return lines.join(' ').slice(0, 500);
  };
  const images = [];
  const seen = new Set();
  document.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (/scontent\.|instagram\.com\/img\/media/.test(src) && !seen.has(src)) {
      seen.add(src);
      images.push(src);
    }
  });
  const posts = [];
  document.querySelectorAll('article, div[data-ad-index]').forEach((card) => {
    const img = card.querySelector('img');
    if (!img) return;
    const src = img.getAttribute('src') || '';
    if (!/scontent\.|instagram\.com\/img\/media/.test(src)) return;
    const author = getText(card.querySelector('h2, h3, a[role="link"]:not([aria-hidden])'));
    const text = getText(card.querySelector('div[role="group"]'));
    const caption = getText(card.querySelector('figcaption, span[role="presentation"] ~ *'));
    if (/^[0-9.,\s]+ followers|following$/i.test(text)) return;
    if (images.length === 0) return;
    if (posts.some(p => p.image === src)) return;
    posts.push({ author: author || '', message: clean(text || caption), image: src, images: [src] });
  });
  return posts;
};

/* ------------------------------- main ------------------------------------ */
(async () => {
  const args = parseArgs(process.argv);
  const pageUrl = normalizePageUrl(args.url);
  const { chromium } = loadPlaywright();
  const executablePath = resolveChrome();

  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--lang=en-US'],
  });
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: 'en-US',
    viewport: { width: 1366, height: 2400 },
  });
  const page = await ctx.newPage();

  const result = { url: pageUrl, fetched_at: new Date().toISOString(), page: {}, posts: [], warnings: [] };

  try {
    const resp = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (resp && resp.status() >= 400) result.warnings.push('HTTP ' + resp.status() + ' from ' + pageUrl);

    await sleep(4000);
    for (const label of ['Not Now', 'Later', 'Retry', 'Close', 'Continue']) {
      try {
        const btn = page.locator('button:has-text("' + label + '")').first();
        if (await btn.isVisible({ timeout: 600 })) {
          await btn.click({ timeout: 1500 });
          await sleep(2000);
        }
      } catch (_) { /* no such button */ }
    }
    try { await page.keyboard.press('Escape'); } catch (_) { /* noop */ }
    await sleep(2000);

    if (/login|checkpoint|reCAPTCHA|captcha/i.test(page.url() || '')) {
      result.warnings.push('Login wall / bot block: ' + page.url() + ' -- profile may be private, region-blocked, or rate-limited.');
      console.log(JSON.stringify(result, null, 2));
      if (args.out) fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
      await browser.close();
      process.exit(0);
    }

    const prof = await page.evaluate(IN_PAGE_PROFILE);
    if (prof) { Object.assign(result.page, prof); }
    if (!prof?.title) result.warnings.push('Profile name not found.');
    if (!prof?.avatar) result.warnings.push('Avatar not found.');

    const collected = [];
    const maxScrolls = Math.min(4 + args.posts, 15);
    for (let i = 0; i < maxScrolls; i++) {
      const batch = await page.evaluate(IN_PAGE_POSTS);
      if (!batch || !batch.length) break;
      for (const p of batch) {
        if (!collected.find(c => c.image === p.image)) collected.push(p);
      }
      if (collected.length >= args.posts + 3) break;
      await page.mouse.wheel(0, 1400);
      await sleep(1800);
    }
    result.posts = collected.slice(0, args.posts);

    if (!result.posts.length) result.warnings.push('No posts extracted (private profile or layout changed).');
    if (collected.length < args.posts) result.warnings.push('Only ' + collected.length + ' of ' + args.posts + ' requested posts loaded.');
  } catch (err) {
    result.warnings.push('Scraper error: ' + err.message);
  }

  const json = JSON.stringify(result, null, 2);
  if (args.out) { fs.writeFileSync(args.out, json); console.error('Wrote ' + args.out); }
  console.log(json);
  await browser.close();
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
