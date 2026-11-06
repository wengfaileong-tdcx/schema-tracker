// Fetches the pages of each site in llms/sites.json, turns them into
// Markdown, and builds llms.txt + llms-full.txt from them.
//
// Run by .github/workflows/llms.yml (button in the tracker, or weekly).
// Inputs come from environment variables:
//   MODE        "update" (default) saves changed pages and rebuilds the files.
//               "check" only compares and writes last-check.json — nothing else changes.
//   SITE        site id from sites.json; blank = every site
//   URLS        only check these pages (space / comma / newline separated);
//               blank = every tracked page plus anything new in sitemap.xml / llms.txt
//   ADD_URLS    start tracking these pages (update mode)
//   REMOVE_URLS stop tracking these pages; they won't be re-added from the sitemap
//
// The script never tries to get past bot protection: a page that answers
// with a challenge (Cloudflare "Just a moment…" etc.) is reported as
// "Couldn't fetch" and its last good copy is kept.

import { readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LLMS = path.join(ROOT, 'llms');
const UA = 'SchemaTrackerBot/1.0 (+https://schema-tracker.llmsource.com)';
const UA_TOKEN = 'schematrackerbot';
const DELAY_MS = 700;
const TIMEOUT_MS = 30000;

const env = k => (process.env[k] || '').trim();
const MODE = env('MODE') === 'check' ? 'check' : 'update';
const ONLY_SITE = env('SITE');
const list = s => s.split(/[\s,]+/).map(x => x.trim()).filter(Boolean);
const URLS = list(env('URLS'));
const ADD = list(env('ADD_URLS'));
const REMOVE = list(env('REMOVE_URLS'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 16);
const now = () => new Date().toISOString();
const exists = p => access(p).then(() => true, () => false);
const readJson = async (p, fallback) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; } };
const readText = async p => { try { return await readFile(p, 'utf8'); } catch { return null; } };
const writeJson = (p, v) => writeFile(p, JSON.stringify(v, null, 2) + '\n');

/* ---------- URLs ---------- */

function norm(u, base) {
  let x;
  try { x = new URL(u, base); } catch { return null; }
  if (!/^https?:$/.test(x.protocol)) return null;
  x.hash = '';
  x.search = '';
  x.hostname = x.hostname.toLowerCase();
  let s = x.toString();
  if (x.pathname !== '/' && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}
const sameSite = (u, base) => { try { return new URL(u).hostname.replace(/^www\./, '') === new URL(base).hostname.replace(/^www\./, ''); } catch { return false; } };

function slugFor(u) {
  const p = new URL(u).pathname.replace(/^\/+|\/+$/g, '');
  if (!p) return 'index';
  return p.toLowerCase().replace(/[^a-z0-9/_-]+/g, '-').replace(/\//g, '__').slice(0, 150);
}

// Where to actually fetch from: the live URL, or the same path on staging.
function fetchUrl(site, u) {
  if (site.fetchFrom !== 'staging' || !site.stagingBase) return u;
  const x = new URL(u), s = new URL(site.stagingBase);
  x.protocol = s.protocol; x.host = s.host;
  return x.toString();
}

/* ---------- fetching ---------- */

async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain,application/xml;q=0.9,*/*;q=0.5' }, redirect: 'follow', signal: ctl.signal });
    const body = await res.text();
    return { status: res.status, url: res.url, type: res.headers.get('content-type') || '', body, server: res.headers.get('server') || '' };
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? 'Timed out after 30s' : (e.message || String(e)) };
  } finally { clearTimeout(t); }
}

function blocked(r) {
  const b = (r.body || '').slice(0, 20000);
  return /<title>\s*(just a moment|attention required|access denied)/i.test(b) ||
    /cf-chl-|challenge-platform|cf_chl_opt/i.test(b) ||
    ((r.status === 403 || r.status === 503) && /cloudflare|akamai|incapsula|sucuri/i.test(r.server + b));
}

/* ---------- robots.txt ---------- */

function robotsRules(txt) {
  const groups = []; let cur = null, lastWasAgent = false;
  for (const raw of (txt || '').split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase()); lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (k === 'allow' || k === 'disallow')) cur.rules.push({ allow: k === 'allow', path: v });
    }
  }
  const mine = groups.filter(g => g.agents.some(a => a !== '*' && UA_TOKEN.includes(a)));
  return (mine.length ? mine : groups.filter(g => g.agents.includes('*'))).flatMap(g => g.rules);
}
function allowed(rules, u) {
  const p = new URL(u).pathname;
  let best = null;
  for (const r of rules) {
    if (!r.path) continue;
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(p) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

/* ---------- discovery ---------- */

async function sitemapUrls(url, depth = 0) {
  if (!url || depth > 2) return [];
  const r = await get(url);
  if (r.status !== 200 || !r.body) return [];
  const locs = [...r.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1].replace(/&amp;/g, '&'));
  if (/<sitemapindex/i.test(r.body)) {
    const out = [];
    for (const l of locs) out.push(...await sitemapUrls(l, depth + 1));
    return out;
  }
  return locs;
}
async function llmsTxtUrls(url) {
  if (!url) return [];
  const r = await get(url);
  if (r.status !== 200 || !/text\/plain|markdown/i.test(r.type)) return [];
  return [...r.body.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map(m => m[1]);
}

/* ---------- HTML → Markdown ---------- */

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
td.remove(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'img', 'picture', 'video', 'audio', 'canvas', 'input', 'select', 'textarea', 'option']);
td.addRule('noImages', { filter: ['img', 'picture', 'svg'], replacement: () => '' });
td.addRule('emptyLink', { filter: n => n.nodeName === 'A' && !n.textContent.trim(), replacement: () => '' });
// A link wrapped around a whole card (heading + text) can't be a Markdown
// link; keep the card's text and put the address on its own line after it.
td.addRule('blockLink', {
  filter: n => n.nodeName === 'A' && n.getAttribute('href') && !!n.querySelector('h1,h2,h3,h4,h5,h6,p,div,ul,ol,li,section'),
  replacement: (content, n) => '\n\n' + content.trim() + '\n\nLink: ' + n.getAttribute('href') + '\n\n'
});

function toMarkdown(html, pageUrl) {
  const { document } = parseHTML(html);
  const meta = n => (document.querySelector(`meta[name="${n}"]`) || document.querySelector(`meta[property="${n}"]`))?.getAttribute('content')?.trim() || '';
  const title = (document.querySelector('title')?.textContent || meta('og:title') || '').replace(/\s+/g, ' ').trim();
  const description = meta('description') || meta('og:description');
  const h1 = document.querySelector('h1')?.textContent.replace(/\s+/g, ' ').trim() || '';

  const root = document.querySelector('main') || document.querySelector('[role="main"]') || document.querySelector('article') || document.body;
  if (!root) return { title, description, h1, md: '' };
  const drop = root === document.body
    ? 'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [aria-hidden="true"], [hidden]'
    : 'nav, [role="navigation"], [aria-hidden="true"], [hidden]';
  root.querySelectorAll(drop).forEach(n => n.remove());
  // Site-wide header/footer sometimes sit inside <main>; an article's own
  // header/footer (byline, date) is kept.
  root.querySelectorAll('header, footer, [role="banner"], [role="contentinfo"]').forEach(n => { if (!n.closest('article')) n.remove(); });
  // A <br> inside a heading is only for visual wrapping.
  root.querySelectorAll('h1 br, h2 br, h3 br, h4 br, h5 br, h6 br').forEach(br => br.replaceWith(document.createTextNode(' ')));
  // Headings that wrap a button/div (FAQ accordions) become plain one-line
  // text, or the Markdown heading ends up empty with the text below it.
  root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
    if (!h.querySelector('div, button, p, span')) return;
    const parts = [];
    h.querySelectorAll('*').forEach(n => { if (!n.children.length) { const t = n.textContent.replace(/\s+/g, ' ').trim(); if (t && !parts.includes(t)) parts.push(t); } });
    h.textContent = parts.join(' ') || h.textContent.replace(/\s+/g, ' ').trim();
  });
  root.querySelectorAll('a[href]').forEach(a => {
    const abs = norm(a.getAttribute('href'), pageUrl);
    if (abs) a.setAttribute('href', abs);
  });

  let md = td.turndown(root.innerHTML || '');
  md = md.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => !/^[-*]\s*$/.test(l)).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  return { title, description, h1, md };
}

const shortTitle = (t, siteName) => {
  if (!t) return t;
  const parts = t.split(/\s+[|\-–—]\s+/);
  while (parts.length > 1 && siteName && parts[parts.length - 1].toLowerCase().includes(siteName.toLowerCase())) parts.pop();
  return parts.join(' - ').trim() || t;
};

/* ---------- llms.txt / llms-full.txt ---------- */

const titleCase = s => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

function sectionOf(site, u) {
  const seg = new URL(u).pathname.split('/').filter(Boolean)[0] || '';
  const map = site.sections || {};
  if (seg in map) return map[seg];
  return seg ? titleCase(seg) : (map[''] || 'Home');
}

function summaryLine(intro, pages) {
  const q = (intro || '').match(/^>\s*(.+)$/m);
  if (q) return q[1].trim();
  const home = pages.find(p => new URL(p.url).pathname === '/');
  return (home && home.description) || '';
}

function buildLlmsTxt(site, intro, pages) {
  let out = intro && intro.trim()
    ? intro.trim() + '\n'
    : `# ${site.name}\n\n> ${summaryLine('', pages)}\n`;
  if (site.llmsTxtLinks === false) return out;
  const groups = new Map();
  for (const p of pages) {
    const s = sectionOf(site, p.url);
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(p);
  }
  for (const [s, ps] of groups) {
    out += `\n## ${s}\n\n`;
    for (const p of ps) out += `- [${p.title || p.url}](${p.url})${p.description ? ': ' + p.description : ''}\n`;
  }
  return out;
}

const demote = md => md.replace(/^(#{1,6})(\s)/gm, (m, h, sp) => '#'.repeat(Math.min(6, h.length + 2)) + sp);

function buildLlmsFull(site, intro, pages, bodies) {
  let out = `# ${site.name}\n\n`;
  const sum = summaryLine(intro, pages);
  if (sum) out += `> ${sum}\n\n`;
  for (const p of pages) {
    out += `---\n\n## ${p.title || p.url}\n\nSource: ${p.url}\n\n${demote(bodies.get(p.url) || '')}\n\n`;
  }
  return out.trim() + '\n';
}

/* ---------- one site ---------- */

async function runSite(site) {
  const dir = path.join(LLMS, site.id);
  const pagesDir = path.join(dir, 'pages');
  await mkdir(pagesDir, { recursive: true });
  const index = await readJson(path.join(dir, 'index.json'), { pages: [] });
  const byUrl = new Map(index.pages.map(p => [p.url, p]));
  const base = site.base;
  const log = [];

  const onSite = u => { const n = norm(u, base); return n && sameSite(n, base) ? n : null; };
  const wrongSite = [...URLS, ...ADD, ...REMOVE].filter(u => !onSite(u));
  for (const u of wrongSite) log.push({ url: u, state: 'failed', error: `Not a ${new URL(base).hostname} address` });

  // Remove / re-add requests (update mode only — check never changes anything).
  if (MODE === 'update') {
    for (const u of REMOVE.map(onSite).filter(Boolean)) {
      const p = byUrl.get(u);
      if (p && !p.excluded) { p.excluded = true; p.excludedAt = now(); log.push({ url: u, state: 'removed', title: p.title }); }
      else if (!p) { byUrl.set(u, { url: u, slug: slugFor(u), excluded: true, excludedAt: now(), source: 'removed' }); log.push({ url: u, state: 'removed' }); }
    }
    for (const u of ADD.map(onSite).filter(Boolean)) {
      const p = byUrl.get(u);
      if (p) { if (p.excluded) { delete p.excluded; delete p.excludedAt; } p.added = true; }
      else byUrl.set(u, { url: u, slug: slugFor(u), source: 'added', added: true });
    }
  }

  // Which pages to look at.
  const selected = URLS.map(onSite).filter(Boolean);
  let targets;
  const discovered = new Set();
  const added = MODE === 'update' ? ADD.map(onSite).filter(Boolean) : [];
  if (selected.length || added.length || (MODE === 'update' && REMOVE.length)) {
    // Only the pages asked about (a remove-only run just rebuilds the files).
    targets = [...new Set([...selected, ...added])];
  } else {
    const found = [...await sitemapUrls(site.sitemap), ...await llmsTxtUrls(site.llmsTxt)].map(onSite).filter(Boolean);
    found.forEach(u => discovered.add(u));
    const excl = (site.exclude || []);
    for (const u of discovered) {
      if (!byUrl.has(u) && !excl.some(x => new URL(u).pathname.startsWith(x))) byUrl.set(u, { url: u, slug: slugFor(u), source: 'sitemap' });
    }
    targets = [...byUrl.values()].filter(p => !p.excluded).map(p => p.url);
  }
  targets = targets.filter(u => !(byUrl.get(u) || {}).excluded);
  for (const u of targets) if (!byUrl.has(u)) byUrl.set(u, { url: u, slug: slugFor(u), source: 'added', added: true });

  const robots = robotsRules((await get(new URL('/robots.txt', fetchUrl(site, base)).toString())).body);
  const results = [];
  const bodies = new Map();
  const changedFiles = [];

  for (const u of targets) {
    const p = byUrl.get(u);
    const slug = p.slug || slugFor(u);
    p.slug = slug;
    const file = path.join(pagesDir, slug + '.md');
    const before = await readText(file);
    const isNew = before == null;
    const src = fetchUrl(site, u);

    let res = { url: u, title: p.title || '' };
    if (!allowed(robots, src)) {
      res.state = 'failed'; res.error = 'robots.txt asks crawlers not to visit this page';
    } else {
      const r = await get(src);
      await sleep(DELAY_MS);
      if (r.error) { res.state = 'failed'; res.error = r.error; }
      else if (blocked(r)) { res.state = 'failed'; res.error = 'Blocked by bot protection (e.g. Cloudflare). Not bypassed. Last good copy kept.'; }
      else if (r.status !== 200) { res.state = 'failed'; res.error = `HTTP ${r.status}`; }
      else if (!/html/i.test(r.type)) { res.state = 'failed'; res.error = `Not an HTML page (${r.type || 'unknown type'})`; }
      else {
        const x = toMarkdown(r.body, u);
        if (!x.md || x.md.length < 40) { res.state = 'failed'; res.error = 'Page has almost no text in its HTML (it may load content with JavaScript)'; }
        else {
          const title = shortTitle(x.title, site.name) || x.h1 || u;
          res.title = title;
          const changed = before !== x.md + '\n';
          res.state = isNew ? 'new' : changed ? 'changed' : 'same';
          if (res.state === 'changed') { res.before = before; res.after = x.md + '\n'; }
          if (res.state === 'new') res.after = x.md + '\n';
          if (MODE === 'update') {
            if (isNew || changed) { await writeFile(file, x.md + '\n'); changedFiles.push(slug); p.lastChanged = now(); }
            Object.assign(p, { title, description: x.description, hash: sha(x.md), lastFetched: now(), lastError: null });
            if (!p.firstSeen) p.firstSeen = now();
          }
        }
      }
    }
    if (res.state === 'failed' && MODE === 'update') { p.lastError = res.error; p.lastErrorAt = now(); }
    if (p.added && res.state === 'new') res.added = true;
    results.push(res);
    console.log(`${res.state.padEnd(8)} ${u}${res.error ? '  — ' + res.error : ''}`);
  }

  // Pages the sitemap no longer lists (full runs only).
  if (discovered.size) {
    for (const p of byUrl.values()) {
      if (p.excluded) continue;
      const missing = p.source === 'sitemap' && !discovered.has(p.url);
      if (MODE === 'update') p.notInSitemap = missing || undefined;
      const r = missing && results.find(x => x.url === p.url);
      if (r) r.notInSitemap = true;
    }
  }

  const run = {
    at: now(), mode: MODE, scope: discovered.size ? 'all' : 'selected',
    requested: discovered.size ? undefined : targets,
    counts: ['changed', 'new', 'same', 'failed', 'removed'].reduce((o, k) => (o[k] = [...results, ...log].filter(r => r.state === k).length, o), {}),
    results: [...log, ...results]
  };

  if (MODE === 'check') {
    await writeJson(path.join(dir, 'last-check.json'), run);
    return run;
  }

  // Rebuild the two files from every tracked page that has a saved copy.
  const tracked = [];
  for (const p of byUrl.values()) {
    if (p.excluded) continue;
    const body = await readText(path.join(pagesDir, p.slug + '.md'));
    if (body == null) continue;
    bodies.set(p.url, body.trim());
    tracked.push(p);
  }
  const order = u => { const i = targets.indexOf(u); return i < 0 ? 1e6 : i; };
  tracked.sort((a, b) => (new URL(a.url).pathname === '/' ? -1 : 0) - (new URL(b.url).pathname === '/' ? -1 : 0) || order(a.url) - order(b.url) || a.url.localeCompare(b.url));
  const intro = await readText(path.join(dir, 'llms-intro.md'));
  await writeFile(path.join(dir, 'llms.txt'), buildLlmsTxt(site, intro, tracked));
  await writeFile(path.join(dir, 'llms-full.txt'), buildLlmsFull(site, intro, tracked, bodies));

  // Excluded pages lose their saved copy so they drop out of the files.
  for (const p of byUrl.values()) if (p.excluded) await rm(path.join(pagesDir, p.slug + '.md'), { force: true });

  const pagesOut = [...byUrl.values()].sort((a, b) => order(a.url) - order(b.url) || a.url.localeCompare(b.url));
  await writeJson(path.join(dir, 'index.json'), { site: site.id, updatedAt: now(), pages: pagesOut });
  await writeJson(path.join(dir, 'last-run.json'), run);
  return run;
}

/* ---------- main ---------- */

const sites = (await readJson(path.join(LLMS, 'sites.json'), { sites: [] })).sites
  .filter(s => !ONLY_SITE || s.id === ONLY_SITE);
if (!sites.length) { console.error(`No site matches "${ONLY_SITE}" in llms/sites.json`); process.exit(1); }

let summary = `### llms.txt ${MODE === 'check' ? 'check' : 'update'}\n\n`;
for (const site of sites) {
  console.log(`\n== ${site.name} (${MODE})`);
  const run = await runSite(site);
  const c = run.counts;
  summary += `**${site.name}** — changed ${c.changed}, new ${c.new}, no change ${c.same}, couldn't fetch ${c.failed}${c.removed ? `, removed ${c.removed}` : ''}\n\n`;
}
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
console.log('\n' + summary);
