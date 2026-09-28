# Playback Writer — local blog editor

**Date:** 2026-08-19
**Status:** approved, implementing

## Problem

Publishing a post currently means hand-authoring YAML frontmatter, memorising the
attribute names of five custom `:::` blocks, copying media into `assets/clips/`
by hand, and remembering to register the file in `content/content.json`. The
blog has a good design and a hostile authoring path.

## Goal

A writing surface: type, watch it render as the real post, press Publish. The
markdown file, the frontmatter, the manifest entry and the commit all become
implementation details the author never touches.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Where the editor runs | Local only, `npm run write` | A page served from Vercel cannot write to the author's disk. Publishing means committing to the repo, so the writer must be local. |
| Hosted at `/write` | No | Without a backend it would be a dead UI; restricting access needs paid Vercel deployment protection or edge middleware. Neither is worth it for zero gain. |
| Editor in git | Yes, excluded from deploy | Versioned and survives a lost laptop. `.vercelignore` keeps it off the site. |
| Writing surface | Split pane: markdown left, live real preview right | A true WYSIWYG that round-trips rich text into `:::` blocks is a large, fragile build. Rendering through the site's own renderer is accurate by construction. |
| Preview implementation | iframe running the real `blog.js` + `blog.css` | Not an approximation of the post — the post's own renderer pointed at the draft. Design changes propagate to the editor for free. |
| Draft privacy | Uncommitted files | On a static site any deployed `.md` is fetchable. A draft is therefore a file that has not been committed. Publish stages only that post's files. |

## Architecture

```
npm run write
    |
    v
writer/server.js  (zero-dependency Node, bound to 127.0.0.1)
    |
    +-- serves the real site from repo root  --> preview loads real CSS/JS/clips
    |
    +-- /__writer/api/*  JSON API
            |
            +-- blog/posts/*.md        read, write, rename, delete
            +-- content/content.json   publish / unpublish
            +-- assets/clips/*         media upload
            +-- git                    targeted stage, commit, push
```

The `/__writer/` prefix keeps the API from colliding with the site's own
`/api/contact` route.

### Components

- **`writer/server.js`** — static file server for the repo plus the JSON API.
  Binds to loopback only. Validates slugs against `^[a-z0-9][a-z0-9-]*$` and
  confines every path to the repo root.
- **`writer/index.html` / `writer.css` / `writer.js`** — editor shell: post list,
  frontmatter form, markdown textarea with slash-menu, preview iframe.
- **`writer/preview.html`** — the iframe document. Loads the site stylesheets and
  `blog.js`, receives `{meta, body}` over `postMessage`, renders via
  `Blog.renderPost`.
- **`blog/blog.js`** — gains `Blog.renderPost(meta, body)`, extracted from the
  inline script in `blog/post.html` so both the live post and the preview use one
  implementation.

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/__writer/api/posts` | All posts: slug, raw markdown, published flag, mtime |
| GET | `/__writer/api/posts/:slug` | One post's markdown |
| PUT | `/__writer/api/posts/:slug` | Write markdown (autosave) |
| POST | `/__writer/api/posts/:slug/rename` | Rename file and fix the manifest together |
| DELETE | `/__writer/api/posts/:slug` | Delete file and manifest entry |
| POST | `/__writer/api/publish` | Add slug to `writing.onSiteArticles` |
| POST | `/__writer/api/unpublish` | Remove it |
| POST | `/__writer/api/media` | Raw binary upload to `assets/clips/` |
| GET | `/__writer/api/git/status` | Which posts have uncommitted changes |
| POST | `/__writer/api/git/publish` | Stage this post's files, commit, push |

The post list returns raw markdown and the browser parses it with
`Blog.parseFrontmatter`, so there is no second frontmatter parser on the server.

## Behaviour

**Frontmatter form.** Title, date, description, theme, film, year, director,
music, tags as inputs. Serialised on save; `director`/`music`/`tags` are written
but deliberately not rendered, matching current behaviour.

**Slash menu.** Typing `/` opens a block picker (lyric, dialogue, clip, loop,
youtube). Inserts a filled skeleton with the cursor placed. A permanent toolbar
offers the same blocks as a fallback.

**Drag-drop media.** Uploads to `assets/clips/`, inserts `:::clip` or `:::loop`.
For video, a poster frame is produced in-browser — seek, paint to canvas, export
JPEG, upload alongside, wire `poster=`. Poster generation failing (unsupported
codec) degrades to no poster rather than failing the drop.

**Autosave.** Debounced 1.5s after typing stops, to the real `.md`. No separate
draft store to drift.

**Publish.** Save, add to manifest, then `git add` **only** this post's markdown,
`content/content.json`, and any `/assets/clips/*` the post references — never
`git add -A`, which would sweep unfinished drafts into the deploy as unlisted but
reachable URLs. Then commit and push.

## Out of scope

Rich-text WYSIWYG. Hosted/multi-device editing. Image editing. Scheduled posts.
Tag pages.

## Known gap, outside the code

`blog.arjunsreedar.xyz` has no DNS record — it does not resolve, so the two
host-conditioned rewrites in `vercel.json` never match and nothing is served
there. Until a CNAME is added and the domain is attached in Vercel, posts are
reachable only at `arjunsreedar.xyz/blog/post.html?slug=<slug>`. The editor shows
both URLs.
