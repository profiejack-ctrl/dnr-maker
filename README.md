# DNR Maker

For local use, run the app with Node.js 22.5 or newer:

```powershell
node server.js
```

Open <http://127.0.0.1:8000/>. Local screenshots are stored in SQLite for offline development.

Use **Save Record** to archive the current report, then **History** to load or delete saved records. Archived records include their screenshots.

## Vercel deployment

Vercel uses the serverless API in `api/[...path].js`, not `server.js`. Create/connect these two Vercel resources:

1. A Neon Postgres integration, with `DATABASE_URL` available to the project.
2. A Vercel Blob store, with `BLOB_READ_WRITE_TOKEN` available to the project.

Then redeploy. Report metadata and history are stored in Neon; screenshot files are stored in Vercel Blob. The first request creates the required Postgres tables automatically.

The existing local `dnr.sqlite3` file is not uploaded or migrated automatically; it remains the local-development database. Add the variables shown in [`.env.example`](C:\Users\ProfieJack\Desktop\DNR Maker\.env.example) in Vercel's Project Settings → Environment Variables.

`index.html` can still be opened directly, but it will use the browser's fallback storage. For the SQLite-backed version, always start `server.js` first.
