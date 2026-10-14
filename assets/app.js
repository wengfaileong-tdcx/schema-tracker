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

  // Every typed node in a schema value, shallowest first: across several
  // <script> blocks, inside each block's @graph, and nested under other nodes
  // (an FAQPage hanging off a WebPage's mainEntity, say).
  function schemaNodes(schema) {
    const out = [], queue = [schema];
    while (queue.length) {
      const v = queue.shift();
      if (!v || typeof v !== 'object') continue;
      if (Array.isArray(v)) { queue.push.apply(queue, v); continue; }
      if (v['@type']) out.push(v);
      Object.keys(v).forEach(k => { if (v[k] && typeof v[k] === 'object') queue.push(v[k]); });
    }
    return out;
  }
  const typesOf = n => [].concat(n['@type'] || []);

  function findFaqPage(schema) {
    return schemaNodes(schema).filter(n => typesOf(n).indexOf('FAQPage') > -1)[0] || null;
  }

  const trackedFaqPairs = faqPage => (faqPage.mainEntity || []).map(q => ({
    q: q.name || '',
    a: (q.acceptedAnswer && q.acceptedAnswer.text) || ''
  }));

  /* ---------- metadata sync check (head tags vs. schema) ---------- */

  // The node describing the page itself. Prefers WebPage, else any *Page.
  function findWebPage(schema) {
    const nodes = schemaNodes(schema);
    return nodes.filter(n => typesOf(n).indexOf('WebPage') > -1)[0] ||
      nodes.filter(n => typesOf(n).some(t => /Page$/.test(t)))[0] || null;
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
      hint: 'What is published on the page (left) vs. the FAQPage in the proposed schema (right).',
      diffIds: { live: DIFF_FAQ, staging: DIFF_FAQ_STAGING },
      live: (page, which) => which === 'live' ? page.liveFaq : page.stagingFaq,
      fromSchema: schema => { const f = findFaqPage(schema); return f ? trackedFaqPairs(f) : null; },
      column: 'Live FAQ', formula: 'LIVE_FAQ', declares: 'an FAQPage block'
    },
    {
      key: 'meta',
      title: 'Metadata sync check with live site',
      hint: 'The page’s own title, meta description, canonical and lang (left) vs. what the WebPage in the proposed schema says they should be (right).',
      diffIds: { live: DIFF_META, staging: DIFF_META_STAGING },
      live: (page, which) => metaFromLive(which === 'live' ? page.liveMeta : page.stagingMeta),
      fromSchema: metaFromSchema,
      column: 'Live Meta', formula: 'LIVE_META', declares: 'a WebPage block'
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

  // What the live page is checked against. With proposedTab set, that is
  // always the newest version in that tab (attached by the sheet loader),
  // never just whichever tab happens to be on screen.
  function proposedFor(page) {
    if (page.proposed) return page.proposed;
    if (page.proposedMissing) return null;
    const cur = ordered(page)[0];
    return { schema: cur.schema, date: cur.date, tab: '' };
  }
  const proposedNote = p => '<p class="hint">Proposed = latest version in ' +
    (p.tab ? 'the <b>' + esc(p.tab) + '</b> tab' : 'this tab') + ', dated <b>' + esc(fmt(p.date)) + '</b>.</p>';

  function syncBlock(spec, page, cur) {
    const prop = proposedFor(page);
    if (!prop) {
      // Only worth flagging where the page does declare the thing checked.
      if (!spec.fromSchema(cur.schema)) return '';
      return '<div class="block"><details class="fold sync-check sync-todo">' +
        '<summary>' + esc(spec.title) + '<span class="count"> · no proposed schema</span></summary>' +
        '<div class="inner"><p class="hint">' + esc(page.proposedMissing) + '</p></div></details></div>';
    }

    // Nothing declared in the schema means there is genuinely nothing to
    // check here, so stay quiet.
    const proposed = spec.fromSchema(prop.schema);
    if (!proposed) return '';

    // Declared but with nothing to compare against is a gap in the sheet, not
    // an absence of work — say so, rather than vanishing and leaving someone
    // wondering where the check went.
    const sources = syncSources(spec, page);
    if (!sources.length) {
      return '<div class="block"><details class="fold sync-check sync-todo">' +
        '<summary>' + esc(spec.title) + '<span class="count"> · not set up</span></summary>' +
        '<div class="inner"><p class="hint">This page’s schema declares ' + esc(spec.declares) +
        ', but the sheet has nothing live to compare it against yet.</p>' +
        '<p class="hint">In the <b>' + esc(window.SHEET_CONFIG && window.SHEET_CONFIG.faqTab || 'FAQ Live') +
        '</b> tab, add a <b>' + esc(spec.column) + '</b> column and put ' +
        '<code>=' + esc(spec.formula) + '("' + esc(page.url) + '")</code> on this URL’s row, ' +
        'then Reconnect.</p>' +
        '</div></details></div>';
    }
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
      '<p class="hint">' + spec.hint + '</p>' + proposedNote(prop) +
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

  /* ---------- editing the current schema ---------- */

  // Only offered on data that came from the sheet, since that's where an
  // edit is written back to.
  const canEdit = () => SOURCE === 'sheet' && !!(window.SchemaApp && window.SchemaApp.onSaveSchema);

  const todayIso = () => {
    const d = new Date(), p = n => (n < 10 ? '0' : '') + n;
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  };

  function editPanel(cur) {
    const sameDay = cur.date === todayIso();
    return '<div class="sch-edit" hidden>' +
      '<p class="hint">Editing the ' + esc(fmt(cur.date)) + ' version. Saving writes straight to the Google Sheet.</p>' +
      '<textarea class="sch-text" spellcheck="false" aria-label="Schema markup"></textarea>' +
      '<div class="controls sch-bar">' +
      '<button class="primary sch-save" type="button" data-mode="new"' + (sameDay ? ' disabled' : '') + '>' +
      'Save as new version (' + esc(fmt(todayIso())) + ')</button>' +
      '<button class="sch-save" type="button" data-mode="fix">Fix current version (' + esc(fmt(cur.date)) + ')</button>' +
      '<button class="mini sch-cancel" type="button">Cancel</button>' +
      '<span class="count sch-msg" role="status">' +
      (sameDay ? 'Today\'s version already exists, so only "Fix current version" is available.' : '') + '</span>' +
      '</div></div>';
  }

  // Same rule the sheet loader applies: text that opens like markup has to
  // parse, anything else is kept as plain text.
  function checkEdit(cur, text) {
    if (!text) return 'The schema can\'t be empty.';
    if (text.length > 50000) return 'Google Sheets cells hold at most 50,000 characters.';
    const markup = /^[[{]|^<script/i.test(text);
    if (!isText(cur) && !markup) return 'This page\'s schema is JSON-LD, so it has to start with {, [ or <script.';
    if (markup) {
      const r = D.parse(text);
      if (r.error) return 'Not valid JSON: ' + r.error;
    }
    return '';
  }

  // After a save the whole list re-renders from the sheet, so reopen the
  // page that was edited and show its new diff.
  function reopen(url) {
    const details = document.querySelector('#list details.page[data-url="' + CSS.escape(url) + '"]');
    if (!details) return;
    details.open = true;
    const fold = details.querySelector('details.fold[data-diff]');
    if (fold) fold.open = true;
    details.scrollIntoView({ block: 'start' });
  }

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
        (canEdit() ? '<button class="mini edit-schema" type="button">Edit schema</button>' : '') +
        '<button class="mini toggle-full" type="button" data-full="0">Show full code</button></div>' +
        (canEdit() ? editPanel(cur) : '') +
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

    /* open / close the schema editor */
    if (t.classList.contains('edit-schema') || t.classList.contains('sch-cancel')) {
      const fold = t.closest('.fold');
      const panel = fold.querySelector('.sch-edit');
      const opening = panel.hidden;
      if (opening) {
        const cur = ordered(pageByUrl(fold.dataset.diff))[0];
        // The cell's own text, so a <script> wrapper or the original
        // formatting survives an edit untouched.
        panel.querySelector('.sch-text').value = cur.raw != null ? cur.raw : show(cur);
      }
      panel.hidden = !opening;
      fold.querySelector('.edit-schema').textContent = opening ? 'Close editor' : 'Edit schema';
      if (opening) panel.querySelector('.sch-text').focus();
      return;
    }

    /* save an edited schema back to the sheet */
    if (t.classList.contains('sch-save')) {
      const fold = t.closest('.fold');
      const panel = t.closest('.sch-edit');
      const msg = panel.querySelector('.sch-msg');
      const page = pageByUrl(fold.dataset.diff);
      const cur = ordered(page)[0];
      const text = panel.querySelector('.sch-text').value.trim();
      const mode = t.dataset.mode;
      const problem = checkEdit(cur, text);
      if (problem) { msg.textContent = problem; return; }
      if (text === (cur.raw != null ? cur.raw : show(cur).trim())) { msg.textContent = 'Nothing has changed yet.'; return; }
      if (mode === 'fix' && !window.confirm('Overwrite the ' + fmt(cur.date) + ' version of ' + page.url +
        ' in the sheet? Its current text will only be recoverable from Google Sheets\' version history.')) return;
      const buttons = panel.querySelectorAll('button');
      buttons.forEach(b => { b.disabled = true; });
      msg.textContent = 'Saving to the sheet…';
      window.SchemaApp.onSaveSchema({ page: page, cur: cur, mode: mode, text: text }, function (err) {
        if (err) {
          buttons.forEach(b => { b.disabled = false; });
          if (cur.date === todayIso()) panel.querySelector('[data-mode="new"]').disabled = true;
          msg.textContent = 'Could not save: ' + err.message;
          return;
        }
        // Still on screen means the reload after saving didn't re-render.
        if (document.body.contains(panel)) {
          msg.textContent = 'Saved to the sheet, but reloading failed — see the status above, then Reconnect.';
          return;
        }
        reopen(page.url);
      });
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
    const prop = proposedFor(page);
    const proposed = prop && spec.fromSchema(prop.schema);
    const source = syncSources(spec, page).filter(s => s.id === e.target.value)[0];
    if (!proposed || !source) return;
    const out = syncCompare(spec, page, proposed, source);
    fold.querySelector('.synchost').innerHTML = out.html;
    fold.querySelector('.sync-status').textContent = out.status;
  });

  /* ---------- find & replace across pages ---------- */

  // One value changed in every page's latest schema at once (a new icon URL,
  // say). Four steps: find, preview with a tick box per page, confirm, done.
  // Saving always writes a new dated version through the sheet loader.
  const FR = { step: 1, find: '', repl: '', exact: true, plan: [], picked: {}, result: null, busy: false };
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

  // Every string value matching `find`, with a readable path to it, e.g.
  // "Organization › logo › url".
  function frHits(schema, find, exact) {
    const out = [];
    (function walk(v, path) {
      if (typeof v === 'string') {
        if (exact ? v === find : v.indexOf(find) > -1) out.push({ path: path, key: path.split(' › ').pop(), value: v });
        return;
      }
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v)) { v.forEach(x => walk(x, path)); return; }
      const label = path || [].concat(v['@type'] || ['(top)'])[0];
      Object.keys(v).forEach(k => {
        if (k === '@graph') walk(v[k], path);
        else if (k !== '@type' && k !== '@context') walk(v[k], label + ' › ' + k);
      });
    })(schema, '');
    return out;
  }

  // The schema with every match replaced, used to check the edited cell text
  // says exactly what the preview showed.
  function frApply(v, find, repl, exact) {
    if (typeof v === 'string') return exact ? (v === find ? repl : v) : v.split(find).join(repl);
    if (!v || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(x => frApply(x, find, repl, exact));
    const o = {};
    Object.keys(v).forEach(k => { o[k] = (k === '@type' || k === '@context') ? v[k] : frApply(v[k], find, repl, exact); });
    return o;
  }

  // The new cell text is the old one with the value swapped in place, so the
  // cell's own formatting and any <script> wrapper survive. If that doesn't
  // parse back to exactly the intended schema (an escaped "\/" in the URL, a
  // match inside a key), the page is left out rather than guessed at.
  function frPlanPage(page) {
    const cur = ordered(page)[0];
    if (!cur || isText(cur) || cur.raw == null) return null;
    const hits = frHits(cur.schema, FR.find, FR.exact);
    if (!hits.length) return null;
    const q = s => JSON.stringify(s), inner = s => q(s).slice(1, -1);
    const text = FR.exact ? cur.raw.split(q(FR.find)).join(q(FR.repl))
      : cur.raw.split(inner(FR.find)).join(inner(FR.repl));
    const parsed = D.parse(text);
    const safe = !parsed.error &&
      JSON.stringify(D.sortKeys(parsed.value)) === JSON.stringify(D.sortKeys(frApply(cur.schema, FR.find, FR.repl, FR.exact)));
    return { page: page, cur: cur, hits: hits, text: text, safe: safe };
  }

  // Marks only the part of a value that changes, like the code diff does.
  function frMarked(value, side) {
    const find = FR.find, repl = FR.repl;
    let a = 0; while (a < find.length && a < repl.length && find[a] === repl[a]) a++;
    let b = 0; while (b < find.length - a && b < repl.length - a && find[find.length - 1 - b] === repl[repl.length - 1 - b]) b++;
    const src = side === 'd' ? find : repl;
    const mid = src.slice(a, src.length - b);
    const one = esc(src.slice(0, a)) + (mid ? '<mark>' + esc(mid) + '</mark>' : '') + esc(src.slice(src.length - b));
    return value.split(find).map(esc).join(one);
  }

  const frChosen = () => FR.plan.filter(x => x.safe && FR.picked[x.page.url]);
  const frPlaces = () => frChosen().reduce((n, x) => n + x.hits.length, 0);

  function frSteps() {
    return '<div class="fr-steps">' + ['Find', 'Preview', 'Confirm', 'Done'].map((t, i) =>
      '<div class="fr-step' + (i + 1 === FR.step ? ' on' : i + 1 < FR.step ? ' done' : '') + '"' +
      (i + 1 === FR.step ? ' aria-current="step"' : '') + '><b>' + (i + 1) + '</b>' + t + '</div>').join('') + '</div>';
  }

  function frBody() {
    const tab = (window.SchemaApp.sheetTab && window.SchemaApp.sheetTab()) || 'sheet';
    if (FR.step === 1) {
      return '<h2>Find &amp; replace across all pages</h2>' +
        '<p class="hint">Change one value in every page’s latest schema at once, e.g. a new website icon URL. You’ll see every change before anything is saved.</p>' +
        '<div class="fr-grid">' +
        '<div><label for="fr-find">Find</label><input type="text" id="fr-find" class="fr-mono" spellcheck="false" value="' + esc(FR.find) + '"></div>' +
        '<div><label for="fr-repl">Replace with</label><input type="text" id="fr-repl" class="fr-mono" spellcheck="false" value="' + esc(FR.repl) + '"></div>' +
        '</div>' +
        '<label class="fr-check"><input type="checkbox" id="fr-exact"' + (FR.exact ? ' checked' : '') + '>' +
        '<span>Whole value only<small>Recommended. Matches a value that is exactly this text, not one that just contains it.</small></span></label>' +
        '<div class="fr-bar"><span class="count fr-msg" role="status"></span><span class="spacer"></span>' +
        '<button class="mini fr-close" type="button">Close</button>' +
        '<button class="primary fr-preview" type="button">Preview changes</button></div>';
    }
    if (FR.step === 2) {
      const safe = FR.plan.filter(x => x.safe), unsafe = FR.plan.filter(x => !x.safe);
      // The field most matches sit in; a match not under it (an image
      // rather than a logo, say) gets flagged for a second look.
      // Counted per page, over every field on the way to a match, so a logo
      // written as logo › url still counts as a logo.
      const tally = {};
      safe.forEach(x => {
        const seen = {};
        x.hits.forEach(h => h.path.split(' › ').slice(1).forEach(k => { seen[k] = 1; }));
        Object.keys(seen).forEach(k => { tally[k] = (tally[k] || 0) + 1; });
      });
      const usual = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
      const n = frChosen().length;
      return '<h2>Preview</h2>' +
        '<div class="fr-chips"><span class="fr-chip blue">' + n + ' of ' + plural(safe.length, 'page') + ' selected</span>' +
        '<span class="fr-chip">' + plural(frPlaces(), 'place') + ' will change</span>' +
        '<span class="fr-chip">Searched ' + plural(DATA.pages.length, 'page') + '</span></div>' +
        '<p class="hint">Untick any page you don’t want changed. Each match shows where it sits in the schema.</p>' +
        '<div class="fr-pages">' + safe.map(x =>
          '<div class="fr-pg' + (FR.picked[x.page.url] ? '' : ' off') + '">' +
          '<label class="fr-pg-head"><input type="checkbox" class="fr-pick" data-url="' + esc(x.page.url) + '"' +
          (FR.picked[x.page.url] ? ' checked' : '') + '>' +
          '<span class="fr-url">' + esc(x.page.url) + '</span>' +
          '<span class="count">' + plural(x.hits.length, 'place') + '</span>' +
          (x.hits.some(h => h.path.split(' › ').indexOf(usual) < 0) ? '<span class="fr-flag">Different field from the other pages, check this one</span>' : '') +
          '</label>' +
          x.hits.map(h => '<div class="fr-hit"><div class="fr-path">' + esc(h.path) + '</div><div class="fr-vals">' +
            '<div class="fr-v d">' + frMarked(h.value, 'd') + '</div>' +
            '<div class="fr-v a">' + frMarked(h.value, 'a') + '</div></div></div>').join('') +
          '</div>').join('') + '</div>' +
        (unsafe.length ? '<div class="fr-note warn"><b>' + plural(unsafe.length, 'page') + ' can’t be changed here</b> because the value is written differently in the sheet. Use <b>Edit schema</b> on: ' +
          unsafe.map(x => esc(x.page.url)).join(', ') + '</div>' : '') +
        '<div class="fr-note">' + plural(DATA.pages.length - FR.plan.length, 'page') + ' not affected.</div>' +
        '<div class="fr-bar"><button class="mini fr-back" data-to="1" type="button">Back</button><span class="spacer"></span>' +
        '<button class="primary fr-next" type="button"' + (n ? '' : ' disabled') + '>Continue with ' + plural(n, 'page') + '</button></div>';
    }
    if (FR.step === 3) {
      const n = frChosen().length;
      return '<h2>Confirm</h2>' +
        '<div class="fr-confirm"><b>Update ' + plural(n, 'page') + ' (' + plural(frPlaces(), 'place') + ')?</b><ul>' +
        '<li>Each page gets a <b>new version dated ' + esc(fmt(todayIso())) + '</b> in the <b>' + esc(tab) + '</b> tab. A page already updated today has today’s version updated instead.</li>' +
        '<li>Older versions stay as they are, so this can be undone.</li>' +
        '<li>The change shows up in each page’s <b>View code changes</b> for review.</li></ul></div>' +
        '<div class="fr-bar"><button class="mini fr-back" data-to="2" type="button"' + (FR.busy ? ' disabled' : '') + '>Back to preview</button>' +
        '<span class="count fr-msg" role="status">' + (FR.busy ? 'Saving to the sheet…' : '') + '</span><span class="spacer"></span>' +
        '<button class="primary fr-save" type="button"' + (FR.busy ? ' disabled' : '') + '>Save ' + plural(n, 'page') + ' as new version</button></div>';
    }
    const r = FR.result;
    return '<h2>Done</h2>' +
      (r.saved.length ? '<div class="fr-res ok"><b>' + plural(r.saved.length, 'page') + ' saved as version ' +
        esc(fmt(todayIso())) + '.</b><ul>' + r.saved.map(u => '<li>' + esc(u) + '</li>').join('') + '</ul></div>' : '') +
      (r.skipped.length ? '<div class="fr-res skip"><b>' + plural(r.skipped.length, 'page') + ' skipped.</b> ' +
        'Someone changed these in the sheet after you loaded it. Reconnect and run the replace again to include them.<ul>' +
        r.skipped.map(s => '<li>' + esc(s.url) + '</li>').join('') + '</ul></div>' : '') +
      '<div class="fr-bar"><button class="mini fr-back" data-to="1" type="button">Start a new replace</button><span class="spacer"></span>' +
      '<button class="mini fr-close" type="button">Close</button>' +
      (r.saved.length ? '<button class="primary fr-view" type="button" data-url="' + esc(r.saved[0]) + '">View changes on ' + esc(r.saved[0]) + '</button>' : '') +
      '</div>';
  }

  function drawFr() {
    $('fr').innerHTML = frSteps() + '<div class="fr-body">' + frBody() + '</div>';
  }

  $('fr-open').addEventListener('click', function () {
    const panel = $('fr');
    if (!panel.hidden) { panel.hidden = true; return; }
    if (FR.step !== 3 || !FR.busy) FR.step = 1;
    panel.hidden = false;
    drawFr();
    $('fr-find').focus();
  });

  $('fr').addEventListener('click', function (e) {
    const t = e.target;
    const msg = $('fr').querySelector('.fr-msg');
    if (t.classList.contains('fr-close')) { $('fr').hidden = true; return; }
    if (t.classList.contains('fr-back')) { FR.step = +t.dataset.to; drawFr(); return; }
    if (t.classList.contains('fr-preview')) {
      FR.find = $('fr-find').value.trim(); FR.repl = $('fr-repl').value.trim(); FR.exact = $('fr-exact').checked;
      if (!FR.find || !FR.repl) { msg.textContent = 'Fill in both boxes.'; return; }
      if (FR.find === FR.repl) { msg.textContent = 'The two values are the same.'; return; }
      FR.plan = DATA.pages.map(frPlanPage).filter(Boolean);
      if (!FR.plan.length) { msg.textContent = 'No page has this value in its latest schema.'; return; }
      FR.picked = {};
      FR.plan.forEach(x => { if (x.safe) FR.picked[x.page.url] = true; });
      FR.step = 2; drawFr(); return;
    }
    if (t.classList.contains('fr-next')) { FR.step = 3; drawFr(); return; }
    if (t.classList.contains('fr-save')) {
      FR.busy = true; drawFr();
      window.SchemaApp.onSaveMany(frChosen().map(x => ({ page: x.page, cur: x.cur, text: x.text })), function (err, result) {
        FR.busy = false;
        if (err) { drawFr(); $('fr').querySelector('.fr-msg').textContent = 'Could not save: ' + err.message; return; }
        FR.result = result; FR.step = 4; drawFr();
      });
      return;
    }
    if (t.classList.contains('fr-view')) { reopen(t.dataset.url); }
  });

  $('fr').addEventListener('change', function (e) {
    if (!e.target.classList.contains('fr-pick')) return;
    FR.picked[e.target.dataset.url] = e.target.checked;
    drawFr();
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

  /* ---------- can this dashboard read a page directly? ----------
     Two separate things have to be true, and they fail with the same browser
     error, so the check distinguishes them: the page has to be reachable at
     all (VPN), and it has to allow this origin to read the response (CORS). */

  function drawTools() {
    $('tools').innerHTML =
      '<details class="tools"><summary>Check whether the dashboard can read a page</summary>' +
      '<div class="tools-b">' +
      '<p class="hint">For the dashboard to pull a page itself — rather than through the sheet — ' +
      'it needs to reach the page <i>and</i> be allowed to read the response.</p>' +
      '<div class="tools-row">' +
      '<input type="text" class="probe-url" value="https://staging.llmsource.com/solutions/agency" ' +
      'placeholder="https://staging.llmsource.com/…" spellcheck="false">' +
      '<button type="button" class="mini probe-go">Check</button></div>' +
      '<div class="probe-out"></div>' +
      '</div></details>';
  }

  function probeReport(box, cls, text) {
    const out = box.querySelector('.probe-out');
    out.className = 'probe-out ' + cls;
    out.innerHTML = text;
  }

  document.addEventListener('click', function (e) {
    if (!e.target.classList.contains('probe-go')) return;
    const btn = e.target, box = btn.closest('.tools-b');
    const url = box.querySelector('.probe-url').value.trim();
    if (!url) { probeReport(box, 'probe-warn', 'Enter a URL first.'); return; }

    const bust = (url.indexOf('?') > -1 ? '&' : '?') + 'cb=' + Date.now();
    btn.disabled = true;
    probeReport(box, '', 'Checking…');

    fetch(url + bust)
      .then(r => r.text())
      .then(html => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const title = (doc.querySelector('title') || {}).textContent || '(no title found)';
        probeReport(box, 'probe-ok',
          '<b>Readable.</b> Got ' + html.length.toLocaleString() + ' bytes; the page’s title is ' +
          '“' + esc(title.trim()) + '”.<br>The dashboard can fetch this page directly — ' +
          'staging comparison can be built on it.');
      })
      .catch(() =>
        // The request may still have reached the server; no-cors tells us
        // whether the wall was the network or the browser.
        fetch(url + bust, { mode: 'no-cors' })
          .then(() => probeReport(box, 'probe-warn',
            '<b>Reached the page, but not allowed to read it.</b> The network side is fine, ' +
            'so this is the missing CORS header. The site needs to send:<br>' +
            '<code>Access-Control-Allow-Origin: ' + esc(location.origin) + '</code>'))
          .catch(() => probeReport(box, 'probe-bad',
            '<b>Couldn’t reach it at all.</b> Either you’re not on the VPN, the URL is wrong, ' +
            'or the site is down. Nothing to do with CORS.'))
      )
      .then(() => { btn.disabled = false; });
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
    $('fr-open').hidden = !(canEdit() && window.SchemaApp.onSaveMany);
    if ($('fr-open').hidden) $('fr').hidden = true;
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
