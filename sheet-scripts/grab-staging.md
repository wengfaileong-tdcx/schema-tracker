# Getting a page into the sheet by hand

## Try the formulas first

`LIVE_FAQ()` and `LIVE_META()` work against any URL Google's servers can
reach. As of this writing that includes `staging.llmsource.com`, which is
publicly reachable despite being a pre-release environment — so the staging
columns can simply be:

```
=LIVE_FAQ("https://staging.llmsource.com/solutions/agency")
=LIVE_META("https://staging.llmsource.com/solutions/agency")
```

Put one in a cell and see. If it returns data, you don't need anything below,
and the column keeps refreshing itself instead of going stale.

## When the formulas can't reach it

A genuinely restricted page — one behind the VPN, an IP allowlist or a login —
will come back as an error, because Apps Script runs on Google's servers
rather than on your laptop. **A button or custom menu in the sheet does not
change that**: it would run in the same place. The fetch has to come from a
machine that is allowed in, which is why this is a browser bookmarklet.

It reads the page you have open and copies both the FAQ and the metadata in
the format the sheet expects, so it's one click and one paste.

## Install once

1. Show your browser's bookmarks bar (Chrome: `Cmd+Shift+B`).
2. Right-click the bar → **Add page** / **Add bookmark**.
3. Name it **Grab page data**.
4. Paste the whole line below as the **URL**, then save.

```
javascript:(function(){var f=[].slice.call(document.querySelectorAll('h3 button[aria-controls]')).map(function(b){var s=b.querySelector('span'),d=document.getElementById(b.getAttribute('aria-controls'));if(!s||!d)return null;return{q:s.textContent.replace(/\s+/g,' ').trim(),a:d.textContent.replace(/\s+/g,' ').trim()}}).filter(function(x){return x&&x.q&&x.a});var g=function(s,a){var e=document.querySelector(s);return e?String(e[a]||e.getAttribute(a)||'').replace(/\s+/g,' ').trim():''};var m={title:(document.title||'').replace(/\s+/g,' ').trim(),description:g('meta[name="description"]','content'),canonical:g('link[rel="canonical"]','href'),lang:(document.documentElement.getAttribute('lang')||'').trim(),ogTitle:g('meta[property="og:title"]','content'),ogDescription:g('meta[property="og:description"]','content')};if(!f.length&&!m.title){alert('Nothing found on this page. The markup may have changed.');return}var p=(f.length?JSON.stringify(f):'')+'\t'+JSON.stringify(m);var ok=function(){alert('Copied '+f.length+' FAQ items and the page metadata.\n\nIn the sheet, click this page’s Staging FAQ cell and paste — it fills Staging FAQ and Staging Meta together.')};var ask=function(){window.prompt('Copy this (Cmd+C), then paste into the Staging FAQ cell:',p)};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(p).then(ok,ask)}else{ask()}})();
```

## Use it

1. Open the staging page in your browser, on the VPN.
2. Click **Grab page data**. It reports how many FAQ items it found.
3. In the `FAQ Live` tab, click that page's **Staging FAQ** cell and paste.

The copied text has a tab between the two values, so Sheets drops the FAQ into
the cell you clicked and the metadata into the one to its right. For that to
land correctly, keep **Staging Meta immediately to the right of Staging FAQ**.
If you'd rather not rely on that, paste into any spare cell, then move the two
values where they belong.

The same bookmarklet works on the live site too, if you ever want to refresh
those columns by hand instead of waiting for the formulas.

## Things to know

- **This is a manual snapshot.** Unlike the live columns it will not refresh
  itself — re-run it whenever staging changes.
- **Staging usually declares the live canonical.** `staging.llmsource.com`
  returns `canonical: https://llmsource.com/...`, which is normal (it keeps
  staging out of search results) but means the canonical row will look like it
  matches even when you are comparing staging. Read that row with care.
- **If it finds nothing**, the FAQ accordion markup has changed. The selectors
  here and in `faq-live.gs` both need updating; the metadata half reads
  standard `<head>` tags and should keep working regardless.
