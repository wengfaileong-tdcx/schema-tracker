/* Optional Google Sheet data source. Does nothing unless
   data/sheet-config.js has enabled: true. Signs the viewer in with
   their own Google account (Google Identity Services) and reads the
   sheet with the Sheets API using their own access — nobody's
   credentials are stored in this code or on the page. */
(function () {
  const cfg = window.SHEET_CONFIG;
  if (!cfg || !cfg.enabled) return;

  const D = window.SchemaDiff;
  const $ = id => document.getElementById(id);

  // The connection controls live in the header's status card.
  const bar = document.getElementById('conn-controls');
  bar.innerHTML =
    '<select id="sheet-tab" style="width:auto" hidden></select>' +
    '<button id="sheet-connect" class="btn-ghost" type="button">Connect Google Sheet</button>';

  const app = () => window.SchemaApp || {};
  const stamp = () => new Date().toLocaleTimeString('en-GB');

  // Mirrors progress into the header card: title is the headline state, sub
  // the detail line under it.
  function report(state, title, sub) {
    if (app().setConnection) app().setConnection({ state: state, title: title, sub: sub });
  }
  const setStatus = msg => report('busy', 'Google Sheet', msg || '');

  function findCol(head, words) {
    for (let i = 0; i < head.length; i++) {
      const h = head[i].toLowerCase();
      for (let j = 0; j < words.length; j++) if (h.indexOf(words[j]) > -1) return i;
    }
    return -1;
  }

  const looksLikeDate = s => /^\d{8}$/.test(String(s || '').trim());
  const toIsoDate = s => s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);

  // Wide layout: one row per page, one column per version. Fixed columns are
  // Title / URL / Status (any order); every other column is a version, its
  // header the date (YYYY-MM-DD) that version went live, its cells the schema
  // JSON. A new version is just a new column appended on the right.
  function rowsToData(rows) {
    if (!rows.length) throw new Error('Sheet has no rows.');
    const head = rows[0].map(x => String(x || '').trim());

    const urlIdx = findCol(head, ['url', 'page', 'link']);
    const titleIdx = findCol(head, ['title', 'name']);
    const statusIdx = findCol(head, ['status']);
    if (urlIdx < 0) throw new Error('Missing a "URL" column in the header row.');

    const fixed = new Set([urlIdx, titleIdx, statusIdx].filter(i => i > -1));
    const versionCols = head
      .map((h, i) => ({ h: h, i: i }))
      .filter(c => !fixed.has(c.i) && c.h);
    if (!versionCols.length) throw new Error('No version columns found — add a dated column (YYYYMMDD) after Title/URL/Status.');
    // Every column that isn't Title/URL/Status is read as a version, so a
    // differently-shaped tab lands here. Name the offending headers and the
    // layout expected, rather than just the first one that failed.
    const badHeaders = versionCols.filter(c => !looksLikeDate(c.h));
    if (badHeaders.length) {
      throw new Error('this tab is not in the expected layout. Every column after Title, URL and Status ' +
        'is read as a version and needs a date header like 20260917, but found ' +
        badHeaders.map(c => '"' + c.h + '"').join(', ') + '.');
    }

    const badCells = [];
    const pages = rows.slice(1).map((r, ri) => {
      const url = (r[urlIdx] || '').trim();
      if (!url) return null;
      const versions = versionCols
        .map(c => ({ date: toIsoDate(c.h), raw: (r[c.i] || '').trim(), col: c.i }))
        .filter(v => v.raw)
        .map(v => {
          // A cell opening with {, [ or <script is meant to be JSON-LD, so a
          // parse failure there is a real error worth reporting. Anything
          // else — an llms.txt, robots.txt, any plain text file we track — is
          // kept verbatim and diffed as text.
          if (!/^[[{]|^<script/i.test(v.raw)) {
            return { version: v.date, date: v.date, kind: 'text', schema: v.raw, raw: v.raw, col: v.col };
          }
          const parsed = D.parse(v.raw);
          if (parsed.error) { badCells.push(url + ' @ ' + v.date + ': ' + parsed.error); return null; }
          // raw and col let an edit from the dashboard write back to exactly
          // this cell, and check nobody changed it in the meantime.
          return { version: v.date, date: v.date, schema: parsed.value, raw: v.raw, col: v.col };
        })
        .filter(Boolean);
      if (!versions.length) return null;
      // Header is sheet row 1, so the first data row is row 2.
      const page = { url: url, versions: versions, sheetRow: ri + 2, urlCol: urlIdx };
      if (titleIdx > -1 && r[titleIdx]) page.title = r[titleIdx].trim();
      if (statusIdx > -1 && r[statusIdx]) page.status = r[statusIdx].trim();
      return page;
    }).filter(Boolean);

    return { site: cfg.site || '', pages: pages, warnings: badCells };
  }

  function api(token, path, opts) {
    return fetch('https://sheets.googleapis.com/v4/spreadsheets/' + cfg.spreadsheetId + path, Object.assign({
      headers: { Authorization: 'Bearer ' + token }
    }, opts)).then(r => {
      if (!r.ok) return r.json().then(e => { throw new Error((e.error && e.error.message) || ('HTTP ' + r.status)); });
      return r.json();
    });
  }

  const fetchTabs = token => api(token, '?fields=sheets.properties.title')
    .then(data => (data.sheets || []).map(s => s.properties.title));

  const fetchValues = (token, tab) => api(token, '/values/' + encodeURIComponent(tab));

  // Missing "FAQ Live" tab shouldn't break the whole load — just means no
  // live-FAQ data is available yet.
  const fetchFaqLive = token => cfg.faqTab
    ? fetchValues(token, cfg.faqTab).catch(() => ({ values: [] }))
    : Promise.resolve({ values: [] });

  // "FAQ Live" tab layout: URL, then any of Live FAQ | Staging FAQ |
  // Live Meta | Staging Meta. Each cell holds JSON written by the
  // LIVE_FAQ() / LIVE_META() Apps Script functions — see
  // sheet-scripts/faq-live.gs. Columns are matched on "faq" or "meta",
  // with "staging" marking the pre-release copy of either.
  function attachLivePage(data, rows) {
    if (!rows.length) return data;
    const head = rows[0].map(x => String(x || '').trim().toLowerCase());
    const uIdx = head.indexOf('url');
    const col = (kind, staging) => head.findIndex(h =>
      h.indexOf(kind) > -1 && (h.indexOf('staging') > -1) === staging);
    const idx = {
      liveFaq: col('faq', false), stagingFaq: col('faq', true),
      liveMeta: col('meta', false), stagingMeta: col('meta', true)
    };
    if (uIdx < 0) return data;

    const parseCell = v => {
      const raw = (v || '').trim();
      if (!raw || raw.indexOf('ERROR') === 0) return null;
      try { return JSON.parse(raw); } catch (e) { return null; } // malformed cell
    };

    const byUrl = {};
    rows.slice(1).forEach(r => {
      const url = (r[uIdx] || '').trim();
      if (!url) return;
      const found = {};
      Object.keys(idx).forEach(k => { if (idx[k] > -1) found[k] = parseCell(r[idx[k]]); });
      byUrl[url] = found;
    });
    data.pages.forEach(p => {
      const found = byUrl[p.url];
      if (!found) return;
      Object.keys(found).forEach(k => { if (found[k]) p[k] = found[k]; });
    });
    return data;
  }

  // Missing "Line Comments" tab shouldn't break the whole load — just means
  // no comments have been posted yet (or the feature isn't set up).
  const fetchLineComments = token => cfg.lineCommentsTab
    ? fetchValues(token, cfg.lineCommentsTab).catch(() => ({ values: [] }))
    : Promise.resolve({ values: [] });

  // "Line Comments" tab layout: URL | DiffId | LineKey | Context | Name |
  // Comment | Timestamp | Resolved. DiffId names which section the comment
  // is on ("View code changes" / "FAQ sync check"); LineKey is the JSON
  // property it's anchored to; Context is the exact text it refers to —
  // the highlighted selection, or the line's before/after — read back so
  // the dashboard can show what was flagged. Resolved is optional and
  // ticked by hand in the sheet; anything non-empty there counts as done.
  const isTruthyCell = v => {
    const s = String(v || '').trim().toLowerCase();
    return !!s && s !== 'false' && s !== 'no' && s !== '0';
  };

  function attachLineComments(data, rows) {
    data.pages.forEach(p => { p.lineComments = {}; });
    if (!rows.length) return data;
    const head = rows[0].map(x => String(x || '').trim().toLowerCase());
    const uIdx = head.indexOf('url'), dIdx = head.indexOf('diffid'), lIdx = head.indexOf('linekey'),
      xIdx = head.indexOf('context'), nIdx = head.indexOf('name'), cIdx = head.indexOf('comment'),
      tIdx = head.indexOf('timestamp'), rIdx = head.indexOf('resolved');
    if (uIdx < 0 || dIdx < 0 || lIdx < 0 || cIdx < 0) return data;

    const byUrl = {};
    rows.slice(1).forEach(r => {
      const url = (r[uIdx] || '').trim(), diffId = (r[dIdx] || '').trim(),
        lineKey = (r[lIdx] || '').trim(), text = (r[cIdx] || '').trim();
      if (!url || !diffId || !lineKey || !text) return;
      byUrl[url] = byUrl[url] || {};
      byUrl[url][diffId] = byUrl[url][diffId] || {};
      (byUrl[url][diffId][lineKey] = byUrl[url][diffId][lineKey] || []).push({
        name: nIdx > -1 ? (r[nIdx] || '').trim() : '',
        text: text,
        context: xIdx > -1 ? (r[xIdx] || '').trim() : '',
        ts: tIdx > -1 ? (r[tIdx] || '').trim() : '',
        resolved: rIdx > -1 && isTruthyCell(r[rIdx])
      });
    });
    data.pages.forEach(p => { if (byUrl[p.url]) p.lineComments = byUrl[p.url]; });
    return data;
  }

  function appendLineComment(token, url, diffId, lineKey, context, name, text) {
    const ts = new Date().toISOString();
    // A:G deliberately stops short of the Resolved column. Sheets appends
    // after the last row holding data *in the range given*, and a checkbox
    // ticked down the whole of that column counts as data on every row — so
    // including it would push each new comment below thousands of blank
    // rows. Leaving Resolved out also preserves whatever checkbox is already
    // sitting on the row, which starts unticked.
    const range = encodeURIComponent(cfg.lineCommentsTab) + '!A:G';
    return api(token, '/values/' + range + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[url, diffId, lineKey, context, name, text, ts]] })
    }).then(() => ({ name: name, text: text, ts: ts }));
  }

  /* ---------- editing a schema cell from the dashboard ---------- */

  // 0 -> A, 25 -> Z, 26 -> AA …
  function colLetter(i) {
    let s = '';
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
    return s;
  }
  const a1 = (tab, ref) => "'" + tab.replace(/'/g, "''") + "'!" + ref;
  const pad2 = n => (n < 10 ? '0' : '') + n;
  const todayStamp = () => {
    const d = new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  };

  // mode 'new' writes the text into today's dated column (adding the column
  // if it isn't there yet); mode 'fix' overwrites the cell the current
  // version came from. Either way the header row and the page's row are
  // re-read first, so an edit never lands on a row that has moved or a cell
  // someone else has changed since the dashboard loaded it.
  function saveSchema(token, tab, page, cur, mode, text) {
    const rowRef = page.sheetRow + ':' + page.sheetRow;
    return api(token, '/values:batchGet?ranges=' + encodeURIComponent(a1(tab, '1:1')) +
      '&ranges=' + encodeURIComponent(a1(tab, rowRef)))
      .then(res => {
        const head = ((res.valueRanges[0].values || [])[0] || []).map(x => String(x || '').trim());
        const row = (res.valueRanges[1].values || [])[0] || [];
        const stale = 'The sheet has changed since it was loaded. Reload the sheet and make the edit again.';
        if (String(row[page.urlCol] || '').trim() !== page.url) throw new Error(stale);

        const writes = [];
        let col;
        if (mode === 'fix') {
          col = cur.col;
          if (head[col] !== cur.version.replace(/-/g, '') || String(row[col] || '').trim() !== cur.raw) throw new Error(stale);
        } else {
          const stamp = todayStamp();
          col = head.indexOf(stamp);
          if (col > -1 && String(row[col] || '').trim()) {
            throw new Error('This page already has a version dated ' + stamp + '. Use "Fix current version" to change it.');
          }
          if (col < 0) {
            col = head.length;
            writes.push({ range: a1(tab, colLetter(col) + '1'), values: [[stamp]] });
          }
        }
        writes.push({ range: a1(tab, colLetter(col) + page.sheetRow), values: [[text]] });
        return ensureColumns(token, tab, col + 1).then(() => writes);
      })
      // RAW so the text is stored exactly as typed — never read as a formula.
      .then(writes => api(token, '/values:batchUpdate', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'RAW', data: writes })
      }));
  }

  // Writing past the tab's last column fails, so widen it first if needed.
  function ensureColumns(token, tab, needed) {
    return api(token, '?fields=sheets.properties(title,sheetId,gridProperties.columnCount)')
      .then(data => {
        const p = (data.sheets || []).map(s => s.properties).filter(x => x.title === tab)[0];
        if (!p || p.gridProperties.columnCount >= needed) return;
        return api(token, ':batchUpdate', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{ appendDimension: {
            sheetId: p.sheetId, dimension: 'COLUMNS', length: needed - p.gridProperties.columnCount } }] })
        });
      });
  }

  let tokenClient = null;
  let currentToken = null;
  let currentTab = null;

  function loadTab(tab) {
    currentTab = tab;
    setStatus('Loading ' + tab + '…');
    return Promise.all([fetchValues(currentToken, tab), fetchFaqLive(currentToken), fetchLineComments(currentToken)])
      .then(([data, faqData, lineCommentsData]) => {
        const result = attachLineComments(attachLivePage(rowsToData(data.values || []), faqData.values || []), lineCommentsData.values || []);
        window.SchemaApp.setData(result, 'sheet');
        $('sheet-connect').textContent = 'Reconnect';
        report('ok', 'Google Sheet connected',
          (result.site || tab) + ' · Last loaded: ' + stamp() +
          (result.warnings.length ? ' · skipped ' + result.warnings.length + ' invalid cell(s)' : ''));
        if (result.warnings.length) result.warnings.forEach(w => console.warn('Schema Tracker sheet:', w));
      })
      .catch(err => report('error', 'Could not load sheet', '"' + tab + '": ' + err.message));
  }

  function connect() {
    if (typeof google === 'undefined' || !google.accounts) {
      report('error', 'Google sign-in not ready', 'The sign-in script is still loading — try again in a moment.');
      return;
    }
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: cfg.clientId,
        scope: cfg.lineCommentsTab || cfg.allowSchemaEdits
          ? 'https://www.googleapis.com/auth/spreadsheets'
          : 'https://www.googleapis.com/auth/spreadsheets.readonly',
        callback: () => {}
      });
    }
    setStatus('Signing in…');
    tokenClient.callback = resp => {
      if (resp.error) { report('error', 'Sign-in failed', resp.error); return; }
      currentToken = resp.access_token;
      setStatus('Reading sheet tabs…');
      fetchTabs(currentToken)
        .then(tabs => {
          if (!tabs.length) throw new Error('Spreadsheet has no tabs.');
          const sel = $('sheet-tab');
          const preferred = tabs.indexOf(cfg.range) > -1 ? cfg.range : tabs[0];
          sel.innerHTML = tabs.map(t => '<option' + (t === preferred ? ' selected' : '') + '>' + D.esc(t) + '</option>').join('');
          sel.hidden = tabs.length < 2;
          loadTab(preferred);
        })
        .catch(err => report('error', 'Could not read spreadsheet', err.message));
    };
    tokenClient.requestAccessToken({ prompt: '' });
  }

  if (cfg.lineCommentsTab) {
    window.SchemaApp = window.SchemaApp || {};
    window.SchemaApp.onPostComment = function (payload, cb) {
      if (!currentToken) { cb(new Error('Not connected to Google Sheet.')); return; }
      appendLineComment(currentToken, payload.url, payload.diffId, payload.lineKey, payload.context || '', payload.name, payload.text)
        .then(entry => cb(null, entry))
        .catch(err => cb(err));
    };
  }

  if (cfg.allowSchemaEdits) {
    window.SchemaApp = window.SchemaApp || {};
    window.SchemaApp.onSaveSchema = function (payload, cb) {
      if (!currentToken) { cb(new Error('Not connected to Google Sheet.')); return; }
      saveSchema(currentToken, currentTab, payload.page, payload.cur, payload.mode, payload.text)
        .then(() => loadTab(currentTab))
        .then(() => cb(null))
        .catch(err => cb(err));
    };
  }

  bar.addEventListener('click', e => { if (e.target.id === 'sheet-connect') connect(); });
  $('sheet-tab').addEventListener('change', e => loadTab(e.target.value));
})();
