/* Schema builder: makes a page's JSON-LD from the LLMSource Schema Flow
   rules, then saves it as a new version in the sheet.

   The rules (Schema Flow's own generator and data, v180) are internal, so
   they are not in this public repo. They live in the private sheet's
   "builder rules" tab, loaded once from a rules file (see README), and are
   read only after someone connects with access to the sheet. Per-site
   settings (business category, site scope, shared values like the business
   name) live in the "builder sites" tab.

   The builder takes Schema Flow's template for the site's category, site
   scope and page type, puts in the page address and the site address, and
   lists every {placeholder} as a field. Fields are filled from the page's
   latest version where the same property already has a value, or from a
   saved copy of the page. Nothing is made up: a field left empty stays a
   {placeholder} and saving warns about it. */
(function () {
  const cfg = window.SHEET_CONFIG;
  if (!cfg || !cfg.enabled || !cfg.allowSchemaEdits) return;
  const D = window.SchemaDiff, esc = D.esc;
  const $ = id => document.getElementById(id);

  const RULES_TAB = 'builder rules', SITES_TAB = 'builder sites', CELL = 49000;
  const SITE_COLS = ['Site', 'Taxonomy ID', 'Site scope', 'Values', 'Updated', 'Updated by'];
  const SCOPES = [['single', 'One location customers visit'], ['multi', 'More than one location'], ['none', 'No premises customers visit']];
  const ROW_SCOPE = { 'Single location': 'single', 'Multi-location': 'multi', 'No premises': 'none' };
  const TPL_SITE = 'https://www.example.com';
  // Placeholders that are the same on every page of a site; kept in "builder sites".
  const SITE_KEYS = new Set(['business_name', 'legal_name', 'description', 'telephone', 'email', 'street_address', 'city',
    'postal_code', 'country_code', 'area_served', 'price_range', 'payment_methods', 'brand_name', 'founder_name', 'currency_code']);
  const TOKEN = /\{([a-z][a-z0-9_]*)(?:,\s*e\.g\.\s*([^{}]*))?\}/g;

  const S = {
    connected: false, loading: false, err: '', missing: false, index: null, rules: null, bv: {}, gens: {},
    sites: [], open: false, url: '', page: null, base: '', typeIdx: -1, vals: {}, prefill: {}, crumbsOn: false,
    trail: '', wrap: false, out: '', manual: false, showDiff: false, msg: '', busy: false, newStatus: 'Draft', newTitle: ''
  };
  const app = () => window.SchemaApp || {};
  const api = (p, o) => app().sheet.api(p, o);
  const enc = encodeURIComponent;
  const a1 = (tab, r) => "'" + tab.replace(/'/g, "''") + "'!" + r;
  const today = () => new Date().toISOString().slice(0, 10);
  const userName = () => { try { return localStorage.getItem('llms-name') || ''; } catch (e) { return ''; } };
  const human = k => k.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const hostKey = u => { try { return new URL(u).host.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } };
  const originOf = u => { try { return new URL(u).origin; } catch (e) { return ''; } };

  /* ---------- reading the sheet ---------- */

  async function ensureTab(title, head) {
    await api(':batchUpdate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: title } } }] }) }).catch(e => {
      if (!/already exists/i.test(e.message)) throw e;
    });
    if (head) await api('/values/' + enc(a1(title, 'A1')) + '?valueInputOption=RAW', { method: 'PUT',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [head] }) });
  }

  // Column A: key, B: part. Rows of one key are next to each other.
  async function loadIndex() {
    let r;
    try { r = await api('/values/' + enc(a1(RULES_TAB, 'A:B'))); }
    catch (e) { if (/Unable to parse range/i.test(e.message)) { S.missing = true; return; } throw e; }
    const idx = {};
    (r.values || []).forEach((row, i) => {
      if (!i || !row[0]) return;
      const k = String(row[0]); const n = i + 1;
      if (!idx[k]) idx[k] = { first: n, last: n }; else idx[k].last = n;
    });
    S.index = idx; S.missing = !idx.gen;
  }
  async function readKeys(keys) {
    const ks = keys.filter(k => S.index[k]);
    if (!ks.length) return {};
    const r = await api('/values:batchGet?' + ks.map(k => 'ranges=' + enc(a1(RULES_TAB, 'C' + S.index[k].first + ':C' + S.index[k].last))).join('&'));
    const out = {};
    r.valueRanges.forEach((v, i) => { out[ks[i]] = JSON.parse((v.values || []).map(x => x[0] || '').join('')); });
    return out;
  }
  async function loadRules() {
    await loadIndex();
    if (S.missing) return;
    const got = await readKeys(['meta', 'gen', 'tax', 'anc', 'range']);
    S.rules = Object.assign({}, got, { LLMSgen: new Function(got.gen + ';return LLMSgen;')() });
  }
  async function loadBv(id) {
    if (S.bv[id]) return S.bv[id];
    const got = await readKeys(['bv:' + id]);
    return (S.bv[id] = got['bv:' + id] || []);
  }
  async function loadSites() {
    let r;
    try { r = await api('/values/' + enc(a1(SITES_TAB, 'A:F'))); } catch (e) { S.sites = []; return; }
    S.sites = (r.values || []).slice(1).map((x, i) => {
      let vals = {};
      try { vals = JSON.parse(x[3] || '{}'); } catch (e) { /* hand-edited cell */ }
      return { row: i + 2, site: String(x[0] || '').trim(), taxId: String(x[1] || '').trim(), scope: String(x[2] || '').trim(), vals: vals };
    }).filter(s => s.site);
  }
  const siteFor = base => S.sites.find(s => hostKey(s.site) === hostKey(base));

  async function saveSite(base, patch) {
    await ensureTab(SITES_TAB, SITE_COLS);
    await loadSites();
    const cur = siteFor(base) || { site: base, taxId: '', scope: '', vals: {} };
    const next = Object.assign({}, cur, patch, { vals: Object.assign({}, cur.vals, patch.vals || {}) });
    const row = [next.site, next.taxId, next.scope, JSON.stringify(next.vals), new Date().toISOString(), userName()];
    if (cur.row) await api('/values/' + enc(a1(SITES_TAB, 'A' + cur.row + ':F' + cur.row)) + '?valueInputOption=RAW', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [row] }) });
    else await api('/values/' + enc(a1(SITES_TAB, 'A:F')) + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [row] }) });
    await loadSites();
  }

  // The rules file from scripts/export-builder-rules.mjs, written into the
  // "builder rules" tab as key | part | text rows.
  async function importRules(file) {
    let R;
    try { R = JSON.parse(await file.text()); } catch (e) { throw new Error('That file isn’t a rules file (not JSON).'); }
    if (!R || R.format !== 'schema-tracker-builder-rules' || !/function LLMSgen\(D\)/.test(R.gen || '') || !R.tax || !R.bv) throw new Error('That file isn’t a schema builder rules file.');
    new Function(R.gen + ';return LLMSgen;')();   // fails here, before anything is written, if the code is broken
    const rows = [['Key', 'Part', 'Text']];
    const put = (k, v) => { const s = JSON.stringify(v); for (let i = 0, n = 1; i < s.length || n === 1; i += CELL, n++) rows.push([k, String(n), s.slice(i, i + CELL)]); };
    put('meta', { label: R.label, exported: R.exported, loaded: new Date().toISOString(), by: userName() });
    put('gen', R.gen); put('tax', R.tax); put('anc', R.anc); put('range', R.range);
    Object.keys(R.bv).forEach(id => put('bv:' + id, R.bv[id]));
    await ensureTab(RULES_TAB);
    await api('/values/' + enc(a1(RULES_TAB, 'A:C')) + ':clear', { method: 'POST' });
    for (let i = 0; i < rows.length;) {
      let size = 0, j = i;
      while (j < rows.length && (size += rows[j][2].length) < 1500000) j++;
      j = Math.max(j, i + 1);
      await api('/values/' + enc(a1(RULES_TAB, 'A' + (i + 1))) + '?valueInputOption=RAW', { method: 'PUT',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: rows.slice(i, j) }) });
      i = j;
    }
    S.bv = {}; S.gens = {};
    await loadRules();
  }

  /* ---------- the template for this page ---------- */

  function typesFor(site) {
    const t = S.rules.tax.find(x => x.id === site.taxId), rows = S.bv[site.taxId];
    if (!t || !rows) return [];
    const G = S.gens[t.id] || (S.gens[t.id] = S.rules.LLMSgen({ tax: S.rules.tax, anc: S.rules.anc, range: S.rules.range, bv: rows }));
    return rows.filter(r => r.need !== 'Not applicable' && (!ROW_SCOPE[r.siteScope] || ROW_SCOPE[r.siteScope] === site.scope))
      .map(r => ({ r: r, tp: G.page(r, t, site.scope) })).filter(x => x.tp && x.tp.json);
  }

  // Which page type to start on: the type the page already says it is, or its address.
  function guessType(types, url, schema) {
    const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch (e) { return ''; } })();
    const has = n => types.findIndex(x => x.r.page === n || x.r.page.indexOf(n) === 0);
    const nodes = flat(schema), pageType = (nodes.find(n => /Page$/.test(typeOf(n))) || {})['@type'];
    const tries = [];
    if (path === '/' || path === '') tries.push('Home');
    if (pageType === 'AboutPage') tries.push('About / Our story');
    if (pageType === 'ContactPage') tries.push('Contact');
    if (pageType === 'FAQPage') tries.push('FAQ');
    [[/about|our-story|who-we-are/, 'About / Our story'], [/contact/, 'Contact'], [/career|job/, 'Careers'], [/case-stud|success-stor/, 'Case study'],
      [/blog|news|insight|article/, 'Blog / News article'], [/faq/, 'FAQ'], [/privacy|terms|polic|cookie/, 'Policies'], [/glossary/, 'Glossary'],
      [/event|webinar/, 'Events'], [/team|leader|people/, 'Team / Staff profile'], [/pricing|plans/, 'Pricing / Plans'], [/service|solution/, 'Service detail']]
      .forEach(([re, n]) => { if (re.test(path)) tries.push(n); });
    for (const n of tries) { const i = has(n); if (i > -1) return i; }
    return 0;
  }

  const typeOf = n => [].concat((n && n['@type']) || [])[0] || '';
  function flat(schema) {
    const out = [];
    (function walk(v) {
      if (Array.isArray(v)) return v.forEach(walk);
      if (!v || typeof v !== 'object') return;
      if (v['@graph']) return walk(v['@graph']);
      if (v['@type']) out.push(v);
    })(schema);
    return out;
  }
  // The same property path in the page's current schema, if it has a real value there.
  function lookup(nodes, type, path) {
    const isPage = /Page$/.test(type);
    let v = nodes.find(n => typeOf(n) === type) || (isPage ? nodes.find(n => /Page$/.test(typeOf(n))) : null);
    for (const k of path) {
      if (v == null) return '';
      if (Array.isArray(v) && typeof k !== 'number') v = v[0];
      v = v == null ? null : v[k];
    }
    return typeof v === 'string' && !/[{}]/.test(v) ? v : '';
  }

  // Put this page's addresses into the template, and find its placeholders.
  function prepare() {
    const x = S.types[S.typeIdx];
    const g0 = JSON.parse(x.tp.json)['@graph'];
    const wp = g0.find(n => n.url && n.isPartOf) || {};
    const tplUrl = wp.url || TPL_SITE + '/';
    let txt = x.tp.json.split(tplUrl).join(S.url).split(TPL_SITE).join(S.base);
    const obj = JSON.parse(txt);
    const fields = [], seen = {};
    const curNodes = flat(S.curSchema);
    // top: the @type of the graph node a value sits in; path: the keys from that node down.
    (function walk(v, top, path) {
      if (Array.isArray(v)) return v.forEach((y, i) => walk(y, top, top ? path.concat(i) : path));
      if (v && typeof v === 'object') {
        if (!top && v['@type']) { top = typeOf(v); path = []; }
        return Object.keys(v).forEach(k => walk(v[k], top, top ? path.concat(k) : path));
      }
      if (typeof v !== 'string') return;
      let m; TOKEN.lastIndex = 0;
      while ((m = TOKEN.exec(v))) {
        const key = m[1];
        if (key === 'crumb_name' || key === 'crumb_url') continue;
        const pre = v === m[0] ? lookup(curNodes, top, path) : '';
        if (seen[key]) { if (!seen[key].pre && pre) seen[key].pre = pre; continue; }
        seen[key] = { key: key, hint: (m[2] || '').trim(), site: SITE_KEYS.has(key), pre: pre };
        fields.push(seen[key]);
      }
    })(obj, '', []);
    S.tpl = obj; S.fields = fields;
    S.hasCrumbs = g0.some(n => typeOf(n) === 'BreadcrumbList');
    const curCrumbs = curNodes.find(n => typeOf(n) === 'BreadcrumbList');
    S.crumbsOn = S.hasCrumbs && !!curCrumbs;
    S.trail = curCrumbs && Array.isArray(curCrumbs.itemListElement)
      ? curCrumbs.itemListElement.map(i => i.name || (i.item && i.item.name) || '').join(' > ')
      : defaultTrail();
    S.notes = x.tp.notes || []; S.optional = x.tp.optional || [];
    S.manual = false;
  }
  function defaultTrail() {
    let segs = [];
    try { segs = new URL(S.url).pathname.split('/').filter(Boolean); } catch (e) { /* relative */ }
    return ['Home'].concat(segs.map((s, i) => i === segs.length - 1 && valueOf('page_title') ? valueOf('page_title')
      : decodeURIComponent(s).replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase()))).join(' > ');
  }
  function valueOf(key) {
    if (S.vals[key] != null) return S.vals[key];
    const site = siteFor(S.base);
    if (SITE_KEYS.has(key) && site && site.vals[key]) return site.vals[key];
    if (S.prefill[key]) return S.prefill[key];
    const f = (S.fields || []).find(x => x.key === key);
    return f && f.pre ? f.pre : '';
  }

  function build() {
    const obj = JSON.parse(JSON.stringify(S.tpl));
    const fill = s => s.replace(TOKEN, (all, key) => { const v = valueOf(key); return v ? v : all; });
    (function walk(v) {
      if (Array.isArray(v)) { v.forEach((y, i) => { if (typeof y === 'string') v[i] = fill(y); else walk(y); }); return; }
      if (v && typeof v === 'object') Object.keys(v).forEach(k => { if (typeof v[k] === 'string') v[k] = fill(v[k]); else walk(v[k]); });
    })(obj);
    let g = obj['@graph'];
    if (S.hasCrumbs) {
      if (!S.crumbsOn) {
        g = g.filter(n => typeOf(n) !== 'BreadcrumbList');
        g.forEach(n => { delete n.breadcrumb; });
      } else {
        const names = S.trail.split('>').map(s => s.trim()).filter(Boolean);
        let segs = [];
        try { segs = new URL(S.url).pathname.split('/').filter(Boolean); } catch (e) { /* relative */ }
        const slash = /\/$/.test(S.url) ? '/' : '';
        const urls = [S.base + '/'].concat(segs.map((s, i) => S.base + '/' + segs.slice(0, i + 1).join('/') + slash));
        const bl = g.find(n => typeOf(n) === 'BreadcrumbList');
        bl.itemListElement = names.map((n, i) => {
          const li = { '@type': 'ListItem', position: i + 1, name: n };
          if (i < names.length - 1 && urls[i]) li.item = urls[i];
          return li;
        });
      }
    }
    obj['@graph'] = g;
    const json = JSON.stringify(obj, null, 2);
    return S.wrap ? '<script type="application/ld+json">\n' + json + '\n</script>' : json;
  }
  const leftovers = t => (String(t).match(TOKEN) || []).length;
  // Schema Flow's stand-in values that look real once the site address is in: check them by hand.
  const examples = t => (String(t).match(/www\.example\.com|facebook\.com\/example|cid=0000000000|\/logo\.png|\/photo\.jpg/g) || [])
    .filter(x => x !== 'www.example.com' || hostKey(S.base) !== 'example.com').length;

  /* ---------- the panel ---------- */

  function panel() {
    let p = $('builder');
    if (!p) {
      p = document.createElement('aside');
      p.id = 'builder'; p.className = 'bd noprint'; p.setAttribute('aria-label', 'Schema builder'); p.hidden = true;
      document.body.appendChild(p);
      p.addEventListener('click', onClick); p.addEventListener('change', onChange); p.addEventListener('input', onInput);
    }
    return p;
  }

  async function openFor(url) {
    const A = app();
    S.open = true; S.err = ''; S.msg = ''; S.vals = {}; S.prefill = {}; S.showDiff = false; S.types = null; S.typeIdx = -1;
    S.page = url ? (A.getPage && A.getPage(url)) : null;
    S.url = url || ''; S.newTitle = '';
    const cur = S.page ? A.ordered(S.page)[0] : null;
    S.cur = cur; S.curSchema = cur && cur.kind !== 'text' ? cur.schema : null;
    S.wrap = !!(cur && /^<script/i.test(String(cur.raw || '').trim()));
    S.base = originOf(S.url) || (cfg.site ? originOf(cfg.site) : '');
    S.loading = S.connected;
    draw(); panel().hidden = false; panel().querySelector('.bd-close').focus();
    if (!S.connected) return;
    try {
      if (!S.rules && !S.missing) await loadRules();
      await loadSites();
      await pickSite();
    } catch (e) { S.err = 'Couldn’t load the builder: ' + e.message; }
    S.loading = false; draw();
  }
  async function pickSite() {
    S.types = null; S.typeIdx = -1;
    const site = S.base && siteFor(S.base);
    if (!S.rules || !site || !site.taxId || !site.scope) return;
    await loadBv(site.taxId);
    S.types = typesFor(site);
    if (!S.types.length) return;
    let saved = null;
    try { saved = localStorage.getItem('bd-type:' + S.url); } catch (e) { /* private window */ }
    const si = saved ? S.types.findIndex(x => x.r.page === saved) : -1;
    S.typeIdx = si > -1 ? si : guessType(S.types, S.url, S.curSchema);
    prepare(); S.out = build();
  }
  function close() {
    S.open = false; panel().hidden = true;
    const back = (S.url && document.querySelector('.open-builder[data-url="' + CSS.escape(S.url) + '"]')) || $('bd-new');
    if (back && !back.hidden) back.focus();
  }

  function draw() {
    const p = panel();
    if (!S.open) return;
    const isNew = !S.page;
    const path = (() => { try { return new URL(S.url).pathname; } catch (e) { return S.url; } })();
    let h = '<div class="bd-head"><div class="bd-h-main"><div class="bd-eyebrow">Schema builder · ' + esc(S.rules && S.rules.meta ? S.rules.meta.label : 'Schema Flow') + '</div>' +
      '<h2>' + esc(isNew ? 'New page' : path || '/') + '</h2>' +
      '<p class="bd-sub">' + esc(isNew ? 'For a page that isn’t in this tab yet. Saving adds it as a new row.' : 'Built from Schema Flow’s template for this page type, filled in from the page’s latest version (' + (S.cur ? S.cur.version : '') + ').') + '</p></div>' +
      '<button type="button" class="bd-close" data-bd="close" aria-label="Close the builder">✕</button></div><div class="bd-body">';
    if (!S.connected) h += '<p class="bd-note">Connect Google Sheet first. The builder’s rules are kept in the private sheet.</p>';
    else if (S.loading) h += '<p class="bd-note">Loading the Schema Flow rules…</p>';
    else if (S.err) h += '<p class="bd-err" role="alert">' + esc(S.err) + '</p>';
    if (S.connected && !S.loading && S.cur && S.cur.kind === 'text') h += '<p class="bd-note">This page tracks a plain-text file, not JSON-LD, so there is nothing to build.</p>';
    else if (S.connected && !S.loading && !S.err) h += S.missing ? drawSetup() : S.rules ? body(isNew) : '';
    p.innerHTML = h + '</div>';
  }

  function drawSetup() {
    return '<div class="bd-card"><h3>Load the Schema Flow rules</h3>' +
      '<p>The builder uses Schema Flow’s own rules. They are internal, so they live in this private sheet, not in the dashboard’s code. Load the rules file once (and again only when Schema Flow is updated).</p>' +
      '<label class="bd-file">Rules file (.json)<input type="file" accept=".json,application/json" data-bd="rules-file"></label>' +
      '<p class="bd-hint">Adds a “builder rules” tab to the sheet. Only people with access to the sheet can read it.</p></div>';
  }

  function siteSection(site) {
    const open = !site || !site.taxId || !site.scope;
    const t = site && S.rules.tax.find(x => x.id === site.taxId);
    const groups = {};
    S.rules.tax.forEach(x => (groups[x.group] = groups[x.group] || []).push(x));
    const opts = Object.keys(groups).map(g => '<optgroup label="' + esc(g) + '">' + groups[g].map(x =>
      '<option value="' + esc(x.id) + '"' + (site && site.taxId === x.id ? ' selected' : '') + '>' + esc(x.id + ' · ' + x.name) + '</option>').join('') + '</optgroup>').join('');
    const saved = site ? Object.keys(site.vals).filter(k => site.vals[k]) : [];
    return '<details class="bd-sec"' + (open ? ' open' : '') + '><summary><span><b>Site settings</b><span class="bd-s">' +
      esc(site && t ? t.name + ' · ' + (SCOPES.find(s => s[0] === site.scope) || ['', ''])[1] : 'Set these once for ' + (S.base ? hostKey(S.base) : 'this site')) + '</span></span>' +
      '<span class="bd-chip ' + (open ? 'bd-chip-warn' : 'bd-chip-ok') + '">' + (open ? 'Needed' : 'Set') + '</span></summary><div class="bd-sec-b">' +
      (S.base ? '' : '<label>Site address<input type="url" id="bd-base" placeholder="https://www.example.com"></label>') +
      '<label>Business category (Taxonomy)<select id="bd-tax"><option value="">Choose…</option>' + opts + '</select></label>' +
      '<label>Locations customers visit<select id="bd-scope"><option value="">Choose…</option>' + SCOPES.map(s =>
        '<option value="' + s[0] + '"' + (site && site.scope === s[0] ? ' selected' : '') + '>' + esc(s[1]) + '</option>').join('') + '</select></label>' +
      (saved.length ? '<p class="bd-hint">Shared values for this site: ' + esc(saved.map(human).join(', ')) + '. They fill in automatically on every page.</p>' : '') +
      '<div class="bd-row"><button type="button" class="mini primary" data-bd="save-site"' + (S.busy ? ' disabled' : '') + '>Save site settings</button>' +
      '<span class="bd-hint">Saved in the “builder sites” tab for everyone.</span></div></div></details>';
  }

  function body(isNew) {
    const site = S.base && siteFor(S.base);
    let h = '';
    if (isNew) h += '<div class="bd-grid2"><label class="bd-span2">Page address<input type="url" id="bd-url" value="' + esc(S.url) + '" placeholder="https://www.example.com/page/"></label>' +
      '<label>Title (for the tracker)<input type="text" id="bd-title" value="' + esc(S.newTitle) + '"></label>' +
      '<label>Status<select id="bd-status">' + ['Draft', 'Live', ''].map(s => '<option value="' + s + '"' + (S.newStatus === s ? ' selected' : '') + '>' + (s || '(blank)') + '</option>').join('') + '</select></label></div>';
    if (!S.base) return h + (isNew ? '<p class="bd-note">Enter the page address to start.</p>' : siteSection(null));
    h += siteSection(site);
    if (!S.types) return h;
    if (!S.types.length) return h + '<p class="bd-note">Schema Flow has no templates for this category and site scope.</p>';
    const x = S.types[S.typeIdx];
    h += '<div class="bd-grid2"><label>Page type<select id="bd-type">' + S.types.map((y, i) =>
      '<option value="' + i + '"' + (i === S.typeIdx ? ' selected' : '') + '>' + esc(y.r.page + ' · ' + y.r.need) + '</option>').join('') + '</select></label>' +
      '<label class="bd-file">Fill from a saved page (.html)<input type="file" accept=".html,.htm,text/html" data-bd="html-file"></label></div>' +
      '<p class="bd-hint">Schema Flow: <b>' + esc(x.r.schema || '') + '</b>' + (x.r.note ? ' · ' + esc(x.r.note) : '') + '</p>';
    // fields
    h += '<details class="bd-sec" open><summary><span><b>Fill in</b><span class="bd-s">' + S.fields.length + ' value' + (S.fields.length === 1 ? '' : 's') + ' from the template</span></span></summary><div class="bd-sec-b">';
    h += S.fields.length ? S.fields.map(f => {
      const v = valueOf(f.key), from = S.vals[f.key] != null ? '' : f.site && site && site.vals[f.key] ? 'From site settings' : S.prefill[f.key] ? 'From the saved page' : f.pre ? 'From the latest version' : '';
      const long = /description|answer|text/.test(f.key);
      return '<label><span class="bd-lab">' + esc(human(f.key)) + (f.site ? ' <span class="bd-chip">Whole site</span>' : '') + '</span>' +
        (long ? '<textarea rows="3" data-key="' + esc(f.key) + '" placeholder="' + esc(f.hint ? 'e.g. ' + f.hint : '') + '">' + esc(v) + '</textarea>'
          : '<input type="text" data-key="' + esc(f.key) + '" value="' + esc(v) + '" placeholder="' + esc(f.hint ? 'e.g. ' + f.hint : '') + '">') +
        (from ? '<span class="bd-from">' + from + '</span>' : '') + '</label>';
    }).join('') : '<p class="bd-hint">This template has no placeholders.</p>';
    h += '</div></details>';
    if (S.hasCrumbs) h += '<details class="bd-sec"' + (S.crumbsOn ? ' open' : '') + '><summary><span><b>Breadcrumb</b><span class="bd-s">' + (S.crumbsOn ? esc(S.trail) : 'Not included') + '</span></span></summary><div class="bd-sec-b">' +
      '<label class="bd-check"><input type="checkbox" id="bd-crumbs"' + (S.crumbsOn ? ' checked' : '') + '> This page shows a breadcrumb trail</label>' +
      '<label>Steps, separated by &gt;<input type="text" id="bd-trail" value="' + esc(S.trail) + '"' + (S.crumbsOn ? '' : ' disabled') + '></label>' +
      '<p class="bd-hint">Schema Flow: add a breadcrumb only if the page shows one. Each step links to the matching part of the address; the last step is this page.</p></div></details>';
    if (S.notes.length || S.optional.length) h += '<details class="bd-sec"><summary><span><b>Schema Flow notes</b><span class="bd-s">' + (S.notes.length + S.optional.length) + ' item' + (S.notes.length + S.optional.length === 1 ? '' : 's') + '</span></span></summary><div class="bd-sec-b">' +
      (S.notes.length ? '<ul class="bd-list">' + S.notes.map(n => '<li>' + esc(n) + '</li>').join('') + '</ul>' : '') +
      (S.optional.length ? '<p class="bd-hint"><b>Optional (Supporting) properties</b>, add by hand in the JSON-LD if the page has them: ' + esc(S.optional.join(', ')) + '</p>' : '') + '</div></details>';
    // output
    const left = leftovers(S.out), ex = examples(S.out);
    h += '<div class="bd-out"><div class="bd-out-h"><b>JSON-LD</b><span class="bd-count" id="bd-count">' + countText(left, ex) + '</span>' +
      '<label class="bd-check"><input type="checkbox" id="bd-wrap"' + (S.wrap ? ' checked' : '') + '> Wrap in &lt;script&gt;</label></div>' +
      (S.manual ? '<p class="bd-warn">Edited by hand. Changing a field above won’t update it until you press <button type="button" class="mini" data-bd="rebuild">Rebuild from the fields</button></p>' : '') +
      '<textarea id="bd-out" class="bd-code" spellcheck="false" rows="18" aria-label="JSON-LD to save">' + esc(S.out) + '</textarea></div>';
    if (S.showDiff && S.curSchema) {
      const parsed = D.parse(S.out);
      const d = parsed.error ? { error: parsed.error } : D.compare(S.curSchema, parsed.value, { sort: true, context: 3, labels: { left: 'Current (' + S.cur.version + ')', right: 'Builder' } });
      h += '<div class="bd-diff">' + (d.error ? '<p class="bd-err">' + esc(d.error) + '</p>' : d.html) + '</div>';
    }
    const sameDay = S.cur && S.cur.date === today();
    h += '<div class="bd-row bd-actions"><button type="button" class="primary" data-bd="save"' + (S.busy ? ' disabled' : '') + '>' +
      (isNew ? 'Add page to the sheet' : sameDay ? 'Update today’s version' : 'Save as new version') + '</button>' +
      '<button type="button" data-bd="copy">Copy JSON-LD</button>' +
      (S.curSchema ? '<button type="button" data-bd="diff" aria-pressed="' + S.showDiff + '">' + (S.showDiff ? 'Hide comparison' : 'Compare with current') + '</button>' : '') +
      '<a href="https://validator.schema.org/" target="_blank" rel="noopener">Schema validator ↗</a></div>' +
      (S.msg ? '<p class="bd-msg" role="status">' + esc(S.msg) + '</p>' : '') +
      '<p class="bd-hint">Saving writes to the Google Sheet only, as ' + (isNew ? 'a new row' : sameDay ? 'today’s version (it already exists, so it is updated)' : 'today’s version') + '. Nothing goes to the website.</p>';
    return h;
  }
  const countText = (left, ex) => (left ? left + ' placeholder' + (left > 1 ? 's' : '') + ' left' : 'No placeholders left') +
    (ex ? ' · ' + ex + ' example value' + (ex > 1 ? 's' : '') + ' to check' : '');

  /* ---------- events ---------- */

  function refreshOut() {
    if (!S.manual) S.out = build();
    const ta = $('bd-out'); if (ta && !S.manual) ta.value = S.out;
    const c = $('bd-count'); if (c) c.textContent = countText(leftovers(S.out), examples(S.out));
  }

  function onInput(e) {
    const t = e.target;
    if (t.dataset.key) { S.vals[t.dataset.key] = t.value; const lab = t.parentElement.querySelector('.bd-from'); if (lab) lab.remove(); refreshOut(); }
    else if (t.id === 'bd-trail') { S.trail = t.value; refreshOut(); }
    else if (t.id === 'bd-out') { S.out = t.value; if (!S.manual) { S.manual = true; } const c = $('bd-count'); if (c) c.textContent = countText(leftovers(S.out), examples(S.out)); }
    else if (t.id === 'bd-title') S.newTitle = t.value;
  }

  async function onChange(e) {
    const t = e.target;
    if (t.id === 'bd-type') {
      S.typeIdx = +t.value; prepare(); S.out = build(); draw();
      try { localStorage.setItem('bd-type:' + S.url, S.types[S.typeIdx].r.page); } catch (er) { /* private window */ }
    } else if (t.id === 'bd-crumbs') { S.crumbsOn = t.checked; refreshOut(); draw(); }
    else if (t.id === 'bd-wrap') { S.wrap = t.checked; if (S.manual) { const json = S.out.replace(/^\s*<script[^>]*>\s*|\s*<\/script>\s*$/gi, ''); S.out = S.wrap ? '<script type="application/ld+json">\n' + json + '\n</script>' : json; } refreshOut(); draw(); }
    else if (t.id === 'bd-status') S.newStatus = t.value;
    else if (t.id === 'bd-url') {
      S.url = t.value.trim(); S.base = originOf(S.url); S.prefill = {};
      if (S.base) { await pickSite(); }
      draw();
    } else if (t.id === 'bd-base') { S.base = originOf(t.value.trim()); draw(); }
    else if (t.dataset.bd === 'rules-file' && t.files[0]) {
      S.busy = true; S.msg = ''; draw();
      try { await importRules(t.files[0]); await loadSites(); await pickSite(); S.msg = 'Rules loaded: ' + S.rules.meta.label + '.'; }
      catch (er) { S.err = 'Couldn’t load the rules: ' + er.message; }
      S.busy = false; draw();
    } else if (t.dataset.bd === 'html-file' && t.files[0]) {
      const doc = new DOMParser().parseFromString(await t.files[0].text(), 'text/html');
      const meta = n => ((doc.querySelector('meta[name="' + n + '"]') || doc.querySelector('meta[property="og:' + n + '"]') || {}).content || '').trim();
      const title = (doc.querySelector('title') || {}).textContent || '';
      S.prefill = { page_title: title.trim(), page_description: meta('description'), page_language: (doc.documentElement.getAttribute('lang') || '').trim() };
      Object.keys(S.prefill).forEach(k => { if (!S.prefill[k]) delete S.prefill[k]; else delete S.vals[k]; });
      S.out = build(); S.manual = false; draw();
      S.msg = 'Filled in from ' + t.files[0].name + ': ' + Object.keys(S.prefill).map(human).join(', ') + '.';
      draw();
    }
  }

  async function onClick(e) {
    const t = e.target.closest('[data-bd]');
    if (!t) return;
    const act = t.dataset.bd;
    if (act === 'close') close();
    else if (act === 'rebuild') { S.manual = false; S.out = build(); draw(); }
    else if (act === 'diff') { S.showDiff = !S.showDiff; draw(); }
    else if (act === 'copy') { try { await navigator.clipboard.writeText(S.out); S.msg = 'Copied the JSON-LD.'; } catch (er) { S.msg = 'Couldn’t copy. Select the text and copy it by hand.'; } draw(); }
    else if (act === 'save-site') {
      const base = S.base || originOf(($('bd-base') || {}).value || '');
      const taxId = $('bd-tax').value, scope = $('bd-scope').value;
      if (!base || !taxId || !scope) { S.msg = 'Choose the business category and the locations first.'; draw(); return; }
      S.busy = true; draw();
      try { await saveSite(base, { taxId: taxId, scope: scope }); S.base = base; S.msg = 'Site settings saved.'; await pickSite(); }
      catch (er) { S.err = 'Couldn’t save the site settings: ' + er.message; }
      S.busy = false; draw();
    } else if (act === 'save') save();
  }

  async function save() {
    const text = S.out.trim();
    const parsed = D.parse(text);
    if (parsed.error || parsed.empty) { S.msg = 'The JSON-LD doesn’t parse: ' + (parsed.error || 'it is empty') + '.'; draw(); return; }
    if (text.length > 50000) { S.msg = 'Too long for one sheet cell (50,000 characters).'; draw(); return; }
    const left = leftovers(text), ex = examples(text);
    if ((left || ex) && !window.confirm((left ? left + ' placeholder' + (left > 1 ? 's are' : ' is') + ' still empty' : '') + (left && ex ? ' and ' : '') +
      (ex ? ex + ' example value' + (ex > 1 ? 's' : '') + ' from Schema Flow (like logo.png) still in it' : '') + '. Save anyway?')) return;
    const A = app(), isNew = !S.page;
    if (isNew) {
      if (!/^https?:\/\//.test(S.url)) { S.msg = 'Enter the full page address first.'; draw(); return; }
      if (A.getPage && A.getPage(S.url)) { S.msg = 'That page is already in this tab. Open it from the list instead.'; draw(); return; }
    } else if (S.cur.date === today() && !window.confirm('This page already has a version dated today. Replace it with this one?')) return;
    S.busy = true; S.msg = 'Saving…'; draw();
    const done = async err => {
      if (err) { S.busy = false; S.msg = 'Couldn’t save: ' + err.message; draw(); return; }
      // Values that are the same on every page go to the site settings.
      const vals = {};
      S.fields.filter(f => f.site).forEach(f => { const v = valueOf(f.key); if (v) vals[f.key] = v; });
      if (Object.keys(vals).length) await saveSite(S.base, { vals: vals }).catch(() => {});
      S.busy = false; close();
      const tt = $('toast'); if (tt) { tt.textContent = isNew ? 'Added to the sheet' : 'Saved as today’s version'; tt.classList.add('show'); setTimeout(() => tt.classList.remove('show'), 2400); }
    };
    if (isNew) A.onAddPage({ url: S.url, title: S.newTitle, status: S.newStatus, text: text }, done);
    else A.onSaveSchema({ page: S.page, cur: S.cur, mode: S.cur.date === today() ? 'fix' : 'new', text: text }, done);
  }

  document.addEventListener('click', e => {
    const b = e.target.closest('.open-builder');
    if (b) { e.preventDefault(); openFor(b.dataset.url); }
    else if (e.target.closest('#bd-new')) openFor('');
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.open && !e.defaultPrevented) close(); });
  document.addEventListener('sheet-connected', () => { S.connected = true; const b = $('bd-new'); if (b) b.hidden = false; });
  window.SchemaBuilder = { open: openFor };
})();
