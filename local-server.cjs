/* DNR Maker local server. Requires Node.js 22.5+ (node:sqlite is built in). */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'dnr.sqlite3');
const PORT = 8000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    document TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS screenshots (
    shot_id TEXT PRIMARY KEY,
    mime_type TEXT NOT NULL,
    data BLOB NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    document TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS history_images (
    record_id INTEGER NOT NULL,
    shot_id TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (record_id, shot_id)
  );
`);

const now = () => new Date().toISOString();
const sendJson = (res, payload, status = 200) => {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
};

function sendError(res, message, status = 400) {
  sendJson(res, { error: message }, status);
}

function readBody(req, limit = MAX_IMAGE_BYTES * 2) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('Request is too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function imageIds(document) {
  const ids = new Set();
  for (const section of document.sections || []) {
    for (const shot of section.shots || []) {
      if (shot.image) ids.add(String(shot.id || ''));
    }
  }
  return ids;
}

function clientDraft() {
  const row = db.prepare('SELECT document FROM drafts WHERE id = 1').get();
  if (!row) return null;
  const document = JSON.parse(row.document);
  const images = new Set(db.prepare('SELECT shot_id FROM screenshots').all().map(item => item.shot_id));
  for (const section of document.sections || []) {
    for (const shot of section.shots || []) {
      const id = String(shot.id || '');
      shot.image = images.has(id) ? `/api/images/${encodeURIComponent(id)}?v=${encodeURIComponent(id)}` : '';
    }
  }
  return document;
}

function historyRecords() {
  return db.prepare(`
    SELECT h.id, h.name, h.created_at, COUNT(i.shot_id) AS screenshot_count
    FROM history h LEFT JOIN history_images i ON i.record_id = h.id
    GROUP BY h.id ORDER BY h.id DESC
  `).all();
}

function historyIdFromPath(pathname) {
  const match = pathname.match(/^\/api\/history\/(\d+)(?:\/load)?$/);
  return match ? Number(match[1]) : null;
}

async function handle(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = requestUrl.pathname;
  const queryShotId = requestUrl.searchParams.get('shotId');
  const historyAction = requestUrl.searchParams.get('action');
  const historyQueryId = requestUrl.searchParams.get('id');

  if (req.method === 'GET' && pathname === '/api/draft') {
    return sendJson(res, { draft: clientDraft() });
  }

  if (req.method === 'GET' && pathname === '/api/history' && !historyAction) {
    return sendJson(res, { records: historyRecords() });
  }

  if (pathname === '/api/history' && /^\d+$/.test(historyQueryId || '')) {
    const recordId = Number(historyQueryId);
    if (req.method === 'DELETE' && historyAction === 'delete') {
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM history_images WHERE record_id = ?').run(recordId);
        db.prepare('DELETE FROM history WHERE id = ?').run(recordId);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return sendJson(res, { ok: true });
    }
    if (req.method === 'POST' && historyAction === 'load') {
      const row = db.prepare('SELECT document FROM history WHERE id = ?').get(recordId);
      if (!row) return sendError(res, 'History record not found', 404);
      const document = JSON.parse(row.document);
      const images = db.prepare('SELECT shot_id, mime_type, data FROM history_images WHERE record_id = ?').all(recordId);
      db.exec('BEGIN');
      try {
        db.exec('DELETE FROM screenshots');
        const insertImage = db.prepare('INSERT INTO screenshots (shot_id, mime_type, data, updated_at) VALUES (?, ?, ?, ?)');
        for (const image of images) insertImage.run(image.shot_id, image.mime_type, image.data, now());
        db.prepare(`
          INSERT INTO drafts (id, document, updated_at) VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET document=excluded.document, updated_at=excluded.updated_at
        `).run(JSON.stringify(document), now());
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return sendJson(res, { draft: documentForClient(db) });
    }
  }

  if (pathname.startsWith('/api/history/')) {
    const recordId = historyIdFromPath(pathname);
    if (!recordId) return sendError(res, 'Invalid history record', 400);

    if (req.method === 'DELETE' && pathname === `/api/history/${recordId}`) {
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM history_images WHERE record_id = ?').run(recordId);
        db.prepare('DELETE FROM history WHERE id = ?').run(recordId);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return sendJson(res, { ok: true });
    }

    if (req.method === 'POST' && pathname === `/api/history/${recordId}/load`) {
      const row = db.prepare('SELECT document FROM history WHERE id = ?').get(recordId);
      if (!row) return sendError(res, 'History record not found', 404);
      const document = JSON.parse(row.document);
      const images = db.prepare('SELECT shot_id, mime_type, data FROM history_images WHERE record_id = ?').all(recordId);
      db.exec('BEGIN');
      try {
        db.exec('DELETE FROM screenshots');
        const insertImage = db.prepare('INSERT INTO screenshots (shot_id, mime_type, data, updated_at) VALUES (?, ?, ?, ?)');
        for (const image of images) insertImage.run(image.shot_id, image.mime_type, image.data, now());
        db.prepare(`
          INSERT INTO drafts (id, document, updated_at) VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET document=excluded.document, updated_at=excluded.updated_at
        `).run(JSON.stringify(document), now());
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return sendJson(res, { draft: clientDraft() });
    }
  }

  if (pathname.startsWith('/api/images/') || (pathname === '/api/images' && queryShotId)) {
    const shotId = pathname.startsWith('/api/images/')
      ? decodeURIComponent(pathname.slice('/api/images/'.length))
      : queryShotId;
    if (req.method === 'GET') {
      const row = db.prepare('SELECT mime_type, data FROM screenshots WHERE shot_id = ?').get(shotId);
      if (!row) return sendError(res, 'Screenshot not found', 404);
      res.writeHead(200, {
        'Content-Type': row.mime_type,
        'Content-Length': row.data.length,
        'Cache-Control': 'public, max-age=31536000, immutable'
      });
      return res.end(row.data);
    }
    if (req.method === 'DELETE') {
      db.prepare('DELETE FROM screenshots WHERE shot_id = ?').run(shotId);
      return sendJson(res, { ok: true });
    }
    if (req.method === 'POST') {
      const mimeType = String(req.headers['content-type'] || '').split(';', 1)[0];
      if (!mimeType.startsWith('image/')) return sendError(res, 'Only image uploads are supported');
      let data;
      try {
        data = await readBody(req, MAX_IMAGE_BYTES);
      } catch (error) {
        return sendError(res, error.message, 413);
      }
      if (!data.length) return sendError(res, 'Image is empty');
      db.prepare(`
        INSERT INTO screenshots (shot_id, mime_type, data, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(shot_id) DO UPDATE SET mime_type=excluded.mime_type,
        data=excluded.data, updated_at=excluded.updated_at
      `).run(shotId, mimeType, data, now());
      return sendJson(res, { ok: true, url: `/api/images/${encodeURIComponent(shotId)}?v=${Date.now()}` });
    }
  }

  if (req.method === 'POST' && pathname === '/api/draft') {
    let document;
    try {
      document = JSON.parse((await readBody(req)).toString('utf8'));
      if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Draft must be an object');
    } catch (error) {
      return sendError(res, error.message);
    }
    const storedDocument = structuredClone(document);
    const ids = imageIds(storedDocument);
    for (const section of storedDocument.sections || []) {
      for (const shot of section.shots || []) shot.image = ids.has(String(shot.id || ''));
    }
    db.prepare(`
      INSERT INTO drafts (id, document, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET document=excluded.document, updated_at=excluded.updated_at
    `).run(JSON.stringify(storedDocument), now());
    if (ids.size) {
      const placeholders = [...ids].map(() => '?').join(',');
      db.prepare(`DELETE FROM screenshots WHERE shot_id NOT IN (${placeholders})`).run(...ids);
    } else {
      db.exec('DELETE FROM screenshots');
    }
    return sendJson(res, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/history') {
    let payload;
    try {
      payload = JSON.parse((await readBody(req)).toString('utf8'));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('History record must be an object');
      if (!String(payload.name || '').trim()) throw new Error('History record name is required');
      if (!payload.document || typeof payload.document !== 'object') throw new Error('History record document is required');
    } catch (error) {
      return sendError(res, error.message);
    }
    const document = structuredClone(payload.document);
    const ids = imageIds(document);
    for (const section of document.sections || []) {
      for (const shot of section.shots || []) shot.image = ids.has(String(shot.id || ''));
    }
    db.exec('BEGIN');
    try {
      const result = db.prepare('INSERT INTO history (name, document, created_at) VALUES (?, ?, ?)').run(String(payload.name).trim(), JSON.stringify(document), now());
      const recordId = Number(result.lastInsertRowid);
      if (ids.size) {
        const placeholders = [...ids].map(() => '?').join(',');
        db.prepare(`
          INSERT INTO history_images (record_id, shot_id, mime_type, data)
          SELECT ?, shot_id, mime_type, data FROM screenshots WHERE shot_id IN (${placeholders})
        `).run(recordId, ...ids);
      }
      db.exec('COMMIT');
      return sendJson(res, { ok: true, id: recordId });
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const body = fs.readFileSync(path.join(ROOT, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
    return res.end(body);
  }
  res.writeHead(404);
  res.end('Not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    console.error(error);
    if (!res.headersSent) sendError(res, 'Internal server error', 500);
    else res.destroy();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`DNR Maker running at http://127.0.0.1:${PORT}/`);
  console.log(`SQLite database: ${DB_PATH}`);
});
