/* Schema diff engine.
   Shared by index.html (dashboard) and tools/compare.html (ad-hoc comparison).
   Everything hangs off one global so it works from file:// with no build step. */
window.SchemaDiff = (function () {

  /* ---------- parsing & formatting ---------- */

  // Pull JSON out of one or more <script type="application/ld+json"> blocks.
  function extract(raw) {
    const t = String(raw || '').trim();
    if (!t) return [];
    const out = [];
    const re = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(t)) !== null) out.push(m[1].trim());
    return out.length ? out : [t];
  }

  const isPlain = v => v && typeof v === 'object' && !Array.isArray(v);

  // Stable key order so reordering alone never shows up as a change.
  function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (isPlain(v)) {
      const o = {};
      const rank = k => k === '@context' ? 0 : k === '@type' ? 1 : k === '@id' ? 2 : 3;
      Object.keys(v).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
        .forEach(k => { o[k] = sortKeys(v[k]); });
      return o;
    }
    return v;
  }

  // Accepts a string (raw paste), an object, or an array of objects.
  function parse(input) {
    if (input == null) return { value: null, error: null, empty: true };
    if (typeof input === 'object') return { value: input, error: null };
    const blocks = extract(input);
    if (!blocks.length) return { value: null, error: null, empty: true };
    const parts = [];
    for (let i = 0; i < blocks.length; i++) {
      try { parts.push(JSON.parse(blocks[i])); }
      catch (e) {
        return { value: null, error: (blocks.length > 1 ? 'Block ' + (i + 1) + ': ' : '') + e.message };
      }
    }
    return { value: parts.length === 1 ? parts[0] : parts, error: null };
  }

  function pretty(value, sort) {
    if (value == null) return '';
    const v = sort ? sortKeys(value) : value;
    return Array.isArray(v) && v.length && v.every(isPlain) && v.length > 1
      ? v.map(x => JSON.stringify(x, null, 2)).join('\n\n')
      : JSON.stringify(v, null, 2);
  }

  function toLines(input, sort) {
    const p = parse(input);
    if (p.error) return { lines: [], error: p.error };
    if (p.empty) return { lines: [], error: null, empty: true };
    return { lines: pretty(p.value, sort).split('\n'), error: null, value: p.value };
  }

  /* ---------- line diff (longest common subsequence) ---------- */

  function lines(a, b) {
    const n = a.length, m = b.length, dp = [];
    for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const r = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { r.push({ t: '=', s: a[i], o: i + 1, w: j + 1 }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { r.push({ t: '-', s: a[i], o: i + 1 }); i++; }
      else { r.push({ t: '+', s: b[j], w: j + 1 }); j++; }
    }
    while (i < n) { r.push({ t: '-', s: a[i], o: i + 1 }); i++; }
    while (j < m) { r.push({ t: '+', s: b[j], w: j + 1 }); j++; }
    return r;
  }

  /* ---------- property-level summary ---------- */

  const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
  const nodeKey = o => isPlain(o) ? ([].concat(o['@type'] || [])[0] || o['@id'] || null) : null;

  function walk(a, b, path, out) {
    if (same(a, b)) return;

    if (isPlain(a) && isPlain(b)) {
      const keys = new Set(Object.keys(a).concat(Object.keys(b)));
      keys.forEach(k => {
        const p = path ? path + '.' + k : k;
        if (!(k in a)) out.added.push(p);
        else if (!(k in b)) out.removed.push(p);
        else walk(a[k], b[k], p, out);
      });
      return;
    }

    if (Array.isArray(a) && Array.isArray(b)) {
      // Match @graph-style nodes by @type/@id so inserting a node doesn't
      // report every later node as changed.
      const ka = a.map(nodeKey), kb = b.map(nodeKey);
      const keyed = ka.every(Boolean) && kb.every(Boolean) &&
        new Set(ka).size === ka.length && new Set(kb).size === kb.length;

      if (keyed) {
        const ma = {}, mb = {};
        a.forEach((v, i) => { ma[ka[i]] = v; });
        b.forEach((v, i) => { mb[kb[i]] = v; });
        new Set(ka.concat(kb)).forEach(k => {
          const p = path ? path + '[' + k + ']' : k;
          if (!(k in ma)) out.added.push(p);
          else if (!(k in mb)) out.removed.push(p);
          else walk(ma[k], mb[k], p, out);
        });
        return;
      }

      const n = Math.max(a.length, b.length);
      for (let i = 0; i < n; i++) {
        const p = path + '[' + i + ']';
        if (i >= a.length) out.added.push(p);
        else if (i >= b.length) out.removed.push(p);
        else walk(a[i], b[i], p, out);
      }
      return;
    }

    out.changed.push({ path: path, from: a, to: b });
  }

  const short = v => {
    if (v == null) return 'empty';
    if (typeof v === 'object') return Array.isArray(v) ? v.length + ' items' : 'object';
    const s = String(v);
    return s.length > 46 ? s.slice(0, 44) + '…' : s;
  };

  // "@graph[Organization].founder.sameAs"  ->  "Organization › founder.sameAs"
  function label(p) {
    let s = p.replace(/^@graph\[([^\]]+)\]\.?/, '$1 › ');
    s = s.replace(/\[(\d+)\]/g, ' #$1');
    return s.replace(/ › $/, '');
  }

  // Collapse "sameAs #4", "sameAs #5" into one line.
  function group(paths) {
    const buckets = {}, plain = [];
    paths.forEach(p => {
      const m = p.match(/^(.*?)\[(\d+)\]$/);
      if (m) { (buckets[m[1]] = buckets[m[1]] || []).push(m[2]); }
      else plain.push(label(p));
    });
    Object.keys(buckets).forEach(k => {
      const n = buckets[k].length;
      plain.push(n === 1 ? label(k + '[' + buckets[k][0] + ']')
        : n + ' entries in ' + label(k));
    });
    return plain;
  }

  // Plain-English list of what actually changed between two schema objects.
  function summarise(prevValue, curValue, max) {
    const out = { added: [], removed: [], changed: [] };
    if (prevValue == null) return ['Initial version'];
    walk(prevValue, curValue, '', out);

    const items = []
      .concat(group(out.added).map(s => 'Added ' + s))
      .concat(group(out.removed).map(s => 'Removed ' + s))
      .concat(out.changed.map(c =>
        'Updated ' + label(c.path) + ' (' + short(c.from) + ' → ' + short(c.to) + ')'));

    if (!items.length) return ['No change'];
    const cap = max || 14;
    return items.length > cap
      ? items.slice(0, cap).concat(['and ' + (items.length - cap) + ' more'])
      : items;
  }

  /* ---------- split-view rendering ---------- */

  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  const cell = (txt, num, cls) =>
    '<span class="cell ' + cls + '"><span class="no">' + (num || '') + '</span>' +
    '<span class="tx">' + (txt === null ? '' : esc(txt)) + '</span></span>';

  /* d: output of lines(). full: show every unchanged line. context: lines kept either side. */
  function splitView(d, full, context) {
    const ctx = context == null ? 3 : context;
    let h = '<div class="diff"><div class="gut"><span>Previous</span><span>Current</span></div>';

    const keep = new Array(d.length).fill(!!full);
    if (!full) d.forEach((x, i) => {
      if (x.t !== '=')
        for (let k = Math.max(0, i - ctx); k <= Math.min(d.length - 1, i + ctx); k++) keep[k] = true;
    });

    const items = [];
    let hid = 0;
    d.forEach((x, i) => {
      if (!keep[i]) { hid++; return; }
      if (hid) { items.push({ skip: hid }); hid = 0; }
      items.push(x);
    });
    if (hid) items.push({ skip: hid });

    let dels = [], adds = [];
    const flush = () => {
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        const L = dels[k], R = adds[k];
        h += '<div class="row">' +
          (L ? cell(L.s, L.o, 'd') : cell(null, '', 'void')) +
          (R ? cell(R.s, R.w, 'a') : cell(null, '', 'void')) + '</div>';
      }
      dels = []; adds = [];
    };

    items.forEach(it => {
      if (it.skip !== undefined) {
        flush();
        h += '<div class="skip">' + it.skip + ' unchanged line' + (it.skip === 1 ? '' : 's') + ' hidden</div>';
        return;
      }
      if (it.t === '-') { dels.push(it); return; }
      if (it.t === '+') { adds.push(it); return; }
      flush();
      h += '<div class="row">' + cell(it.s, it.o, '') + cell(it.s, it.w, '') + '</div>';
    });
    flush();
    return h + '</div>';
  }

  /* Convenience: two inputs -> {html, add, del, summary, error} */
  function compare(prev, cur, opts) {
    const o = opts || {};
    const sort = o.sort !== false;
    const A = toLines(prev, sort), B = toLines(cur, sort);
    if (A.error || B.error) {
      return {
        error: (A.error ? 'Previous — ' + A.error : '') +
          (A.error && B.error ? ' / ' : '') +
          (B.error ? 'Current — ' + B.error : '')
      };
    }
    const d = lines(A.lines, B.lines);
    return {
      d: d,
      add: d.filter(x => x.t === '+').length,
      del: d.filter(x => x.t === '-').length,
      summary: summarise(A.value == null ? null : A.value, B.value),
      html: splitView(d, !!o.full, o.context)
    };
  }

  return {
    extract: extract, sortKeys: sortKeys, parse: parse, pretty: pretty,
    toLines: toLines, lines: lines, summarise: summarise,
    splitView: splitView, compare: compare, esc: esc
  };
})();
