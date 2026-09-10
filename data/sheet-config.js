/* ============================================================
   Optional: load data from a Google Sheet instead of
   data/schema-history.js. Leave "enabled: false" to keep using
   the local file — nothing below matters until this is turned on.

   To switch on, you need three things from Google Cloud Console
   (see README.md, "Connecting a Google Sheet" section, for the
   exact steps):

     1. clientId       — OAuth 2.0 Client ID (Web application type)
     2. spreadsheetId  — the long id in the sheet's URL, e.g.
                          docs.google.com/spreadsheets/d/THIS_PART/edit
     3. range          — which sheet/tab and columns to read,
                          e.g. "Tracker!A:G"

   The sheet's first row must be a header naming these columns
   (any order, any casing): URL, Title, Status, Version, Date,
   Schema, Note. One row per version — same layout as the sample
   pages already in schema-history.js, just flattened into rows.
   ============================================================ */

window.SHEET_CONFIG = {
  enabled: true,
  clientId: "369422014820-1kou8ivk7s0nd8411qtrh65q9sejbbeb.apps.googleusercontent.com",
  spreadsheetId: "1ca7noantQV3pbxobG1ByidyN27O8DACAm0ehgys0JP4",
  range: "Sheet1!A:G"
};
