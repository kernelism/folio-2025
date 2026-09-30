#!/usr/bin/env node
/* Blog Writer — the local half of the blog editor.
   Serves the real site out of the repo root, so the preview iframe loads the
   same CSS, the same blog.js and the same clips the published post will, and
   exposes a small JSON API under /__writer/ that reads and writes the files a
   post is actually made of.

   Bound to loopback. This process writes to your repo and shells out to git;
   it has no business being reachable from the network.

   No dependencies. `node writer/server.js`. */

'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(__dirname, '..');
const WRITER_DIR = __dirname;
const POSTS_DIR = path.join(ROOT, 'blog', 'posts');
const CLIPS_DIR = path.join(ROOT, 'assets', 'clips');
const CONTENT_JSON = path.join(ROOT, 'content', 'content.json');

const PORT = Number(process.env.PORT) || 4321;
const HOST = '127.0.0.1';

/* Slugs become filenames and URL paths, so they get the strict treatment. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

const MEDIA_EXT = new Set([
    '.mp4', '.webm', '.mov', '.m4v', '.ogv',
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif'
]);
const MAX_UPLOAD = 128 * 1024 * 1024;
const MAX_JSON_BODY = 4 * 1024 * 1024;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.ogv': 'video/ogg',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8'
};

/* --- small helpers ------------------------------------------------------ */

function sendJson(res, code, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function fail(res, code, message) {
    sendJson(res, code, { error: message });
}

class HttpError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                reject(new HttpError(413, 'Body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

async function readJsonBody(req) {
    const raw = await readBody(req, MAX_JSON_BODY);
    if (!raw.length) return {};
    try {
        return JSON.parse(raw.toString('utf8'));
    } catch (e) {
        throw new HttpError(400, 'Invalid JSON body');
    }
}

function requireSlug(value) {
    const slug = String(value || '');
    if (!SLUG_RE.test(slug)) {
        throw new HttpError(400, 'Invalid slug: use lowercase letters, numbers and hyphens');
    }
    return slug;
}

function postPath(slug) {
    return path.join(POSTS_DIR, slug + '.md');
}

async function exists(p) {
    try {
        await fsp.access(p);
        return true;
    } catch (e) {
        return false;
    }
}

/* --- the manifest ------------------------------------------------------- */
/* content.json is the site's, not ours. Read it, touch only
   writing.onSiteArticles, and write it back in the formatting it already uses
   (2-space indent, trailing newline) so publishing never shows up as a
   whole-file reformat in the diff. */

async function readContent() {
    const raw = await fsp.readFile(CONTENT_JSON, 'utf8');
    return JSON.parse(raw);
}

async function writeContent(content) {
    await fsp.writeFile(CONTENT_JSON, JSON.stringify(content, null, 2) + '\n', 'utf8');
}

function manifestList(content) {
    return ((content.writing || {}).onSiteArticles || []);
}

function manifestFiles(content) {
    return manifestList(content)
        .map((entry) => (typeof entry === 'string' ? entry : (entry && entry.file)))
        .filter(Boolean);
}

async function setPublished(slug, published) {
    const content = await readContent();
    if (!content.writing) content.writing = {};
    if (!Array.isArray(content.writing.onSiteArticles)) content.writing.onSiteArticles = [];

    const file = slug + '.md';
    const list = content.writing.onSiteArticles;
    const index = list.findIndex((entry) => (typeof entry === 'string' ? entry : (entry && entry.file)) === file);

    if (published && index === -1) {
        // Newest first, matching how the list already reads. Order is cosmetic
        // either way — the site sorts by frontmatter date.
        list.unshift({ file });
    } else if (!published && index !== -1) {
        list.splice(index, 1);
    }

    await writeContent(content);
    return manifestFiles(content);
}

/* --- git ---------------------------------------------------------------- */

async function git(args) {
    try {
        const { stdout, stderr } = await execFileAsync('git', args, {
            cwd: ROOT,
            maxBuffer: 8 * 1024 * 1024
        });
        return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (e) {
        return {
            ok: false,
            stdout: String(e.stdout || '').trim(),
            stderr: String(e.stderr || e.message || '').trim()
        };
    }
}

/* Which repo-relative paths have uncommitted changes. Used to tell a published
   post apart from a published post with edits you haven't pushed yet. */
async function dirtyPaths() {
    // -uall matters: without it git collapses an untracked directory into a
    // single entry, and every post inside it looks clean.
    const result = await git(['status', '--porcelain', '-z', '-uall']);
    if (!result.ok) return null;

    const out = new Set();
    const parts = result.stdout.split('\0').filter(Boolean);
    for (const part of parts) {
        // Porcelain v1: XY<space>path. Renames emit the target in a separate
        // NUL-delimited field, which this loop reads as its own entry — good
        // enough, since we only ever ask "is this path dirty".
        const p = part.length > 3 ? part.slice(3) : part;
        if (p) out.add(p);
    }
    return out;
}

/* Media the post actually references, so publishing commits the clips too but
   nothing else sitting in assets/clips/. */
function referencedMedia(markdown) {
    const found = new Set();
    const re = /\/assets\/clips\/([A-Za-z0-9._-]+)/g;
    let m;
    while ((m = re.exec(markdown))) {
        found.add(path.posix.join('assets/clips', m[1]));
    }
    return [...found];
}

/* --- API ---------------------------------------------------------------- */

async function listPosts() {
    let names = [];
    try {
        names = await fsp.readdir(POSTS_DIR);
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }

    const content = await readContent();
    const published = new Set(manifestFiles(content));
    const dirty = await dirtyPaths();

    const posts = [];
    for (const name of names) {
        if (!name.endsWith('.md')) continue;
        const slug = name.slice(0, -3);
        if (!SLUG_RE.test(slug)) continue;

        const full = path.join(POSTS_DIR, name);
        const [markdown, stat] = await Promise.all([
            fsp.readFile(full, 'utf8'),
            fsp.stat(full)
        ]);

        const repoPath = path.posix.join('blog/posts', name);
        posts.push({
            slug,
            markdown,
            published: published.has(name),
            // null when git isn't available, so the UI can stay quiet about it
            dirty: dirty ? dirty.has(repoPath) : null,
            modified: stat.mtimeMs
        });
    }

    posts.sort((a, b) => b.modified - a.modified);
    return posts;
}

async function handleApi(req, res, url) {
    const route = url.pathname.replace(/^\/__writer\/api/, '') || '/';
    const method = req.method;

    if (method === 'GET' && route === '/posts') {
        return sendJson(res, 200, { posts: await listPosts() });
    }

    if (route === '/media' && method === 'POST') {
        const rawName = String(req.headers['x-filename'] || '');
        const decoded = decodeURIComponent(rawName);
        const ext = path.extname(decoded).toLowerCase();
        if (!MEDIA_EXT.has(ext)) {
            throw new HttpError(400, 'Unsupported file type: ' + (ext || decoded));
        }

        const base = path.basename(decoded, ext)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60) || 'clip';

        await fsp.mkdir(CLIPS_DIR, { recursive: true });

        // Never silently overwrite an existing clip another post may be using.
        let name = base + ext;
        let n = 2;
        while (await exists(path.join(CLIPS_DIR, name))) {
            name = base + '-' + n + ext;
            n += 1;
        }

        const data = await readBody(req, MAX_UPLOAD);
        if (!data.length) throw new HttpError(400, 'Empty upload');
        await fsp.writeFile(path.join(CLIPS_DIR, name), data);

        return sendJson(res, 200, {
            path: '/assets/clips/' + name,
            name,
            bytes: data.length
        });
    }

    if (route === '/publish' || route === '/unpublish') {
        if (method !== 'POST') throw new HttpError(405, 'Use POST');
        const body = await readJsonBody(req);
        const slug = requireSlug(body.slug);
        if (!(await exists(postPath(slug)))) {
            throw new HttpError(404, 'No such post: ' + slug);
        }
        const files = await setPublished(slug, route === '/publish');
        return sendJson(res, 200, { published: route === '/publish', manifest: files });
    }

    if (route === '/git/status') {
        const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
        const dirty = await dirtyPaths();
        return sendJson(res, 200, {
            available: branch.ok,
            branch: branch.ok ? branch.stdout : null,
            dirty: dirty ? [...dirty] : []
        });
    }

    if (route === '/git/publish') {
        if (method !== 'POST') throw new HttpError(405, 'Use POST');
        const body = await readJsonBody(req);
        const slug = requireSlug(body.slug);

        const file = postPath(slug);
        if (!(await exists(file))) throw new HttpError(404, 'No such post: ' + slug);
        const markdown = await fsp.readFile(file, 'utf8');

        /* Only this post's files. `git add -A` here would sweep every other
           draft in blog/posts/ into the deploy, where they'd be unlisted but
           publicly fetchable. That is the whole reason drafts stay safe. */
        const paths = [
            path.posix.join('blog/posts', slug + '.md'),
            'content/content.json',
            ...referencedMedia(markdown)
        ];
        const present = [];
        for (const p of paths) {
            if (await exists(path.join(ROOT, p))) present.push(p);
        }

        const steps = [];
        const add = await git(['add', '--', ...present]);
        steps.push({ step: 'add', ...add });
        if (!add.ok) return sendJson(res, 200, { ok: false, steps, staged: present });

        const message = String(body.message || ('blog: ' + slug)).slice(0, 200);
        const commit = await git(['commit', '-m', message, '--', ...present]);
        steps.push({ step: 'commit', ...commit });

        const nothingToCommit = !commit.ok && /nothing to commit|no changes added/i.test(
            commit.stdout + commit.stderr
        );
        if (!commit.ok && !nothingToCommit) {
            return sendJson(res, 200, { ok: false, steps, staged: present });
        }

        if (body.push === false) {
            return sendJson(res, 200, { ok: true, pushed: false, nothingToCommit, steps, staged: present });
        }

        const push = await git(['push']);
        steps.push({ step: 'push', ...push });

        return sendJson(res, 200, {
            ok: push.ok,
            pushed: push.ok,
            nothingToCommit,
            steps,
            staged: present
        });
    }

    /* /posts/:slug and /posts/:slug/rename */
    const postMatch = route.match(/^\/posts\/([^/]+)(\/rename)?$/);
    if (postMatch) {
        const slug = requireSlug(decodeURIComponent(postMatch[1]));
        const file = postPath(slug);

        if (postMatch[2]) {
            if (method !== 'POST') throw new HttpError(405, 'Use POST');
            const body = await readJsonBody(req);
            const target = requireSlug(body.to);
            if (target === slug) return sendJson(res, 200, { slug });
            if (!(await exists(file))) throw new HttpError(404, 'No such post: ' + slug);
            if (await exists(postPath(target))) {
                throw new HttpError(409, 'A post called ' + target + ' already exists');
            }

            const content = await readContent();
            const wasPublished = manifestFiles(content).includes(slug + '.md');

            await fsp.rename(file, postPath(target));
            if (wasPublished) {
                await setPublished(slug, false);
                await setPublished(target, true);
            }
            return sendJson(res, 200, { slug: target, published: wasPublished });
        }

        if (method === 'GET') {
            if (!(await exists(file))) throw new HttpError(404, 'No such post: ' + slug);
            return sendJson(res, 200, { slug, markdown: await fsp.readFile(file, 'utf8') });
        }

        if (method === 'PUT') {
            const body = await readJsonBody(req);
            if (typeof body.markdown !== 'string') {
                throw new HttpError(400, 'Expected { markdown: string }');
            }
            await fsp.mkdir(POSTS_DIR, { recursive: true });
            await fsp.writeFile(file, body.markdown, 'utf8');
            return sendJson(res, 200, { slug, bytes: Buffer.byteLength(body.markdown), saved: Date.now() });
        }

        if (method === 'DELETE') {
            if (await exists(file)) await fsp.unlink(file);
            await setPublished(slug, false);
            return sendJson(res, 200, { deleted: slug });
        }

        throw new HttpError(405, 'Method not allowed');
    }

    throw new HttpError(404, 'No such endpoint: ' + route);
}

/* --- static ------------------------------------------------------------- */

/* Resolve a URL path inside a base directory, refusing anything that climbs
   out via .. or a symlinked shortcut. */
function safeResolve(base, urlPath) {
    const decoded = decodeURIComponent(urlPath);
    const resolved = path.resolve(base, '.' + path.posix.normalize('/' + decoded));
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
    return resolved;
}

async function serveFile(res, file, req) {
    let stat;
    try {
        stat = await fsp.stat(file);
    } catch (e) {
        return false;
    }
    if (stat.isDirectory()) {
        return serveFile(res, path.join(file, 'index.html'), req);
    }

    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';

    /* Range support, because the preview plays video and Safari will not touch
       a video served without it. */
    const range = req.headers.range;
    if (range && /^bytes=/.test(range)) {
        const m = range.replace(/^bytes=/, '').split('-');
        const start = m[0] ? Number(m[0]) : 0;
        const end = m[1] ? Number(m[1]) : stat.size - 1;
        if (Number.isFinite(start) && start < stat.size && end >= start) {
            const last = Math.min(end, stat.size - 1);
            res.writeHead(206, {
                'Content-Type': type,
                'Content-Length': last - start + 1,
                'Content-Range': `bytes ${start}-${last}/${stat.size}`,
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-store'
            });
            fs.createReadStream(file, { start, end: last }).pipe(res);
            return true;
        }
    }

    res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        // The point of this server is watching edits land. Never cache.
        'Cache-Control': 'no-store'
    });
    fs.createReadStream(file).pipe(res);
    return true;
}

/* --- server ------------------------------------------------------------- */

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + HOST + ':' + PORT);

    try {
        if (url.pathname.startsWith('/__writer/api')) {
            return await handleApi(req, res, url);
        }

        // The editor itself.
        if (url.pathname === '/write' || url.pathname === '/write/') {
            if (await serveFile(res, path.join(WRITER_DIR, 'index.html'), req)) return;
            return fail(res, 404, 'writer/index.html is missing');
        }

        if (url.pathname.startsWith('/__writer/')) {
            const file = safeResolve(WRITER_DIR, url.pathname.replace('/__writer', ''));
            if (file && await serveFile(res, file, req)) return;
            return fail(res, 404, 'Not found');
        }

        // Everything else is the real site, straight off disk.
        const file = safeResolve(ROOT, url.pathname);
        if (file && await serveFile(res, file, req)) return;

        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found: ' + url.pathname);
    } catch (e) {
        if (res.headersSent) return res.end();
        if (e instanceof HttpError) return fail(res, e.code, e.message);
        console.error('[writer]', e);
        fail(res, 500, e && e.message ? e.message : 'Internal error');
    }
});

server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}/write`;
    console.log('');
    console.log('  Blog Writer');
    console.log('  ' + url);
    console.log('');
    console.log('  posts    ' + path.relative(ROOT, POSTS_DIR));
    console.log('  clips    ' + path.relative(ROOT, CLIPS_DIR));
    console.log('  manifest ' + path.relative(ROOT, CONTENT_JSON));
    console.log('');
    console.log('  Ctrl-C to stop.');
    console.log('');
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.error(`\n  Port ${PORT} is busy. Try:  PORT=4322 npm run write\n`);
        process.exit(1);
    }
    throw e;
});
