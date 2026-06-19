const express = require('express');
const crypto = require('crypto');

const app = express();

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function getValidKeyHashes() {
  // Put your secret SHA-256 key hashes in Render Environment Variables.
  // Example: VALID_KEY_HASHES=hash1,hash2,hash3
  return (process.env.VALID_KEY_HASHES || '')
    .split(',')
    .map(hash => hash.trim())
    .filter(Boolean);
}

app.get('/', (req, res) => {
  res.send('Key system is online');
});

app.get('/check', (req, res) => {
  const userKey = String(req.query.key || '');

  if (!userKey || userKey.length > 100) {
    return res.json({ valid: false });
  }

  const userKeyHash = sha256(userKey);
  const validKeyHashes = getValidKeyHashes();

  if (validKeyHashes.includes(userKeyHash)) {
    return res.json({ valid: true });
  }

  res.json({ valid: false });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
