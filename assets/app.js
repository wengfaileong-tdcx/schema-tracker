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

  function summaryFor(page, i) {
    const vs = ordered(page);
    const cur = vs[i], prev = vs[i + 1];
    if (cur.summary && cur.summary.length) return cur.summary;
    return D.summarise(prev ? prev.schema : null, cur.schema);
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

  function faqSyncBlock(page, cur) {
    const faqPage = findFaqPage(cur.schema);
    if (!faqPage || !page.liveFaq) return '';
    const tracked = trackedFaqPairs(faqPage);
    const r = D.compare(page.liveFaq, tracked, {
      full: false, sort: true, context: 3, labels: { left: 'Live Site', right: 'Proposed' },
      commentOpts: { diffId: DIFF_FAQ, comments: commentsFor(page, DIFF_FAQ), canPost: canComment() }
    });
    const inSync = !r.error && !r.add && !r.del;
    return '<div class="block"><details class="fold"' + (inSync ? '' : ' open') + '>' +
      '<summary>FAQ sync check with live site<span class="count"> · ' +
      (r.error ? 'error' : inSync ? 'in sync' : 'out of sync') + '</span></summary>' +
      '<div class="inner">' +
      '<p class="hint">What is currently live on the page (left) vs. the proposed FAQPage schema from Google Sheet (right).</p>' +
      (r.error ? '<div class="err">' + esc(r.error) + '</div>' : (inSync ? '<div class="flat">No difference found.</div>' : r.html)) +
      selectionCommentUI(page, DIFF_FAQ) +
      '</div></details></div>';
  }

  /* ---------- render one page row ---------- */

  function pageRow(page) {
    const vs = ordered(page);
    if (!vs.length) return '';
    const cur = vs[0];
    const recent = daysAgo(cur.date) <= RECENT_DAYS;
    const items = summaryFor(page, 0);
    const st = (page.status || '').toLowerCase();

    let h = '<details class="page" data-url="' + esc(page.url) + '">';
    h += '<summary>';
    h += '<div class="u">' + esc(page.url) + '</div>';
    h += '<div class="line2">';
    h += '<span>Current version <b>' + esc(cur.version) + '</b></span>';
    h += '<span>Last updated <b>' + esc(fmt(cur.date)) + '</b></span>';
    if (page.status) h += '<span class="badge ' + (st === 'live' ? 'live' : st === 'draft' ? 'draft' : '') + '">' + esc(page.status) + '</span>';
    if (recent) h += '<span class="badge new">Updated recently</span>';
    h += '</div>';
    h += '<div class="latest">' + esc(items.slice(0, 2).join(' · ')) +
      (items.length > 2 ? ' · +' + (items.length - 2) + ' more' : '') + '</div>';
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
        '<div class="diffhost"></div>' + selectionCommentUI(page, DIFF_CODE) +
        '</div></details>';
    } else {
      h += '<div class="flat">Only one version recorded, so there is nothing to compare yet.</div>';
    }
    h += '</div>';

    /* 1b. FAQ sync check, only when both a tracked FAQPage and live data exist */
    h += faqSyncBlock(page, cur);

    /* 2. full current schema */
    h += '<div class="block">' +
      '<details class="fold" data-schema="' + esc(page.url) + '">' +
      '<summary>View current schema</summary><div class="inner">' +
      '<div class="foldbar"><span class="count">' + esc(cur.version) + ' · live now</span>' +
      '<span class="spacer"></span>' +
      '<button class="mini copy-schema" type="button">Copy schema</button></div>' +
      selectionCodeBlock(page, 'Schema: ' + cur.version, cur.schema) +
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

  const RECENT_FEED_MAX = 8;

  function recentFeed() {
    const rows = DATA.pages
      .filter(p => (p.versions || []).length)
      .map(p => ({ page: p, cur: ordered(p)[0] }))
      .filter(r => r.cur.date)
      .sort((a, b) => b.cur.date.localeCompare(a.cur.date));

    if (!rows.length) return '';

    const items = rows.slice(0, RECENT_FEED_MAX).map(r => {
      const recent = daysAgo(r.cur.date) <= RECENT_DAYS;
      return '<li class="rf-item' + (recent ? ' rf-new' : '') + '" data-url="' + esc(r.page.url) + '">' +
        '<button type="button" class="rf-open">' +
        '<span class="rf-title">' + esc(r.page.title || r.page.url) + '</span>' +
        '<span class="rf-url">' + esc(r.page.url) + '</span>' +
        '<span class="rf-date">' + esc(fmt(r.cur.date)) + '</span>' +
        '</button></li>';
    }).join('');

    return '<h2 class="rf-h">Latest schema changes</h2>' +
      '<ul class="rf-list">' + items + '</ul>';
  }

  function drawRecent() {
    $('recent').innerHTML = recentFeed();
  }

  document.addEventListener('click', function (e) {
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

  /* ---------- select-and-comment on a full-code block ---------- */

  const SEL_KEY = 'note'; // one flat comment thread per code block; each entry quotes its own selection

  // Comment UI for whatever code block is rendered immediately before it —
  // a full-code <pre>, a diff split view, anything. The viewer selects text
  // in that block and comments on that exact selection; the selected text is
  // stored in the same "context" field the Line Comments sheet already has.
  function selectionCommentUI(page, diffId) {
    const items = (commentsFor(page, diffId)[SEL_KEY]) || [];
    const canPost = canComment();
    const list = items.map(c =>
      '<li><div class="cm-meta"><b>' + esc(c.name || 'Anonymous') + '</b> · ' + esc(String(c.ts || '').slice(0, 10)) + '</div>' +
      (c.context ? '<blockquote class="sel-quote">' + esc(c.context) + '</blockquote>' : '') +
      '<p class="cm-text">' + esc(c.text) + '</p></li>').join('');

    return '<div class="sel-cm" data-sel-scope="' + esc(diffId) + '">' +
      (canPost ? '<button type="button" class="mini sel-cm-trigger">Comment on selected text</button>' : '') +
      '<div class="sel-cm-box" hidden>' +
      '<p class="hint sel-cm-msg">Select some text above, then click “Comment on selected text” again.</p>' +
      '<blockquote class="sel-quote sel-cm-quote"></blockquote>' +
      '<div class="cm-form"><input type="text" class="cm-name" placeholder="Your name">' +
      '<textarea class="cm-body" placeholder="Add a comment…" rows="2"></textarea>' +
      '<div class="foldbar"><button class="mini sel-cm-post" type="button">Post comment</button>' +
      '<span class="count sel-cm-postmsg"></span></div></div>' +
      '</div>' +
      (items.length ? '<ul class="cm-list sel-cm-list">' + list + '</ul>' : '') +
      '</div>';
  }

  const selectionCodeBlock = (page, diffId, schema) =>
    '<pre class="code" data-sel-scope="' + esc(diffId) + '">' + esc(D.pretty(schema, false)) + '</pre>' +
    selectionCommentUI(page, diffId);

  function renderDiffInto(host, prev, cur, full, commentOpts) {
    const r = D.compare(prev, cur, { full: full, sort: true, context: 3, commentOpts: commentOpts });
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
        renderDiffInto(host, vs[1].schema, vs[0].schema, false,
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
      renderDiffInto(fold.querySelector('.diffhost'), vs[1].schema, vs[0].schema, !!on,
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

    /* toggle a line comment panel open/closed */
    const lnBtn = t.closest('.ln-cm-btn');
    if (lnBtn) {
      const panel = lnBtn.closest('.row').nextElementSibling;
      if (panel && panel.classList.contains('ln-cm-panel')) panel.hidden = !panel.hidden;
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
      const cellTexts = row ? [].slice.call(row.querySelectorAll('.cell .tx')).map(x => x.textContent.trim()) : [];
      const context = cellTexts.length > 1 && cellTexts[0] !== cellTexts[1]
        ? cellTexts[0] + '  →  ' + cellTexts[1]
        : (cellTexts[0] || cellTexts[1] || '');
      msg.textContent = 'Posting…';
      t.disabled = true;
      window.SchemaApp.onPostComment({ url: url, diffId: diffId, lineKey: lineKey, context: context, name: name, text: text }, function (err, entry) {
        t.disabled = false;
        if (err) { msg.textContent = 'Could not post: ' + err.message; return; }
        const list = panel.querySelector('.cm-list');
        const empty = list.querySelector('.cm-empty');
        if (empty) empty.remove();
        list.insertAdjacentHTML('beforeend',
          '<li><div class="cm-meta"><b>' + esc(entry.name) + '</b> · ' + esc(String(entry.ts || '').slice(0, 10)) + '</div>' +
          '<p class="cm-text">' + esc(entry.text) + '</p></li>');
        const cmBtn = row && row.querySelector('.ln-cm-btn');
        if (cmBtn) {
          const n = list.querySelectorAll('li').length;
          const countEl = cmBtn.querySelector('.ln-cm-count');
          if (countEl) countEl.textContent = n;
          else cmBtn.insertAdjacentHTML('beforeend', '<span class="ln-cm-count">' + n + '</span>');
        }
        nameEl.value = ''; bodyEl.value = ''; msg.textContent = 'Posted.';
      });
      return;
    }

    /* open the selection-comment composer, using whatever text is currently selected */
    if (t.classList.contains('sel-cm-trigger')) {
      const wrap = t.closest('.sel-cm');
      // The code this comments on is whatever was rendered right before it:
      // a <pre> of full code, or the diff view's host element.
      const codeEl = wrap.previousElementSibling;
      const box = wrap.querySelector('.sel-cm-box');
      const sel = window.getSelection();
      const text = sel && sel.rangeCount ? sel.toString().trim() : '';
      const container = sel && sel.rangeCount ? sel.getRangeAt(0).commonAncestorContainer : null;
      const inScope = !!(codeEl && container && codeEl.contains(container));
      box.hidden = false;
      const msg = box.querySelector('.sel-cm-msg');
      const quote = box.querySelector('.sel-cm-quote');
      if (!text || !inScope) {
        msg.hidden = false;
        quote.hidden = true;
        box.dataset.snippet = '';
      } else {
        msg.hidden = true;
        quote.hidden = false;
        quote.textContent = text;
        box.dataset.snippet = text;
        box.querySelector('.cm-body').focus();
      }
      return;
    }

    /* post a selection comment */
    if (t.classList.contains('sel-cm-post')) {
      const box = t.closest('.sel-cm-box');
      const wrap = t.closest('.sel-cm');
      const nameEl = box.querySelector('.cm-name'), bodyEl = box.querySelector('.cm-body'), msg = box.querySelector('.sel-cm-postmsg');
      const name = nameEl.value.trim(), text = bodyEl.value.trim();
      if (!name || !text) { msg.textContent = 'Enter your name and a comment.'; return; }
      if (!box.dataset.snippet) { msg.textContent = 'Select some text in the code above first.'; return; }
      const page = t.closest('.page');
      const url = page ? page.dataset.url : '';
      const diffId = wrap.dataset.selScope;
      msg.textContent = 'Posting…';
      t.disabled = true;
      window.SchemaApp.onPostComment({ url: url, diffId: diffId, lineKey: SEL_KEY, context: box.dataset.snippet, name: name, text: text }, function (err, entry) {
        t.disabled = false;
        if (err) { msg.textContent = 'Could not post: ' + err.message; return; }
        let list = wrap.querySelector('.sel-cm-list');
        if (!list) {
          list = document.createElement('ul');
          list.className = 'cm-list sel-cm-list';
          wrap.appendChild(list);
        }
        list.insertAdjacentHTML('beforeend',
          '<li><div class="cm-meta"><b>' + esc(entry.name) + '</b> · ' + esc(String(entry.ts || '').slice(0, 10)) + '</div>' +
          (box.dataset.snippet ? '<blockquote class="sel-quote">' + esc(box.dataset.snippet) + '</blockquote>' : '') +
          '<p class="cm-text">' + esc(entry.text) + '</p></li>');
        nameEl.value = ''; bodyEl.value = ''; msg.textContent = 'Posted.';
        box.hidden = true;
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
        '<div class="inner">' + selectionCodeBlock(page, 'Schema: ' + v.version, v.schema) + '</div></details>';
      if (prev) {
        const r = D.compare(prev.schema, v.schema, { full: false, sort: true, context: 3 });
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
      const r = D.compare(vs[older].schema, vs[newer].schema, { full: false, sort: true, context: 3 });
      host.innerHTML = '<p class="count" style="padding:0 0 7px">' +
        esc(vs[older].version) + ' → ' + esc(vs[newer].version) + '</p>' +
        (r.error ? '<div class="err">' + esc(r.error) + '</div>' : r.html);
    }
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

  function drawBanner() {
    if (SOURCE === 'sheet') {
      $('banner').innerHTML = '<div class="src-banner src-live">' +
        'Showing live data loaded from your Google Sheet.</div>';
      return;
    }
    const hasSheet = window.SHEET_CONFIG && window.SHEET_CONFIG.enabled;
    $('banner').innerHTML = '<div class="src-banner src-sample">' +
      'Showing sample data, not real schema history.' +
      (hasSheet ? ' Click <b>Connect Google Sheet</b> below to load the real thing.' : '') +
      '</div>';
  }

  function renderAll() {
    $('site').textContent = DATA.site || '';
    const allDates = DATA.pages.reduce((a, p) => a.concat((p.versions || []).map(v => v.date)), []).sort();
    $('stamp').textContent = allDates.length ? 'Most recent change ' + fmt(allDates[allDates.length - 1]) : '';
    drawBanner();
    drawRecent();
    draw();
  }

  // Lets an external loader (e.g. assets/sheet-loader.js) swap in fresh data
  // without a page reload.
  window.SchemaApp = {
    setData: function (data, source) { DATA = data || { pages: [] }; SOURCE = source || 'sample'; renderAll(); }
  };

  renderAll();
})();
