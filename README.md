# Load Dev Tracker

Offline-first PWA. Vanilla HTML/CSS/JS, no build step, no dependencies, no backend.
All data is stored in IndexedDB on the device; use Settings > Export / Import to back up or move it.

## Hosting (needed once, to install)
Service workers and "Add to Home Screen" require HTTPS (or localhost). Put this folder on any static
host, e.g. GitHub Pages, Netlify Drop or Cloudflare Pages, open the URL on your phone, then Add to Home Screen.
After the first load the whole app is cached and runs with no connectivity.

Note: data is stored per-origin. Always open the app from the same URL, or export/import when moving.

## Updating
Change any file, then bump `CACHE` in `sw.js` (e.g. `loaddev-v2`) so installed copies pick up the update.

## Files
- `index.html`, `style.css`, `app.js` - the app
- `sw.js` - service worker (cache-first app shell)
- `manifest.webmanifest`, `icons/` - install metadata

