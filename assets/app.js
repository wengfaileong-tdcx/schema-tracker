(function () {
  const D = window.SchemaDiff;
  const $ = id => document.getElementById(id);
  const esc = D.esc;

  let DATA = window.SCHEMA_HISTORY || { pages: [] };
  let SOURCE = 'sample';
  const RECENT_DAYS = 14;

  // Written verbatim into the "DiffId" column when a line comment is posted,
  // so the raw sheet row is readable without opening the dashboard.
  const DIFF_CODE = 'View code changes';
  const DIFF_FAQ = 'FAQ sync check';
  const DIFF_FAQ_STAGING = 'FAQ sync check (staging)';
  const DIFF_META = 'Metadata sync check';
  const DIFF_META_STAGING = 'Metadata sync check (staging)';

  /* ---------- helpers ---------- */

  const parseDate = s => {
    const d = new Date(s + 'T00:00:00');
    return isNaN(d) ? null : d;
  };
  const fmt = s => {
    const d = parseDate(s);
    if (!d) return s || '—';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const daysAgo = s => {
    const d = parseDate(s);
    if (!d) return Infinity;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  };

  // Versions newest first, whatever order they were written in.
  function ordered(page) {
    return (page.versions || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }

  // Not everything tracked is JSON-LD — an llms.txt is plain text, and has
  // to be printed, diffed and summarised as text rather than parsed.
  const isText = v => !!v && v.kind === 'text';
  const show = v => isText(v) ? String(v.schema) : D.pretty(v.schema, false);
  const cmpOpts = (v, extra) => Object.assign({ full: false, sort: true, context: 3, text: isText(v) }, extra || {});

  function summaryFor(page, i) {
    const vs = ordered(page);
    const cur = vs[i], prev = vs[i + 1];
    if (cur.summary && cur.summary.length) return cur.summary;
    const before = prev ? prev.schema : null;
    return isText(cur) ? D.summariseText(before, cur.schema) : D.summarise(before, cur.schema);
  }

  const cls = t => /^Added/.test(t) ? 'add'
    : /^Removed/.test(t) ? 'del'
      : /^Updated/.test(t) ? 'mod' : 'nil';

  const chgList = items =>
    '<ul class="chg">' + items.map(t => '<li class="' + cls(t) + '">' + esc(t) + '</li>').join('') + '</ul>';

  /* ---------- FAQ sync check (tracked FAQPage schema vs. live page) ---------- */

  // Finds an FAQPage node anywhere in a schema value, including inside @graph.
  function findFaqPage(schema) {
    if (!schema || typeof schema !== 'object') return null;
    const nodes = Array.isArray(schema) ? schema : schema['@graph'] ? schema['@graph'] : [schema];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n && [].concat(n['@type'] || []).indexOf('FAQPage') > -1) return n;
    }
    return null;
  }

  const trackedFaqPairs = faqPage => (faqPage.mainEntity || []).map(q => ({
    q: q.name || '',
    a: (q.acceptedAnswer && q.acceptedAnswer.text) || ''
  }));

  /* ---------- metadata sync check (head tags vs. schema) ---------- */

  // The node describing the page itself. Prefers WebPage, else any *Page.
  function findWebPage(schema) {
    if (!schema || typeof schema !== 'object') return null;
    const nodes = Array.isArray(schema) ? schema : schema['@graph'] ? schema['@graph'] : [schema];
    let fallback = null;
    for (let i = 0; i < nodes.length; i++) {
      const types = [].concat((nodes[i] && nodes[i]['@type']) || []);
      if (types.indexOf('WebPage') > -1) return nodes[i];
      if (!fallback && types.some(t => /Page$/.test(t))) fallback = nodes[i];
    }
    return fallback;
  }

  // Both sides are reduced to the same four fields so the diff reads as a
  // field-by-field comparison. A blank on the schema side is itself worth
  // seeing — it means the markup never declared that field.
  function metaFromSchema(schema) {
    const p = findWebPage(schema);
    if (!p) return null;
    return { title: p.name || '', description: p.description || '', canonical: p.url || '', lang: p.inLanguage || '' };
  }
  const metaFromLive = m => m
    ? { title: m.title || '', description: m.description || '', canonical: m.canonical || '', lang: m.lang || '' }
    : null;

  /* ---------- sync checks, live page vs. proposed schema ---------- */

  const SYNCS = [
    {
      key: 'faq',
      title: 'FAQ sync check with live site',
      hint: 'What is published on the page (left) vs. the proposed FAQPage schema from Google Sheet (right).',
      diffIds: { live: DIFF_FAQ, staging: DIFF_FAQ_STAGING },
      live: (page, which) => which === 'live' ? page.liveFaq : page.stagingFaq,
      fromSchema: schema => { const f = findFaqPage(schema); return f ? trackedFaqPairs(f) : null; }
    },
    {
      key: 'meta',
      title: 'Metadata sync check with live site',
      hint: 'The page’s own title, meta description, canonical and lang (left) vs. what the proposed schema says they should be (right).',
      diffIds: { live: DIFF_META, staging: DIFF_META_STAGING },
      live: (page, which) => metaFromLive(which === 'live' ? page.liveMeta : page.stagingMeta),
      fromSchema: metaFromSchema
    }
  ];

  const syncByKey = key => SYNCS.filter(s => s.key === key)[0];

  // Which published copies of a page we can compare against. Staging only
  // appears when the sheet has data for it.
  const syncSources = (spec, page) => [
    { id: 'live', label: 'Live site', diffId: spec.diffIds.live },
    { id: 'staging', label: 'Staging site', diffId: spec.diffIds.staging }
  ].map(s => Object.assign(s, { data: spec.live(page, s.id) }))
    .filter(s => s.data && (!Array.isArray(s.data) || s.data.length));

  function syncCompare(spec, page, proposed, source) {
    const r = D.compare(source.data, proposed, {
      full: false, sort: true, context: 3, labels: { left: source.label, right: 'Proposed' },
      commentOpts: { diffId: source.diffId, comments: commentsFor(page, source.diffId), canPost: canComment() }
    });
    const inSync = !r.error && !r.add && !r.del;
    return {
      status: r.error ? 'error' : inSync ? 'in sync' : 'out of sync',
      html: r.error ? '<div class="err">' + esc(r.error) + '</div>'
        : inSync ? '<div class="flat">No difference found.</div>' : r.html
    };
  }

  function syncBlock(spec, page, cur) {
    const proposed = spec.fromSchema(cur.schema);
    const sources = proposed ? syncSources(spec, page) : [];
    if (!sources.length) return '';
    const first = syncCompare(spec, page, proposed, sources[0]);

    const picker = sources.length > 1
      ? '<div class="foldbar"><span class="count">Compare against</span>' +
        '<select class="sync-src" style="width:auto">' +
        sources.map(s => '<option value="' + esc(s.id) + '">' + esc(s.label) + '</option>').join('') +
        '</select></div>'
      : '';

    // Starts collapsed like every other section — the status in the summary
    // already says whether it needs a look.
    return '<div class="block"><details class="fold sync-check" data-sync="' + esc(spec.key) + '"' +
      ' data-url="' + esc(page.url) + '">' +
      '<summary>' + esc(spec.title) + '<span class="count"> · <span class="sync-status">' +
      first.status + '</span></span></summary>' +
      '<div class="inner">' +
      '<p class="hint">' + spec.hint + '</p>' +
      picker + '<div class="synchost">' + first.html + '</div>' +
      '</div></details></div>';
  }

  /* ---------- shared bits of page metadata ---------- */

  // How many individual changes the newest version introduced. "Initial
  // version" and "No change" are statements about the diff, not a list of
  // edits, so they count as none.
  function changeCount(page) {
    const items = summaryFor(page, 0);
    if (items.length === 1 && /^(Initial version|No change)$/.test(items[0])) return 0;
    return items.length;
  }

  // The schema.org types a page declares, e.g. WebPage, FAQPage. Page-level
  // types come first: they say what the page *is*, which is more use at a
  // glance than the Offer or Brand nodes hanging off it.
  function schemaTypes(schema) {
    const out = [];
    const visit = v => {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v)) { v.forEach(visit); return; }
      [].concat(v['@type'] || []).forEach(t => { if (t && out.indexOf(t) < 0) out.push(t); });
      if (v['@graph']) visit(v['@graph']);
    };
    visit(schema);
    const isPage = t => /Page$/.test(t);
    return out.filter(isPage).concat(out.filter(t => !isPage(t)));
  }

  const pathOf = u => {
    const m = String(u || '').match(/^https?:\/\/[^/]+(\/.*)?$/);
    return m ? (m[1] || '/') : (u || '');
  };

  const changesPill = n =>
    '<span class="pill pill-chg">' + n + ' change' + (n === 1 ? '' : 's') + '</span>';

  // A text file has no @type, so name the file itself instead.
  const typePills = (v, url, max) => {
    const types = isText(v) ? [(pathOf(url).split('/').pop() || 'Text')] : schemaTypes(v.schema);
    return types.slice(0, max || 2)
      .map(t => '<span class="pill pill-type">' + esc(t) + '</span>').join('');
  };

  const extLink = url => /^https?:\/\//.test(url)
    ? '<a class="ext" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer"' +
      ' aria-label="Open page in a new tab" title="Open page in a new tab">' +
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2h8v8h-2V5.4L6.7 10.7 5.3 9.3 10.6 4H6V2z"/><path d="M2 4h3v2H4v6h6V9h2v5H2V4z"/></svg></a>'
    : '';

  /* ---------- render one page row ---------- */

  function pageRow(page, index) {
    const vs = ordered(page);
    if (!vs.length) return '';
    const cur = vs[0];
    const recent = daysAgo(cur.date) <= RECENT_DAYS;
    const items = summaryFor(page, 0);
    const st = (page.status || '').toLowerCase();

    let h = '<details class="page" data-url="' + esc(page.url) + '">';
    h += '<summary>';
    h += '<span class="p-num">' + (index + 1) + '</span>';
    h += '<div class="p-main">';
    h += '<div class="u">' + esc(page.url) + extLink(page.url) + '</div>';
    h += '<div class="line2">';
    h += '<span>Current version <b>' + esc(cur.version) + '</b></span>';
    h += '<span>Last updated <b>' + esc(fmt(cur.date)) + '</b></span>';
    if (page.status) h += '<span class="badge ' + (st === 'live' ? 'live' : st === 'draft' ? 'draft' : '') + '">' + esc(page.status) + '</span>';
    if (recent) h += '<span class="badge new">Updated recently</span>';
    h += '</div>';
    h += '<div class="latest">' + esc(items.slice(0, 2).join(', ')) +
      (items.length > 2 ? ' + ' + (items.length - 2) + ' more changes…' : '') + '</div>';
    h += '</div>';
    h += '<span class="p-right">' + changesPill(changeCount(page)) + '<span class="chev"></span></span>';
    h += '</summary>';

    h += '<div class="body">';

    /* 1. code diff */
    h += '<div class="block">';
    if (vs.length > 1) {
      h += '<details class="fold" data-diff="' + esc(page.url) + '">' +
        '<summary>View code changes</summary><div class="inner">' +
        '<div class="foldbar"><span class="count">' + esc(vs[1].version) + ' → ' + esc(cur.version) + '</span>' +
        '<span class="spacer"></span>' +
        '<button class="mini toggle-full" type="button" data-full="0">Show full code</button></div>' +
        '<div class="diffhost"></div></div></details>';
    } else {
      h += '<div class="flat">Only one version recorded, so there is nothing to compare yet.</div>';
    }
    h += '</div>';

    /* 1b. sync checks — each appears only where the schema declares the
       thing being checked and the sheet has live data to check it against */
    SYNCS.forEach(spec => { h += syncBlock(spec, page, cur); });

    /* 2. full current schema */
    h += '<div class="block">' +
      '<details class="fold" data-schema="' + esc(page.url) + '">' +
      '<summary>View current schema</summary><div class="inner">' +
      '<div class="foldbar"><span class="count">' + esc(cur.version) + ' · live now</span>' +
      '<span class="spacer"></span>' +
      '<button class="mini copy-schema" type="button">Copy schema</button></div>' +
      '<pre class="code">' + esc(show(cur)) + '</pre>' +
      '</div></details></div>';

    /* 3. compare any two versions */
    if (vs.length > 2) {
      h += '<div class="block"><details class="fold" data-ab="1">' +
        '<summary>Compare any two versions</summary><div class="inner">' +
        '<div class="foldbar">' +
        '<span class="count">From</span>' + sel(vs, 'ab-from', vs.length - 1) +
        '<span class="count">to</span>' + sel(vs, 'ab-to', 0) +
        '<span class="spacer"></span>' +
        '<button class="mini ab-go" type="button">Compare</button></div>' +
        '<div class="abhost"></div></div></details></div>';
    }

    /* 4. latest change summary */
    h += '<div class="block"><details class="fold">' +
      '<summary>Latest change summary<span class="count"> · ' +
      items.length + ' item' + (items.length === 1 ? '' : 's') + '</span></summary>' +
      '<div class="inner">' + chgList(items) + '</div></details></div>';

    /* 5. version history */
    h += '<div class="block"><details class="fold">' +
      '<summary>Version history<span class="count"> · ' +
      vs.length + ' version' + (vs.length === 1 ? '' : 's') + '</span></summary>' +
      '<div class="inner"><ol class="vh">';
    vs.forEach((v, i) => {
      const s = summaryFor(page, i);
      h += '<li>' +
        '<button class="v" type="button" aria-expanded="false" data-i="' + i + '">' +
        '<span class="vn">' + esc(v.version) + '</span>' +
        '<span class="vd">' + esc(fmt(v.date)) + '</span>' +
        '<span class="vs">' + esc(s.slice(0, 2).join(' · ')) +
        (s.length > 2 ? ' · +' + (s.length - 2) + ' more' : '') + '</span>' +
        '</button><div class="vdetail" hidden></div></li>';
    });
    h += '</ol></div></details></div>';

    return h + '</div></details>';
  }

  const sel = (vs, cl, def) =>
    '<select class="' + cl + '" style="width:auto">' +
    vs.map((v, i) => '<option value="' + i + '"' + (i === def ? ' selected' : '') + '>' +
      esc(v.version) + ' — ' + esc(fmt(v.date)) + '</option>').join('') + '</select>';

  /* ---------- latest changes feed ---------- */

  const FEED_PREVIEW = 8;

  // The pages that changed in the most recent batch, newest first.
  function latestBatch() {
    const rows = DATA.pages
      .filter(p => (p.versions || []).length)
      .map(p => ({ page: p, cur: ordered(p)[0] }))
      .filter(r => r.cur.date)
      .sort((a, b) => b.cur.date.localeCompare(a.cur.date));
    if (!rows.length) return { date: '', rows: [] };
    const newest = rows[0].cur.date;
    return { date: newest, rows: rows.filter(r => r.cur.date === newest) };
  }

  const ICON = {
    doc: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2h6l4 4v12H5V2zm6 1.5V7h3.5L11 3.5z"/></svg>',
    code: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.4 5.6 3 10l4.4 4.4 1.4-1.4L5.8 10l3-3-1.4-1.4zm5.2 0L11.2 7l3 3-3 3 1.4 1.4L17 10l-4.4-4.4z"/></svg>',
    cal: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 2v2H4v14h12V4h-2V2h-2v2H8V2H6zm10 6v8H4V8h12z"/></svg>'
  };

  function heroBand() {
    const batch = latestBatch();
    if (!batch.rows.length) return '';
    const urls = batch.rows.length;
    const changes = batch.rows.reduce((n, r) => n + changeCount(r.page), 0);
    const tile = (icon, value, label) =>
      '<div class="tile"><span class="tile-i">' + icon + '</span>' +
      '<span class="tile-v">' + esc(value) + '</span>' +
      '<span class="tile-l">' + esc(label) + '</span></div>';

    return '<section class="hero">' +
      '<div class="hero-main"><span class="hero-i">' + ICON.doc + '</span>' +
      '<div><h2 class="hero-h">Latest schema changes</h2>' +
      '<p class="hero-sub">' + urls + ' URL' + (urls === 1 ? '' : 's') + ' updated on <b>' + esc(fmt(batch.date)) + '</b></p>' +
      '<p class="hero-hint">Review the changes below. Click any URL to jump to its section.</p></div></div>' +
      '<div class="hero-tiles">' +
      tile(ICON.doc, String(urls), 'URLs changed') +
      tile(ICON.code, String(changes), 'Schema changes') +
      tile(ICON.cal, fmt(batch.date), 'Latest update') +
      '</div></section>';
  }

  // A jump index into the reviews below: the first few changed URLs, with the
  // rest a click away.
  function recentFeed() {
    const batch = latestBatch();
    const total = batch.rows.length;
    if (!total) return '';
    const shown = Math.min(FEED_PREVIEW, total);

    const items = batch.rows.map((r, i) => {
      const hidden = i >= FEED_PREVIEW;
      return '<li class="rf-item' + (hidden ? ' rf-extra' : '') + '"' + (hidden ? ' hidden' : '') +
        ' data-url="' + esc(r.page.url) + '">' +
        '<button type="button" class="rf-open">' +
        '<span class="rf-n">' + (i + 1) + '</span>' +
        '<span class="rf-t">' + esc(r.page.title || pathOf(r.page.url)) + '</span>' +
        '<span class="rf-u">' + esc(pathOf(r.page.url)) + '</span>' +
        '<span class="rf-pills">' + changesPill(changeCount(r.page)) + typePills(r.cur, r.page.url, 2) + '</span>' +
        '<span class="rf-d">' + esc(fmt(r.cur.date)) + '</span>' +
        '<span class="chev"></span>' +
        '</button></li>';
    }).join('');

    const rest = total - shown;
    return '<section class="rf">' +
      '<div class="rf-head"><h2 class="rf-h">Recent changed URLs</h2>' +
      (total > FEED_PREVIEW
        ? '<span class="rf-showing">Showing ' + shown + ' of ' + total + '</span>' +
          '<button type="button" class="rf-toggle btn-ghost" data-total="' + total + '" data-preview="' + FEED_PREVIEW + '">' +
          'View all ' + total + '<span class="chev chev-r"></span></button>'
        : '<span class="rf-showing">' + total + ' URL' + (total === 1 ? '' : 's') + '</span>') +
      '</div>' +
      '<ul class="rf-list">' + items + '</ul>' +
      (total > FEED_PREVIEW
        ? '<div class="rf-foot"><button type="button" class="rf-toggle rf-more" data-total="' + total +
          '" data-preview="' + FEED_PREVIEW + '">Show ' + rest + ' more URL' + (rest === 1 ? '' : 's') +
          '<span class="chev"></span></button></div>'
        : '') +
      '</section>';
  }

  function drawRecent() {
    $('recent').innerHTML = recentFeed();
  }

  document.addEventListener('click', function (e) {
    /* expand or collapse the rest of the index (two buttons, kept in sync) */
    const toggle = e.target.closest('.rf-toggle');
    if (toggle) {
      const wrap = toggle.closest('.rf');
      const total = +toggle.dataset.total, preview = +toggle.dataset.preview;
      const open = wrap.dataset.open === '1';
      const rest = total - Math.min(preview, total);
      wrap.querySelectorAll('.rf-extra').forEach(li => { li.hidden = open; });
      wrap.dataset.open = open ? '0' : '1';
      wrap.querySelector('.rf-showing').textContent =
        'Showing ' + (open ? Math.min(preview, total) : total) + ' of ' + total;
      const top = wrap.querySelector('.btn-ghost');
      if (top) top.innerHTML = (open ? 'View all ' + total : 'Show fewer') + '<span class="chev chev-r"></span>';
      const more = wrap.querySelector('.rf-more');
      if (more) more.innerHTML = (open ? 'Show ' + rest + ' more URL' + (rest === 1 ? '' : 's') : 'Show fewer') +
        '<span class="chev"></span>';
      return;
    }

    /* jump to a page's review section */
    const item = e.target.closest('.rf-item');
    if (!item) return;
    const details = document.querySelector('#list details.page[data-url="' + CSS.escape(item.dataset.url) + '"]');
    if (!details) return;
    details.open = true;
    const diffFold = details.querySelector('details.fold[data-diff]');
    if (diffFold) diffFold.open = true;
    details.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  /* ---------- list ---------- */

  function draw() {
    const q = $('q').value.trim().toLowerCase();
    const order = $('sort').value;

    let pages = DATA.pages.filter(p => (p.versions || []).length);
    if (q) pages = pages.filter(p =>
      (p.url + ' ' + (p.title || '')).toLowerCase().indexOf(q) > -1);

    pages = pages.slice().sort((a, b) => {
      if (order === 'url') return a.url.localeCompare(b.url);
      const da = ordered(a)[0].date || '', db = ordered(b)[0].date || '';
      return order === 'oldest' ? da.localeCompare(db) : db.localeCompare(da);
    });

    $('count').textContent = pages.length + ' of ' + DATA.pages.length + ' pages';
    $('list').innerHTML = pages.length
      ? pages.map(pageRow).join('')
      : '<div class="empty">No page matches “' + esc($('q').value) + '”.</div>';
  }

  /* ---------- lazy diff rendering ---------- */

  const pageByUrl = u => DATA.pages.filter(p => p.url === u)[0];

  const canComment = () => !!(window.SchemaApp && window.SchemaApp.onPostComment);
  const commentsFor = (page, diffId) => (page.lineComments && page.lineComments[diffId]) || {};

  /* ---------- highlight-to-comment inside a diff ---------- */

  // Reveal the comment icon on whichever rows the current text selection
  // touches, so highlighting part of the code offers to comment on it.
  function markSelectedRows() {
    document.querySelectorAll('.row.sel-hit').forEach(r => r.classList.remove('sel-hit'));
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const host = (node.nodeType === 3 ? node.parentElement : node).closest('.diff');
    if (!host) return;
    host.querySelectorAll('.row').forEach(row => {
      if (range.intersectsNode(row)) row.classList.add('sel-hit');
    });
  }

  document.addEventListener('mouseup', () => setTimeout(markSelectedRows, 0));
  document.addEventListener('keyup', e => { if (e.shiftKey || e.key === 'Escape') markSelectedRows(); });

  // The text currently selected within this row, if any — that's what a
  // comment posted from this row should quote.
  function selectionWithin(row) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return '';
    const range = sel.getRangeAt(0);
    return range.intersectsNode(row) ? sel.toString().trim() : '';
  }

  function renderDiffInto(host, prevV, curV, full, commentOpts) {
    const r = D.compare(prevV.schema, curV.schema,
      cmpOpts(curV, { full: full, commentOpts: commentOpts }));
    host.innerHTML = r.error ? '<div class="err">' + esc(r.error) + '</div>' : r.html;
  }

  document.addEventListener('toggle', function (e) {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.open) return;

    if (d.dataset.diff) {
      const host = d.querySelector('.diffhost');
      if (host && !host.dataset.done) {
        const page = pageByUrl(d.dataset.diff);
        const vs = ordered(page);
        renderDiffInto(host, vs[1], vs[0], false,
          { diffId: DIFF_CODE, comments: commentsFor(page, DIFF_CODE), canPost: canComment() });
        host.dataset.done = '1';
      }
    }
  }, true);

  document.addEventListener('click', function (e) {
    const t = e.target;

    /* full-code toggle inside a diff */
    if (t.classList.contains('toggle-full')) {
      const fold = t.closest('.fold');
      const page = pageByUrl(fold.dataset.diff);
      const vs = ordered(page);
      const on = t.dataset.full === '1' ? 0 : 1;
      t.dataset.full = on;
      t.textContent = on ? 'Show changes only' : 'Show full code';
      renderDiffInto(fold.querySelector('.diffhost'), vs[1], vs[0], !!on,
        { diffId: DIFF_CODE, comments: commentsFor(page, DIFF_CODE), canPost: canComment() });
      return;
    }

    /* copy current schema */
    if (t.classList.contains('copy-schema')) {
      const pre = t.closest('.inner').querySelector('pre.code');
      const done = ok => {
        t.textContent = ok ? 'Copied' : 'Press Ctrl+C';
        setTimeout(() => { t.textContent = 'Copy schema'; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(pre.textContent).then(() => done(true), () => fallback());
      } else fallback();
      function fallback() {
        // file:// in some browsers has no async clipboard; select the text instead.
        const r = document.createRange();
        r.selectNodeContents(pre);
        const s = window.getSelection();
        s.removeAllRanges(); s.addRange(r);
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        done(ok);
      }
      return;
    }

    /* open a line's comment panel, quoting whatever is highlighted on it */
    const lnBtn = t.closest('.ln-cm-btn');
    if (lnBtn) {
      const row = lnBtn.closest('.row');
      const snippet = selectionWithin(row);
      let panel = row.nextElementSibling;
      if (!panel || !panel.classList.contains('ln-cm-panel')) {
        // No comments on this line yet, so no panel was rendered — make one.
        row.insertAdjacentHTML('afterend',
          D.commentPanel(lnBtn.dataset.diffId, lnBtn.dataset.lineKey, [], canComment()));
        panel = row.nextElementSibling;
      }
      panel.hidden = !panel.hidden;
      const quote = panel.querySelector('.ln-cm-quote');
      if (quote) {
        // Whatever is posted records the line it refers to, but only an
        // actual highlight is worth quoting back: the line itself is right
        // above the panel, so repeating it just adds a block to read past.
        const cellTexts = [].slice.call(row.querySelectorAll('.cell .tx')).map(x => x.textContent.trim());
        const lineText = cellTexts.length > 1 && cellTexts[0] !== cellTexts[1]
          ? cellTexts[0] + '  →  ' + cellTexts[1]
          : (cellTexts[0] || cellTexts[1] || '');
        panel.dataset.snippet = snippet || lineText;
        quote.textContent = snippet;
        panel.querySelector('.cm-on').hidden = !snippet;
      }
      if (!panel.hidden) {
        const body = panel.querySelector('.cm-body');
        if (body) body.focus();
      }
      return;
    }

    /* post a line comment */
    if (t.classList.contains('ln-cm-post')) {
      const panel = t.closest('.ln-cm-panel');
      const nameEl = panel.querySelector('.cm-name'), bodyEl = panel.querySelector('.cm-body'), msg = panel.querySelector('.ln-cm-msg');
      const name = nameEl.value.trim(), text = bodyEl.value.trim();
      if (!name || !text) { msg.textContent = 'Enter your name and a comment.'; return; }
      const page = t.closest('.page');
      const url = page ? page.dataset.url : '';
      const diffId = panel.dataset.diffId, lineKey = panel.dataset.lineKey;
      const row = panel.previousElementSibling;
      const context = panel.dataset.snippet || '';
      msg.textContent = 'Posting…';
      t.disabled = true;
      window.SchemaApp.onPostComment({ url: url, diffId: diffId, lineKey: lineKey, context: context, name: name, text: text }, function (err, entry) {
        t.disabled = false;
        if (err) { msg.textContent = 'Could not post: ' + err.message; return; }
        const list = panel.querySelector('.cm-list');
        // Rendered by the same helper the panel uses, so a comment looks the
        // same whether it just arrived or came back from the sheet.
        list.insertAdjacentHTML('beforeend', D.commentItem({
          name: entry.name, text: entry.text, ts: entry.ts, context: context
        }));
        const n = list.querySelectorAll('.cm-item').length;
        panel.querySelector('.cm-head').textContent = n + ' comment' + (n === 1 ? '' : 's') + ' on this line';
        const cmBtn = row && row.querySelector('.ln-cm-btn');
        if (cmBtn) {
          cmBtn.classList.add('has-cm');
          cmBtn.classList.remove('all-done');
          const countEl = cmBtn.querySelector('.ln-cm-count');
          if (countEl) countEl.textContent = n;
          else cmBtn.insertAdjacentHTML('beforeend', '<span class="ln-cm-count">' + n + '</span>');
        }
        nameEl.value = ''; bodyEl.value = ''; msg.textContent = 'Posted.';
      });
      return;
    }

    /* version history row */
    const vbtn = t.closest('button.v');
    if (vbtn) {
      const box = vbtn.nextElementSibling;
      const open = vbtn.getAttribute('aria-expanded') === 'true';
      vbtn.setAttribute('aria-expanded', String(!open));
      box.hidden = open;
      if (open || box.dataset.done) return;

      const page = pageByUrl(vbtn.closest('.page').dataset.url);
      const vs = ordered(page);
      const i = +vbtn.dataset.i;
      const v = vs[i], prev = vs[i + 1];

      let h = chgList(summaryFor(page, i));
      if (v.note) h += '<p class="flat" style="margin-top:9px">' + esc(v.note) + '</p>';
      h += '<details class="fold"><summary>View schema for ' + esc(v.version) + '</summary>' +
        '<div class="inner"><pre class="code">' + esc(show(v)) + '</pre></div></details>';
      if (prev) {
        const r = D.compare(prev.schema, v.schema, cmpOpts(v));
        h += '<details class="fold"><summary>Compare with ' + esc(prev.version) + '</summary>' +
          '<div class="inner">' + (r.error ? '<div class="err">' + esc(r.error) + '</div>' : r.html) +
          '</div></details>';
      }
      box.innerHTML = h;
      box.dataset.done = '1';
      return;
    }

    /* compare A -> B */
    if (t.classList.contains('ab-go')) {
      const fold = t.closest('.fold');
      const vs = ordered(pageByUrl(t.closest('.page').dataset.url));
      const a = +fold.querySelector('.ab-from').value;
      const b = +fold.querySelector('.ab-to').value;
      const host = fold.querySelector('.abhost');
      if (a === b) { host.innerHTML = '<div class="flat">Pick two different versions.</div>'; return; }
      const older = Math.max(a, b), newer = Math.min(a, b);
      const r = D.compare(vs[older].schema, vs[newer].schema, cmpOpts(vs[newer]));
      host.innerHTML = '<p class="count" style="padding:0 0 7px">' +
        esc(vs[older].version) + ' → ' + esc(vs[newer].version) + '</p>' +
        (r.error ? '<div class="err">' + esc(r.error) + '</div>' : r.html);
    }
  });

  /* switch a sync check between the live and staging page */
  document.addEventListener('change', function (e) {
    if (!e.target.classList.contains('sync-src')) return;
    const fold = e.target.closest('.sync-check');
    const spec = syncByKey(fold.dataset.sync);
    const page = pageByUrl(fold.dataset.url);
    if (!spec || !page) return;
    const proposed = spec.fromSchema(ordered(page)[0].schema);
    const source = syncSources(spec, page).filter(s => s.id === e.target.value)[0];
    if (!proposed || !source) return;
    const out = syncCompare(spec, page, proposed, source);
    fold.querySelector('.synchost').innerHTML = out.html;
    fold.querySelector('.sync-status').textContent = out.status;
  });

  /* ---------- boot ---------- */

  $('q').addEventListener('input', draw);
  $('sort').addEventListener('change', draw);
  $('expand').addEventListener('click', function () {
    const all = document.querySelectorAll('#list details.page');
    const anyClosed = [].slice.call(all).some(d => !d.open);
    all.forEach(d => { d.open = anyClosed; });
    this.textContent = anyClosed ? 'Collapse all' : 'Expand all';
  });

  /* ---------- the staging grabber, offered where the team will find it ----------
     A bookmarklet has to live in each person's own browser, so rather than
     passing the source around, the dashboard hands it out: drag the link to
     the bookmarks bar. Kept as a JS string and assigned to .href so none of
     its quotes or ampersands need HTML-escaping. */

  const GRAB_BOOKMARKLET = "javascript:(function(){var f=[].slice.call(document.querySelectorAll('h3 button[aria-controls]')).map(function(b){var s=b.querySelector('span'),d=document.getElementById(b.getAttribute('aria-controls'));if(!s||!d)return null;return{q:s.textContent.replace(/\\s+/g,' ').trim(),a:d.textContent.replace(/\\s+/g,' ').trim()}}).filter(function(x){return x&&x.q&&x.a});var g=function(s,a){var e=document.querySelector(s);return e?String(e[a]||e.getAttribute(a)||'').replace(/\\s+/g,' ').trim():''};var m={title:(document.title||'').replace(/\\s+/g,' ').trim(),description:g('meta[name=\"description\"]','content'),canonical:g('link[rel=\"canonical\"]','href'),lang:(document.documentElement.getAttribute('lang')||'').trim(),ogTitle:g('meta[property=\"og:title\"]','content'),ogDescription:g('meta[property=\"og:description\"]','content')};if(!f.length&&!m.title){alert('Nothing found on this page. The markup may have changed.');return}var p=(f.length?JSON.stringify(f):'')+'\\t'+JSON.stringify(m);var ok=function(){alert('Copied '+f.length+' FAQ items and the page metadata.\\n\\nIn the sheet, click this page’s Staging FAQ cell and paste — it fills Staging FAQ and Staging Meta together.')};var ask=function(){window.prompt('Copy this (Cmd+C), then paste into the Staging FAQ cell:',p)};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(p).then(ok,ask)}else{ask()}})();";

  function drawTools() {
    $('tools').innerHTML =
      '<details class="tools"><summary>Set up the staging grabber</summary>' +
      '<div class="tools-b">' +
      '<p class="hint">Staging sits behind the VPN, so the sheet’s formulas can’t reach it — ' +
      'it has to be copied from a browser that can. Each person installs this once, in their own browser.</p>' +
      '<p class="tools-drag"><b>Drag this to your bookmarks bar:</b> ' +
      '<a class="grab-link" href="#">Grab page data</a>' +
      '<button type="button" class="mini grab-copy">Copy instead</button>' +
      '<span class="count grab-msg"></span></p>' +
      '<p class="hint">Then open a staging page, click the bookmark, and paste into that page’s ' +
      '<b>Staging FAQ</b> cell — it fills Staging Meta beside it.</p>' +
      '</div></details>';
    $('tools').querySelector('.grab-link').href = GRAB_BOOKMARKLET;
  }

  document.addEventListener('click', function (e) {
    // Clicking would run the grabber against the dashboard itself, which is
    // never what someone means — they meant to drag it.
    const link = e.target.closest('.grab-link');
    if (link) {
      e.preventDefault();
      link.closest('.tools-b').querySelector('.grab-msg').textContent =
        'Drag it to your bookmarks bar rather than clicking, or use Copy instead.';
      return;
    }
    if (e.target.classList.contains('grab-copy')) {
      const msg = e.target.closest('.tools-b').querySelector('.grab-msg');
      const done = ok => { msg.textContent = ok ? 'Copied — paste it as a new bookmark’s URL.' : 'Could not copy automatically.'; };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(GRAB_BOOKMARKLET).then(() => done(true), () => done(false));
      } else done(false);
    }
  });

  /* back to top — a long diff leaves the index far out of reach */
  const toTop = $('totop');
  const showToTop = () => { toTop.hidden = window.pageYOffset < 400; };
  window.addEventListener('scroll', showToTop, { passive: true });
  toTop.addEventListener('click', function () {
    const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: still ? 'auto' : 'smooth' });
  });
  showToTop();

  function drawBanner() {
    // When a sheet is connected the header's status card already says so, and
    // a second banner just adds noise — only warn about sample data.
    if (SOURCE === 'sheet') { $('banner').innerHTML = ''; return; }
    const hasSheet = window.SHEET_CONFIG && window.SHEET_CONFIG.enabled;
    $('banner').innerHTML = '<div class="src-banner src-sample">' +
      'Showing sample data, not real schema history.' +
      (hasSheet ? ' Use <b>Connect Google Sheet</b> above to load the real thing.' : '') +
      '</div>';
  }

  function renderAll() {
    $('site').textContent = DATA.site || '';
    const allDates = DATA.pages.reduce((a, p) => a.concat((p.versions || []).map(v => v.date)), []).sort();
    $('stamp').textContent = allDates.length ? 'Most recent change ' + fmt(allDates[allDates.length - 1]) : '';
    drawBanner();
    $('hero').innerHTML = heroBand();
    drawRecent();
    draw();
    drawTools();
  }

  // Lets an external loader (e.g. assets/sheet-loader.js) swap in fresh data
  // without a page reload, and report its connection state into the header.
  window.SchemaApp = {
    setData: function (data, source) { DATA = data || { pages: [] }; SOURCE = source || 'sample'; renderAll(); },
    // state: 'idle' | 'busy' | 'ok' | 'error'
    setConnection: function (info) {
      const c = info || {};
      $('conn').dataset.state = c.state || 'idle';
      $('conn-title').textContent = c.title || 'Not connected';
      $('conn-sub').textContent = c.sub || '';
      // Shown in full on hover, since the line is clipped unless it's an error.
      $('conn-sub').title = c.sub || '';
    }
  };

  renderAll();
})();
