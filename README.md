# DNR Maker

For local use, run the app with Node.js 22.5 or newer:

```powershell
node local-server.cjs
```

Open <http://127.0.0.1:8000/>. Local screenshots are stored in SQLite for offline development.

Use **Save Record** to archive the current report, then **History** to load or delete saved records. Archived records include their screenshots.

## Vercel deployment

Vercel uses the serverless API in `api/[...path].js`, not `local-server.cjs`. Create/connect these two resources:

1. A Turso database, with `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` available to the project.
2. A Vercel Blob store, with `BLOB_READ_WRITE_TOKEN` available to the project.

Then redeploy. Report metadata and history are stored in Turso; screenshot files are converted to WebP in the browser before being stored in Vercel Blob. The first request creates the required Turso tables automatically.

The existing local `dnr.sqlite3` file is not uploaded or migrated automatically; it remains the local-development database. Add the variables shown in [`.env.example`](C:\Users\ProfieJack\Desktop\DNR Maker\.env.example) in Vercel's Project Settings → Environment Variables.

To reset only this app's Turso data, set the Turso variables locally and run `RESET_DNR_DATABASE=1 npm run reset:turso`. The reset script intentionally requires the explicit confirmation variable and does not delete unrelated Turso tables.

`index.html` can still be opened directly, but it will use the browser's fallback storage. For the SQLite-backed local version, always start `local-server.cjs` first.
