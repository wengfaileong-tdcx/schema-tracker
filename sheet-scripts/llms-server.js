/* ============================================================
   llms.txt for the Schema Tracker: Apps Script side.

   The dashboard's llms.txt tab never fetches websites itself. It adds a
   request row to the "llms queue" tab; this script (running every
   minute on the sheet, as the person who installed it) picks the
   request up, fetches the pages, and writes the results back into the
   sheet. Finished llms.txt / llms-full.txt copies go to a Drive folder.

   Tabs it uses (created by llmsSetup):
     llms sites  one row per website (address, staging, sitemap, intro)
     llms pages  one row per page (text as Markdown, previous text)
     llms queue  requests from the dashboard and the weekly check
     llms files  your edited versions of llms.txt / llms-full.txt
                 (added by the dashboard the first time you save one)

   Install (once, by someone with edit access to the sheet):
     1. Sheet -> Extensions -> Apps Script.
     2. Add a new file (+ -> Script), name it "llms", paste this whole
        file. Keep your existing Code.gs (LIVE_FAQ etc.) as it is.
     3. Check LLMS_DRIVE_FOLDER_ID below, then Save.
     4. Choose llmsSetup in the function list at the top, press Run, and
        allow the permissions it asks for (fetch websites, edit this
        sheet, create files in Drive, run on a timer).
   llmsSetup adds the tabs, fills in the four sites, and sets up the
   every-minute and every-Monday timers. Running it again is safe.

   The script respects robots.txt and never tries to get past bot
   protection: a blocked page is marked "Couldn't fetch" and keeps its
   last good text. Use Upload in the dashboard for those pages.
   ============================================================ */

var LLMS_DRIVE_FOLDER_ID = '1qoE4dyUpW2Rfxt_ZUvprG5AH3Uxgtbik';
var LLMS_AGENT = 'SchemaTrackerBot/1.0 (+https://schema-tracker.llmsource.com)';
var LLMS_BUDGET_MS = 4.5 * 60 * 1000;   // Apps Script stops a run at 6 minutes
var LLMS_BATCH = 5;                      // pages fetched at the same time
var LLMS_CELL = 49000;                   // a cell holds 50,000 characters

var LLMS_TAB = { sites: 'llms sites', pages: 'llms pages', queue: 'llms queue' };
var LLMS_COLS = {
  sites: ['Site ID', 'Name', 'Live URL', 'Staging URL', 'Sitemap', 'llms.txt URL', 'Exclude paths', 'Sections', 'Page links in llms.txt', 'Intro'],
  pages: ['Site ID', 'URL', 'Title', 'Description', 'Text from', 'Added by hand', 'Removed', 'In sitemap', 'Last changed', 'Last checked', 'Last error', 'Markdown', 'Markdown 2', 'Previous', 'Previous 2', 'Edited from', 'Edited from 2'],
  queue: ['ID', 'Requested at', 'Requested by', 'Site ID', 'Action', 'URLs', 'Status', 'Progress', 'Finished at', 'Result']
};
var LLMS_SEED_SITES = [
  ['llmsource', 'LLMSource', 'https://llmsource.com', '', 'https://llmsource.com/sitemap.xml', 'https://llmsource.com/llms.txt', '', 'ai-diagnostic=AI Diagnostic', 'yes', ''],
  ['tdcx', 'TDCX', 'https://www.tdcx.com', '', 'https://www.tdcx.com/sitemap.xml', 'https://www.tdcx.com/llms.txt', '', '', 'yes', ''],
  ['chemin', 'Chemin', 'https://chemin.com', '', 'https://chemin.com/sitemap.xml', 'https://chemin.com/llms.txt', '', '', 'yes', ''],
  ['tdcxai', 'TDCX AI', 'https://tdcx.ai', '', 'https://tdcx.ai/sitemap.xml', 'https://tdcx.ai/llms.txt', '', '', 'yes', '']
];

/* ---------- setup ---------- */

function llmsSetup() {
  var ss = SpreadsheetApp.getActive();
  Object.keys(LLMS_TAB).forEach(function (k) {
    var sh = ss.getSheetByName(LLMS_TAB[k]) || ss.insertSheet(LLMS_TAB[k]);
    sh.getRange(1, 1, sh.getMaxRows(), Math.max(sh.getMaxColumns(), LLMS_COLS[k].length)).setNumberFormat('@');
    sh.getRange(1, 1, 1, LLMS_COLS[k].length).setValues([LLMS_COLS[k]]).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (k === 'sites' && sh.getLastRow() < 2) sh.getRange(2, 1, LLMS_SEED_SITES.length, LLMS_COLS.sites.length).setValues(LLMS_SEED_SITES);
  });
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (/^llms(Tick|Weekly)$/.test(t.getHandlerFunction())) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('llmsTick').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('llmsWeekly').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).create();
  DriveApp.getFolderById(LLMS_DRIVE_FOLDER_ID).getName();   // asks for Drive permission now, not on the first save
  llmsTick();
}

function llmsWeekly() {
  llmsSites_().forEach(function (s) { llmsEnqueue_(s.id, 'check', '', 'Weekly check'); });
}

/* ---------- sheet helpers ---------- */

function llmsSheet_(k) {
  var sh = SpreadsheetApp.getActive().getSheetByName(LLMS_TAB[k]);
  if (!sh) throw new Error('Missing the "' + LLMS_TAB[k] + '" tab. Run llmsSetup once.');
  return sh;
}
function llmsRows_(k) {
  var sh = llmsSheet_(k), n = sh.getLastRow();
  return n < 2 ? [] : sh.getRange(2, 1, n - 1, LLMS_COLS[k].length).getValues();
}
function llmsNow_() { return new Date().toISOString(); }
function llmsYes_(v) { return /^(y|yes|true|1)$/i.test(String(v).trim()); }

function llmsSites_() {
  return llmsRows_('sites').filter(function (r) { return r[0] && r[2]; }).map(function (r) {
    return {
      id: String(r[0]).trim(), name: String(r[1] || r[0]), base: LlmsCore.normUrl(r[2]), staging: String(r[3] || '').trim(),
      sitemap: String(r[4] || '').trim(), llmsTxt: String(r[5] || '').trim(),
      exclude: String(r[6] || '').split(/[,\n]/).map(function (x) { return x.trim(); }).filter(Boolean),
      sections: LlmsCore.parseSections(r[7]), links: !/^(n|no|false|0)$/i.test(String(r[8]).trim()), intro: String(r[9] || '')
    };
  });
}

function llmsEnqueue_(siteId, action, urls, by) {
  var id = 'w' + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
  llmsSheet_('queue').appendRow([id, llmsNow_(), by || '', siteId, action, urls || '', 'Waiting', '', '', '']);
}

// Pages for one site, with where each row lives in the sheet.
function llmsPages_(siteId) {
  return llmsRows_('pages').map(function (r, i) { return { row: i + 2, v: r }; })
    .filter(function (x) { return String(x.v[0]) === siteId; })
    .map(function (x) {
      var v = x.v;
      return {
        row: x.row, url: String(v[1]), title: String(v[2]), description: String(v[3]), from: String(v[4]),
        added: llmsYes_(v[5]), removed: llmsYes_(v[6]), inSitemap: String(v[7]),
        markdown: String(v[11] || '') + String(v[12] || ''), editBase: String(v[15] || '') + String(v[16] || ''), raw: v
      };
    });
}
function llmsSplit_(s) { s = String(s || ''); return [s.slice(0, LLMS_CELL), s.slice(LLMS_CELL, LLMS_CELL * 2)]; }

/* ---------- the queue ---------- */

function llmsTick() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return;
  try {
    var started = Date.now();
    while (Date.now() - started < LLMS_BUDGET_MS) {
      var q = llmsRows_('queue'), idx = -1;
      for (var i = 0; i < q.length; i++) if (q[i][6] === 'Running' || q[i][6] === 'Waiting') { idx = i; break; }
      if (idx < 0) return;
      var job = { row: idx + 2, id: String(q[idx][0]), by: String(q[idx][2]), site: String(q[idx][3]), action: String(q[idx][4]), urls: String(q[idx][5]) };
      var done = llmsRun_(job, started);
      if (!done) return;   // out of time; the next tick carries on
    }
  } finally {
    lock.releaseLock();
  }
}

function llmsSetJob_(job, status, progress, result) {
  var sh = llmsSheet_('queue');
  sh.getRange(job.row, 7, 1, 2).setValues([[status, progress || '']]);
  if (status === 'Done' || status === 'Failed') sh.getRange(job.row, 9, 1, 2).setValues([[llmsNow_(), JSON.stringify(result || {}).slice(0, LLMS_CELL)]]);
}

// Returns true when the job is finished (done or failed).
function llmsRun_(job, started) {
  var props = PropertiesService.getScriptProperties(), key = 'llms-job-' + job.id;
  try {
    if (job.action === 'find-urls') {
      llmsSetJob_(job, 'Done', '', llmsFindUrls_(job.urls.trim()));
      return true;
    }
    if (job.action === 'page-read') {
      llmsSetJob_(job, 'Done', '', llmsReadPage_(job.urls.trim()));
      return true;
    }
    var site = llmsSites_().filter(function (s) { return s.id === job.site; })[0];
    if (!site) throw new Error('No site "' + job.site + '" in the "llms sites" tab.');
    var urls = job.urls.split(/[\s,]+/).filter(Boolean);
    if (job.action === 'remove' || job.action === 'restore') {
      llmsMark_(site, urls, job.action === 'remove');
      llmsSetJob_(job, 'Done', '', { action: job.action, results: urls.map(function (u) { return { u: LlmsCore.normUrl(u), s: job.action === 'remove' ? 'removed' : 'restored' }; }) });
      return true;
    }
    if (job.action === 'save-drive') {
      llmsSetJob_(job, 'Done', '', llmsSaveDrive_(site, job.urls.trim()));
      return true;
    }
    if (job.action !== 'update' && job.action !== 'check' && job.action !== 'add') throw new Error('Unknown action "' + job.action + '"');

    var state = JSON.parse(props.getProperty(key) || 'null');
    if (!state) state = llmsPlan_(site, job, urls);
    llmsSetJob_(job, 'Running', state.i + ' / ' + state.targets.length);
    var write = job.action !== 'check';
    var pages = llmsPages_(site.id), byUrl = {};
    pages.forEach(function (p) { byUrl[p.url] = p; });

    while (state.i < state.targets.length) {
      if (Date.now() - started > LLMS_BUDGET_MS) {
        props.setProperty(key, JSON.stringify(state));
        llmsSetJob_(job, 'Running', state.i + ' / ' + state.targets.length);
        return false;
      }
      var batch = state.targets.slice(state.i, state.i + LLMS_BATCH);
      var res = llmsFetchMany_(site, batch, state.robots);
      res.forEach(function (r) {
        var p = byUrl[r.u];
        var item = { u: r.u, t: r.title || (p && p.title) || '' };
        if (r.error) { item.s = 'failed'; item.e = r.error; }
        else item.s = !p || !p.markdown ? 'new' : (p.editBase || p.markdown) === r.md ? 'same' : 'changed';
        if (write) byUrl[r.u] = llmsSave_(site, p, r, item, job.action === 'add');
        state.results.push(item);
      });
      state.i += batch.length;
      llmsSetJob_(job, 'Running', state.i + ' / ' + state.targets.length);
      Utilities.sleep(500);
    }

    if (write && state.discovered) llmsSitemapFlags_(site, state.discovered);
    var counts = {};
    state.results.forEach(function (r) { counts[r.s] = (counts[r.s] || 0) + 1; });
    var results = state.results;
    if (JSON.stringify(results).length > 45000) results = results.filter(function (r) { return r.s !== 'same'; });
    llmsSetJob_(job, 'Done', state.targets.length + ' / ' + state.targets.length,
      { action: job.action, scope: state.discovered ? 'all' : 'selected', counts: counts, results: results, trimmed: results.length < state.results.length });
    props.deleteProperty(key);
    return true;
  } catch (e) {
    props.deleteProperty(key);
    llmsSetJob_(job, 'Failed', '', { error: String(e.message || e) });
    return true;
  }
}

// Which pages a run looks at, and the site's robots.txt rules.
function llmsPlan_(site, job, urls) {
  var pages = llmsPages_(site.id);
  var onSite = urls.map(function (u) { return LlmsCore.normUrl(u); }).filter(function (u) { return u && LlmsCore.sameSite(u, site.base); });
  var state = { i: 0, results: [], targets: [], discovered: null };
  urls.filter(function (u) { var n = LlmsCore.normUrl(u); return !n || !LlmsCore.sameSite(n, site.base); })
    .forEach(function (u) { state.results.push({ u: u, s: 'failed', e: 'Not an address on ' + LlmsCore.host(site.base) }); });
  if (onSite.length) {
    state.targets = onSite.filter(function (u, i) { return onSite.indexOf(u) === i; });
  } else {
    var found = llmsSitemapUrls_(site.sitemap, 0).concat(llmsLlmsTxtUrls_(site.llmsTxt))
      .map(function (u) { return LlmsCore.normUrl(u); })
      .filter(function (u) { return u && LlmsCore.sameSite(u, site.base) && !site.exclude.some(function (x) { return LlmsCore.pathOf(u).indexOf(x) === 0; }); });
    var seen = {};
    found = found.filter(function (u) { return seen[u] ? false : (seen[u] = true); });
    state.discovered = found;
    var removed = {};
    pages.forEach(function (p) { if (p.removed) removed[p.url] = true; });
    var list = pages.filter(function (p) { return !p.removed; }).map(function (p) { return p.url; });
    found.forEach(function (u) { if (!removed[u] && list.indexOf(u) < 0) list.push(u); });
    state.targets = list;
  }
  var robots = llmsGet_(LlmsCore.normUrl(site.base) + '/robots.txt');
  state.robots = robots.status === 200 ? LlmsCore.robotsRules(robots.body, 'schematrackerbot') : [];
  return state;
}

/* ---------- fetching ---------- */

function llmsGet_(url) {
  try {
    var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': LLMS_AGENT } });
    return { status: r.getResponseCode(), body: r.getContentText(), type: String(r.getHeaders()['Content-Type'] || '') };
  } catch (e) { return { status: 0, error: String(e.message || e) }; }
}

function llmsSitemapUrls_(url, depth) {
  if (!url || depth > 2) return [];
  var r = llmsGet_(url);
  if (r.status !== 200) return [];
  var locs = [], re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi, m;
  while ((m = re.exec(r.body))) locs.push(m[1].replace(/&amp;/g, '&'));
  if (/<sitemapindex/i.test(r.body)) return [].concat.apply([], locs.map(function (l) { return llmsSitemapUrls_(l, depth + 1); }));
  return locs;
}
function llmsLlmsTxtUrls_(url) {
  if (!url) return [];
  var r = llmsGet_(url);
  if (r.status !== 200 || !/text\/plain|markdown/i.test(r.type)) return [];
  var out = [], re = /\]\((https?:\/\/[^)\s]+)\)/g, m;
  while ((m = re.exec(r.body))) out.push(m[1]);
  return out;
}

function llmsFetchMany_(site, urls, robots) {
  var out = urls.map(function (u) { return { u: u }; });
  var ask = [];
  out.forEach(function (o, i) {
    if (!LlmsCore.robotsAllow(robots || [], o.u)) o.error = 'robots.txt asks crawlers not to visit this page';
    else ask.push(i);
  });
  if (!ask.length) return out;
  var resp;
  try {
    resp = UrlFetchApp.fetchAll(ask.map(function (i) {
      return { url: out[i].u, muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': LLMS_AGENT } };
    }));
  } catch (e) {
    ask.forEach(function (i) { out[i].error = 'Couldn’t reach the page: ' + (e.message || e); });
    return out;
  }
  ask.forEach(function (i, k) {
    var r = resp[k], o = out[i], code = r.getResponseCode(), body = r.getContentText(), type = String(r.getHeaders()['Content-Type'] || '');
    if (LlmsCore.looksBlocked(code, body)) o.error = 'Blocked by bot protection (e.g. Cloudflare). Not bypassed. Upload the page instead; last good text kept.';
    else if (code !== 200) o.error = 'HTTP ' + code;
    else if (!/html/i.test(type)) o.error = 'Not an HTML page (' + (type || 'unknown type') + ')';
    else {
      var x = LlmsCore.toMarkdown(body, o.u);
      if (!x.md || x.md.length < 40) o.error = 'Page has almost no text in its HTML (it may load with JavaScript). Upload the page instead.';
      else { o.md = x.md; o.title = LlmsCore.shortTitle(x.title, site.name) || x.h1 || o.u; o.description = x.description; }
    }
  });
  return out;
}

/* ---------- schema builder: read one live page ---------- */

// For the dashboard's schema builder ("Fill from the live page"): the page's
// JSON-LD blocks, title, description and language, as the site serves them.
// Same rules as fetching for llms.txt: robots.txt is respected and bot
// protection is never bypassed.
function llmsReadPage_(url) {
  var u = LlmsCore.normUrl(url);
  if (!u) return { action: 'page-read', url: url, error: 'Not a page address.' };
  var robots = llmsGet_(u.replace(/^(https?:\/\/[^\/]+).*$/, '$1') + '/robots.txt');
  if (robots.status === 200 && !LlmsCore.robotsAllow(LlmsCore.robotsRules(robots.body, 'schematrackerbot'), u))
    return { action: 'page-read', url: url, error: 'robots.txt asks crawlers not to visit this page.' };
  var r = llmsGet_(url);
  if (r.error) return { action: 'page-read', url: url, error: 'Couldn’t reach the page: ' + r.error };
  if (LlmsCore.looksBlocked(r.status, r.body)) return { action: 'page-read', url: url, error: 'Blocked by bot protection (e.g. Cloudflare). Not bypassed. Use a saved copy of the page instead.' };
  if (r.status !== 200) return { action: 'page-read', url: url, error: 'HTTP ' + r.status };
  var html = r.body, ld = [], m, re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = re.exec(html))) ld.push(m[1].trim());
  var attr = function (tagRe, name) { var t = html.match(tagRe); if (!t) return ''; var a = t[0].match(new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i')); return a ? (a[2] || a[3] || '') : ''; };
  var unesc = function (s) { return String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim(); };
  var title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  var out = {
    action: 'page-read', url: url,
    title: unesc(title.replace(/\s+/g, ' ')),
    description: unesc(attr(/<meta[^>]+name\s*=\s*["']description["'][^>]*>/i, 'content')),
    lang: unesc(attr(/<html[^>]*>/i, 'lang')),
    ld: ld
  };
  // The Result cell holds about 49,000 characters; keep whole blocks only.
  while (JSON.stringify(out).length > 45000 && out.ld.length) { out.ld.pop(); out.trimmed = true; }
  return out;
}

// For the schema builder's "Find new pages": every page address in the
// site's sitemap(s), with its lastmod, written to the "builder urls" tab
// (Site | URL | Last modified | Found at), replacing that site's old list.
var LLMS_URLS_TAB = 'builder urls', LLMS_URLS_MAX = 5000;
function llmsFindUrls_(origin) {
  var base = LlmsCore.normUrl(origin);
  if (!base) return { action: 'find-urls', error: 'Not a site address.' };
  base = base.replace(/^(https?:\/\/[^\/]+).*$/, '$1');
  var maps = [];
  try { llmsSites_().forEach(function (s) { if (s.sitemap && LlmsCore.sameSite(s.base, base)) maps.push(s.sitemap); }); } catch (e) { /* no llms sites tab */ }
  var rb = llmsGet_(base + '/robots.txt');
  if (rb.status === 200) String(rb.body).replace(/^\s*sitemap:\s*(\S+)/gim, function (m, u) { maps.push(u); return m; });
  if (!maps.length) maps.push(base + '/sitemap.xml');
  maps = maps.filter(function (u, i) { return maps.indexOf(u) === i; });
  var found = {}, list = [], errors = [];
  function walk(url, depth) {
    if (depth > 3 || list.length >= LLMS_URLS_MAX) return;
    var r = llmsGet_(url);
    if (r.status !== 200 || LlmsCore.looksBlocked(r.status, r.body)) { errors.push(url + ': ' + (LlmsCore.looksBlocked(r.status, r.body || '') ? 'blocked by bot protection' : 'HTTP ' + r.status)); return; }
    var body = String(r.body), m;
    if (/<sitemapindex/i.test(body)) {
      var re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
      while ((m = re.exec(body))) walk(m[1].replace(/&amp;/g, '&'), depth + 1);
      return;
    }
    var ure = /<url>([\s\S]*?)<\/url>/gi;
    while ((m = ure.exec(body)) && list.length < LLMS_URLS_MAX) {
      var loc = (m[1].match(/<loc>\s*([^<\s]+)\s*<\/loc>/i) || [])[1], mod = (m[1].match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i) || [])[1] || '';
      var u = loc && LlmsCore.normUrl(loc.replace(/&amp;/g, '&'));
      if (u && LlmsCore.sameSite(u, base) && !found[u]) { found[u] = true; list.push([base, loc.replace(/&amp;/g, '&'), mod]); }
    }
  }
  maps.forEach(function (u) { walk(u, 0); });
  if (!list.length) return { action: 'find-urls', site: base, error: 'No pages found in ' + maps.join(', ') + (errors.length ? ' (' + errors.slice(0, 3).join('; ') + ')' : '') };
  var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName(LLMS_URLS_TAB);
  var head = ['Site', 'URL', 'Last modified', 'Found at'];
  if (!sh) { sh = ss.insertSheet(LLMS_URLS_TAB); sh.getRange(1, 1, 1, 4).setValues([head]).setFontWeight('bold'); sh.setFrozenRows(1); }
  var keep = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().filter(function (r) { return r[0] && !LlmsCore.sameSite(String(r[0]), base); }) : [];
  var now = llmsNow_(), rows = keep.concat(list.map(function (x) { return [x[0], x[1], x[2], now]; }));
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 4).clearContent();
  sh.getRange(2, 1, rows.length, 4).setNumberFormat('@').setValues(rows);
  return { action: 'find-urls', site: base, sitemaps: maps, count: list.length, capped: list.length >= LLMS_URLS_MAX, problems: errors.slice(0, 5) };
}

/* ---------- writing pages ---------- */

function llmsSave_(site, p, r, item, byHand) {
  var sh = llmsSheet_('pages'), now = llmsNow_();
  var row = p ? p.raw.slice() : [site.id, r.u, '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''];
  while (row.length < LLMS_COLS.pages.length) row.push('');
  if (byHand) { row[5] = 'yes'; row[6] = ''; }
  row[9] = now;
  if (r.error) { row[10] = r.error; }
  else {
    row[2] = r.title; row[3] = r.description || ''; row[10] = '';
    if (item.s === 'new' || item.s === 'changed') {
      var prev = llmsSplit_(p ? p.markdown : ''), md = r.md;
      row[4] = 'live fetch'; row[8] = now;
      if (p && p.editBase) {
        // You edited this page by hand: merge the page's changes into your text.
        var m = LlmsCore.mergePage(p.editBase, p.markdown, r.md), base = llmsSplit_(r.md);
        md = m.md; row[4] = 'live fetch + your edits'; row[15] = base[0]; row[16] = base[1];
        if (m.conflicts) { row[10] = LlmsCore.reviewNote(m.conflicts); item.review = m.conflicts; }
      }
      var cur = llmsSplit_(md);
      row[11] = cur[0]; row[12] = cur[1]; row[13] = prev[0]; row[14] = prev[1];
      if (md.length > LLMS_CELL * 2) row[10] = 'Text cut at ' + LLMS_CELL * 2 + ' characters';
    } else if (p && /^Review:/.test(String(p.raw[10] || ''))) {
      row[10] = p.raw[10];   // keep the review note until someone saves the page
    }
  }
  if (p) sh.getRange(p.row, 1, 1, row.length).setValues([row]);
  else { sh.appendRow(row); }
  var rowNum = p ? p.row : sh.getLastRow();
  return { row: rowNum, url: r.u, title: row[2], markdown: String(row[11]) + String(row[12]), editBase: String(row[15] || '') + String(row[16] || ''), removed: llmsYes_(row[6]), raw: row };
}

function llmsMark_(site, urls, removed) {
  var sh = llmsSheet_('pages'), pages = llmsPages_(site.id);
  urls.map(function (u) { return LlmsCore.normUrl(u); }).filter(Boolean).forEach(function (u) {
    var p = pages.filter(function (x) { return x.url === u; })[0];
    if (p) sh.getRange(p.row, 7).setValue(removed ? 'yes' : '');
    else if (removed) sh.appendRow([site.id, u, '', '', '', '', 'yes', '', '', '', '', '', '', '', '']);
  });
}

function llmsSitemapFlags_(site, discovered) {
  var sh = llmsSheet_('pages');
  llmsPages_(site.id).forEach(function (p) {
    var v = discovered.indexOf(p.url) > -1 ? 'yes' : 'no';
    if (p.inSitemap !== v) sh.getRange(p.row, 8).setValue(v);
  });
}

/* ---------- Drive ---------- */

// The dashboard writes the exact text to save (including any edited
// version) into the "llms files" tab under an export id; without one the
// files are built from the saved pages.
function llmsExport_(siteId, exportId) {
  var sh = SpreadsheetApp.getActive().getSheetByName('llms files');
  if (!exportId || !sh || sh.getLastRow() < 2) return null;
  var parts = {};
  sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues().forEach(function (r) {
    if (String(r[0]) === siteId && String(r[2]) === exportId && String(r[3]) === 'export') (parts[r[1]] = parts[r[1]] || []).push([+r[6] || 0, String(r[7])]);
  });
  var out = {};
  Object.keys(parts).forEach(function (f) { out[f] = parts[f].sort(function (a, b) { return a[0] - b[0]; }).map(function (p) { return p[1]; }).join(''); });
  return out['llms.txt'] != null && out['llms-full.txt'] != null ? out : null;
}

function llmsSaveDrive_(site, exportId) {
  var pages = llmsPages_(site.id).filter(function (p) { return !p.removed && p.markdown; });
  var exp = llmsExport_(site.id, exportId);
  if (!pages.length && !exp) throw new Error('No saved pages for ' + site.name + ' yet.');
  var root = DriveApp.getFolderById(LLMS_DRIVE_FOLDER_ID);
  var it = root.getFoldersByName(site.name), folder = it.hasNext() ? it.next() : root.createFolder(site.name);
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HHmm');
  var files = [
    ['llms.txt', exp ? exp['llms.txt'] : LlmsCore.buildLlmsTxt(site, pages)],
    ['llms-full.txt', exp ? exp['llms-full.txt'] : LlmsCore.buildLlmsFull(site, pages)]
  ].map(function (f) {
    var file = folder.createFile(stamp + ' ' + f[0], f[1], 'text/plain');
    return { name: file.getName(), url: file.getUrl(), size: f[1].length };
  });
  return { action: 'save-drive', folder: folder.getUrl(), files: files };
}
