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
    const badHeaders = versionCols.filter(c => !looksLikeDate(c.h));
    if (badHeaders.length) throw new Error('Version column "' + badHeaders[0].h + '" is not a YYYYMMDD date.');

    const badCells = [];
    const pages = rows.slice(1).map(r => {
      const url = (r[urlIdx] || '').trim();
      if (!url) return null;
      const versions = versionCols
        .map(c => ({ date: toIsoDate(c.h), raw: (r[c.i] || '').trim() }))
        .filter(v => v.raw)
        .map(v => {
          // A cell opening with {, [ or <script is meant to be JSON-LD, so a
          // parse failure there is a real error worth reporting. Anything
          // else — an llms.txt, robots.txt, any plain text file we track — is
          // kept verbatim and diffed as text.
          if (!/^[[{]|^<script/i.test(v.raw)) {
            return { version: v.date, date: v.date, kind: 'text', schema: v.raw };
          }
          const parsed = D.parse(v.raw);
          if (parsed.error) { badCells.push(url + ' @ ' + v.date + ': ' + parsed.error); return null; }
          return { version: v.date, date: v.date, schema: parsed.value };
        })
        .filter(Boolean);
      if (!versions.length) return null;
      const page = { url: url, versions: versions };
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

  // "FAQ Live" tab layout: URL | Live FAQ | Staging FAQ (optional), each FAQ
  // cell a JSON array of {q,a} written by the LIVE_FAQ() Apps Script function
  // — see sheet-scripts/faq-live.gs. Staging lets the dashboard compare the
  // proposed schema against a pre-release page as well as the live one.
  function attachFaqLive(data, rows) {
    if (!rows.length) return data;
    const head = rows[0].map(x => String(x || '').trim().toLowerCase());
    const uIdx = head.indexOf('url');
    const sIdx = head.findIndex(h => h.indexOf('staging') > -1);
    const fIdx = head.findIndex((h, i) => i !== sIdx && (h.indexOf('faq') > -1 || h.indexOf('live') > -1));
    if (uIdx < 0 || (fIdx < 0 && sIdx < 0)) return data;

    const parseCell = v => {
      const raw = (v || '').trim();
      if (!raw || raw.indexOf('ERROR') === 0) return null;
      try { return JSON.parse(raw); } catch (e) { return null; } // malformed cell
    };

    const byUrl = {};
    rows.slice(1).forEach(r => {
      const url = (r[uIdx] || '').trim();
      if (!url) return;
      byUrl[url] = {
        live: fIdx > -1 ? parseCell(r[fIdx]) : null,
        staging: sIdx > -1 ? parseCell(r[sIdx]) : null
      };
    });
    data.pages.forEach(p => {
      const found = byUrl[p.url];
      if (!found) return;
      if (found.live) p.liveFaq = found.live;
      if (found.staging) p.stagingFaq = found.staging;
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
    const range = encodeURIComponent(cfg.lineCommentsTab) + '!A:H';
    return api(token, '/values/' + range + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      // Trailing '' leaves Resolved blank — a new comment is always open.
      body: JSON.stringify({ values: [[url, diffId, lineKey, context, name, text, ts, '']] })
    }).then(() => ({ name: name, text: text, ts: ts }));
  }

  let tokenClient = null;
  let currentToken = null;

  function loadTab(tab) {
    setStatus('Loading ' + tab + '…');
    Promise.all([fetchValues(currentToken, tab), fetchFaqLive(currentToken), fetchLineComments(currentToken)])
      .then(([data, faqData, lineCommentsData]) => {
        const result = attachLineComments(attachFaqLive(rowsToData(data.values || []), faqData.values || []), lineCommentsData.values || []);
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
        scope: cfg.lineCommentsTab
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

  bar.addEventListener('click', e => { if (e.target.id === 'sheet-connect') connect(); });
  $('sheet-tab').addEventListener('change', e => loadTab(e.target.value));
})();
