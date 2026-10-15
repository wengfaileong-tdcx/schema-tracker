---
name: new-schema
description: Write JSON-LD schema for new URLs, using the Schema Tracker's "Copy latest schemas" text as the reference. Use when the user pastes that copied text and lists new pages that need schema, or asks for schema for a new URL "like the others".
---

# New schema from the latest schemas

The user gives you two things:

1. **The reference**: text copied with **Copy latest schemas** on the Schema Tracker
   dashboard. It opens with `Latest schema for each page…`, then one block per page:
   `=== <url> · <title> · version <date> ===` followed by that page's newest schema.
2. **The new URLs** that need schema.

If either is missing, ask for it before doing anything else.

## Steps

1. **Learn the house style from the reference.**
   - Find the nodes repeated across pages: Organization, WebSite, logo, publisher, and any
     shared `@id`. Reuse them exactly as written. Never retype the logo URL or `@id` values.
   - Note the format of the cells. Is it bare JSON or wrapped in `<script type="application/ld+json">`?
     Is it a single `@graph` or several blocks? Match it.
2. **Pick the closest reference page** for each new URL, by page type and URL pattern
   (a `/blog/...` page follows an existing blog post, a product page follows a product page).
3. **Read the new page itself.** Fetch each URL and take the facts from what is on the page:
   title tag, meta description, canonical, `lang`, H1, breadcrumbs, dates, and any visible FAQ.
   If a page can't be fetched (staging behind the VPN, for example), ask the user to paste its
   content. Don't guess it.
4. **Write the schema.**
   - Use only facts that are on the page, or shared nodes from the reference.
   - Never invent prices, ratings, reviews, FAQ questions or answers, dates, or authors.
     If a property's value isn't on the page, leave the property out and list it under
     "Needs a person to check".
   - The tracker's sync checks compare against the live page, so match it exactly:
     - **FAQ check:** each FAQPage `mainEntity` question and answer has to read word for word
       like the visible FAQ.
     - **Metadata check:** the WebPage `name`, `description`, `url` and `inLanguage` have to equal
       the page's title tag, meta description, canonical and `lang`.
5. **Check the JSON parses** before handing it over (for example with `node -e "JSON.parse(...)"`
   on the JSON inside any `<script>` wrapper).

## What to hand back

For each new URL:

- **Based on:** which reference page you followed, and its version date.
- **Ready to paste:** the schema, in the same format as the reference cells.
- **Needs a person to check:** anything left out or uncertain. Write "Nothing" if there is none.

Then remind the user to add a row per URL in the sheet (Title, URL, Status) with the schema
in today's dated column (`YYYYMMDD`), and to review it in the tracker. A new page has only one
version, so reviewers read the whole schema rather than a diff.

Don't write to the Google Sheet yourself.
