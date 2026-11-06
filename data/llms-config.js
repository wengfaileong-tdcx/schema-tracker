/* ============================================================
   llms.txt tab
   ============================================================
   Where the tab reads its data from and which GitHub workflow its
   "Check pages & update" button starts.

   The sites themselves (address, sitemap, live or staging, section
   names) are set in llms/sites.json. The intro at the top of each
   site's llms.txt is llms/<site>/llms-intro.md.

   repo      owner/name of this repository
   branch    branch the workflow commits to
   workflow  file name under .github/workflows/
   Remove this file's <script> tag from index.html to hide the tab.
   ============================================================ */

window.LLMS_CONFIG = {
  // Off while llms data moves to the Google Sheet (keeps client content
  // out of this public repo). true shows the llms.txt tab again.
  enabled: false,
  repo: "wengfaileong-tdcx/schema-tracker",
  branch: "main",
  workflow: "llms.yml"
};
