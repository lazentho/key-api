const express = require('express');
const crypto = require('crypto');

const app = express();

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function getKeys() {
  // Preferred format in Render Environment Variables:
  // LICENSE_KEYS_JSON={"hash_here":{"expires":"2026-07-19"}}
  //
  // Old format still works:
  // VALID_KEY_HASHES=hash1,hash2,hash3
  // Old format keys never expire.

  if (process.env.LICENSE_KEYS_JSON) {
    try {
      return JSON.parse(process.env.LICENSE_KEYS_JSON);
    } catch (error) {
      console.error('Invalid LICENSE_KEYS_JSON:', error.message);
      return {};
    }
  }

  const oldHashes = (process.env.VALID_KEY_HASHES || '')
    .split(',')
    .map(hash => hash.trim())
    .filter(Boolean);

  const keys = {};
  for (const hash of oldHashes) {
    keys[hash] = { expires: null };
  }

  return keys;
}

function isExpired(expires) {
  if (!expires) return false;

  const today = new Date();
  const expiryDate = new Date(expires + 'T23:59:59Z');

  return today > expiryDate;
}

app.get('/', (req, res) => {
  res.send('Key system is online');
});

app.get('/check', (req, res) => {
  const userKey = String(req.query.key || '');

  if (!userKey || userKey.length > 100) {
    return res.json({ valid: false, reason: 'missing_or_invalid_key' });
  }

  const userKeyHash = sha256(userKey);
  const keys = getKeys();
  const keyData = keys[userKeyHash];

  if (!keyData) {
    return res.json({ valid: false, reason: 'key_not_found' });
  }

  if (isExpired(keyData.expires)) {
    return res.json({ valid: false, reason: 'expired', expires: keyData.expires });
  }

  res.json({ valid: true, expires: keyData.expires || null });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
