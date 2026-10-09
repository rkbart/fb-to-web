#!/usr/bin/env node
/**
 * fb-to-web scraper: extract a public Facebook page's content as JSON.
 *
 * Usage:
 *   node scrape.js <facebook_page_url> [--posts 10] [--out file.json]
 *
 * Output: JSON on stdout (and optionally --out) with shape:
 *   { url, page: {name, followers, category, intro, website, ...}, posts: [...] }
 *
 * Requires: playwright module + a Chromium/Chrome executable.
 * Resolves automatically; override with env FBWEB_CHROME / FBWEB_NODE_PATH.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/* ---------- resolve playwright (NODE_PATH or mise global install) ---------- */
function loadPlaywright() {
  try { return require('playwright'); } catch (_) { /* fall through */ }
  const envPath = process.env.FBWEB_NODE_PATH;
  const candidates = [];
  if (envPath) candidates.push(envPath);
  try {
    const found = execSync(
      "find \"$HOME/.local/share/mise/installs/npm-playwright\" -maxdepth 6 -type d -name playwright 2>/dev/null | head -1",
      { shell: '/bin/bash', encoding: 'utf8' }
    ).trim();
    if (found) candidates.push(path.dirname(found));
  } catch (_) { /* ignore */ }
  for (const c of candidates) {
    try { return require(path.join(c, 'playwright')); } catch (_) { /* try next */ }
  }
  console.error('ERROR: playwright module not found. Install it or set FBWEB_NODE_PATH to its node_modules dir.');
  process.exit(2);
}

function resolveChrome() {
  if (process.env.FBWEB_CHROME && fs.existsSync(process.env.FBWEB_CHROME)) return process.env.FBWEB_CHROME;
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) {
    if (fs.existsSync(p)) return p;
  }
  return undefined; // let playwright use its own bundled browser
}

/* ------------------------------ helpers ---------------------------------- */
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizePageUrl(raw) {
  let u;
  try { u = new URL(raw.trim()); } catch (_) {
    // allow bare pagename like "nintendo"
    return `https://www.facebook.com/${raw.trim().replace(/^\/+/, '')}`;
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`Unsupported protocol: ${u.protocol}`);
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] === 'profile.php') return `https://www.facebook.com/profile.php?id=${u.searchParams.get('id')}`;
  const keep = parts.filter((p) => !['posts', 'videos', 'photos', 'about', 'reviews', 'people', 'photo'].includes(p.toLowerCase()));
  return `https://www.facebook.com/${keep.join('/')}`;
}

function parseArgs(argv) {
  const args = { posts: 10, out: null, url: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--posts') args.posts = Math.max(1, parseInt(argv[++i], 10) || 10);
    else if (a === '--out') args.out = argv[++i];
    else if (!a.startsWith('--') && !args.url) args.url = a;
  }
  if (!args.url) {
    console.error('Usage: node scrape.js <facebook_page_url> [--posts N] [--out file.json]');
    process.exit(2);
  }
  return args;
}

/* ------------------------ extraction (runs in page) ----------------------- */
const IN_PAGE_PROFILE = `() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const bodyText = document.body.innerText || '';
  const out = {};

  out.name =
    (document.querySelector('meta[property="og:title"]') || {}).content ||
    (document.querySelector('h2') ? document.querySelector('h2').innerText : null) || null;
  if (out.name) out.name = clean(out.name).replace(/\\s*\\|\\s*Facebook$/, '');

  const fm = bodyText.match(/([\\d.,]+\\s*[KMB]?\\s*(?:followers|seguidores|abonnés|follower))/i);
  out.followers = fm ? clean(fm[1]) : null;

  out.category = null;
  const catEl = document.querySelector('#pages_msite_category_name, [data-testid="category_label"]');
  if (catEl) out.category = clean(catEl.innerText);
  if (!out.category) {
    const cm = bodyText.match(/Page\\s*·\\s*([^\\n]{2,60})/);
    if (cm) out.category = clean(cm[1]);
  }

  out.intro = (document.querySelector('meta[property="og:description"]') || {}).content || null;
  const introIdx = bodyText.indexOf('\\nIntro\\n');
  if (introIdx >= 0) {
    const seg = bodyText.slice(introIdx + 7, introIdx + 700).split('\\n').map(clean).filter(Boolean);
    const stop = seg.findIndex((t, i) => i > 0 && /^(Photos|Videos|Posts|See all|Menu|Reels|About|Timeline)$/i.test(t));
    out.intro = (stop > 0 ? seg.slice(0, stop) : seg).join(' ');
  }

  // Website: external domain mentioned on the page; prefer brand match, skip free-email hosts
  out.website = null;
  const FREE_MAIL = /gmail|yahoo|hotmail|outlook|icloud|proton|aol\\.|mail\\.com/i;
  const domains = (bodyText.match(/\\b((?:www\\.)?[a-z0-9-]+\\.(?:com|org|net|io|co|us|uk|de|fr|jp|ph|edu|gov)(?:\\/[\\w\\-/.?=&%]*)?)/gi) || [])
    .filter((d) => !/facebook\\.com|fbcdn|instagram|messenger/i.test(d) && !FREE_MAIL.test(d));
  if (domains.length) {
    const brand = (out.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    out.website = domains.find((d) => brand && d.toLowerCase().replace(/[^a-z0-9]/g, '').includes(brand.slice(0, 6))) || domains[0];
  }
  // Email / phone: from links first, then plain text in the bio
  out.email = null;
  out.phone = null;
  const links = Array.from(document.querySelectorAll('a[href]'));
  for (const a of links) {
    const href = a.getAttribute('href') || '';
    const text = clean(a.innerText);
    if (/mailto:/.test(href)) out.email = out.email || href.replace(/^mailto:/, '').split('?')[0];
    else if (/tel:/.test(href)) out.phone = out.phone || href.replace(/^tel:/, '');
    else if (/^https?:\\/\\//.test(href) && !/facebook\\.com|fbcdn|instagram\\.com|messenge/.test(href) && text && !/^https?:/.test(text)) {
      out.website = out.website || text;
    }
    if (/\\b[\\w.+-]+@[\\w.-]+\\.[a-z]{2,}\\b/i.test(text)) out.email = out.email || text.match(/\\b[\\w.+-]+@[\\w.-]+\\.[a-z]{2,}\\b/i)[0];
    if (/\\+?[\\d][\\d\\s().-]{7,}\\d/.test(text) && !/followers/i.test(text)) out.phone = out.phone || text.match(/\\+?[\\d][\\d\\s().-]{7,}\\d/)[0];
  }
  // Fallback: email/phone written as plain text in the bio
  if (!out.email) {
    const em = bodyText.match(/\\b[\\w.+-]+@(?:[\\w-]+\\.)+[a-z]{2,}\\b/i);
    if (em) out.email = em[0];
  }
  if (!out.phone) {
    const ph = bodyText.match(/(?:\\+?\\d[\\d\\s().-]{7,}\\d)/);
    if (ph && !/followers|reviews/i.test(ph[0])) out.phone = ph[0].trim();
  }

  out.avatar = (document.querySelector('meta[property="og:image"]') || {}).content || null;
  out.cover = null;
  const imgs = Array.from(document.querySelectorAll('img'));
  const big = imgs.map((i) => ({ src: i.src, w: i.naturalWidth || 0, h: i.naturalHeight || 0 }))
    .filter((i) => i.src && /fbcdn\\.net/.test(i.src) && i.w > 300);
  if (big.length) out.cover = big.sort((a, b) => (b.w * b.h) - (a.w * a.h))[0].src;

  return out;
}`;

const IN_PAGE_POSTS = `() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const seen = new Set();
  const posts = [];
  const articles = Array.from(document.querySelectorAll('div[role="article"], article'));
  for (const art of articles) {
    const text = clean(art.innerText);
    if (!text || text.length < 20) continue;
    if (/^(Log In|Create new account|Forgot)/.test(text)) continue;

    const key = text.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);

    const timeEl = art.querySelector('time');
    const datetime = timeEl ? timeEl.getAttribute('datetime') : null;
    const ariaDate = timeEl ? (timeEl.getAttribute('aria-label') || null) : null;

    let author = null;
    const h = art.querySelector('h2, h3, h4, strong, [data-testid="story-subtitle"]');
    if (h) author = clean(h.innerText);

    // Filter: top-level posts carry the reactions/buttons chrome; bare comment bubbles don't
    const isTopLevel = /All reactions?:|Like\\s+Comment/i.test(text);
    if (!isTopLevel) continue;

    let reactions = null;
    const rm = text.match(/(?:All reactions:|Reactions?:|Likes?:)\\s*([\\d.,]+\\s*[KMB]?)/i);
    if (rm) reactions = clean(rm[1]);

    const images = Array.from(art.querySelectorAll('img'))
      .map((i) => ({ src: i.src, w: i.naturalWidth || 0, h: i.naturalHeight || 0 }))
      .filter((i) => i.src && /fbcdn\\.net/.test(i.src) && i.w >= 200 && i.h >= 200 && !/emoji|static\\.xx/.test(i.src))
      .sort((a, b) => (b.w * b.h) - (a.w * a.h))
      .map((i) => i.src);
    const videos = art.querySelectorAll('video').length;

    // Message: strip author prefix, status chrome, date variants, and trailing UI
    let message = text;
    message = message.replace(/^(?:Online status indicator\\s*)?(?:Active\\s*)+/i, '');
    if (author && message.startsWith(author)) message = message.slice(author.length).trimStart();
    message = message.replace(/^((?:\\d+|a|an)\\s*(?:minute|hour|day|week|month|year)s?\\s+ago\\s+\\S+|[a-z]+\\s+ago\\s+\\S+|[a-z]+ ago)\\s*·\\s*/i, '');
    message = message.replace(/^\\d+\\s*(?:[a-z]+\\s*)?·\\s*/i, '');
    message = message.replace(/^[A-Z][a-z]+\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?(?:\\s+at\\s+\\d{1,2}:\\d{2}\\s*[AP]M)?\\s*·\\s*/i, '');
    const cut = message.search(/\\s+All reactions?:|\\s+Like\\s+Comment|\\s+View more comments|\\s+Author\\s+\\S+.*@everyone/i);
    if (cut >= 0) message = message.slice(0, cut).trim();
    // FB truncates with "… See more"; everything after is player/UI chrome
    const sm = message.search(/\\s*…?\\s*See more\\b/i);
    if (sm > 30) message = message.slice(0, sm).trim() + '…';
    else message = message.replace(/\\s*…?\\s*See more\\s*$/, '…').trim();
    message = message.replace(/\\s+\\d+:\\d+\\s*\\/\\s*\\d+:\\d+\\s*$/, '').trim();

    // Drop shells: leftover reaction counts, unavailable-content placeholders
    if (/^\\d+\\s*(Like\\s*Comment.*)?$/i.test(message)) continue;
    if (/This content isn't available right now|Content Not Available/i.test(message)) continue;

    if (message.length < 15 && !images.length) continue;

    posts.push({ author, datetime, date_label: ariaDate, message, reactions, image_count: images.length, images: images.slice(0, 4), video_count: videos });
  }
  return posts;
}`;

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
    viewport: { width: 1366, height: 2000 },
  });
  const page = await ctx.newPage();

  const result = { url: pageUrl, fetched_at: new Date().toISOString(), page: {}, posts: [], warnings: [] };

  try {
    const resp = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (resp && resp.status() >= 400) result.warnings.push(`HTTP ${resp.status()} from ${pageUrl}`);
    await sleep(4000);

    // Dismiss login interstitial if present
    for (const label of ['Close', 'Not Now', 'Decline']) {
      try {
        const btn = page.locator(`button:has-text("${label}")`).first();
        if (await btn.isVisible({ timeout: 800 })) { await btn.click({ timeout: 1500 }); await sleep(1200); }
      } catch (_) { /* no dialog */ }
    }
    try { await page.keyboard.press('Escape'); } catch (_) { /* noop */ }
    await sleep(1500);

    // If Facebook redirected to login, bail early with clear warning
    if (/login|checkpoint/i.test(page.url())) {
      result.warnings.push(`Redirected to login wall: ${page.url()} — the page may be private or region-blocked.`);
      console.log(JSON.stringify(result, null, 2));
      if (args.out) fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
      await browser.close();
      process.exit(0);
    }

    // Profile info
    result.page = (await page.evaluate(`(${IN_PAGE_PROFILE})()`)) || {};
    result.page.url = pageUrl;

    // Scroll timeline to load posts
    const collected = [];
    const maxScrolls = Math.min(4 + args.posts, 20);
    for (let i = 0; i < maxScrolls; i++) {
      const batch = (await page.evaluate(`(${IN_PAGE_POSTS})()`)) || [];
      const have = new Set(collected.map((p) => p.message.slice(0, 100)));
      for (const p of batch) if (!have.has(p.message.slice(0, 100))) collected.push(p);
      if (collected.length >= args.posts + 3) break;
      await page.mouse.wheel(0, 2200);
      await sleep(2200);
    }
    result.posts = collected.slice(0, args.posts);

    if (!result.posts.length) result.warnings.push('No posts extracted (layout may have changed or timeline is empty).');
    if (!result.page.name) result.warnings.push('Page name not found.');
  } catch (err) {
    result.warnings.push(`Scraper error: ${err.message}`);
  }

  const json = JSON.stringify(result, null, 2);
  if (args.out) { fs.writeFileSync(args.out, json); console.error(`Wrote ${args.out}`); }
  console.log(json);
  await browser.close();
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
