---
name: fb-to-web
description: "Turn a Facebook page link (business/brand/creator page) into a standalone website. Scrapes the public page content — profile (name, followers, category, intro, website, contact), timeline posts, images — as JSON via headless Chromium, then generates a complete static site from that content. Use when the user shares a facebook.com page URL and wants a website, landing page, or web presence built from it."
---

# fb-to-web — Facebook Page → Website

Convert any **public Facebook page** into a generated website:

```
FB page URL  →  scripts/scrape.js (headless Chromium)  →  content JSON  →  website
```

## When to Apply

Use when the user provides a Facebook page URL (`https://www.facebook.com/<page>`, `profile.php?id=...`, or a bare page name) and wants a website, landing page, microsite, or "web presence" built from that page's content.

Skip when: the user wants the official Facebook Page Plugin embed only, wants to manage/automate a FB page (that's an API task), or the link is a personal profile/group (public groups can partially work; personal profiles are usually login-walled).

## Workflow

### Step 1 — Scrape the page

```bash
node "${CLAUDE_PLUGIN_ROOT}/.claude/skills/fb-to-web/scripts/scrape.js" \
  "<facebook_page_url>" --posts 8 --out fb-content.json
```

- The script needs **Playwright + Chromium**; it auto-resolves them on this machine (mise-installed playwright + system `/usr/bin/chromium`). Override with `FBWEB_NODE_PATH` (playwright node_modules dir) or `FBWEB_CHROME` (browser binary) if needed.
- Runtime is ~30–90 s (it scrolls the timeline). Run it in the background if the tool timeout is short, then read the JSON output.
- Output shape:

```jsonc
{
  "url": "https://www.facebook.com/nintendo",
  "page": {
    "name": "Nintendo of America",
    "followers": "5.6M followers",
    "category": "Video Game",
    "intro": "Welcome to the official …",   // page bio / About text
    "website": "nintendo.com/us",           // external site if listed
    "email": null, "phone": null,
    "avatar": "https://scontent…400x400.png",  // profile picture (hotlinkable)
    "cover": "https://scontent…1920x1080.png"  // cover photo
  },
  "posts": [
    { "author": "…", "datetime": null, "date_label": "…",
      "message": "post text", "reactions": "685",
      "images": ["https://scontent…"], "image_count": 1, "video_count": 0 }
  ],
  "warnings": []
}
```

**Reading warnings:**

- `Redirected to login wall` → page is private/region-blocked; tell the user and offer alternatives (they can supply content manually, or make the page public).
- `No posts extracted` → build the site from `page` fields alone (name/bio/avatar/cover are usually enough for a landing page).

### Step 2 — Review and enrich the content

- Check `warnings` and tell the user what was/wasn't available.
- The JSON is the **source of truth for content**: page name, bio (`intro`), category, follower social proof, website/contact, and posts (text + images + engagement).
- Post images are hotlinkable `scontent…fbcdn.net` URLs — **download them into the site's `assets/` dir** (e.g. `curl -L "<url>" -o assets/post-1.jpg`) instead of hotlinking: FB CDN URLs are signed and expire (`oe=` param). The avatar/cover URLs have the same caveat.
- Trim post messages: remove trailing "…" artifacts and pick the 3–8 most brand-relevant posts. Use reaction counts as social-proof numbers, not as content.

### Step 3 — Generate the website

1. Choose the site form from the content:
   - Rich timeline (8+ good posts) → multi-section landing page: hero (cover + name + follower count) → about (intro) → feed/gallery (posts) → contact/footer (website link, FB link).
   - Thin content (bio only) → single-page landing: hero, about, CTA to the Facebook page.
2. Invoke the **ui-ux-pro-max** skill for style/palette/typography decisions before writing markup — it should drive the visual direction, since FB brand colors (blue #1877F2) are often a poor default for an unrelated business.
3. Stack: default to a **single self-contained `index.html`** (inline CSS, no build step) unless the user asks for a framework or the working directory already contains one (Next.js/Vite/etc. — then match the existing project).
4. Content rules:
   - Write copy from the scraped JSON only; never invent facts (addresses, hours, products) that weren't scraped.
   - Attribute content: footer link back to the original FB page.
   - Include the follower count as social proof ("Join 5.6M followers on Facebook").
   - Images: local copies (Step 2); add `loading="lazy"` and width/height to avoid CLS.

### Step 2.5 — Port a proven scaffold to a second page (transferability)

Proven on two live pages (T42 Cafe → Brewed Awakening): the same storefront structure transfers with only content/theme swaps — Next.js + Tailwind v4, 6 products, `localStorage` cart, 6 routes (`/ /menu /about /contact /cart /checkout`), order-ID + copy-message checkout confirmation.

- Swap `@theme` tokens (primary/ink/surface/cream/muted), fonts, currency formatter, and content; keep components/routes identical and version the cart key per site (e.g. `t42-cart-v1` → `brewed-cart-v1`).
- Only one product price needs to be truly grounded; mark the rest as estimates and say so on the menu page.
- Large page files can hit writer limits — write them via shell heredoc (`cat > file <<'EOF'`) instead of one big edit.

### Step 4 — Verify

- Open/serve the site (e.g. `python3 -m http.server` in the site dir) or at minimum validate the HTML loads without console errors.
- Confirm: no broken images, no lorem ipsum, FB source link present, mobile viewport meta included.
- For storefront ports, run the same transfer E2E on the prod build: menu card count → add 2 items → cart badge → cart persists after reload → checkout confirmation shows an order ID → zero broken images (`naturalWidth` check) → zero mobile overflow (`scrollWidth - clientWidth === 0`) → desktop + mobile screenshots.

## Failure Modes & Fallbacks

| Symptom | Cause | Action |
|---|---|---|
| `playwright module not found` | NODE_PATH resolution | Set `FBWEB_NODE_PATH` to the node_modules dir containing `playwright` |
| Browser executable missing | No system Chromium | `FBWEB_CHROME=/path/to/chrome` or `npx playwright install chromium` |
| HTTP 400 / "something went wrong" | Rare with real browser; IP block | Retry once; if persistent, tell the user scraping is blocked from this network |
| Login wall warning | Private page or FB gating | Ask user for public access or manual content |
| Checkout silently won't submit | Phone regex rejects `(…)`-leading numbers (US-style `(208) 555-0100`) | Allow `(` as first char: `/^[+\d(][\d\s\-()]{6,}$/` |
| Empty `category`/`contact` | Layout variant | Use `intro` text; ask user for missing contact details |

## Limitations (be transparent with the user)

- Scrapes **public** page content only; no DMs, private groups, or admin data.
- Facebook's DOM changes without notice — if extraction quality degrades, the selectors in `scripts/scrape.js` (`div[role="article"]`, og: meta tags) are the place to fix.
- Signed CDN image URLs expire; always localize downloaded images.
- Respect the page owner's copyright and Facebook's ToS — generated sites are for content the user owns or has rights to.
