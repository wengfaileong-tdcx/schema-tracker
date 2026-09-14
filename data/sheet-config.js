/* ============================================================
   Optional: load data from a Google Sheet instead of
   data/schema-history.js. Leave "enabled: false" to keep using
   the local file — nothing below matters until this is turned on.

   Sheet layout — one row per PAGE, one column per VERSION:

     Title    | URL              | Status | 20260528     | 20260610
     Homepage | /                | Live   | {schema json}| {schema json}

   - Title and Status are optional; URL is required.
   - Every column after Title/URL/Status is a version: its header must
     be the date (YYYYMMDD) that version went live, and its cells hold
     that version's schema JSON, one page per row.
   - Adding a new version for a page is just adding a new dated column
     on the right and filling in that row's cell — leave other rows'
     cells in that column blank if they didn't change that day.

   clientId and spreadsheetId come from Google Cloud Console / the
   sheet's own URL — see README.md, "Connecting a Google Sheet".

   If the spreadsheet has more than one tab, a dropdown appears on the
   dashboard to switch between them (e.g. tracking multiple sites in
   one file). "range" below just picks which tab loads by default —
   it must match a real tab name exactly.

   faqTab (optional): name of a tab with columns URL | Live FAQ, where
   Live FAQ is filled by the LIVE_FAQ() Apps Script function (see
   sheet-scripts/faq-live.gs). When a page's tracked schema contains an
   FAQPage block and this tab has a matching URL, the dashboard shows a
   "FAQ sync check" comparing the live page's Q&A against the tracked
   schema. Leave blank to skip this entirely.

   lineCommentsTab (optional): turns on commenting directly on a changed
   line inside "View code changes" or "FAQ sync check" — a 💬 button
   appears next to each changed line. Comments are saved as new rows in
   this tab: URL | DiffId | LineKey | Context | Name | Comment | Timestamp
   (create the tab with just that header row before turning this on).
   DiffId names the section ("View code changes" / "FAQ sync check");
   LineKey is the JSON property the comment is anchored to; Context is
   the actual before/after text at the time of posting, so the row is
   self-explanatory if you're looking at the sheet directly rather than
   the dashboard. All three are filled in automatically — never type them
   by hand. Enabling this upgrades the Google permission the dashboard
   asks for from read-only to read+write, since posting a comment means
   writing to the sheet. Leave blank ("") to keep commenting off and
   stay read-only.
   ============================================================ */

window.SHEET_CONFIG = {
  enabled: true,
  clientId: "369422014820-1kou8ivk7s0nd8411qtrh65q9sejbbeb.apps.googleusercontent.com",
  spreadsheetId: "1ca7noantQV3pbxobG1ByidyN27O8DACAm0ehgys0JP4",
  range: "Sheet1",
  faqTab: "FAQ Live",
  lineCommentsTab: "Line Comments"
};
