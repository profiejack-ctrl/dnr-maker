# DNR Maker

Run the app with Node.js 22.5 or newer:

```powershell
node server.js
```

Open <http://127.0.0.1:8000/>. Screenshots are stored as image BLOBs in `dnr.sqlite3`; the browser keeps only report metadata and image URLs, so adding many screenshots no longer fills `localStorage`.

Use **Save Record** to archive the current report, then **History** to load or delete saved records. Archived records include their screenshots.

`index.html` can still be opened directly, but it will use the browser's fallback storage. For the SQLite-backed version, always start `server.js` first.
