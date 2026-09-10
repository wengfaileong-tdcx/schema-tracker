/* Optional Google Sheet data source. Does nothing unless
   data/sheet-config.js has enabled: true. Signs the viewer in with
   their own Google account (Google Identity Services) and reads the
   sheet with the Sheets API using their own access — nobody's
   credentials are stored in this code or on the page. */
(function () {
  const cfg = window.SHEET_CONFIG;
  if (!cfg || !cfg.enabled) return;

  const $ = id => document.getElementById(id);

  const bar = document.createElement('div');
  bar.className = 'sheet-bar noprint';
  bar.innerHTML =
    '<button id="sheet-connect" type="button">Connect Google Sheet</button>' +
    '<span class="count" id="sheet-status"></span>';
  document.getElementById('recent').insertAdjacentElement('beforebegin', bar);

  const setStatus = msg => { $('sheet-status').textContent = msg || ''; };

  const COLS = {
    url: ['url', 'page', 'link'],
    title: ['title', 'name'],
    status: ['status'],
    version: ['version'],
    date: ['date'],
    schema: ['schema', 'json', 'markup'],
    note: ['note', 'reason']
  };

  function findCol(head, words) {
    for (let i = 0; i < head.length; i++) {
      const h = head[i].toLowerCase();
      for (let j = 0; j < words.length; j++) if (h.indexOf(words[j]) > -1) return i;
    }
    return -1;
  }

  // Sheets API returns rows as arrays of cell strings — one row per version.
  function rowsToData(rows) {
    if (!rows.length) throw new Error('Sheet has no rows.');
    const head = rows[0].map(x => String(x || '').trim());
    const idx = {};
    Object.keys(COLS).forEach(k => { idx[k] = findCol(head, COLS[k]); });
    ['url', 'version', 'date', 'schema'].forEach(k => {
      if (idx[k] < 0) throw new Error('Missing a "' + k + '" column in the header row.');
    });

    const byUrl = {};
    const order = [];
    rows.slice(1).forEach(r => {
      const url = (r[idx.url] || '').trim();
      const schema = (r[idx.schema] || '').trim();
      const version = (r[idx.version] || '').trim();
      if (!url || !schema || !version) return;
      if (!byUrl[url]) { byUrl[url] = { url: url, versions: [] }; order.push(url); }
      byUrl[url].versions.push({
        version: version,
        date: (r[idx.date] || '').trim(),
        schema: schema,
        note: idx.note > -1 ? (r[idx.note] || '').trim() || undefined : undefined,
        _status: idx.status > -1 ? (r[idx.status] || '').trim() : '',
        _title: idx.title > -1 ? (r[idx.title] || '').trim() : ''
      });
    });

    const pages = order.map(u => {
      const page = byUrl[u];
      const newest = page.versions.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
      page.status = newest._status || undefined;
      page.title = newest._title || undefined;
      page.versions.forEach(v => { delete v._status; delete v._title; });
      return page;
    });

    return { site: cfg.site || '', pages: pages };
  }

  function fetchValues(token) {
    const range = encodeURIComponent(cfg.range || 'Sheet1');
    const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + cfg.spreadsheetId + '/values/' + range;
    return fetch(url, { headers: { Authorization: 'Bearer ' + token } }).then(r => {
      if (!r.ok) return r.json().then(e => { throw new Error((e.error && e.error.message) || ('HTTP ' + r.status)); });
      return r.json();
    });
  }

  let tokenClient = null;

  function connect() {
    if (typeof google === 'undefined' || !google.accounts) {
      setStatus('Google sign-in script has not loaded yet — try again in a moment.');
      return;
    }
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: cfg.clientId,
        scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
        callback: () => {}
      });
    }
    setStatus('Signing in…');
    tokenClient.callback = resp => {
      if (resp.error) { setStatus('Sign-in failed: ' + resp.error); return; }
      setStatus('Loading sheet…');
      fetchValues(resp.access_token)
        .then(data => {
          window.SchemaApp.setData(rowsToData(data.values || []));
          setStatus('Loaded from Google Sheet · ' + new Date().toLocaleTimeString('en-GB'));
        })
        .catch(err => setStatus('Could not load sheet: ' + err.message));
    };
    tokenClient.requestAccessToken({ prompt: '' });
  }

  bar.addEventListener('click', e => { if (e.target.id === 'sheet-connect') connect(); });
})();
