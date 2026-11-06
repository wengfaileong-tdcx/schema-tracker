/* ============================================================
   llms.txt tab
   ============================================================
   The tab keeps everything in the connected Google Sheet (tabs
   "llms sites", "llms pages", "llms queue") and saves finished files
   to the Drive folder set in sheet-scripts/llms.gs. Nothing about the
   sites' pages is stored in this repo.

   enabled   false hides the tab
   repo      where the tab links to for the Apps Script file (llms.gs)
   ============================================================ */

window.LLMS_CONFIG = {
  enabled: true,
  repo: "wengfaileong-tdcx/schema-tracker"
};
