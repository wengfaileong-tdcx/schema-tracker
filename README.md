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

## Sample data

`data/schema-history.js` ships with example content so the dashboard has something to
render. Replace it with your real history before using it for anything.
