const express = require('express');
const fs = require('fs');

const app = express();

app.get('/', (req, res) => {
  res.send('Key system is online');
});

app.get('/check', (req, res) => {
  const userKey = req.query.key;
  const keys = JSON.parse(fs.readFileSync('keys.json', 'utf8'));

  if (keys[userKey] === true) {
    return res.json({ valid: true });
  }

  res.json({ valid: false });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
