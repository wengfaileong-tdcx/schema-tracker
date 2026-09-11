(function () {
  const D = window.SchemaDiff;
  const $ = id => document.getElementById(id);
  const esc = D.esc;

  let DATA = window.SCHEMA_HISTORY || { pages: [] };
  let SOURCE = 'sample';
  const RECENT_DAYS = 14;

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

  /* ---------- comments (only writable when a sheet with write access is connected) ---------- */

  const fmtTs = ts => {
    const d = new Date(ts);
    return isNaN(d) ? (ts || '') : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const commentItem = c =>
    '<li><div class="cm-meta"><b>' + esc(c.name || 'Anonymous') + '</b> · ' + esc(fmtTs(c.ts)) + '</div>' +
    '<p class="cm-text">' + esc(c.text) + '</p></li>';

  function commentsBlock(page, v) {
    const comments = v.comments || [];
    const canPost = !!(window.SchemaApp && window.SchemaApp.onPostComment);
    return '<details class="fold" data-comments="' + esc(page.url) + '|' + esc(v.version) + '">' +
      '<summary>Comments<span class="count"> · ' + comments.length + '</span></summary>' +
      '<div class="inner">' +
      '<ul class="cm-list">' + (comments.length ? comments.map(commentItem).join('') : '<li class="cm-empty">No comments yet.</li>') + '</ul>' +
      (canPost
        ? '<div class="cm-form"><input type="text" class="cm-name" placeholder="Your name">' +
          '<textarea class="cm-body" placeholder="Add a comment…" rows="2"></textarea>' +
          '<div class="foldbar"><button class="mini cm-post" type="button">Post comment</button>' +
          '<span class="count cm-msg"></span></div></div>'
        : '<p class="flat">Connect Google Sheet to add a comment.</p>') +
      '</div></details>';
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
        '<div class="diffhost"></div></div></details>';
    } else {
      h += '<div class="flat">Only one version recorded, so there is nothing to compare yet.</div>';
    }
    h += '</div>';

    /* 1b. comments on the current version */
    h += '<div class="block">' + commentsBlock(page, cur) + '</div>';

    /* 2. full current schema */
    h += '<div class="block">' +
      '<details class="fold" data-schema="' + esc(page.url) + '">' +
      '<summary>View current schema</summary><div class="inner">' +
      '<div class="foldbar"><span class="count">' + esc(cur.version) + ' · live now</span>' +
      '<span class="spacer"></span>' +
      '<button class="mini copy-schema" type="button">Copy schema</button></div>' +
      '<pre class="code">' + esc(D.pretty(cur.schema, false)) + '</pre>' +
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

  function renderDiffInto(host, prev, cur, full) {
    const r = D.compare(prev, cur, { full: full, sort: true, context: 3 });
    host.innerHTML = r.error ? '<div class="err">' + esc(r.error) + '</div>' : r.html;
  }

  document.addEventListener('toggle', function (e) {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.open) return;

    if (d.dataset.diff) {
      const host = d.querySelector('.diffhost');
      if (host && !host.dataset.done) {
        const vs = ordered(pageByUrl(d.dataset.diff));
        renderDiffInto(host, vs[1].schema, vs[0].schema, false);
        host.dataset.done = '1';
      }
    }
  }, true);

  document.addEventListener('click', function (e) {
    const t = e.target;

    /* full-code toggle inside a diff */
    if (t.classList.contains('toggle-full')) {
      const fold = t.closest('.fold');
      const vs = ordered(pageByUrl(fold.dataset.diff));
      const on = t.dataset.full === '1' ? 0 : 1;
      t.dataset.full = on;
      t.textContent = on ? 'Show changes only' : 'Show full code';
      renderDiffInto(fold.querySelector('.diffhost'), vs[1].schema, vs[0].schema, !!on);
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
        '<div class="inner"><pre class="code">' + esc(D.pretty(v.schema, false)) + '</pre></div></details>';
      if (prev) {
        const r = D.compare(prev.schema, v.schema, { full: false, sort: true, context: 3 });
        h += '<details class="fold"><summary>Compare with ' + esc(prev.version) + '</summary>' +
          '<div class="inner">' + (r.error ? '<div class="err">' + esc(r.error) + '</div>' : r.html) +
          '</div></details>';
      }
      if (i > 0) h += commentsBlock(page, v); // current version's comments already shown above
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
      return;
    }

    /* post a comment */
    if (t.classList.contains('cm-post')) {
      const inner = t.closest('.inner');
      const nameEl = inner.querySelector('.cm-name'), bodyEl = inner.querySelector('.cm-body'), msg = inner.querySelector('.cm-msg');
      const name = nameEl.value.trim(), text = bodyEl.value.trim();
      if (!name || !text) { msg.textContent = 'Enter your name and a comment.'; return; }
      const [url, version] = t.closest('[data-comments]').dataset.comments.split('|');
      msg.textContent = 'Posting…';
      t.disabled = true;
      window.SchemaApp.onPostComment({ url: url, version: version, name: name, text: text }, function (err, entry) {
        t.disabled = false;
        if (err) { msg.textContent = 'Could not post: ' + err.message; return; }
        const list = inner.querySelector('.cm-list');
        const empty = list.querySelector('.cm-empty');
        if (empty) empty.remove();
        list.insertAdjacentHTML('beforeend', commentItem(entry));
        const fold = t.closest('.fold');
        const count = fold.querySelector('summary .count');
        count.textContent = ' · ' + list.querySelectorAll('li').length;
        nameEl.value = ''; bodyEl.value = ''; msg.textContent = 'Posted.';
      });
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
