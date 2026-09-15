# Grabbing FAQ content from a page your browser can reach

`LIVE_FAQ()` in the sheet is fetched by Google's servers, so it only works for
pages that are reachable from the public internet. A staging site behind the
VPN is not: Google gets blocked, and the cell comes back as an error.

Your own browser *is* on the VPN, though. This bookmarklet reads the FAQ
straight out of the page you have open and copies it in the exact format the
`Staging FAQ` column expects, so it's one click plus one paste.

## Install once

1. Show your browser's bookmarks bar (Chrome: `Cmd+Shift+B`).
2. Right-click the bar → **Add page** / **Add bookmark**.
3. Name it something like **Grab FAQ**.
4. Paste the whole line below as the **URL**, then save.

```
javascript:(function(){var p=[].slice.call(document.querySelectorAll('h3 button[aria-controls]')).map(function(b){var s=b.querySelector('span'),d=document.getElementById(b.getAttribute('aria-controls'));if(!s||!d)return null;return{q:s.textContent.replace(/\s+/g,' ').trim(),a:d.textContent.replace(/\s+/g,' ').trim()}}).filter(function(x){return x&&x.q&&x.a});if(!p.length){alert('No FAQ found on this page. The accordion markup may have changed.');return}var j=JSON.stringify(p);function done(){alert('Copied '+p.length+' FAQ items. Paste into the Staging FAQ cell.')}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(j).then(done,function(){window.prompt('Copy this (Cmd+C), then paste into the Staging FAQ cell:',j)})}else{window.prompt('Copy this (Cmd+C), then paste into the Staging FAQ cell:',j)}})();
```

## Use it

1. Open the staging page in your browser (on the VPN).
2. Click **Grab FAQ** in the bookmarks bar. It copies the FAQ and tells you how
   many items it found.
3. In the sheet's `FAQ Live` tab, paste into that page's **Staging FAQ** cell.

The dashboard then offers a "Compare against" picker on the FAQ sync check, so
you can flip the left-hand side between the live site and staging.

Because this is a manual snapshot, re-run it whenever staging changes — unlike
the live column, it will not refresh itself.

## If it finds nothing

The snippet pairs each FAQ question with its own answer panel via the
accordion's `aria-controls` attribute. If the site's FAQ is rebuilt with
different markup, that pairing breaks and it will report finding nothing —
at which point the selectors here and in `faq-live.gs` both need updating.
