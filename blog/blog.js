/* Blog engine — frontmatter, custom media blocks, rendering.
   Shared by blog.html (listing), blog/post.html (reader) and index.html (latest posts).
   Depends on marked (vendored alongside this file). */

(function (global) {
    'use strict';

    function escapeHtml(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /* Inline markdown for captions and credits, so *this* still works in them. */
    function inline(s) {
        if (!s) return '';
        try {
            return marked.parseInline(s);
        } catch (e) {
            return escapeHtml(s);
        }
    }

    /* --- Frontmatter -------------------------------------------------------
       A small YAML subset: `key: value`, quoted values, and `[a, b]` lists.
       Frontmatter is the single source of truth for a post's metadata —
       content.json only says which files exist. */

    function parseFrontmatter(md) {
        var m = String(md).match(/^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/);
        if (!m) return { meta: {}, body: String(md).trim() };

        var meta = {};
        m[1].split(/\r?\n/).forEach(function (line) {
            if (!line.trim() || line.trim().charAt(0) === '#') return;
            var i = line.indexOf(':');
            if (i === -1) return;

            var key = line.slice(0, i).trim().toLowerCase();
            var val = line.slice(i + 1).trim();

            if (val.charAt(0) === '[' && val.slice(-1) === ']') {
                val = val.slice(1, -1).split(',')
                    .map(function (s) { return s.trim().replace(/^["']|["']$/g, ''); })
                    .filter(Boolean);
            } else {
                val = val.replace(/^["']|["']$/g, '');
            }
            if (key) meta[key] = val;
        });

        return { meta: meta, body: m[2].trim() };
    }

    /* --- Custom blocks -----------------------------------------------------

       :::lyric song="..." film="..." by="..."
       <tamil>
       <transliteration>
       <translation>
       :::

       Blank lines separate stanzas. Within a stanza the lines map in order to
       Tamil, transliteration, translation — give fewer and the later registers
       are simply omitted. */

    var BLOCK_RE = /^:::[ \t]*([a-z]+)[ \t]*([^\n]*)\n([\s\S]*?)^:::[ \t]*$/gm;

    function parseAttrs(str) {
        var attrs = {};
        var re = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
        var m;
        while ((m = re.exec(str))) {
            var v = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
            attrs[m[1].toLowerCase()] = v;
        }
        return attrs;
    }

    function stanzas(text) {
        return String(text).split(/\n[ \t]*\n/)
            .map(function (s) {
                return s.split('\n')
                    .map(function (l) { return l.trim(); })
                    .filter(Boolean);
            })
            .filter(function (g) { return g.length; });
    }

    /* Two registers, always: the Tamil, then what it means.
       Transliteration was a third line of near-identical text and it made
       every quote tiring to read, so it isn't a register any more.

       First line and last line — not the first two. A quote still written in
       the old three-line form (Tamil / transliteration / meaning) therefore
       drops its middle line rather than losing the translation. */
    function stackHtml(lines, prefix) {
        var kept = lines.length > 1 ? [lines[0], lines[lines.length - 1]] : [lines[0]];

        return kept.map(function (line, i) {
            var register = i === 0 ? 'ta' : 'en';
            var lang = i === 0 ? ' lang="ta"' : '';
            return '<span class="' + prefix + '-' + register + '"' + lang + '>' +
                escapeHtml(line) + '</span>';
        }).join('');
    }

    function credit(parts) {
        var kept = parts.filter(Boolean).map(inline);
        if (!kept.length) return '';
        return '<figcaption class="block-credit">' + kept.join('<span class="sep">·</span>') + '</figcaption>';
    }

    var RENDERERS = {
        /* The one place the design raises its voice: three registers, one idea. */
        lyric: function (attrs, text) {
            var groups = stanzas(text).map(function (lines) {
                return '<p class="lyric-stanza">' + stackHtml(lines, 'lyric') + '</p>';
            }).join('');

            return '<figure class="lyric">' + groups +
                credit([attrs.song, attrs.film, attrs.by]) + '</figure>';
        },

        /* Quieter than a lyric — no rule, just an indent and a name beneath. */
        dialogue: function (attrs, text) {
            var groups = stanzas(text).map(function (lines) {
                return '<p class="dialogue-line">' + stackHtml(lines, 'dialogue') + '</p>';
            }).join('');

            var who = [attrs.speaker, attrs.film].filter(Boolean).map(inline);
            var cap = who.length
                ? '<figcaption class="dialogue-who">— ' + who.join('<span class="sep">·</span>') + '</figcaption>'
                : '';

            return '<figure class="dialogue">' + groups + cap + '</figure>';
        },

        /* Self-hosted, with sound. Breaks the text column slightly. */
        clip: function (attrs, text) {
            var poster = attrs.poster ? ' poster="' + escapeHtml(attrs.poster) + '"' : '';
            return '<figure class="media">' +
                '<video class="media-video" src="' + escapeHtml(attrs.src || '') + '"' + poster +
                ' preload="none" controls playsinline></video>' +
                (text.trim() ? '<figcaption class="media-caption">' + inline(text.trim()) + '</figcaption>' : '') +
                '</figure>';
        },

        /* A moving photograph. Muted, looping, paused when out of view or when
           the reader has asked for reduced motion. */
        loop: function (attrs, text) {
            var poster = attrs.poster ? ' poster="' + escapeHtml(attrs.poster) + '"' : '';
            return '<figure class="media media-loop">' +
                '<video class="media-video" src="' + escapeHtml(attrs.src || '') + '"' + poster +
                ' preload="metadata" muted loop playsinline data-autoplay></video>' +
                (text.trim() ? '<figcaption class="media-caption">' + inline(text.trim()) + '</figcaption>' : '') +
                '</figure>';
        },

        /* A still. Same frame as a clip, and never cropped — a photograph
           keeps whatever shape it was taken in. */
        image: function (attrs, text) {
            return '<figure class="media media-still">' +
                '<img class="media-image" src="' + escapeHtml(attrs.src || '') +
                '" alt="' + escapeHtml(attrs.alt || '') + '" loading="lazy">' +
                (text.trim() ? '<figcaption class="media-caption">' + inline(text.trim()) + '</figcaption>' : '') +
                '</figure>';
        },

        /* A thumbnail until clicked, so four embeds don't load four iframes. */
        youtube: function (attrs, text) {
            var id = escapeHtml(attrs.id || attrs.src || '');
            var t = String(attrs.t || '').replace(/[^0-9]/g, '');
            return '<figure class="media media-yt">' +
                '<button type="button" class="yt-facade" data-yt="' + id + '"' +
                (t ? ' data-t="' + t + '"' : '') +
                ' aria-label="Play video on YouTube">' +
                '<img class="yt-thumb" src="https://i.ytimg.com/vi/' + id + '/hqdefault.jpg" alt="" loading="lazy">' +
                '<span class="yt-play" aria-hidden="true"></span>' +
                '</button>' +
                (text.trim() ? '<figcaption class="media-caption">' + inline(text.trim()) + '</figcaption>' : '') +
                '</figure>';
        }
    };

    /* Blocks are pulled out before marked runs and stitched back afterwards,
       so markdown never sees — and never mangles — the generated HTML. */
    function renderMarkdown(body) {
        var blocks = [];

        var stripped = String(body).replace(BLOCK_RE, function (match, name, attrLine, inner) {
            var render = RENDERERS[name];
            if (!render) return match; // unknown block: leave it alone, visibly
            blocks.push(render(parseAttrs(attrLine), inner));
            return '\n\n<!--block:' + (blocks.length - 1) + '-->\n\n';
        });

        var html = marked.parse(stripped, { mangle: false, headerIds: false });

        return html.replace(/<!--block:(\d+)-->/g, function (_, i) {
            return blocks[Number(i)] || '';
        });
    }

    /* --- Behaviours --------------------------------------------------------
       Called after post HTML lands in the DOM. */

    function attachBehaviors(root) {
        var reduceMotion = global.matchMedia &&
            global.matchMedia('(prefers-reduced-motion: reduce)').matches;

        var loops = root.querySelectorAll('video[data-autoplay]');

        if (reduceMotion) {
            // Give them controls instead of motion the reader didn't ask for.
            Array.prototype.forEach.call(loops, function (v) { v.controls = true; });
        } else if (global.IntersectionObserver) {
            var io = new IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                    var v = entry.target;
                    if (entry.isIntersecting) {
                        var p = v.play();
                        if (p && p.catch) p.catch(function () { v.controls = true; });
                    } else {
                        v.pause();
                    }
                });
            }, { threshold: 0.25 });
            Array.prototype.forEach.call(loops, function (v) { io.observe(v); });
        } else {
            Array.prototype.forEach.call(loops, function (v) { v.autoplay = true; });
        }

        // A clip whose file is missing shouldn't take the paragraph with it.
        Array.prototype.forEach.call(root.querySelectorAll('video'), function (v) {
            v.addEventListener('error', function () {
                var fig = v.closest('figure');
                if (fig) fig.classList.add('media-missing');
            });
        });

        Array.prototype.forEach.call(root.querySelectorAll('.yt-facade'), function (btn) {
            btn.addEventListener('click', function () {
                var id = btn.getAttribute('data-yt');
                var t = btn.getAttribute('data-t');
                var frame = document.createElement('iframe');
                frame.className = 'yt-frame';
                frame.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) +
                    '?autoplay=1&rel=0' + (t ? '&start=' + encodeURIComponent(t) : '');
                frame.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture');
                frame.setAttribute('allowfullscreen', '');
                frame.setAttribute('title', 'YouTube video');
                btn.replaceWith(frame);
            });
        });
    }

    /* --- Loading -----------------------------------------------------------
       `base` is the path to the blog directory from the calling page:
       './blog/' from the site root, './' from inside blog/. */

    function postUrl(base, file) {
        return base + 'posts/' + file;
    }

    function slugOf(file) {
        return String(file).replace(/\.md$/, '');
    }

    /* Content changes more often than code, and a browser holding an old
       content.json lists posts that no longer exist. 'no-cache' keeps the
       cached copy but checks with the server before using it. */
    function loadManifest(contentPath) {
        return fetch(contentPath, { cache: 'no-cache' })
            .then(function (r) {
                if (!r.ok) throw new Error('content.json ' + r.status);
                return r.json();
            })
            .then(function (content) {
                return ((content.writing || {}).onSiteArticles || []);
            });
    }

    /* Fetches every listed post and reads its frontmatter. Posts that fail to
       load are dropped rather than breaking the page. */
    function loadPosts(base, contentPath) {
        return loadManifest(contentPath).then(function (entries) {
            return Promise.all(entries.map(function (entry) {
                var file = typeof entry === 'string' ? entry : entry.file;
                if (!file) return null;
                return fetch(postUrl(base, file), { cache: 'no-cache' })
                    .then(function (r) {
                        if (!r.ok) throw new Error(file + ' ' + r.status);
                        return r.text();
                    })
                    .then(function (md) {
                        var parsed = parseFrontmatter(md);
                        return {
                            slug: slugOf(file),
                            meta: parsed.meta,
                            body: parsed.body
                        };
                    })
                    .catch(function (e) {
                        console.warn('Skipping post:', file, e);
                        return null;
                    });
            }));
        }).then(function (posts) {
            return posts.filter(Boolean).sort(function (a, b) {
                return new Date(b.meta.date || 0) - new Date(a.meta.date || 0);
            });
        });
    }

    function formatDate(value) {
        if (!value) return '';
        var d = new Date(value);
        if (isNaN(d)) return String(value);
        return d.toLocaleDateString('en-US', {
            month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC'
        });
    }

    /* --- Assembling a post -------------------------------------------------
       post.html and the writer's preview both need the same DOM, or the
       preview stops being trustworthy. It lives here so there is one of it. */

    function topicOf(meta) {
        return String((meta && meta.theme) || 'cinema').toLowerCase();
    }

    /* Everything that isn't the writing goes in the rail: date, theme, film.
       Director and composer stay in the frontmatter and stay off the page. */
    function railHtml(meta) {
        var rows = [];

        if (meta.date) {
            rows.push('<span class="rail-item label">' +
                escapeHtml(formatDate(meta.date)) + '</span>');
        }
        if (meta.theme) {
            rows.push('<span class="rail-item label rail-topic">' +
                escapeHtml(meta.theme) + '</span>');
        }
        if (meta.film) {
            rows.push('<span class="rail-item rail-film">' + escapeHtml(meta.film) +
                (meta.year ? ', ' + escapeHtml(meta.year) : '') + '</span>');
        }

        return rows.length ? '<div class="post-rail">' + rows.join('') + '</div>' : '';
    }

    /* Inner HTML for <article class="blog-post">. The caller sets data-topic
       from topicOf(meta) — that one attribute drives every accent on the page. */
    function renderPost(meta, body, fallbackTitle) {
        meta = meta || {};
        var title = meta.title || fallbackTitle || '';

        return railHtml(meta) +
            '<header class="post-header">' +
            '<h1 class="post-title">' + escapeHtml(title) + '</h1>' +
            (meta.description
                ? '<p class="post-description">' + escapeHtml(meta.description) + '</p>'
                : '') +
            '</header>' +
            '<div class="post-body">' + renderMarkdown(body || '') + '</div>';
    }

    global.Blog = {
        parseFrontmatter: parseFrontmatter,
        renderMarkdown: renderMarkdown,
        renderPost: renderPost,
        topicOf: topicOf,
        attachBehaviors: attachBehaviors,
        loadPosts: loadPosts,
        formatDate: formatDate,
        escapeHtml: escapeHtml,
        slugOf: slugOf
    };

})(window);
