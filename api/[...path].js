const { createClient } = require('@libsql/client');
const { list, put } = require('@vercel/blob');

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
let client;
let schemaReady;

function database() {
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required');
  }
  if (!client) client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
  });
  return client;
}

async function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db.batch([
      `CREATE TABLE IF NOT EXISTS dnr_drafts (
        id INTEGER PRIMARY KEY,
        document TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS dnr_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        document TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`
    ]).catch(error => {
      schemaReady = undefined;
      throw error;
    });
  }
  await schemaReady;
}

function json(res, payload, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function error(res, message, status = 400) {
  json(res, { error: message }, status);
}

function pathParts(req) {
  return new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname
    .split('/').filter(Boolean).slice(1);
}

function requestBody(req, limit = MAX_IMAGE_BYTES * 2) {
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
    if (typeof req.body === 'string') return Promise.resolve(Buffer.from(req.body));
    return Promise.resolve(Buffer.from(JSON.stringify(req.body)));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const body = await requestBody(req);
  const value = JSON.parse(body.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request must be an object');
  return value;
}

function parseDocument(value) {
  if (!value) return null;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function screenshotCount(document) {
  return (document.sections || []).reduce((total, section) => total + (section.shots || []).filter(shot => shot.image).length, 0);
}

async function hydrateLegacyImages(document) {
  const shots = [];
  for (const section of document?.sections || []) {
    for (const shot of section.shots || []) {
      if (shot.image === true) shots.push(shot);
    }
  }
  if (!shots.length) return document;

  const blobs = [];
  let cursor;
  do {
    const page = await list({ prefix: 'dnr/', limit: 1000, ...(cursor ? { cursor } : {}) });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  for (const shot of shots) {
    const suffix = `-${shot.id}`;
    const matches = blobs.filter(blob => blob.pathname.includes(suffix));
    matches.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    shot.image = matches[0]?.url || '';
  }
  return document;
}

async function handler(req, res) {
  const db = database();
  await ensureSchema(db);
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = pathParts(req);
  const queryShotId = requestUrl.searchParams.get('shotId');
  const historyAction = requestUrl.searchParams.get('action');
  const historyQueryId = requestUrl.searchParams.get('id');

  if (req.method === 'GET' && parts.length === 1 && parts[0] === 'draft') {
    const result = await db.execute('SELECT document FROM dnr_drafts WHERE id = 1');
    const document = await hydrateLegacyImages(parseDocument(result.rows[0]?.document));
    return json(res, { draft: document });
  }

  if (parts[0] === 'images' && (parts[1] || queryShotId)) {
    const shotId = parts[1] || queryShotId;
    if (req.method === 'POST') {
      const mimeType = String(req.headers['content-type'] || '').split(';', 1)[0];
      if (!mimeType.startsWith('image/')) return error(res, 'Only image uploads are supported');
      let data;
      try {
        data = await requestBody(req, MAX_IMAGE_BYTES);
      } catch (uploadError) {
        return error(res, uploadError.message, 413);
      }
      if (!data.length) return error(res, 'Image is empty');
      const blob = await put(`dnr/${Date.now()}-${shotId}`, data, {
        access: 'public',
        addRandomSuffix: true,
        contentType: mimeType
      });
      return json(res, { ok: true, url: blob.url });
    }
    // Blob files are immutable. Keep them because saved history records may
    // still reference the URL after the current draft removes the image.
    if (req.method === 'DELETE') return json(res, { ok: true });
  }

  if (req.method === 'POST' && parts.length === 1 && parts[0] === 'draft') {
    const document = await readJson(req);
    await db.execute({
      sql: `INSERT INTO dnr_drafts (id, document, updated_at)
        VALUES (1, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET document = excluded.document, updated_at = CURRENT_TIMESTAMP`,
      args: [JSON.stringify(document)]
    });
    return json(res, { ok: true });
  }

  if (req.method === 'GET' && parts.length === 1 && parts[0] === 'history' && !historyAction) {
    const result = await db.execute('SELECT id, name, created_at, document FROM dnr_history ORDER BY id DESC');
    return json(res, { records: result.rows.map(row => {
      const document = parseDocument(row.document);
      return {
        id: String(row.id),
        name: row.name,
        created_at: row.created_at,
        screenshot_count: screenshotCount(document)
      };
    }) });
  }

  if (req.method === 'POST' && parts.length === 1 && parts[0] === 'history' && !historyAction) {
    const payload = await readJson(req);
    const name = String(payload.name || '').trim();
    if (!name) return error(res, 'History record name is required');
    if (!payload.document || typeof payload.document !== 'object') return error(res, 'History record document is required');
    const result = await db.execute({
      sql: 'INSERT INTO dnr_history (name, document) VALUES (?, ?) RETURNING id',
      args: [name, JSON.stringify(payload.document)]
    });
    return json(res, { ok: true, id: String(result.rows[0].id) });
  }

  if (parts.length === 1 && parts[0] === 'history' && /^\d+$/.test(historyQueryId || '')) {
    const id = Number(historyQueryId);
    if (req.method === 'DELETE' && historyAction === 'delete') {
      await db.execute({ sql: 'DELETE FROM dnr_history WHERE id = ?', args: [id] });
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && historyAction === 'load') {
      const result = await db.execute({ sql: 'SELECT document FROM dnr_history WHERE id = ?', args: [id] });
      if (!result.rows[0]) return error(res, 'History record not found', 404);
      const document = await hydrateLegacyImages(parseDocument(result.rows[0].document));
      await db.execute({
        sql: `INSERT INTO dnr_drafts (id, document, updated_at)
          VALUES (1, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET document = excluded.document, updated_at = CURRENT_TIMESTAMP`,
        args: [JSON.stringify(document)]
      });
      return json(res, { draft: document });
    }
  }

  if (parts[0] === 'history' && /^\d+$/.test(parts[1] || '')) {
    const id = Number(parts[1]);
    if (req.method === 'DELETE' && parts.length === 2) {
      await db.execute({ sql: 'DELETE FROM dnr_history WHERE id = ?', args: [id] });
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && parts[2] === 'load') {
      const result = await db.execute({ sql: 'SELECT document FROM dnr_history WHERE id = ?', args: [id] });
      if (!result.rows[0]) return error(res, 'History record not found', 404);
      const document = parseDocument(result.rows[0].document);
      await db.execute({
        sql: `INSERT INTO dnr_drafts (id, document, updated_at)
          VALUES (1, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET document = excluded.document, updated_at = CURRENT_TIMESTAMP`,
        args: [JSON.stringify(document)]
      });
      return json(res, { draft: document });
    }
  }

  return error(res, 'Not found', 404);
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
