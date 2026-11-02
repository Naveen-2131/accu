const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3007;

app.use(express.json());

const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

app.get('*', (req, res) => {
  const indexPath = path.join(publicDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  res.status(404).send('Accumulator Bot - Not Found');
});

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`📈 DERIV ACCUMULATOR BOT SERVER RUNNING!`);
  console.log(`👉 Access URL: http://localhost:${PORT}`);
  console.log(`=======================================================`);
});
