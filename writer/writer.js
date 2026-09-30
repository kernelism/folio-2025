/* Playback Writer — the editor.

   Talks to writer/server.js over /__writer/api, renders the preview by
   postMessaging the real blog.js inside an iframe, and knows how to turn a
   form plus a textarea into the exact markdown file the site expects.

   Frontmatter is parsed with Blog.parseFrontmatter — the site's own parser —
   so the editor can never disagree with the renderer about what a post says. */

(function () {
    'use strict';

    var API = '/__writer/api';

    /* Order matters: this is the order keys are written into frontmatter. */
    var META_KEYS = ['title', 'date', 'description', 'theme', 'tags', 'film', 'year', 'director', 'music'];

    var CARET = '‸'; // marks where the cursor lands in a block template

    var BLOCKS = [
        {
            key: 'lyric',
            label: 'Lyric',
            hint: 'A song quote — the Tamil, then what it means',
            template: ':::lyric song="' + CARET + '" film="" by=""\n\n\n:::'
        },
        {
            key: 'dialogue',
            label: 'Dialogue',
            hint: 'A line from a film, quieter than a lyric',
            template: ':::dialogue speaker="' + CARET + '" film=""\n\n\n:::'
        },
        {
            key: 'image',
            label: 'Image',
            hint: 'A still with a caption — or just drop a file',
            template: ':::image src="/assets/clips/' + CARET + '" alt=""\n\n:::'
        },
        {
            key: 'clip',
            label: 'Clip',
            hint: 'Self-hosted video with sound — or just drop a file',
            template: ':::clip src="/assets/clips/' + CARET + '" poster=""\n\n:::'
        },
        {
            key: 'loop',
            label: 'Loop',
            hint: 'Muted, looping, pauses when off screen',
            template: ':::loop src="/assets/clips/' + CARET + '"\n\n:::'
        },
        {
            key: 'youtube',
            label: 'YouTube',
            hint: 'Thumbnail until clicked, so the page stays light',
            template: ':::youtube id="' + CARET + '" t=""\n\n:::'
        }
    ];

    /* ---------- elements ---------- */

    function $(id) { return document.getElementById(id); }

    var els = {
        body: $('body'),
        bodyWrap: $('bodyWrap'),
        list: $('postList'),
        count: $('postCount'),
        saveState: $('saveState'),
        branch: $('branch'),
        frame: $('previewFrame'),
        slash: $('slash'),
        toasts: $('toasts'),
        modal: $('modal'),
        modalTitle: $('modalTitle'),
        modalBody: $('modalBody'),
        modalActions: $('modalActions'),
        slugHint: $('slugHint'),
        layout: $('layout')
    };

    /* ---------- state ---------- */

    var posts = [];
    var doc = null;
    var saveTimer = null;
    var previewTimer = null;
    var previewReady = false;
    var pendingPreview = null;
    var previewDark = false;
    var slash = null; // { start, query, items, index }

    function blankDoc() {
        return {
            slug: '',
            exists: false,
            published: false,
            extra: {},        // frontmatter keys the form doesn't know about
            saved: null,      // last markdown known to be on disk
            slugLocked: false // true once the slug stops following the title
        };
    }

    /* ---------- http ---------- */

    function request(path, options) {
        return fetch(API + path, options).then(function (res) {
            return res.json().catch(function () { return null; }).then(function (data) {
                if (!res.ok) {
                    throw new Error((data && data.error) || (res.status + ' ' + res.statusText));
                }
                return data;
            });
        });
    }

    function send(path, body, method) {
        return request(path, {
            method: method || 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        });
    }

    /* ---------- frontmatter ---------- */

    function yamlValue(value) {
        if (Array.isArray(value)) {
            // The parser splits a list on commas, so a comma inside a tag
            // cannot survive the round trip. Neither can a bracket.
            return '[' + value.map(function (v) {
                return String(v).replace(/[[\],\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
            }).filter(Boolean).join(', ') + ']';
        }

        // Frontmatter is line-based — a newline inside a value would end the
        // value, or the block. Collapse rather than corrupt.
        var s = String(value).replace(/\s*[\r\n]+\s*/g, ' ');

        /* Blog.parseFrontmatter strips exactly one leading and one trailing
           quote character and does no unescaping whatsoever. So one bare layer
           of quotes is both necessary and sufficient — escaping the inner
           quotes the way JSON does would leave the backslashes behind in the
           parsed value. */
        if (/^\[[\s\S]*\]$/.test(s) || /^["']/.test(s) || /["']$/.test(s) || s !== s.trim()) {
            return '"' + s + '"';
        }
        return s;
    }

    function composeMarkdown(meta, extra, body) {
        var lines = [];

        META_KEYS.forEach(function (key) {
            var v = meta[key];
            if (v === undefined || v === null || v === '') return;
            if (Array.isArray(v) && !v.length) return;
            lines.push(key + ': ' + yamlValue(v));
        });

        // Anything the form has no field for survives the round trip.
        Object.keys(extra || {}).forEach(function (key) {
            lines.push(key + ': ' + yamlValue(extra[key]));
        });

        return '---\n' + lines.join('\n') + '\n---\n\n' + String(body).trim() + '\n';
    }

    /* ---------- slugs ---------- */

    function slugify(s) {
        return String(s || '')
            .toLowerCase()
            .normalize('NFKD')
            .replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 80);
    }

    function uniqueSlug(base, ignore) {
        var taken = {};
        posts.forEach(function (p) { if (p.slug !== ignore) taken[p.slug] = true; });

        var slug = base || 'untitled';
        var n = 2;
        while (taken[slug]) {
            slug = base + '-' + n;
            n += 1;
        }
        return slug;
    }

    /* ---------- form ---------- */

    function readForm() {
        var meta = {};

        META_KEYS.forEach(function (key) {
            if (key === 'tags') return;
            var el = $('f-' + key);
            if (!el) return;
            var v = el.value.trim();
            if (v) meta[key] = v;
        });

        var tags = $('f-tags').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        if (tags.length) meta.tags = tags;

        return meta;
    }

    function writeForm(meta) {
        META_KEYS.forEach(function (key) {
            var el = $('f-' + key);
            if (!el) return;
            var v = meta[key];
            if (key === 'tags') v = Array.isArray(v) ? v.join(', ') : (v || '');
            el.value = v === undefined || v === null ? '' : String(v);
        });
    }

    function todayISO() {
        var d = new Date();
        return [
            d.getFullYear(),
            String(d.getMonth() + 1).padStart(2, '0'),
            String(d.getDate()).padStart(2, '0')
        ].join('-');
    }

    /* <input type="date"> only speaks YYYY-MM-DD. Convert what we can and be
       honest about what we can't rather than silently blanking a date. */
    function normalizeDate(value) {
        if (!value) return { value: '', lost: false };
        var s = String(value);
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { value: s, lost: false };

        var d = new Date(s);
        if (isNaN(d)) return { value: '', lost: true };
        return { value: d.toISOString().slice(0, 10), lost: false };
    }

    /* ---------- preview ---------- */

    function schedulePreview() {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(pushPreview, 140);
    }

    function pushPreview() {
        var payload = {
            type: 'preview',
            meta: readForm(),
            body: els.body.value,
            slug: doc ? doc.slug : ''
        };

        if (!previewReady || !els.frame.contentWindow) {
            pendingPreview = payload;
            return;
        }
        els.frame.contentWindow.postMessage(payload, window.location.origin);
    }

    window.addEventListener('message', function (event) {
        if (event.origin !== window.location.origin) return;
        if (!event.data || event.data.type !== 'preview-ready') return;

        previewReady = true;
        applyPreviewTheme();
        if (pendingPreview) {
            els.frame.contentWindow.postMessage(pendingPreview, window.location.origin);
            pendingPreview = null;
        } else {
            pushPreview();
        }
    });

    /* Same origin, so we can reach in and set the attribute the site's own
       stylesheets key their dark palette off. */
    function applyPreviewTheme() {
        try {
            var d = els.frame.contentDocument;
            if (!d) return;
            if (previewDark) d.documentElement.setAttribute('data-theme', 'dark');
            else d.documentElement.removeAttribute('data-theme');
        } catch (e) { /* frame not ready yet */ }
    }

    /* ---------- save state ---------- */

    function setState(text, kind) {
        els.saveState.textContent = text;
        els.saveState.className = 'save-state' + (kind ? ' ' + kind : '');
    }

    function currentMarkdown() {
        return composeMarkdown(readForm(), doc.extra, els.body.value);
    }

    function hasChanges() {
        if (!doc) return false;
        if (!doc.exists) return Boolean(readForm().title || els.body.value.trim());
        return currentMarkdown() !== doc.saved;
    }

    function scheduleSave() {
        clearTimeout(saveTimer);
        if (!doc) return;

        if (!readForm().title) {
            setState('Add a title and I’ll start saving');
            return;
        }
        setState('Unsaved…');
        saveTimer = setTimeout(function () { save(); }, 1500);
    }

    function save(options) {
        options = options || {};
        clearTimeout(saveTimer);
        if (!doc) return Promise.resolve(false);

        var meta = readForm();
        if (!meta.title) {
            setState('Add a title and I’ll start saving');
            if (options.loud) toast('A post needs a title before it can be saved.', 'bad');
            return Promise.resolve(false);
        }

        if (!doc.slug) {
            // A slug typed but not yet blurred hasn't fired 'change', so read
            // the field directly rather than silently overriding it.
            var typed = slugify($('f-slug').value);
            doc.slug = uniqueSlug(typed || slugify(meta.title) || 'untitled', null);
            $('f-slug').value = doc.slug;
        }

        var markdown = currentMarkdown();
        if (doc.exists && markdown === doc.saved) {
            setState('Saved');
            return Promise.resolve(true);
        }

        setState('Saving…', 'saving');
        return send('/posts/' + encodeURIComponent(doc.slug), { markdown: markdown }, 'PUT')
            .then(function () {
                doc.saved = markdown;
                doc.exists = true;
                setState('Saved ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
                return refreshPosts().then(function () { return true; });
            })
            .catch(function (e) {
                setState('Save failed', 'error');
                toast('Couldn’t save: ' + e.message, 'bad');
                return false;
            });
    }

    /* ---------- post list ---------- */

    function refreshPosts() {
        return request('/posts').then(function (data) {
            posts = (data && data.posts) || [];
            renderList();
        }).catch(function (e) {
            toast('Couldn’t read blog/posts: ' + e.message, 'bad');
        });
    }

    function metaOf(post) {
        try {
            return Blog.parseFrontmatter(post.markdown).meta || {};
        } catch (e) {
            return {};
        }
    }

    function stateOf(post) {
        var state;
        if (!post.published) state = { cls: 'draft', label: 'draft' };
        else if (post.dirty) state = { cls: 'edited', label: 'edits not pushed' };
        else state = { cls: 'live', label: 'published' };

        return state;
    }

    function renderList() {
        els.count.textContent = posts.length ? String(posts.length) : '';
        els.list.innerHTML = '';

        posts.forEach(function (post) {
            var meta = metaOf(post);
            var state = stateOf(post);

            var li = document.createElement('li');
            li.className = 'post-item' + (doc && doc.slug === post.slug && doc.exists ? ' active' : '');
            li.tabIndex = 0;

            var title = document.createElement('span');
            title.className = 't';
            title.textContent = meta.title || post.slug;

            var sub = document.createElement('span');
            sub.className = 's';
            var dot = document.createElement('span');
            dot.className = 'dot ' + state.cls;
            sub.appendChild(dot);
            sub.appendChild(document.createTextNode(state.label));

            li.appendChild(title);
            li.appendChild(sub);

            li.addEventListener('click', function () { openPost(post.slug); });
            li.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openPost(post.slug);
                }
            });

            els.list.appendChild(li);
        });
    }

    /* ---------- open / new ---------- */

    function confirmDiscard() {
        if (!hasChanges()) return Promise.resolve(true);
        return new Promise(function (resolve) {
            openModal('Unsaved changes', '<p>This post has edits that aren’t on disk yet.</p>', [
                { label: 'Save first', kind: 'primary', act: function () { closeModal(); save().then(resolve); } },
                { label: 'Discard them', act: function () { closeModal(); resolve(true); } },
                { label: 'Cancel', act: function () { closeModal(); resolve(false); } }
            ]);
        });
    }

    function openPost(slug) {
        if (doc && doc.slug === slug && doc.exists) return;

        confirmDiscard().then(function (go) {
            if (!go) return;

            var post = posts.filter(function (p) { return p.slug === slug; })[0];
            if (!post) return;

            var parsed = Blog.parseFrontmatter(post.markdown);
            var meta = {};
            var extra = {};

            Object.keys(parsed.meta || {}).forEach(function (key) {
                if (META_KEYS.indexOf(key) !== -1) meta[key] = parsed.meta[key];
                else extra[key] = parsed.meta[key];
            });

            var date = normalizeDate(meta.date);
            if (date.lost) {
                toast('The date "' + meta.date + '" isn’t a date I can read — please set it again.', 'bad');
            }
            meta.date = date.value;

            doc = blankDoc();
            doc.slug = slug;
            doc.exists = true;
            doc.published = post.published;
            doc.extra = extra;
            doc.slugLocked = true;

            writeForm(meta);
            $('f-slug').value = slug;
            els.body.value = parsed.body;
            doc.saved = currentMarkdown();

            // doc.saved is what *we* would write, not the bytes on disk — the
            // file may order its keys differently. Comparing against our own
            // output keeps a freshly opened post from looking instantly dirty.
            setState('Saved');

            updateSlugHint();
            updatePublishButton();
            renderList();
            schedulePreview();
            $('f-title').focus();
        });
    }

    function newPost() {
        confirmDiscard().then(function (go) {
            if (!go) return;

            doc = blankDoc();
            writeForm({ date: todayISO(), theme: 'cinema' });
            $('f-slug').value = '';
            els.body.value = '';

            setState('New post');
            updateSlugHint();
            updatePublishButton();
            renderList();
            schedulePreview();
            $('f-title').focus();
        });
    }

    function updateSlugHint() {
        if (!doc) return;
        els.slugHint.textContent = doc.exists ? '— renames the file' : '— follows the title';
    }

    function updatePublishButton() {
        var btn = $('publishPost');
        btn.textContent = doc && doc.published ? 'Republish' : 'Publish';
    }

    /* ---------- publish ---------- */

    function siteUrls(slug) {
        return {
            apex: 'https://arjunsreedar.xyz/blog/post.html?slug=' + encodeURIComponent(slug),
            sub: 'https://blog.arjunsreedar.xyz/' + encodeURIComponent(slug),
            local: window.location.origin + '/blog/post.html?slug=' + encodeURIComponent(slug)
        };
    }

    function publishFlow() {
        save({ loud: true }).then(function (ok) {
            if (!ok) return;

            var meta = readForm();
            if (!meta.date) {
                toast('Set a date before publishing — the listing sorts by it.', 'bad');
                return;
            }

            var body =
                '<p>Adds this post to <code>content.json</code>, commits it with ' +
                'any clips it uses, and pushes. Other drafts stay on your machine.</p>' +
                '<label class="stack">Commit message' +
                '<input type="text" id="commitMsg" value="' +
                escapeAttr('blog: ' + (meta.title || doc.slug)) + '"></label>';

            var actions = [
                {
                    label: 'Publish &amp; push', kind: 'primary', act: function () {
                        var msg = $('commitMsg').value;
                        closeModal();
                        runPublish(msg, true);
                    }
                },
                {
                    label: 'Commit, don’t push', act: function () {
                        var msg = $('commitMsg').value;
                        closeModal();
                        runPublish(msg, false);
                    }
                }
            ];

            if (doc.published) {
                actions.push({
                    label: 'Unpublish', act: function () {
                        closeModal();
                        send('/unpublish', { slug: doc.slug }).then(function () {
                            doc.published = false;
                            updatePublishButton();
                            refreshPosts();
                            toast('Removed from the listing. Commit and push to take it off the site.', 'good');
                        }).catch(function (e) { toast(e.message, 'bad'); });
                    }
                });
            }

            actions.push({ label: 'Cancel', act: closeModal });

            openModal('Publish “' + (meta.title || doc.slug) + '”', body, actions);
        });
    }

    function runPublish(message, push) {
        setState('Publishing…', 'saving');

        send('/publish', { slug: doc.slug })
            .then(function () {
                doc.published = true;
                updatePublishButton();
                return send('/git/publish', { slug: doc.slug, message: message, push: push });
            })
            .then(function (result) {
                refreshPosts();
                setState('Published');
                showPublishResult(result, push);
            })
            .catch(function (e) {
                setState('Publish failed', 'error');
                toast('Publish failed: ' + e.message, 'bad');
            });
    }

    function showPublishResult(result, wantedPush) {
        var urls = siteUrls(doc.slug);
        var html = '';

        if (result.ok && result.pushed) {
            html += '<p>Pushed. Vercel usually has it live in under a minute.</p>';
        } else if (result.ok && !wantedPush) {
            html += '<p>Committed on your machine. Nothing is live until you push.</p>';
        } else {
            html += '<p>Git didn’t finish. The post is saved and listed, but not pushed.</p>';
        }

        if (result.staged && result.staged.length) {
            html += '<div class="log">staged\n  ' + result.staged.map(escapeHtml).join('\n  ') + '</div>';
        }

        var failed = (result.steps || []).filter(function (s) { return !s.ok; });
        if (failed.length) {
            html += '<div class="log">' + failed.map(function (s) {
                return escapeHtml(s.step + ': ' + (s.stderr || s.stdout || 'failed'));
            }).join('\n\n') + '</div>';
        }

        if (result.ok && result.pushed) {
            html += '<p><a href="' + escapeAttr(urls.apex) + '" target="_blank" rel="noopener">' +
                escapeHtml(urls.apex) + '</a></p>';
            html += '<p style="opacity:.7">Once <code>blog.arjunsreedar.xyz</code> has a DNS record, ' +
                'the same post also answers at <a href="' + escapeAttr(urls.sub) + '" target="_blank" ' +
                'rel="noopener">' + escapeHtml(urls.sub) + '</a>.</p>';
        }

        openModal('Published', html, [
            { label: 'Open locally', act: function () { window.open(urls.local, '_blank', 'noopener'); } },
            { label: 'Done', kind: 'primary', act: closeModal }
        ]);
    }

    /* ---------- rename / delete ---------- */

    function maybeRename() {
        if (!doc || !doc.exists) return;

        var wanted = slugify($('f-slug').value);
        if (!wanted || wanted === doc.slug) {
            $('f-slug').value = doc.slug;
            return;
        }

        var target = uniqueSlug(wanted, doc.slug);
        send('/posts/' + encodeURIComponent(doc.slug) + '/rename', { to: target })
            .then(function (res) {
                doc.slug = res.slug;
                $('f-slug').value = res.slug;
                toast('Renamed. The old URL will 404 once you push.', 'good');
                return refreshPosts();
            })
            .catch(function (e) {
                $('f-slug').value = doc.slug;
                toast(e.message, 'bad');
            });
    }

    function deleteCurrent() {
        if (!doc || !doc.exists) return;

        openModal('Delete this post?',
            '<p>Removes <code>blog/posts/' + escapeHtml(doc.slug) + '.md</code> from disk and from ' +
            'the listing. If it was already pushed, it stays on the site until you commit the deletion.</p>',
            [
                {
                    label: 'Delete', kind: 'primary', act: function () {
                        closeModal();
                        request('/posts/' + encodeURIComponent(doc.slug), { method: 'DELETE' })
                            .then(function () {
                                toast('Deleted.', 'good');
                                doc = blankDoc();
                                return refreshPosts();
                            })
                            .then(function () {
                                if (posts.length) openPost(posts[0].slug);
                                else newPost();
                            })
                            .catch(function (e) { toast(e.message, 'bad'); });
                    }
                },
                { label: 'Keep it', act: closeModal }
            ]);
    }

    /* ---------- text insertion ---------- */

    function replaceRange(start, end, text, caretAt) {
        var ta = els.body;
        var value = ta.value;
        ta.value = value.slice(0, start) + text + value.slice(end);
        var pos = caretAt === undefined ? start + text.length : caretAt;
        ta.selectionStart = ta.selectionEnd = pos;
        ta.focus();
        onEdit();
    }

    /* Blocks must start their own line and be followed by a blank one, or the
       renderer's block regex won't match them. */
    function insertBlock(template) {
        var ta = els.body;
        var start = ta.selectionStart;
        var value = ta.value;

        var before = value.slice(0, start);
        var lead = before && !/\n\n$/.test(before) ? (/\n$/.test(before) ? '\n' : '\n\n') : '';
        var after = value.slice(ta.selectionEnd);
        var trail = /^\n\n/.test(after) ? '' : (/^\n/.test(after) ? '\n' : '\n\n');

        var text = lead + template + trail;
        var caretIndex = text.indexOf(CARET);
        text = text.replace(CARET, '');

        replaceRange(start, ta.selectionEnd, text,
            caretIndex === -1 ? undefined : start + caretIndex);
    }

    function wrapSelection(before, after) {
        var ta = els.body;
        var start = ta.selectionStart;
        var end = ta.selectionEnd;
        var selected = ta.value.slice(start, end);

        replaceRange(start, end, before + selected + after,
            selected ? start + before.length + selected.length + after.length : start + before.length);
    }

    function prefixLine(prefix) {
        var ta = els.body;
        var start = ta.selectionStart;
        var lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;

        if (ta.value.slice(lineStart).indexOf(prefix) === 0) return; // already there
        replaceRange(lineStart, lineStart, prefix, start + prefix.length);
    }

    function applyMark(mark) {
        if (mark === 'bold') return wrapSelection('**', '**');
        if (mark === 'italic') return wrapSelection('*', '*');
        if (mark === 'h2') return prefixLine('## ');
        if (mark === 'quote') return prefixLine('> ');
        if (mark === 'link') {
            var ta = els.body;
            var selected = ta.value.slice(ta.selectionStart, ta.selectionEnd);
            var start = ta.selectionStart;
            var text = '[' + selected + '](url)';
            // Land the cursor on `url` so you can paste straight over it.
            replaceRange(start, ta.selectionEnd, text, start + text.length - 4);
            ta.selectionEnd = ta.selectionStart + 3;
        }
    }

    /* ---------- slash menu ---------- */

    /* Where the caret is on screen. A hidden div copies the textarea's metrics
       and holds the text up to the caret; the span at the end sits exactly
       where the caret does. */
    function caretPoint() {
        var ta = els.body;
        var cs = window.getComputedStyle(ta);
        var mirror = document.createElement('div');

        ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
            'textTransform', 'wordSpacing', 'paddingTop', 'paddingRight', 'paddingBottom',
            'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth',
            'borderLeftWidth', 'boxSizing'].forEach(function (prop) {
                mirror.style[prop] = cs[prop];
            });

        mirror.style.position = 'absolute';
        mirror.style.visibility = 'hidden';
        mirror.style.whiteSpace = 'pre-wrap';
        mirror.style.overflowWrap = 'break-word';
        mirror.style.width = ta.clientWidth + 'px';
        mirror.style.top = '0';
        mirror.style.left = '-9999px';

        mirror.textContent = ta.value.slice(0, ta.selectionStart);
        var marker = document.createElement('span');
        marker.textContent = '​';
        mirror.appendChild(marker);
        document.body.appendChild(mirror);

        var rect = ta.getBoundingClientRect();
        var point = {
            top: rect.top + marker.offsetTop - ta.scrollTop,
            left: rect.left + marker.offsetLeft - ta.scrollLeft,
            line: parseFloat(cs.lineHeight) || 20
        };

        document.body.removeChild(mirror);
        return point;
    }

    function openSlash(start) {
        slash = { start: start, query: '', index: 0 };
        renderSlash();
    }

    function closeSlash() {
        slash = null;
        els.slash.hidden = true;
    }

    function slashMatches() {
        var q = slash.query.toLowerCase();
        if (!q) return BLOCKS;
        return BLOCKS.filter(function (b) { return b.key.indexOf(q) === 0 || b.label.toLowerCase().indexOf(q) === 0; });
    }

    function renderSlash() {
        var items = slashMatches();
        if (!items.length) return closeSlash();

        if (slash.index >= items.length) slash.index = items.length - 1;

        els.slash.innerHTML = '';
        items.forEach(function (block, i) {
            var el = document.createElement('div');
            el.className = 'slash-item' + (i === slash.index ? ' on' : '');
            el.innerHTML = '<b>' + escapeHtml(block.label) + '</b><span>' + escapeHtml(block.hint) + '</span>';
            el.addEventListener('mousedown', function (e) {
                e.preventDefault();
                chooseSlash(block);
            });
            els.slash.appendChild(el);
        });

        var point = caretPoint();
        els.slash.hidden = false;

        var height = els.slash.offsetHeight;
        var below = point.top + point.line;
        // Flip above the caret when there isn't room beneath it.
        var top = (below + height > window.innerHeight - 12) ? point.top - height - 4 : below;

        els.slash.style.top = Math.max(8, top) + 'px';
        els.slash.style.left = Math.min(point.left, window.innerWidth - els.slash.offsetWidth - 12) + 'px';
    }

    function chooseSlash(block) {
        var ta = els.body;
        var end = slash.start + 1 + slash.query.length;
        var start = slash.start;
        closeSlash();

        // Drop the "/query" the user typed, then insert in its place.
        ta.value = ta.value.slice(0, start) + ta.value.slice(end);
        ta.selectionStart = ta.selectionEnd = start;
        insertBlock(block.template);
    }

    function syncSlash() {
        if (!slash) return;

        var caret = els.body.selectionStart;
        if (caret <= slash.start) return closeSlash();

        var typed = els.body.value.slice(slash.start + 1, caret);
        if (/\s/.test(typed) || typed.length > 12) return closeSlash();

        slash.query = typed;
        renderSlash();
    }

    /* ---------- media ---------- */

    function uploadFile(file) {
        return fetch(API + '/media', {
            method: 'POST',
            headers: { 'x-filename': encodeURIComponent(file.name) },
            body: file
        }).then(function (res) {
            return res.json().catch(function () { return null; }).then(function (data) {
                if (!res.ok) throw new Error((data && data.error) || ('upload failed (' + res.status + ')'));
                return data;
            });
        });
    }

    function once(target, event, ms) {
        return new Promise(function (resolve, reject) {
            var timer = setTimeout(function () { reject(new Error('timed out waiting for ' + event)); }, ms || 8000);
            target.addEventListener(event, function handler() {
                clearTimeout(timer);
                target.removeEventListener(event, handler);
                resolve();
            });
            target.addEventListener('error', function () {
                clearTimeout(timer);
                reject(new Error('could not decode the video'));
            }, { once: true });
        });
    }

    /* Grab a frame for the poster. Best-effort: a codec the browser can't paint
       (plenty of .mov files) just means no poster, not a failed drop. */
    function posterFrom(file) {
        var url = URL.createObjectURL(file);
        var video = document.createElement('video');
        video.preload = 'metadata';
        video.muted = true;
        video.playsInline = true;
        video.src = url;

        return once(video, 'loadedmetadata')
            .then(function () {
                video.currentTime = Math.min(1, (video.duration || 3) / 3);
                return once(video, 'seeked');
            })
            .then(function () {
                if (!video.videoWidth) throw new Error('no video track');

                var width = Math.min(1280, video.videoWidth);
                var height = Math.round(video.videoHeight * (width / video.videoWidth));
                var canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(video, 0, 0, width, height);

                return new Promise(function (resolve) {
                    canvas.toBlob(resolve, 'image/jpeg', 0.82);
                });
            })
            .then(function (blob) {
                URL.revokeObjectURL(url);
                return blob;
            })
            .catch(function () {
                URL.revokeObjectURL(url);
                return null;
            });
    }

    function handleFiles(files) {
        var list = Array.prototype.slice.call(files);
        if (!list.length) return;

        var chain = Promise.resolve();
        list.forEach(function (file) {
            chain = chain.then(function () { return handleOneFile(file); });
        });
    }

    function handleOneFile(file) {
        var isVideo = /^video\//.test(file.type) || /\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name);
        var isImage = /^image\//.test(file.type) || /\.(jpe?g|png|gif|webp|avif)$/i.test(file.name);

        if (!isVideo && !isImage) {
            toast('I can only take video and image files — ' + file.name + ' isn’t one.', 'bad');
            return Promise.resolve();
        }

        if (file.size > 20 * 1024 * 1024) {
            toast(file.name + ' is ' + Math.round(file.size / 1048576) +
                'MB. It goes into git forever — consider trimming it first.');
        }

        setState('Uploading ' + file.name + '…', 'saving');

        var posterStep = isVideo ? posterFrom(file) : Promise.resolve(null);

        return Promise.all([uploadFile(file), posterStep])
            .then(function (results) {
                var media = results[0];
                var posterBlob = results[1];

                if (!posterBlob) return { media: media, poster: null };

                var base = media.name.replace(/\.[^.]+$/, '');
                var posterFile = new File([posterBlob], base + '.jpg', { type: 'image/jpeg' });
                return uploadFile(posterFile)
                    .then(function (p) { return { media: media, poster: p }; })
                    .catch(function () { return { media: media, poster: null }; });
            })
            .then(function (out) {
                setState('Saved');

                if (isImage) {
                    // Caret lands in the caption slot, same as a dropped clip.
                    // Leave it empty and no figcaption renders.
                    insertBlock(':::image src="' + out.media.path + '" alt=""\n' +
                        CARET + '\n:::');
                    toast('Added ' + out.media.name + '.', 'good');
                    return;
                }

                var template = ':::clip src="' + out.media.path + '"' +
                    (out.poster ? ' poster="' + out.poster.path + '"' : '') +
                    '\n' + CARET + '\n:::';
                insertBlock(template);

                var path = out.media.path;
                toast('Added ' + out.media.name + (out.poster ? ' with a poster frame.' : '.'), 'good', {
                    label: 'Make it a silent loop',
                    act: function () {
                        // Only this clip: match the block that carries this src.
                        var pattern = ':::clip src="' + path + '"';
                        if (els.body.value.indexOf(pattern) === -1) return;
                        els.body.value = els.body.value.replace(pattern, ':::loop src="' + path + '"');
                        onEdit();
                    }
                });
            })
            .catch(function (e) {
                setState('Upload failed', 'error');
                toast('Couldn’t add ' + file.name + ': ' + e.message, 'bad');
            });
    }

    /* ---------- toasts & modal ---------- */

    function toast(message, kind, action) {
        var el = document.createElement('div');
        el.className = 'toast' + (kind ? ' ' + kind : '');

        var text = document.createElement('span');
        text.textContent = message;
        el.appendChild(text);

        if (action) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = action.label;
            btn.addEventListener('click', function () {
                action.act();
                el.remove();
            });
            el.appendChild(btn);
        }

        els.toasts.appendChild(el);
        setTimeout(function () { el.remove(); }, action ? 12000 : 6000);
    }

    function openModal(title, html, actions) {
        els.modalTitle.textContent = title;
        els.modalBody.innerHTML = html;
        els.modalActions.innerHTML = '';

        (actions || []).forEach(function (action) {
            var btn = document.createElement('button');
            btn.className = action.kind === 'primary' ? 'primary-btn' : 'ghost-btn';
            btn.innerHTML = action.label;
            btn.addEventListener('click', action.act);
            els.modalActions.appendChild(btn);
        });

        els.modal.hidden = false;
    }

    function closeModal() {
        els.modal.hidden = true;
    }

    function escapeHtml(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function escapeAttr(s) { return escapeHtml(s); }

    /* ---------- wiring ---------- */

    function onEdit() {
        schedulePreview();
        scheduleSave();
    }

    function bind() {
        META_KEYS.forEach(function (key) {
            var el = $('f-' + key);
            if (el) el.addEventListener('input', onEdit);
        });

        $('f-title').addEventListener('input', function () {
            if (doc && !doc.exists && !doc.slugLocked) {
                $('f-slug').value = slugify($('f-title').value);
            }
        });

        $('f-slug').addEventListener('input', function () {
            if (doc) doc.slugLocked = true;
        });

        $('f-slug').addEventListener('change', function () {
            if (!doc) return;
            if (doc.exists) maybeRename();
            else doc.slug = slugify($('f-slug').value);
        });

        els.body.addEventListener('input', function () {
            syncSlash();
            onEdit();
        });

        els.body.addEventListener('keydown', function (e) {
            if (slash) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    var items = slashMatches();
                    slash.index = (slash.index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
                    renderSlash();
                    return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault();
                    chooseSlash(slashMatches()[slash.index]);
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    closeSlash();
                    return;
                }
            }

            if (e.key === '/') {
                var caret = els.body.selectionStart;
                var prev = caret > 0 ? els.body.value.charAt(caret - 1) : '\n';
                // Only at the start of a word, so URLs and dates stay untouched.
                if (/[\s\n]/.test(prev) || caret === 0) {
                    setTimeout(function () { openSlash(caret); }, 0);
                }
            }
        });

        els.body.addEventListener('blur', closeSlash);
        els.body.addEventListener('scroll', function () { if (slash) renderSlash(); });

        document.querySelectorAll('#toolbar [data-mark]').forEach(function (btn) {
            btn.addEventListener('click', function () { applyMark(btn.dataset.mark); });
        });

        document.querySelectorAll('#toolbar [data-block]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var block = BLOCKS.filter(function (b) { return b.key === btn.dataset.block; })[0];
                if (block) insertBlock(block.template);
            });
        });

        $('savePost').addEventListener('click', function () { save({ loud: true }); });
        $('publishPost').addEventListener('click', publishFlow);
        $('newPost').addEventListener('click', newPost);

        $('toggleSidebar').addEventListener('click', function () {
            els.layout.classList.toggle('no-sidebar');
        });

        $('themeToggle').addEventListener('click', function () {
            previewDark = !previewDark;
            applyPreviewTheme();
        });

        els.modal.addEventListener('click', function (e) {
            if (e.target === els.modal) closeModal();
        });

        // Drag and drop, anywhere over the writing pane.
        ['dragenter', 'dragover'].forEach(function (type) {
            els.bodyWrap.addEventListener(type, function (e) {
                if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') === -1) return;
                e.preventDefault();
                els.bodyWrap.classList.add('dropping');
            });
        });

        ['dragleave', 'dragend'].forEach(function (type) {
            els.bodyWrap.addEventListener(type, function (e) {
                if (e.target !== els.bodyWrap && e.type === 'dragleave') return;
                els.bodyWrap.classList.remove('dropping');
            });
        });

        els.bodyWrap.addEventListener('drop', function (e) {
            if (!e.dataTransfer || !e.dataTransfer.files.length) return;
            e.preventDefault();
            els.bodyWrap.classList.remove('dropping');
            handleFiles(e.dataTransfer.files);
        });

        // The browser would otherwise navigate away and show the file.
        window.addEventListener('dragover', function (e) { e.preventDefault(); });
        window.addEventListener('drop', function (e) { e.preventDefault(); });

        document.addEventListener('keydown', function (e) {
            var mod = e.metaKey || e.ctrlKey;
            if (!mod) {
                if (e.key === 'Escape' && !els.modal.hidden) closeModal();
                return;
            }

            if (e.key === 's') { e.preventDefault(); save({ loud: true }); }
            else if (e.key === 'Enter') { e.preventDefault(); publishFlow(); }
            else if (e.key === 'b' && document.activeElement === els.body) { e.preventDefault(); applyMark('bold'); }
            else if (e.key === 'i' && document.activeElement === els.body) { e.preventDefault(); applyMark('italic'); }
            else if (e.key === 'k' && document.activeElement === els.body) { e.preventDefault(); applyMark('link'); }
            else if (e.key === 'Backspace' && e.shiftKey) { e.preventDefault(); deleteCurrent(); }
        });

        window.addEventListener('beforeunload', function (e) {
            if (!hasChanges()) return;
            e.preventDefault();
            e.returnValue = '';
        });
    }

    /* ---------- boot ---------- */

    function boot() {
        bind();

        request('/git/status')
            .then(function (status) {
                if (status && status.branch) els.branch.textContent = status.branch;
            })
            .catch(function () { /* no git, no badge */ });

        refreshPosts().then(function () {
            if (posts.length) {
                doc = blankDoc();
                openPost(posts[0].slug);
            } else {
                newPost();
            }
        });
    }

    boot();
})();
