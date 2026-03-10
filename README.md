# Portfolio — The Typographic Machine

Maximalist, vintage-styled portfolio built with Astro, GSAP, Three.js, and Lenis.

## Stack

- **Astro 5** — static site generation, content collections for blog
- **GSAP + ScrollTrigger** — scroll animations, horizontal timeline, staggers
- **Lenis** — smooth scrolling
- **Boska** (Fontshare) — display serif
- **JetBrains Mono** (Google Fonts) — body/terminal monospace

## Running locally

```bash
npm install
npm run dev
```

Opens at `http://localhost:4321`.

## Building for production

```bash
npm run build
npm run preview   # preview the built site locally
```

Output goes to `dist/`.

## Deploying to Vercel

This project is configured for Vercel deployment:

1. Push the `site/` folder to a GitHub repo (or set it as the root)
2. Import to Vercel — it auto-detects Astro
3. Set environment variable `WEB3FORMS_ACCESS_KEY` in Vercel dashboard
4. The `api/contact.js` serverless function handles the contact form

The `CNAME` file in `public/` points to `arjunsreedar.xyz`.

## Project structure

```
site/
├── api/contact.js              # Vercel serverless function (Web3Forms)
├── public/assets/              # Static images
├── src/
│   ├── components/             # Astro components (each section)
│   ├── content/blog/           # Markdown blog posts
│   ├── data/                   # content.json, suggestions.json
│   ├── layouts/                # BaseLayout, BlogLayout
│   ├── pages/                  # index, blog/, curations
│   ├── scripts/init.ts         # GSAP + Lenis setup
│   └── styles/global.css       # Design system
└── astro.config.mjs
```

## Adding a blog post

Create a markdown file in `src/content/blog/` with frontmatter:

```md
---
title: "Post Title"
date: "2026-03-10"
author: "Arjhun Sreedar"
tags: ["tag1", "tag2"]
description: "Short description."
---

Your content here.
```

## Dark mode

Toggles via the button in the top-right corner. Persists to `localStorage` and respects `prefers-color-scheme` on first visit.

## Contact form

The terminal at the bottom of the page accepts messages in the format:

```
name | email | message
```

In production (Vercel), it routes through the serverless function. Locally, it falls back to the Web3Forms API directly.

## Fonts

- **Boska** is loaded from Fontshare CDN (free for personal and commercial use)
- **JetBrains Mono** is loaded from Google Fonts
- To swap to a different display font (e.g. Grafier), change `--font-display` in `global.css` and update the `<link>` in `BaseLayout.astro`
