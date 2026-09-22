/* ============================================================
   Google Apps Script custom functions for the Schema Tracker:

     LIVE_FAQ(url)   visible FAQ question/answer pairs
     LIVE_META(url)  title, meta description, canonical, lang, og:*

   Both fetch a live page and return JSON for the dashboard to compare
   against the schema tracked for that same URL.

   Install:
     1. Open the Google Sheet -> Extensions -> Apps Script.
     2. Delete any starter code in Code.gs and paste this whole file
        (it defines both functions).
     3. Save (the disk/save icon). Give the project any name.
     4. Back in the sheet, in a "FAQ Live" tab (see README), put:
          A1: URL   B1: Live FAQ   C1: Live Meta
          A2: <a live page URL>   B2: =LIVE_FAQ(A2)   C2: =LIVE_META(A2)
     5. The first time it runs, Google will ask you to authorize the
        script (it needs permission to fetch external URLs). Review
        and allow it — this runs only inside your own sheet, using
        your own Google account, not shared with anyone else.

   Both work on any environment sharing the site's markup, so the same
   functions serve the live and the staging URL — point separate
   columns at each.

   LIVE_META reads standard <head> tags, so it survives redesigns.
   LIVE_FAQ has to match the page's FAQ accordion: the question sits in
   a <span class="flex-1 text-lg font-medium ...">, and the answer is
   the first <p> inside the accordion's role="region" panel. The answer
   is anchored on role="region" rather than the paragraph's own classes
   because those differ between live and staging. If the site is
   redesigned, those two patterns need updating.
   ============================================================ */

function LIVE_FAQ(url) {
  if (!url) return '';
  var html;
  try {
    html = UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText();
  } catch (e) {
    return 'ERROR: could not fetch page — ' + e.message;
  }

  var questions = matchAll_(html, /<span class="flex-1 text-lg font-medium[^"]*">([\s\S]*?)<\/span>/g);
  var answers = matchAll_(html, /role="region"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g);

  var n = Math.min(questions.length, answers.length);
  var pairs = [];
  for (var i = 0; i < n; i++) {
    pairs.push({ q: stripTags_(questions[i]), a: stripTags_(answers[i]) });
  }
  if (!pairs.length) return 'ERROR: no FAQ items found — page structure may have changed.';
  return JSON.stringify(pairs);
}

function LIVE_META(url) {
  if (!url) return '';
  var html;
  try {
    html = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true }).getContentText();
  } catch (e) {
    return 'ERROR: could not fetch page — ' + e.message;
  }

  var head = html.split(/<\/head>/i)[0] || html;
  var meta = {
    title: stripTags_(first_(head, [/<title[^>]*>([\s\S]*?)<\/title>/i])),
    description: metaContent_(head, 'name', 'description'),
    canonical: first_(head, [
      /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i,
      /<link[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["']/i
    ]),
    lang: first_(html, [/<html[^>]*\blang=["']([^"']+)["']/i]),
    ogTitle: metaContent_(head, 'property', 'og:title'),
    ogDescription: metaContent_(head, 'property', 'og:description')
  };
  if (!meta.title && !meta.description) {
    return 'ERROR: no <title> or meta description found — check the URL resolves to a real page.';
  }
  return JSON.stringify(meta);
}

// A <meta> tag's content, whichever order the attributes happen to be in.
function metaContent_(html, attr, value) {
  var v = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return first_(html, [
    new RegExp('<meta[^>]*' + attr + '=["\']' + v + '["\'][^>]*content=["\']([^"\']*)["\']', 'i'),
    new RegExp('<meta[^>]*content=["\']([^"\']*)["\'][^>]*' + attr + '=["\']' + v + '["\']', 'i')
  ]);
}

function first_(html, patterns) {
  for (var i = 0; i < patterns.length; i++) {
    var m = html.match(patterns[i]);
    if (m) return decodeEntities_(m[1]).replace(/\s+/g, ' ').trim();
  }
  return '';
}

// Page markup escapes characters that the schema stores plainly, so an
// apostrophe written as &#x27; has to come back as ' or every description
// containing one would read as a mismatch.
function decodeEntities_(s) {
  var named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&([a-z]+);/gi, function (m, n) {
      var k = n.toLowerCase();
      return Object.prototype.hasOwnProperty.call(named, k) ? named[k] : m;
    });
}

function matchAll_(html, re) {
  var out = [], m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

function stripTags_(s) {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
