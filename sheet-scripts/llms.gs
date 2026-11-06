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
  pages: ['Site ID', 'URL', 'Title', 'Description', 'Text from', 'Added by hand', 'Removed', 'In sitemap', 'Last changed', 'Last checked', 'Last error', 'Markdown', 'Markdown 2', 'Previous', 'Previous 2'],
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
        markdown: String(v[11] || '') + String(v[12] || ''), raw: v
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
    var site = llmsSites_().filter(function (s) { return s.id === job.site; })[0];
    if (!site) throw new Error('No site "' + job.site + '" in the "llms sites" tab.');
    var urls = job.urls.split(/[\s,]+/).filter(Boolean);
    if (job.action === 'remove' || job.action === 'restore') {
      llmsMark_(site, urls, job.action === 'remove');
      llmsSetJob_(job, 'Done', '', { action: job.action, results: urls.map(function (u) { return { u: LlmsCore.normUrl(u), s: job.action === 'remove' ? 'removed' : 'restored' }; }) });
      return true;
    }
    if (job.action === 'save-drive') {
      llmsSetJob_(job, 'Done', '', llmsSaveDrive_(site));
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
        else item.s = !p || !p.markdown ? 'new' : p.markdown === r.md ? 'same' : 'changed';
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

/* ---------- writing pages ---------- */

function llmsSave_(site, p, r, item, byHand) {
  var sh = llmsSheet_('pages'), now = llmsNow_();
  var row = p ? p.raw.slice() : [site.id, r.u, '', '', '', '', '', '', '', '', '', '', '', '', ''];
  while (row.length < LLMS_COLS.pages.length) row.push('');
  if (byHand) { row[5] = 'yes'; row[6] = ''; }
  row[9] = now;
  if (r.error) { row[10] = r.error; }
  else {
    row[2] = r.title; row[3] = r.description || ''; row[10] = '';
    if (item.s === 'new' || item.s === 'changed') {
      var prev = llmsSplit_(p ? p.markdown : ''), cur = llmsSplit_(r.md);
      row[4] = 'live fetch'; row[8] = now;
      row[11] = cur[0]; row[12] = cur[1]; row[13] = prev[0]; row[14] = prev[1];
      if (r.md.length > LLMS_CELL * 2) row[10] = 'Text cut at ' + LLMS_CELL * 2 + ' characters';
    }
  }
  if (p) sh.getRange(p.row, 1, 1, row.length).setValues([row]);
  else { sh.appendRow(row); }
  var rowNum = p ? p.row : sh.getLastRow();
  return { row: rowNum, url: r.u, title: row[2], markdown: String(row[11]) + String(row[12]), removed: llmsYes_(row[6]), raw: row };
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

function llmsSaveDrive_(site) {
  var pages = llmsPages_(site.id).filter(function (p) { return !p.removed && p.markdown; });
  if (!pages.length) throw new Error('No saved pages for ' + site.name + ' yet.');
  var root = DriveApp.getFolderById(LLMS_DRIVE_FOLDER_ID);
  var it = root.getFoldersByName(site.name), folder = it.hasNext() ? it.next() : root.createFolder(site.name);
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HHmm');
  var files = [
    ['llms.txt', LlmsCore.buildLlmsTxt(site, pages)],
    ['llms-full.txt', LlmsCore.buildLlmsFull(site, pages)]
  ].map(function (f) {
    var file = folder.createFile(stamp + ' ' + f[0], f[1], 'text/plain');
    return { name: file.getName(), url: file.getUrl(), size: f[1].length };
  });
  return { action: 'save-drive', folder: folder.getUrl(), files: files };
}

/* ============================================================
   Shared with the dashboard (assets/llms-core.js). Generated by
   scripts/build-llms-gs.mjs; edit that file, not this copy.
   ============================================================ */

/* llms core: HTML → Markdown, and building llms.txt / llms-full.txt.
   Plain JavaScript with no browser or Node APIs, so the same code runs
   in the dashboard (uploads, downloads) and in the sheet's Apps Script
   (fetching live pages). sheet-scripts/llms.gs embeds a copy of this
   file; after changing it, run: node scripts/build-llms-gs.mjs */
var LlmsCore = (function () {

  /* ---------- URLs ---------- */

  function normUrl(u, base) {
    u = String(u || '').trim();
    if (!u) return null;
    var abs;
    if (/^https?:\/\//i.test(u)) abs = u;
    else if (/^\/\//.test(u)) abs = 'https:' + u;
    else if (base && /^\//.test(u)) abs = origin(base) + u;
    else if (base && !/^[a-z][a-z0-9+.-]*:/i.test(u) && u.charAt(0) !== '#') abs = origin(base) + '/' + u.replace(/^\.\//, '');
    else return null;
    var m = abs.match(/^(https?):\/\/([^\/?#]+)([^?#]*)/i);
    if (!m) return null;
    var path = m[3] || '/';
    if (path.length > 1) path = path.replace(/\/+$/, '');
    return m[1].toLowerCase() + '://' + m[2].toLowerCase() + path;
  }
  function origin(u) { var m = String(u).match(/^(https?:\/\/[^\/?#]+)/i); return m ? m[1].toLowerCase() : ''; }
  function host(u) { var m = String(u || '').match(/^https?:\/\/([^\/?#:]+)/i); return m ? m[1].toLowerCase().replace(/^www\./, '') : ''; }
  function pathOf(u) { var m = String(u || '').match(/^https?:\/\/[^\/?#]+([^?#]*)/i); return (m && m[1]) || '/'; }
  function sameSite(u, base) { return !!host(u) && host(u) === host(base); }
  // A staging (or any other host's) address → the same path on the live site.
  function toLive(u, liveBase) { var n = normUrl(u); return n ? normUrl(origin(liveBase) + pathOf(n)) : null; }

  /* ---------- tolerant HTML parser ---------- */

  var VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, source: 1, track: 1, wbr: 1 };
  var RAW_DROP = /<(script|style|noscript|template|svg|iframe|canvas|video|audio|object|math)\b[\s\S]*?<\/\1\s*>/gi;
  var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
    mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•',
    laquo: '«', raquo: '»', times: '×', deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢', zwj: '', zwnj: '', shy: '' };

  function decode(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, e) {
      if (e.charAt(0) === '#') {
        var n = e.charAt(1).toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { return n ? String.fromCodePoint(n) : ''; } catch (x) { return ''; }
      }
      var k = e.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENT, k) ? ENT[k] : m;
    });
  }

  function parseAttrs(s) {
    var a = {}, re = /([^\s=\/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g, m;
    while ((m = re.exec(s))) a[m[1].toLowerCase()] = decode(m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : '');
    return a;
  }

  // Elements that end an open element of the listed kinds when they start.
  var AUTO_CLOSE = { li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], tr: ['tr', 'td', 'th'], td: ['td', 'th'], th: ['td', 'th'], option: ['option'] };
  var P_ENDERS = /^(p|div|ul|ol|h[1-6]|table|section|article|header|footer|blockquote|pre|form|nav|aside|main|figure|dl|hr)$/;

  function parse(html) {
    html = String(html || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(RAW_DROP, '');
    var root = { tag: '#root', attrs: {}, children: [], parent: null }, cur = root;
    var re = /<\/?([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|<![^>]*>|<\?[^>]*>|([^<]+)|</g, m;
    while ((m = re.exec(html))) {
      if (m[3] != null || m[0] === '<') { cur.children.push({ text: decode(m[3] != null ? m[3] : '<'), parent: cur }); continue; }
      if (!m[1]) continue;
      var tag = m[1].toLowerCase();
      if (m[0].charAt(1) === '/') {
        for (var n = cur; n && n !== root; n = n.parent) if (n.tag === tag) { cur = n.parent; break; }
        continue;
      }
      var closes = AUTO_CLOSE[tag];
      if (closes) {
        for (var k = cur; k && k !== root; k = k.parent) {
          if (closes.indexOf(k.tag) > -1) { cur = k.parent; break; }
          if (/^(ul|ol|dl|table|tbody|thead|select)$/.test(k.tag)) break;
        }
      }
      if (P_ENDERS.test(tag) && cur.tag === 'p') cur = cur.parent;
      var el = { tag: tag, attrs: parseAttrs(m[2] || ''), children: [], parent: cur };
      cur.children.push(el);
      if (!VOID[tag] && !/\/\s*$/.test(m[2] || '')) cur = el;
    }
    return root;
  }

  function each(node, fn) {
    (node.children || []).forEach(function (c) { if (c.tag) { fn(c); each(c, fn); } });
  }
  function find(node, test) {
    var out = null;
    (function walk(n) {
      (n.children || []).some(function (c) { if (c.tag && test(c)) { out = c; return true; } if (c.tag) walk(c); return !!out; });
    })(node);
    return out;
  }
  function textOf(node) {
    if (node.text != null) return node.text;
    return (node.children || []).map(textOf).join(node.tag && /^(p|div|li|h[1-6]|br|tr|td|th|section)$/.test(node.tag) ? ' ' : '');
  }
  const clean = s => String(s).replace(/\s+/g, ' ').trim();
  function closest(node, tag) { for (var n = node.parent; n; n = n.parent) if (n.tag === tag) return n; return null; }
  function remove(node) { var p = node.parent; if (p) p.children = p.children.filter(function (c) { return c !== node; }); }

  /* ---------- page → Markdown ---------- */

  var BLOCK = /^(p|div|section|article|main|header|footer|aside|nav|ul|ol|li|h[1-6]|blockquote|pre|table|thead|tbody|tfoot|tr|figure|figcaption|dl|dt|dd|hr|address|details|summary|fieldset|form)$/;
  var DROP = /^(img|picture|input|select|textarea|option|button-icon|head|title|meta|link|base)$/;

  function hasBlock(n) { return (n.children || []).some(function (c) { return c.tag && (BLOCK.test(c.tag) || hasBlock(c)); }); }

  function inline(nodes, ctx) {
    return nodes.map(function (n) { return render(n, ctx); }).join('');
  }

  function render(n, ctx) {
    if (n.text != null) return ctx.pre ? n.text : n.text.replace(/\s+/g, ' ');
    var t = n.tag, kids = n.children || [];
    if (DROP.test(t)) return '';
    if (t === 'br') return ctx.pre ? '\n' : '\n';
    if (t === 'hr') return '\n\n---\n\n';
    var h = t.match(/^h([1-6])$/);
    if (h) {
      var ht = headingText(n);
      return ht ? '\n\n' + '######'.slice(0, +h[1]) + ' ' + ht + '\n\n' : '';
    }
    if (t === 'pre') { var code = textOf(n).replace(/\n+$/, ''); return code.trim() ? '\n\n```\n' + code + '\n```\n\n' : ''; }
    if (t === 'code' && !ctx.pre) { var c = clean(textOf(n)); return c ? '`' + c + '`' : ''; }
    if (t === 'strong' || t === 'b') { var s = inline(kids, ctx); return s.trim() ? wrapInline(s, '**') : s; }
    if (t === 'em' || t === 'i') { var e = inline(kids, ctx); return e.trim() ? wrapInline(e, '*') : e; }
    if (t === 'a') {
      var href = normUrl(n.attrs.href, ctx.base);
      if (hasBlock(n)) {
        var body = inline(kids, ctx);
        return body.trim() ? '\n\n' + body.trim() + (href ? '\n\nLink: ' + href : '') + '\n\n' : '';
      }
      var lt = clean(inline(kids, ctx));
      if (!lt) return '';
      return href ? '[' + lt.replace(/([\[\]])/g, '\\$1') + '](' + href + ')' : lt;
    }
    if (t === 'ul' || t === 'ol') {
      var i = 0, items = [];
      kids.forEach(function (li) {
        var txt = li.tag ? render(li.tag === 'li' ? { tag: 'div', children: li.children, attrs: {} } : li, ctx) : clean(li.text || '');
        txt = tidy(txt);
        if (!txt) return;
        i++;
        var mark = t === 'ol' ? i + '. ' : '- ';
        items.push(mark + txt.split('\n').join('\n' + '   '.slice(0, mark.length)));
      });
      return items.length ? '\n\n' + items.join('\n') + '\n\n' : '';
    }
    if (t === 'blockquote') { var q = tidy(inline(kids, ctx)); return q ? '\n\n' + q.split('\n').map(function (l) { return '> ' + l; }).join('\n') + '\n\n' : ''; }
    if (t === 'table') return table(n, ctx);
    if (t === 'dt') { var dt = clean(inline(kids, ctx)); return dt ? '\n\n**' + dt + '**\n' : ''; }
    var inner = inline(kids, ctx);
    return BLOCK.test(t) ? '\n\n' + inner + '\n\n' : inner;
  }

  function wrapInline(s, m) {
    var lead = s.match(/^\s*/)[0], trail = s.match(/\s*$/)[0];
    return lead + m + s.trim() + m + trail;
  }

  // Headings that wrap a button/div (FAQ accordions) become one plain line;
  // repeated pieces (a label shown twice for mobile/desktop) are kept once.
  function headingText(n) {
    var parts = [];
    (function walk(x) {
      (x.children || []).forEach(function (c) {
        if (c.text != null) { var s = clean(c.text); if (s && parts.indexOf(s) < 0) parts.push(s); }
        else if (!DROP.test(c.tag)) walk(c);
      });
    })(n);
    return parts.join(' ');
  }

  function table(n, ctx) {
    var rows = [];
    each(n, function (r) {
      if (r.tag !== 'tr') return;
      var cells = r.children.filter(function (c) { return c.tag === 'td' || c.tag === 'th'; })
        .map(function (c) { return clean(inline(c.children, ctx)).replace(/\|/g, '\\|'); });
      if (cells.some(Boolean)) rows.push(cells);
    });
    if (!rows.length) return '';
    var w = Math.max.apply(null, rows.map(function (r) { return r.length; }));
    var line = function (r) { var x = r.slice(); while (x.length < w) x.push(''); return '| ' + x.join(' | ') + ' |'; };
    var sep = '|' + new Array(w + 1).join(' --- |');
    return '\n\n' + [line(rows[0]), sep].concat(rows.slice(1).map(line)).join('\n') + '\n\n';
  }

  function tidy(md) {
    return String(md).split('\n').map(function (l) { return l.replace(/[ \t]+$/, '').replace(/^[ \t]+(?![-\d>*])/, ''); })
      .filter(function (l) { return !/^[-*]\s*$/.test(l); })
      .join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function meta(doc, name) {
    var hit = find(doc, function (n) { return n.tag === 'meta' && ((n.attrs.name || '').toLowerCase() === name || (n.attrs.property || '').toLowerCase() === name); });
    return hit ? clean(hit.attrs.content || '') : '';
  }

  // The page's own address as the HTML states it: canonical, og:url, or the
  // "saved from url=" note browsers add when saving a page.
  function statedUrl(html) {
    var saved = String(html).match(/<!--\s*saved from url=\(\d+\)(https?:\/\/[^\s>]+)\s*-->/i);
    var doc = parse(String(html).replace(/<body[\s\S]*$/i, ''));
    var canon = find(doc, function (n) { return n.tag === 'link' && /(^|\s)canonical(\s|$)/i.test(n.attrs.rel || ''); });
    return (canon && normUrl(canon.attrs.href)) || normUrl(meta(doc, 'og:url')) || (saved && normUrl(saved[1])) || '';
  }

  function toMarkdown(html, pageUrl) {
    var doc = parse(html);
    var titleNode = find(doc, function (n) { return n.tag === 'title'; });
    var title = clean(titleNode ? textOf(titleNode) : '') || meta(doc, 'og:title');
    var description = meta(doc, 'description') || meta(doc, 'og:description');
    var h1n = find(doc, function (n) { return n.tag === 'h1'; });
    var h1 = h1n ? headingText(h1n) : '';

    var root = find(doc, function (n) { return n.tag === 'main'; }) || find(doc, function (n) { return n.attrs.role === 'main'; }) ||
      find(doc, function (n) { return n.tag === 'article'; }) || find(doc, function (n) { return n.tag === 'body'; }) || doc;
    var drops = [];
    each(root, function (n) {
      var a = n.attrs;
      if (n.tag === 'nav' || a.role === 'navigation' || a['aria-hidden'] === 'true' || 'hidden' in a) drops.push(n);
      else if ((n.tag === 'header' || n.tag === 'footer' || a.role === 'banner' || a.role === 'contentinfo') && !closest(n, 'article')) drops.push(n);
      else if (n.tag === 'aside' && root.tag === 'body') drops.push(n);
    });
    drops.forEach(remove);
    var md = tidy(render({ tag: 'div', attrs: {}, children: root.children }, { base: pageUrl }));
    return { title: title, description: description, h1: h1, md: md };
  }

  function shortTitle(t, siteName) {
    if (!t) return t;
    var parts = t.split(/\s+[|\-–—]\s+/);
    while (parts.length > 1 && siteName && parts[parts.length - 1].toLowerCase().indexOf(siteName.toLowerCase()) > -1) parts.pop();
    return parts.join(' - ').trim() || t;
  }

  // Bot-protection pages ("Just a moment…") are reported, never worked around.
  function looksBlocked(status, body) {
    var b = String(body || '').slice(0, 20000);
    return /<title>\s*(just a moment|attention required|access denied)/i.test(b) || /cf-chl-|challenge-platform|cf_chl_opt/i.test(b) ||
      ((status === 403 || status === 503) && /cloudflare|akamai|incapsula|sucuri/i.test(b));
  }

  /* ---------- robots.txt ---------- */

  function robotsRules(txt, agent) {
    var groups = [], cur = null, lastAgent = false;
    String(txt || '').split('\n').forEach(function (raw) {
      var line = raw.replace(/#.*/, '').trim(), m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
      if (!m) return;
      var k = m[1].toLowerCase(), v = m[2].trim();
      if (k === 'user-agent') {
        if (!lastAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
        cur.agents.push(v.toLowerCase()); lastAgent = true;
      } else {
        lastAgent = false;
        if (cur && (k === 'allow' || k === 'disallow')) cur.rules.push({ allow: k === 'allow', path: v });
      }
    });
    var mine = groups.filter(function (g) { return g.agents.some(function (a) { return a !== '*' && (agent || '').indexOf(a) > -1; }); });
    var use = mine.length ? mine : groups.filter(function (g) { return g.agents.indexOf('*') > -1; });
    return [].concat.apply([], use.map(function (g) { return g.rules; }));
  }
  function robotsAllow(rules, u) {
    var p = pathOf(u), best = null;
    rules.forEach(function (r) {
      if (!r.path) return;
      var re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
      if (re.test(p) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
    });
    return !best || best.allow;
  }

  /* ---------- llms.txt / llms-full.txt ---------- */

  function titleCase(s) { return s.replace(/[-_]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

  function parseSections(s) {
    var map = {};
    String(s || '').split(/[;\n]/).forEach(function (pair) {
      var i = pair.indexOf('=');
      if (i > -1) map[pair.slice(0, i).trim().replace(/^\/+|\/+$/g, '')] = pair.slice(i + 1).trim();
    });
    return map;
  }
  function sectionOf(site, u) {
    var seg = pathOf(u).split('/').filter(Boolean)[0] || '';
    var map = site.sections || {};
    if (Object.prototype.hasOwnProperty.call(map, seg)) return map[seg];
    return seg ? titleCase(seg) : 'Home';
  }
  function summaryLine(intro, pages) {
    var q = String(intro || '').match(/^>\s*(.+)$/m);
    if (q) return q[1].trim();
    var home = pages.filter(function (p) { return pathOf(p.url) === '/'; })[0];
    return (home && home.description) || '';
  }
  // Home first, then the order the pages are listed in.
  function ordered(pages) {
    return pages.map(function (p, i) { return { p: p, i: i }; })
      .sort(function (a, b) { return (pathOf(a.p.url) === '/' ? -1 : 0) - (pathOf(b.p.url) === '/' ? -1 : 0) || a.i - b.i; })
      .map(function (x) { return x.p; });
  }
  function buildLlmsTxt(site, pages) {
    pages = ordered(pages);
    var intro = String(site.intro || '').trim();
    var out = intro ? intro + '\n' : '# ' + site.name + '\n\n> ' + summaryLine('', pages) + '\n';
    if (site.links === false) return out;
    var groups = [], by = {};
    pages.forEach(function (p) {
      var s = sectionOf(site, p.url);
      if (!by[s]) { by[s] = []; groups.push(s); }
      by[s].push(p);
    });
    groups.forEach(function (s) {
      out += '\n## ' + s + '\n\n';
      by[s].forEach(function (p) { out += '- [' + (p.title || p.url) + '](' + p.url + ')' + (p.description ? ': ' + p.description : '') + '\n'; });
    });
    return out;
  }
  function demote(md) { return String(md).replace(/^(#{1,6})(\s)/gm, function (m, h, sp) { return '######'.slice(0, Math.min(6, h.length + 2)) + sp; }); }
  function buildLlmsFull(site, pages) {
    pages = ordered(pages);
    var out = '# ' + site.name + '\n\n', sum = summaryLine(site.intro, pages);
    if (sum) out += '> ' + sum + '\n\n';
    pages.forEach(function (p) { out += '---\n\n## ' + (p.title || p.url) + '\n\nSource: ' + p.url + '\n\n' + demote(String(p.markdown || '').trim()) + '\n\n'; });
    return out.trim() + '\n';
  }

  return {
    normUrl: normUrl, host: host, pathOf: pathOf, sameSite: sameSite, toLive: toLive,
    parse: parse, toMarkdown: toMarkdown, statedUrl: statedUrl, shortTitle: shortTitle, looksBlocked: looksBlocked,
    robotsRules: robotsRules, robotsAllow: robotsAllow,
    parseSections: parseSections, buildLlmsTxt: buildLlmsTxt, buildLlmsFull: buildLlmsFull
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = LlmsCore;
