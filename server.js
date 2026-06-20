const express = require('express');
const crypto = require('crypto');

const fetchImpl = globalThis.fetch || require('node-fetch');
const app = express();

// Required Render environment variable:
//   GITHUB_TOKEN=<fine-grained token with Contents: Read and write on LICENSE_REPO>
// Optional Render environment variables (defaults shown):
//   LICENSE_REPO=lazentho/key-api
//   LICENSE_BRANCH=license-data
//   LICENSE_FILE=licenses.json
// Keep GITHUB_TOKEN server-side. Never put it in client code or log it.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const LICENSE_REPO = process.env.LICENSE_REPO || 'lazentho/key-api';
const LICENSE_BRANCH = process.env.LICENSE_BRANCH || 'license-data';
const LICENSE_FILE = process.env.LICENSE_FILE || 'licenses.json';
const MAX_WRITE_ATTEMPTS = 3;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function getConfiguredKeys() {
  // Preferred format:
  // LICENSE_KEYS_JSON={"hash_here":{"expires":"2026-07-19"}}
  // Legacy format still works; legacy keys never expire:
  // VALID_KEY_HASHES=hash1,hash2,hash3
  const keys = {};

  if (process.env.LICENSE_KEYS_JSON) {
    try {
      const parsed = JSON.parse(process.env.LICENSE_KEYS_JSON);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error('expected a JSON object');
      }
      for (const [hash, value] of Object.entries(parsed)) {
        if (/^[a-f0-9]{64}$/i.test(hash)) {
          keys[hash.toLowerCase()] = {
            expires: value && typeof value === 'object' ? value.expires || null : null,
          };
        }
      }
    } catch (error) {
      console.error('Invalid LICENSE_KEYS_JSON:', error.message);
    }
  }

  for (const hash of (process.env.VALID_KEY_HASHES || '').split(',').map(value => value.trim())) {
    if (/^[a-f0-9]{64}$/i.test(hash) && !keys[hash.toLowerCase()]) {
      keys[hash.toLowerCase()] = { expires: null };
    }
  }

  return keys;
}

function isExpired(expires) {
  if (!expires) return false;
  const expiryDate = new Date(expires + 'T23:59:59Z');
  return Number.isNaN(expiryDate.getTime()) || new Date() > expiryDate;
}

function encodedFilePath() {
  return LICENSE_FILE.split('/').map(encodeURIComponent).join('/');
}

function contentsUrl() {
  return `https://api.github.com/repos/${LICENSE_REPO}/contents/${encodedFilePath()}`;
}

async function githubRequest(url, options = {}) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not configured');

  const response = await fetchImpl(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'key-api-license-store',
      ...(options.headers || {}),
    },
  });

  let body = null;
  try {
    body = await response.json();
  } catch (_) {
    // A body is not required for every successful GitHub response.
  }

  if (!response.ok) {
    const error = new Error(`GitHub Contents API returned ${response.status}`);
    error.status = response.status;
    error.githubMessage = body && body.message;
    throw error;
  }

  return body;
}

function normalizeStore(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return {};
  const normalized = {};
  for (const [hash, record] of Object.entries(value)) {
    if (!/^[a-f0-9]{64}$/i.test(hash) || !record || typeof record !== 'object') continue;
    normalized[hash.toLowerCase()] = {
      expires: record.expires || null,
      hwid: typeof record.hwid === 'string' && /^[a-f0-9]{64}$/i.test(record.hwid)
        ? record.hwid.toLowerCase()
        : null,
    };
  }
  return normalized;
}

async function readLicenseStore() {
  try {
    const file = await githubRequest(`${contentsUrl()}?ref=${encodeURIComponent(LICENSE_BRANCH)}`);
    const text = Buffer.from(String(file.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
    return { licenses: normalizeStore(JSON.parse(text || '{}')), sha: file.sha };
  } catch (error) {
    if (error.status !== 404) throw error;

    try {
      const created = await githubRequest(contentsUrl(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Initialize license HWID store',
          content: Buffer.from('{}\n').toString('base64'),
          branch: LICENSE_BRANCH,
        }),
      });
      return { licenses: {}, sha: created.content.sha };
    } catch (createError) {
      // Another instance may have created the file after our GET returned 404.
      if (createError.status === 409 || createError.status === 422) {
        const file = await githubRequest(`${contentsUrl()}?ref=${encodeURIComponent(LICENSE_BRANCH)}`);
        const text = Buffer.from(String(file.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
        return { licenses: normalizeStore(JSON.parse(text || '{}')), sha: file.sha };
      }
      throw createError;
    }
  }
}

async function writeLicenseStore(licenses, sha, message) {
  return githubRequest(contentsUrl(), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: Buffer.from(JSON.stringify(licenses, null, 2) + '\n').toString('base64'),
      sha,
      branch: LICENSE_BRANCH,
    }),
  });
}

function importConfiguredKeys(licenses) {
  let changed = false;
  for (const [hash, configured] of Object.entries(getConfiguredKeys())) {
    const existing = licenses[hash];
    const next = {
      expires: configured.expires || null,
      hwid: existing && existing.hwid ? existing.hwid : null,
    };
    if (!existing || existing.expires !== next.expires || existing.hwid !== next.hwid) {
      licenses[hash] = next;
      changed = true;
    }
  }
  return changed;
}

async function initializeLicenseStore() {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const current = await readLicenseStore();
    if (!importConfiguredKeys(current.licenses)) return;
    try {
      await writeLicenseStore(current.licenses, current.sha, 'Import configured license keys');
      return;
    } catch (error) {
      if ((error.status === 409 || error.status === 422) && attempt + 1 < MAX_WRITE_ATTEMPTS) continue;
      throw error;
    }
  }
}

let initializationPromise;
function ensureInitialized() {
  if (!initializationPromise) {
    initializationPromise = initializeLicenseStore().catch(error => {
      initializationPromise = null;
      throw error;
    });
  }
  return initializationPromise;
}

async function checkAndBindLicense(keyHash, hwid) {
  await ensureInitialized();

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const current = await readLicenseStore();
    const keyData = current.licenses[keyHash];

    if (!keyData) return { valid: false, reason: 'key_not_found' };
    if (isExpired(keyData.expires)) {
      return { valid: false, reason: 'expired', expires: keyData.expires };
    }
    if (keyData.hwid) {
      return keyData.hwid === hwid
        ? { valid: true, bound: true, expires: keyData.expires || null }
        : { valid: false, reason: 'hwid_mismatch' };
    }

    current.licenses[keyHash] = { expires: keyData.expires || null, hwid };
    try {
      await writeLicenseStore(current.licenses, current.sha, 'Bind license key to first HWID');
      return { valid: true, bound: true, expires: keyData.expires || null };
    } catch (error) {
      // A competing request may have bound the key first. Reread and decide again.
      if ((error.status === 409 || error.status === 422) && attempt + 1 < MAX_WRITE_ATTEMPTS) continue;
      throw error;
    }
  }

  throw new Error('Unable to update license store after conflict retries');
}

app.get('/', (req, res) => {
  res.send('Key system is online');
});

app.get('/check', async (req, res) => {
  const userKey = String(req.query.key || '');
  const hwid = String(req.query.hwid || '').toLowerCase();

  if (!userKey || userKey.length > 100) {
    return res.json({ valid: false, reason: 'missing_or_invalid_key' });
  }
  if (!/^[a-f0-9]{64}$/.test(hwid)) {
    return res.json({ valid: false, reason: 'missing_or_invalid_hwid' });
  }

  try {
    const result = await checkAndBindLicense(sha256(userKey), hwid);
    return res.json(result);
  } catch (error) {
    // Do not include request headers, tokens, or GitHub response bodies in logs/responses.
    console.error('License storage request failed:', error.message);
    return res.status(503).json({ valid: false, reason: 'storage_unavailable' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
  ensureInitialized().catch(error => {
    console.error('License storage initialization failed:', error.message);
  });
});

