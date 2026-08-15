const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT = path.join(__dirname, '.');

app.use(express.static(ROOT));

app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Portfolio site running at http://localhost:${PORT}`);
});
