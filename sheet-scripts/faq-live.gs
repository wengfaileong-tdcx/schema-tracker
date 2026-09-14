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

   This matches the specific HTML structure of the FAQ accordion at
   the time this was written (a Radix UI / Tailwind CSS accordion —
   question in a <span class="flex-1 text-lg font-medium ...">,
   answer in a following <p class="flex flex-col gap-4 text-lg ...">).
   If the live site is later redesigned, the class names below will
   need updating to match the new markup.
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
  var answers = matchAll_(html, /<p class="flex flex-col gap-4 text-lg[^"]*">([\s\S]*?)<\/p>/g);

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
