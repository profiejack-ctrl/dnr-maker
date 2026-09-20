const { neon } = require('@neondatabase/serverless');
const { put } = require('@vercel/blob');

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
let schemaReady;

function database() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  return neon(process.env.DATABASE_URL);
}

async function ensureSchema(sql) {
  if (!schemaReady) {
    schemaReady = sql.transaction([
      sql`CREATE TABLE IF NOT EXISTS dnr_drafts (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        document JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      sql`CREATE TABLE IF NOT EXISTS dnr_history (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        document JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

function screenshotCount(document) {
  return (document.sections || []).reduce((total, section) => total + (section.shots || []).filter(shot => shot.image).length, 0);
}

async function handler(req, res) {
  const sql = database();
  await ensureSchema(sql);
  const parts = pathParts(req);

  if (req.method === 'GET' && parts.length === 1 && parts[0] === 'draft') {
    const rows = await sql`SELECT document FROM dnr_drafts WHERE id = 1`;
    return json(res, { draft: rows[0]?.document || null });
  }

  if (parts[0] === 'images' && parts[1]) {
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
      const blob = await put(`dnr/${Date.now()}-${parts[1]}`, data, {
        access: 'public',
        addRandomSuffix: true,
        contentType: mimeType
      });
      return json(res, { ok: true, url: blob.url });
    }
    // Image files live in Blob and are immutable. Deletion is intentionally a
    // no-op here because a saved history record may still reference the URL.
    if (req.method === 'DELETE') return json(res, { ok: true });
  }

  if (req.method === 'POST' && parts.length === 1 && parts[0] === 'draft') {
    const document = await readJson(req);
    await sql`INSERT INTO dnr_drafts (id, document, updated_at)
      VALUES (1, ${JSON.stringify(document)}::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document, updated_at = NOW()`;
    return json(res, { ok: true });
  }

  if (req.method === 'GET' && parts.length === 1 && parts[0] === 'history') {
    const rows = await sql`SELECT id, name, created_at, document FROM dnr_history ORDER BY id DESC`;
    return json(res, { records: rows.map(row => ({
      id: String(row.id), name: row.name, created_at: row.created_at,
      screenshot_count: screenshotCount(row.document)
    })) });
  }

  if (req.method === 'POST' && parts.length === 1 && parts[0] === 'history') {
    const payload = await readJson(req);
    const name = String(payload.name || '').trim();
    if (!name) return error(res, 'History record name is required');
    if (!payload.document || typeof payload.document !== 'object') return error(res, 'History record document is required');
    const rows = await sql`INSERT INTO dnr_history (name, document) VALUES (${name}, ${JSON.stringify(payload.document)}::jsonb) RETURNING id`;
    return json(res, { ok: true, id: String(rows[0].id) });
  }

  if (parts[0] === 'history' && /^\d+$/.test(parts[1] || '')) {
    const id = Number(parts[1]);
    if (req.method === 'DELETE' && parts.length === 2) {
      await sql`DELETE FROM dnr_history WHERE id = ${id}`;
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && parts[2] === 'load') {
      const rows = await sql`SELECT document FROM dnr_history WHERE id = ${id}`;
      if (!rows[0]) return error(res, 'History record not found', 404);
      const document = rows[0].document;
      await sql`INSERT INTO dnr_drafts (id, document, updated_at)
        VALUES (1, ${JSON.stringify(document)}::jsonb, NOW())
        ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document, updated_at = NOW()`;
      return json(res, { draft: document });
    }
  }

  return error(res, 'Not found', 404);
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
