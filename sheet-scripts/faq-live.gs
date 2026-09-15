/* ============================================================
   Google Apps Script custom function: LIVE_FAQ(url)

   Fetches a live page and extracts its visible FAQ question/answer
   pairs as JSON, so they can be compared in the dashboard against
   the FAQPage schema tracked for that same URL.

   Install:
     1. Open the Google Sheet -> Extensions -> Apps Script.
     2. Delete any starter code in Code.gs and paste this whole file.
     3. Save (the disk/save icon). Give the project any name.
     4. Back in the sheet, in a "FAQ Live" tab (see README), put:
          A1: URL          B1: Live FAQ
          A2: <a live page URL>   B2: =LIVE_FAQ(A2)
     5. The first time it runs, Google will ask you to authorize the
        script (it needs permission to fetch external URLs). Review
        and allow it — this runs only inside your own sheet, using
        your own Google account, not shared with anyone else.

   Works on any environment that shares the site's FAQ accordion
   markup, so the same function serves both the live and the staging
   URL — just point separate columns at each.

   It matches a Radix UI / Tailwind accordion: the question sits in a
   <span class="flex-1 text-lg font-medium ...">, and the answer is the
   first <p> inside the accordion's role="region" panel. The answer is
   anchored on role="region" rather than the paragraph's own classes
   because those differ between live and staging. If the site is
   redesigned, the two patterns below need updating to match.
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

function matchAll_(html, re) {
  var out = [], m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

function stripTags_(s) {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
