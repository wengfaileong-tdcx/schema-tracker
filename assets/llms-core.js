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
  var BOXED = /^(label|button|legend|output)$/;
  var DROP = /^(img|picture|input|select|textarea|option|button-icon|head|title|meta|link|base)$/;

  function hasBlock(n) { return (n.children || []).some(function (c) { return c.tag && (BLOCK.test(c.tag) || hasBlock(c)); }); }

  function inline(nodes, ctx) {
    return nodes.map(function (n) { return render(n, ctx); }).join('');
  }

  // Cloudflare "email protection" hides addresses from bots but shows them to
  // every visitor (the page decodes them as it loads). Do the same.
  function cfDecode(hex) {
    try {
      var key = parseInt(hex.substr(0, 2), 16), s = '';
      for (var i = 2; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ key);
      return decodeURIComponent(escape(s));
    } catch (e) { return ''; }
  }

  function render(n, ctx) {
    if (n.text != null) return ctx.pre ? n.text : n.text.replace(/\s+/g, ' ');
    var t = n.tag, kids = n.children || [];
    if (DROP.test(t)) return '';
    if (n.attrs && n.attrs['data-cfemail']) return cfDecode(n.attrs['data-cfemail']);
    // A form's fields and buttons ("Name", "Email", "Send message") say nothing about the business.
    if (t === 'form') return '\n\n' + inline(kids, Object.assign({}, ctx, { inForm: true })) + '\n\n';
    if (ctx.inForm && /^(label|button|legend|output|select|textarea|option)$/.test(t)) return '';
    if (t === 'br') return ctx.pre ? '\n' : '\n';
    if (t === 'hr') return '\n\n---\n\n';
    var h = t.match(/^h([1-6])$/);
    if (h) {
      var ht = headingText(n);
      return ht ? '\n\n' + '######'.slice(0, +h[1]) + ' ' + ht + '\n\n' : '';
    }
    if (t === 'pre') { var code = textOf(n).replace(/\n+$/, ''); return code.trim() ? '\n\n```\n' + code + '\n```\n\n' : ''; }
    if (t === 'code' && !ctx.pre) { var c = clean(textOf(n)); return c ? '`' + c + '`' : ''; }
    // Bold or italic on a bare number ("**91** *+17*" from a score widget) means
    // nothing to a reader of the file: keep the formatting only around words.
    if (t === 'strong' || t === 'b') { var s = inline(kids, ctx); return ownLine(n, s.trim() && /\p{L}/u.test(s) ? wrapInline(s, '**') : s); }
    if (t === 'em' || t === 'i') { var e = inline(kids, ctx); return ownLine(n, e.trim() && /\p{L}/u.test(e) ? wrapInline(e, '*') : e); }
    if (t === 'a') {
      var cf = String(n.attrs.href || '').match(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/i);
      if (cf) { var em = cfDecode(cf[1]), lab = clean(inline(kids, ctx)); return lab && lab !== em ? lab + ' (' + em + ')' : em; }
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
        // One item stays one line: "**Title**: description", unless it holds a nested list.
        txt = tidy(txt).split(/\n{2,}/).map(function (part, k) {
          return k === 0 ? part.replace(/^#{1,6} (.+)$/, '**$1**') : part;   // a heading inside an item becomes its bold title
        }).reduce(function (a, b) {
          if (!a) return b;
          if (/^([-*]|\d+\.) /.test(b)) return a + '\n' + b;
          var last = a.split('\n').pop();
          return a + (/^\*\*[^*]+\*\*$/.test(last) && !/[.?!:]\*\*$/.test(last) ? ': ' : ' ') + b;
        }, '');
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
    var cls = ' ' + String((n.attrs && n.attrs['class']) || '').replace(/\s+/g, ' ') + ' ';
    // Children of a flex or grid box are separate boxes on screen: keep them apart.
    var inner = / (flex|inline-flex|grid|inline-grid) /.test(cls) && !ctx.pre
      ? kids.map(function (k) { return render(k, ctx); }).filter(function (x) { return x.trim(); }).reduce(function (a, b) {
          if (!a) return b;
          if (/ flex-col | grid /.test(cls)) return a + '\n\n' + b;
          // no space before "%", "," or ")" or after "$" or "(": "47.3%", "$299"
          return /[$(£€]\s*$/.test(a) || /^\s*[%.,;:!?)]/.test(b) ? a + b : a + ' ' + b;
        }, '')
      : inline(kids, ctx);
    // Pages often make a span or small a block with a CSS class (Tailwind's
    // "block", "flex"…), and form labels and buttons sit on their own line on
    // screen. Without this their text runs together ("Monthly ad spendGoogle").
    if (BLOCK.test(t) || BOXED.test(t) || / (block|flex|grid|table|list-item) /.test(cls)) return '\n\n' + inner + '\n\n';
    if (/ inline-(block|flex|grid) /.test(cls)) return ' ' + inner + ' ';
    return inner;
  }

  // An inline tag the page styles as its own line (class "block", "flex"…).
  function ownLine(n, out) {
    var cls = ' ' + String((n.attrs && n.attrs['class']) || '').replace(/\s+/g, ' ') + ' ';
    if (/ (block|flex|grid|table|list-item) /.test(cls)) return '\n\n' + out + '\n\n';
    if (/ inline-(block|flex|grid) /.test(cls)) return ' ' + out + ' ';
    return out;
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
    return String(md).split('\n').map(function (l) {
      return l.replace(/[ \t]+$/, '').replace(/^[ \t]+(?![-\d>*])/, '')
        .replace(/(\S)[ \t]{2,}(?=\S)/g, '$1 ')   // spaces left where boxes were joined
        .replace(/\*\*\*\*(?=\S)/g, '** **');      // two bold pieces side by side
    })
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


  /* ---------- following an edited version (three-way merge) ---------- */

  // For each line of a, the index of the matching line in b (or -1).
  // Common start/end are matched directly; the middle uses lines that occur
  // once in both as anchors (fast on long files), and a full LCS only for
  // small gaps between anchors.
  function matchLines(a, b) {
    var m = new Array(a.length).fill(-1);
    function lcs(a0, a1, b0, b1) {
      var n = a1 - a0, k = b1 - b0;
      if (!n || !k) return;
      if (n * k > 4000000) return;
      var dp = [], i, j;
      for (i = 0; i <= n; i++) dp.push(new Uint32Array(k + 1));
      for (i = n - 1; i >= 0; i--) for (j = k - 1; j >= 0; j--)
        dp[i][j] = a[a0 + i] === b[b0 + j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      i = 0; j = 0;
      while (i < n && j < k) {
        if (a[a0 + i] === b[b0 + j]) { m[a0 + i] = b0 + j; i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
      }
    }
    function walk(a0, a1, b0, b1, depth) {
      while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) { m[a0] = b0; a0++; b0++; }
      while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) { a1--; b1--; m[a1] = b1; }
      if (a0 >= a1 || b0 >= b1) return;
      if ((a1 - a0) * (b1 - b0) <= 250000 || depth > 8) { lcs(a0, a1, b0, b1); return; }
      var ca = {}, cb = {}, i;
      for (i = a0; i < a1; i++) { var x = ca[a[i]]; ca[a[i]] = x ? { n: x.n + 1, i: x.i } : { n: 1, i: i }; }
      for (i = b0; i < b1; i++) { var y = cb[b[i]]; cb[b[i]] = y ? { n: y.n + 1, i: y.i } : { n: 1, i: i }; }
      var pairs = [];
      for (i = a0; i < a1; i++) { var p = ca[a[i]], q = cb[a[i]]; if (p.n === 1 && q && q.n === 1) pairs.push([i, q.i]); }
      if (!pairs.length) { lcs(a0, a1, b0, b1); return; }
      // longest increasing run of b positions (patience)
      var tails = [], prev = new Array(pairs.length);
      pairs.forEach(function (pr, idx) {
        var lo = 0, hi = tails.length;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (pairs[tails[mid]][1] < pr[1]) lo = mid + 1; else hi = mid; }
        prev[idx] = lo ? tails[lo - 1] : -1; tails[lo] = idx;
      });
      var chain = [], t = tails[tails.length - 1];
      while (t > -1) { chain.unshift(pairs[t]); t = prev[t]; }
      var pa = a0, pb = b0;
      chain.forEach(function (c) { walk(pa, c[0], pb, c[1], depth + 1); m[c[0]] = c[1]; pa = c[0] + 1; pb = c[1] + 1; });
      walk(pa, a1, pb, b1, depth + 1);
    }
    walk(0, a.length, 0, b.length, 0);
    return m;
  }

  // base: the generated text when you saved your version; mine: your saved
  // version; theirs: what the pages generate now. Changes from the pages
  // are applied to your version; where both changed the same lines, your
  // lines are kept and the spot is reported as a conflict.
  function merge3(base, mine, theirs) {
    var o = String(base).split('\n'), a = String(mine).split('\n'), b = String(theirs).split('\n');
    var ma = matchLines(o, a), mb = matchLines(o, b);
    var out = [], conflicts = [], applied = 0, io = 0, ia = 0, ib = 0;
    var eq = function (x, y) { return x.length === y.length && x.every(function (v, i) { return v === y[i]; }); };
    for (;;) {
      var k = io;
      while (k < o.length && !(ma[k] >= ia && mb[k] >= ib)) k++;
      var ak = k < o.length ? ma[k] : a.length, bk = k < o.length ? mb[k] : b.length;
      var O = o.slice(io, k), A = a.slice(ia, ak), B = b.slice(ib, bk);
      if (O.length || A.length || B.length) {
        if (eq(A, O)) { if (!eq(B, O)) applied++; out.push.apply(out, B); }
        else if (eq(B, O) || eq(A, B)) out.push.apply(out, A);
        // both only added lines at the same spot: keep yours, then the new ones
        else if (!O.length) { out.push.apply(out, A); out.push.apply(out, B); applied++; }
        else { conflicts.push({ at: out.length, mine: A.join('\n'), theirs: B.join('\n'), base: O.join('\n') }); out.push.apply(out, A); }
      }
      if (k >= o.length) break;
      out.push(o[k]); io = k + 1; ia = ak + 1; ib = bk + 1;
    }
    return { text: out.join('\n'), conflicts: conflicts, applied: applied };
  }

  // A page you edited by hand: base is the page text your edit started
  // from, mine is your edited text, fresh is the page text now. Your edits
  // are kept; where the page changed a line you also changed, yours stays.
  function mergePage(base, mine, fresh) {
    if (fresh === base) return { md: mine, conflicts: 0, same: true };
    var r = merge3(base, mine, fresh);
    return { md: r.text, conflicts: r.conflicts.length, same: false };
  }
  function reviewNote(n) {
    return 'Review: the page changed ' + n + ' place' + (n > 1 ? 's' : '') + ' you also edited. Your text was kept; compare with the live page.';
  }

  /* ---------- following your own llms-full.txt, page by page ---------- */

  // Splits an llms-full.txt into its intro, "# Group" headings and "## Page"
  // sections. A page section is known by its "URL:" or "Source:" line.
  function splitFull(text) {
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n'), pre = [], items = [], cur = null, firstTitle = true;
    lines.forEach(function (l) {
      var group = /^# \S/.test(l), page = /^## \S/.test(l);
      if (group && firstTitle && !items.length && !pre.some(function (x) { return /^# /.test(x); })) { pre.push(l); return; }
      if (group || page) { cur = { kind: group ? 'group' : 'page', lines: [l] }; items.push(cur); return; }
      (cur ? cur.lines : pre).push(l);
    });
    items.forEach(function (it) {
      var n = it.lines.length;
      while (n > 1 && /^\s*(-{3,})?\s*$/.test(it.lines[n - 1])) n--;
      it.body = it.lines.slice(0, n); it.tail = it.lines.slice(n);
      if (it.kind === 'page') {
        it.title = it.lines[0].replace(/^##\s+/, '');
        for (var i = 1; i < Math.min(it.body.length, 8); i++) {
          var m = it.body[i].match(/^(?:URL|Source):\s*(\S+)/i);
          if (m) { it.url = normUrl(m[1]); it.label = it.body[i].match(/^(URL|Source):/i)[1]; break; }
        }
      }
    });
    // A "---" left at the end of the intro belongs between sections, not to the intro.
    return { pre: pre, items: items };
  }
  var sameBody = function (a, b) { return a.join('\n').replace(/\s+/g, ' ').trim() === b.join('\n').replace(/\s+/g, ' ').trim(); };
  var seg = function (u) { return (pathOf(u).split('/').filter(Boolean)[0] || ''); };

  // mine: your saved llms-full.txt; base: what the tool made when you saved it;
  // gen: what the tool makes now. Your sections are never changed here: pages
  // the site changed are listed as conflicts (your section vs the new one),
  // new pages are added once in your format, next to pages from the same part
  // of the site. Returns null when your file has no page sections to follow.
  function followFull(base, mine, gen) {
    var M = splitFull(mine), B = splitFull(base), G = splitFull(gen);
    var myPages = M.items.filter(function (x) { return x.kind === 'page' && x.url; });
    if (!myPages.length) return null;
    var byUrl = function (S) { var o = {}; S.items.forEach(function (x) { if (x.kind === 'page' && x.url && !o[x.url]) o[x.url] = x; }); return o; };
    var mine1 = byUrl(M), base1 = byUrl(B), gen1 = byUrl(G);
    var label = myPages.some(function (x) { return /^url$/i.test(x.label); }) ? 'URL' : 'Source';
    var styled = function (g) { return g.body.map(function (l, i) { return i < 8 && /^Source:\s/i.test(l) ? l.replace(/^Source:/i, label + ':') : l; }); };
    var counts = {}; myPages.forEach(function (x) { counts[x.url] = (counts[x.url] || 0) + 1; });
    var out = { added: [], changed: [], removed: [], dupes: Object.keys(counts).filter(function (u) { return counts[u] > 1; }) };
    var items = M.items.slice();
    var spacer = (myPages[0] && myPages[0].tail.length ? myPages[0].tail : ['']).slice();
    G.items.forEach(function (g, gi) {
      if (g.kind !== 'page' || !g.url || mine1[g.url]) return;
      if (base1[g.url]) return;   // it was in the file when you saved and you took it out: respect that
      var it = { kind: 'page', url: g.url, title: g.title, body: styled(g), tail: spacer.slice(), added: true };
      var at = -1;
      items.forEach(function (x, i) { if (x.kind === 'page' && x.url && seg(x.url) === seg(g.url) && seg(g.url)) at = i; });
      if (at < 0) {   // else after the page that comes before it in the generated file
        for (var k = gi - 1; k >= 0 && at < 0; k--) { var prev = G.items[k]; if (prev.url) items.forEach(function (x, i) { if (x.url === prev.url) at = i; }); }
      }
      if (at < 0) at = items.length - 1;
      if (at >= 0 && !items[at].tail.length) items[at].tail = spacer.slice();
      items.splice(at + 1, 0, it);
      out.added.push({ url: g.url, title: g.title });
    });
    Object.keys(mine1).forEach(function (u) { if (!gen1[u]) out.removed.push({ url: u, title: mine1[u].title }); });
    var lines = M.pre.slice(), conflicts = [];
    out.updated = [];
    items.forEach(function (x) {
      var g = x.kind === 'page' && x.url && !x.added ? gen1[x.url] : null, b = g ? base1[x.url] : null, body = x.body;
      if (g && b && !sameBody(b.body, g.body) && counts[x.url] === 1) {
        var sb = styled(b), sg = styled(g);
        // Section as the tool made it, or lightly edited: take the website's change
        // the usual way. Rewritten by you (most lines differ): ask.
        var have = {}; sb.forEach(function (l) { have[l.trim()] = true; });
        var mineLines = body.filter(function (l) { return l.trim(); });
        var kept = mineLines.filter(function (l) { return have[l.trim()]; }).length / Math.max(1, mineLines.length);
        var m = sameBody(body, sb) ? { text: sg.join('\n'), conflicts: [] } : kept >= 0.7 ? merge3(sb.join('\n'), body.join('\n'), sg.join('\n')) : null;
        if (m && !m.conflicts.length) { body = m.text.split('\n'); out.updated.push({ url: x.url, title: x.title }); }
        else {
          conflicts.push({ at: lines.length, mine: body.join('\n'), theirs: sg.join('\n'), base: sb.join('\n'), page: x.title, url: x.url });
          out.changed.push({ url: x.url, title: x.title });
        }
      }
      lines = lines.concat(body, x.tail);
    });
    return { text: lines.join('\n'), conflicts: conflicts, added: out.added, updated: out.updated, changed: out.changed, removed: out.removed, dupes: out.dupes };
  }

  return {
    splitFull: splitFull, followFull: followFull,
    reviewNote: reviewNote,
    normUrl: normUrl, host: host, pathOf: pathOf, sameSite: sameSite, toLive: toLive,
    parse: parse, toMarkdown: toMarkdown, statedUrl: statedUrl, shortTitle: shortTitle, looksBlocked: looksBlocked,
    robotsRules: robotsRules, robotsAllow: robotsAllow,
    parseSections: parseSections, buildLlmsTxt: buildLlmsTxt, buildLlmsFull: buildLlmsFull,
    matchLines: matchLines, merge3: merge3, mergePage: mergePage
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = LlmsCore;
