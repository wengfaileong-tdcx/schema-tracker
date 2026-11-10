# Schema Markup Tracker

An internal dashboard listing every URL we maintain JSON-LD for, what changed in each
version, and the code diff behind it. Plain HTML, CSS and JavaScript — no build step,
no dependencies, no server required.

## Folder structure

```
schema-tracker/
  index.html                 the dashboard
  assets/
    diff.js                  comparison engine (parsing, diffing, summarising)
    app.js                   dashboard behaviour
    styles.css               shared styling
  data/
    schema-history.js        >>> THE ONLY FILE YOU EDIT <<<
  tools/
    compare.html             ad-hoc comparison + PDF export
  README.md
```

## Why the data file is `.js` and not `.json`

Browsers block `fetch()` of local files over `file://`. A `.json` data file would only
load from a web server, which means your manager could not just open the dashboard by
double-clicking it. A `.js` file that assigns one global variable loads fine either way
and is otherwise identical to edit. If the dashboard is ever hosted properly, the data
file can be switched to `.json` with a two-line change in `index.html`.

---

## How to add a new URL

Open `data/schema-history.js` and add a block to the `pages` array:

```js
{
  url: "/solutions/enterprise",
  title: "Enterprise",
  status: "Live",
  versions: [
    {
      version: "v1.0",
      date: "2026-09-02",
      schema: { "@context": "https://schema.org", "@type": "WebPage" }
    }
  ]
}
```

`status` is free text — "Live" shows green, "Draft" shows amber, anything else shows grey.
`title` is optional and only used to widen search matching.

## How to update an existing URL's schema

Do **not** overwrite the existing version. Add a new one to the **top** of that page's
`versions` array:

```js
versions: [
  {
    version: "v1.5",
    date: "2026-09-09",
    schema: { ...the new markup... }
  },
  {
    version: "v1.4",         // leave everything below untouched
    ...
  }
]
```

Paste the schema as a plain JSON object. No `<script>` tags, no surrounding quotes, no
escaping. Order of properties does not matter — the dashboard normalises it before
comparing, so reshuffling alone never shows as a change.

## How a new version gets recorded

Adding the entry above is the whole process. On reload the dashboard will:

- treat the newest entry as current and show it at the top of the list
- compare it against the entry directly below it
- work out the change summary itself, at property level, e.g.
  *Added Organization › contactPoint*, *Updated Brand › logo.url*
- flag the page as recently updated if the date is within 14 days

You can override the generated summary by adding your own `summary: ["...", "..."]`
array to a version, but you rarely need to. Add `note: "..."` for context that isn't a
code change, such as why the edit was made.

## How to open it, and how to share it with your manager

**Locally** — double-click `index.html`. Everything works offline.

**For your manager** — put the whole `schema-tracker` folder in a shared Google Drive
folder. She downloads it once and opens `index.html`. When you update the data file, she
re-downloads it. Clunky but zero setup.

**Better, if it can be approved** — push the folder to a private GitHub repo and turn on
GitHub Pages. She gets a URL that is always current and never has to download anything or
know that Git exists. Check with whoever handles security before putting company markup
on GitHub.

## Version control

If the folder is in Git, every edit to `data/schema-history.js` is a recoverable version
in its own right, so the file's own history is a second safety net behind the version
array. Nothing in the dashboard requires Git, and nobody reviewing it needs to use it.

## Ad-hoc comparison tool

`tools/compare.html` is the previous comparison tool, kept and rewired to use the same
engine as the dashboard. Use it for one-off checks on markup that isn't tracked yet, or
when you need a printable PDF for a formal review. Anything worth keeping a record of
belongs in the dashboard instead.

### Importing from a spreadsheet

Rather than pasting page by page, feed it a three-column table:

| URL | Previous schema | Current schema |
|-----|-----------------|----------------|

Two ways in:

- **Upload a CSV.** Export from Google Sheets with File → Download → CSV.
- **Paste.** Select the cells in Sheets, copy, paste into the import box, click Load rows.

The header row is detected automatically and the column names are flexible — anything
containing *url*/*page*, *previous*/*old*/*before*, and *current*/*new*/*amended* is
matched. With no header, the first three columns are used in that order. The separator
is auto-detected; override it if a file comes in oddly.

JSON-LD contains commas, quotes and line breaks, so the importer uses proper CSV
quoting rules. Exports from Sheets and Excel work as-is. If you build the CSV by hand,
each schema cell must be wrapped in double quotes with any internal quotes doubled —
the **Download template** button gives you a correctly-formatted example to copy.

Once loaded, every row becomes a comparison and the report renders immediately. Rows
where both schema cells are empty are skipped.

## Connecting a Google Sheet (optional, instead of editing the .js file)

The dashboard can read its data from a Google Sheet instead of `data/schema-history.js`,
so non-technical teammates can add rows in a spreadsheet rather than editing code. This
uses each viewer's own Google sign-in and their own access to the sheet — there is no
shared password or API key sitting in the code, so it's safe to use even once this repo
is public.

### 1. Set up the sheet

One row per page, one column per version — new version = new column on the right:

| Title | URL | Status | 20260528 | 20260610 |
|-------|-----|--------|----------|----------|
| Homepage | / | Live | {schema json} | {schema json} |

- `Title` and `Status` are optional; `URL` is required.
- Every column after Title/URL/Status is treated as a version — its **header must be the
  date the version went live, in `YYYYMMDD` format** (e.g. `20260528`), and its cells hold
  that version's schema JSON pasted as plain text (use Alt+Enter for line breaks inside a cell).
- Leave a cell blank in a version column if that page didn't change that day.
- Column order for Title/URL/Status doesn't matter — the loader matches by keyword.
- Share the sheet as **"Anyone at [your org] with the link can view"** (not "Publish to
  web" — that's a different, less controllable setting), or share individually with
  named collaborators if the project isn't on a company-managed Google account. Only
  people who already have access to the sheet in Drive will ever be able to load it in
  the dashboard.

### 2. Create the OAuth client (one-time, in Google Cloud Console)

1. Create or pick a Google Cloud project.
2. **APIs & Services → Library** → enable **Google Sheets API**.
3. **APIs & Services → OAuth consent screen** → User type **Internal** (this is what
   restricts sign-in to people inside the organization — pick this over "External").
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** → Application
   type **Web application**.
5. Under **Authorized JavaScript origins**, add every URL the dashboard will be opened
   from, e.g. `https://<org>.github.io` and, for local testing, `http://localhost:5500`
   (whatever port you preview with). No redirect URI is needed.
6. Copy the generated **Client ID**.

### 3. Wire it up

Open `data/sheet-config.js` and fill in:

```js
window.SHEET_CONFIG = {
  enabled: true,
  clientId: "...apps.googleusercontent.com",   // from step 2.6
  spreadsheetId: "...",                        // the id in the sheet's URL
  range: "Sheet1"                              // tab name
};
```

Reload the dashboard — a **Connect Google Sheet** button appears above the search bar.
Clicking it opens a Google sign-in popup; once signed in, the dashboard replaces its data
with whatever the sheet contains, without a page reload. If someone without sheet access
clicks it, Google's own sign-in simply won't grant them the data — nothing to configure
on the dashboard side for that.

Until `enabled` is `true`, none of this loads and `data/schema-history.js` is used as
before.

### Editing a schema from the dashboard

With `allowSchemaEdits: true` in `data/sheet-config.js`, **View code changes** and
**View current schema** get an **Edit schema** button once the sheet is connected. It opens the current version's cell
text for editing, with two ways to save:

- **Save as new version** writes into today's dated column (`YYYYMMDD`), adding the
  column if it isn't there yet. The diff then shows your edit as the latest change.
- **Fix current version** overwrites the current version's cell, for typos and mistakes.
  The old text is then only recoverable from Google Sheets' version history.

In **View current schema**, Edit schema makes the lines themselves editable instead of
opening a text box, so comments stay beside the lines they refer to. Enter adds a line;
Backspace on an empty line removes it. The cell is saved one property per line, keeping
its `<script>` wrapper (one per block where the cell had several).

Any line with a 💬 button in either section can also be edited on its own: open its
comment panel and switch from **Comment** to **Edit this line**. The line's comments stay
in view while you edit. A line removed in the latest version can only be commented on.
Saving from **View code changes** stores the cell with properties in A–Z order, the order
that section shows them in.

JSON-LD has to parse before it can be saved. Before writing, the dashboard re-reads the
page's row and refuses to save if the row has moved or the cell was changed since it
loaded — reload the sheet and redo the edit. Only people with edit access to the
spreadsheet can save; anyone else gets Google's permission error.

### Find & replace across pages

The same setting adds a **Find & replace** button next to Expand all, for changing one
value in every page's latest schema at once — a new website icon URL, say.

1. **Find** the old value and type the new one. *Whole value only* (on by default)
   matches values that are exactly that text, not ones that merely contain it.
2. **Preview** lists every page it was found on, where it sits in the schema, and the
   exact change. Untick any page to leave it alone. A match in a different field from
   the other pages (an `image` rather than a `logo`) is flagged for a second look.
3. **Confirm**, then save. Each page gets a new version dated today; one already
   updated today has today's version updated instead.
4. **Done** lists what was saved and what was skipped.

Only JSON-LD is searched, not plain-text files like llms.txt. A page where the value is
written differently in the sheet (with escaped slashes, say) is listed but left out —
change it with **Edit schema**. A page changed in the sheet after you loaded it is
skipped and named, never overwritten.

### Writing schema for new pages with AI

**Copy latest schemas** (next to Find & replace, once the sheet is connected) copies every
page's newest schema, with its URL and version date, as plain text. A page left blank in
the newest column is copied from its newest filled version, so dates can differ.

To have Claude Code write schema for new URLs, run `/new-schema`, paste the copied text,
and list the new URLs. The skill (in `.claude/skills/new-schema/`) reuses the shared
Organization/WebSite/logo nodes as they are and takes everything else from the new page
itself. Anything it can't find on the page is left out and listed for a person to check.
It never writes to the sheet: add each new URL as a row with the schema in today's column.

## Sample data

`data/schema-history.js` ships with example content so the dashboard has something to
render. Replace it with your real history before using it for anything.

## llms.txt tab

The **llms.txt** tab (next to **Schema**) keeps each site's page text and builds `llms.txt` and `llms-full.txt` for the developer. Everything is stored in the connected Google Sheet and a Drive folder, so only people with access to those can see it. Nothing about the sites' pages is stored in this repo.

**Usual flow**
1. Connect Google Sheet, open the **llms.txt** tab, pick the site.
2. Live site: paste the URLs the developer changed and press **Check pages & update** (leave empty to check every page plus new ones in `sitemap.xml` / the live `llms.txt`). The sheet's script picks the request up within a minute and fetches the pages.
3. Staging, or a site that blocks fetching: open each page in your browser, save it as "Webpage, HTML only" (or copy its source), then use **Upload pages**. Each file is matched to its live address and converted in the browser; check the addresses and press **Save**.
4. Open changed pages to see before/now. Then **Download** both files (top of the tab) and send them to the developer. **Save both to Drive** keeps a dated copy in the Drive folder.

**Editing and comments on the two files**
- **View & comment** shows the file line by line; 💬 on a line adds a comment (stored in the "Line Comments" tab, like schema comments). Comments on lines that later change are listed under the file.
- **All pages** lists new and changed pages (from the last update) first, then pages to review or that couldn’t be fetched, then the rest by latest change. Open a page and press **Edit text** to change its text; it goes into llms-full.txt. The page text it started from is kept in the “Edited from” columns, so later fetches or uploads merge the page’s changes into your text. If the page changed a line you also edited, your line stays and the page shows a yellow review note. **Undo my edits** goes back to the page’s own text.
- **Edit** opens the whole file. **Save as my version** stores it in the "llms files" tab (created automatically). From then on the file *follows your version*: each time pages change, the changes are merged into your text and your hand edits are kept. If a page changes a line you also edited, your line is kept and shown under "to review". There you can press **Use this box** to take the new text, or type straight into the "New from the pages" box, then press **Save my changes**. **Save this as my version** makes the merged result your new base; **Stop following my version** goes back to the generated file.
- Download, Copy and **Save both to Drive** always use what you see (your version when you have one).

**Other controls**: **Add page** (a page not in the sitemap), **Remove** / **Track again**, and a weekly check every Monday 9am that only shows a reminder.

**Where things live**
- `llms sites` tab: one row per site (ID, name, live URL, staging URL, sitemap, live llms.txt, paths to exclude, section names like `ai-diagnostic=AI Diagnostic; blog=Articles`, whether to list page links, and the **Intro** used at the top of llms.txt).
- `llms pages` tab: one row per page with its Markdown and the previous Markdown (long pages continue in "Markdown 2" / "Previous 2").
- `llms queue` tab: requests from the dashboard and the weekly check, with their results.
- `llms files` tab: your saved versions of llms.txt / llms-full.txt (and the exact text of each Drive save).
- Drive: `LLMS_DRIVE_FOLDER_ID` in `sheet-scripts/llms.gs`; one subfolder per site.

**Setup (once)**: in the sheet, Extensions → Apps Script → add a file named `llms`, paste [`sheet-scripts/llms.gs`](sheet-scripts/llms.gs), save, run `llmsSetup`, and allow the permissions. It creates the three tabs, fills in the sites, and starts the every-minute and Monday timers. The timers run as whoever ran `llmsSetup`.

**Editing the code**: the HTML→Markdown converter and file builders are in `assets/llms-core.js` (used by the dashboard) and copied into `llms.gs`. After changing either `assets/llms-core.js` or `sheet-scripts/llms-server.js`, run `node scripts/build-llms-gs.mjs` and paste the new `llms.gs` into Apps Script.

**Limits**: fetching respects robots.txt and never bypasses bot protection (those pages show "Couldn't fetch"; upload them). Text that only appears after JavaScript runs can be missing from a fetch. A cell holds 50,000 characters, so a page is split over two cells and cut at about 98,000.

## Schema builder

Each page in the Schema tab has a **Build / edit schema** button, and the toolbar has **+ New page schema**. Both open the builder panel (needs Google Sheet connected with edit access).

- **Rules:** the builder uses the LLMSource Schema Flow’s own generator and data (currently **v180**, the version the developers build from). They are internal, so they are **not in this repo**: they live in the private sheet’s **“builder rules”** tab. Load them once from the panel (“Load the Schema Flow rules”) with a rules file made by `node scripts/export-builder-rules.mjs <saved Schema Flow page.html> <out.json> "Schema Flow v180"`. Load a new file only when Schema Flow itself is updated. Anyone who can edit the sheet can change these rules, and the dashboard runs the generator from them.
- **Site settings** (per site, in the **“builder sites”** tab): the business category (Taxonomy row) and how many locations customers visit (single / multi / none). Values that are the same on every page (business name, description, telephone…) are saved here when you save a page, and fill in automatically next time.
- **Per page:** pick the page type (Schema Flow’s Business View rows for that category and scope; the builder guesses from the page’s address and current schema). The template is Schema Flow’s, with the page address and site address put in. Every `{placeholder}` becomes a field, filled from the page’s latest version where the same property has a value, or from a saved copy of the page (.html). Empty fields stay as `{placeholders}`; saving warns about them and about Schema Flow’s stand-in values (e.g. `/logo.png`).
- **Fill from the live page:** asks the sheet’s Apps Script (the same one the llms.txt tab uses, through the “llms queue” tab) to fetch the page and read its JSON-LD, title, description and language. Fields are then filled from the live page, and the panel says whether the live schema matches the sheet’s latest version (with the difference). Takes up to a minute; robots.txt is respected and bot protection is never bypassed, so blocked sites still need a saved copy (.html). Site settings values (e.g. business name) still win over the live page.
- **Breadcrumb:** only if the page shows one (Schema Flow’s rule); the steps follow the address.
- **Saving** writes today’s version for the page (or updates it if today’s already exists), or adds a new row for a new page. You can edit the JSON-LD by hand before saving, and compare it with the current version.
