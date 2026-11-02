const fs = require('fs');
const path = require('path');

const baseDir = 'C:\\Users\\ADMIN\\Desktop\\Accumulator-Bot';

// 1. Update app.js
const appJsPath = path.join(baseDir, 'public', 'js', 'app.js');
let appCode = fs.readFileSync(appJsPath, 'utf8');

// Replace top header comment
appCode = appCode.replace('Complete 27-Symbol Wave Engine', 'Complete 24-Symbol Wave Engine');
appCode = appCode.replace('Supports all 27 Volatility, Volatility 1s, Crash, and Boom Symbols', 'Supports all 24 Volatility, Volatility 1s, Crash, and Boom Symbols');
appCode = appCode.replace('Complete 27 Symbols from User Screenshots', 'Complete 24 Symbols from User Screenshots');

// Remove the 3 symbols from ALL_SYMBOLS
const targetSymbolsBlock = `  { v: '1HZ150V',    l: 'Volatility 150 (1s) Index (ACCU)', group: 'Volatility 1s' },
  { v: '1HZ250V',    l: 'Volatility 250 (1s) Index (ACCU)', group: 'Volatility 1s' },
  { v: '1HZ300V',    l: 'Volatility 300 (1s) Index (ACCU)', group: 'Volatility 1s' },
`;
appCode = appCode.replace(targetSymbolsBlock, '');

// Pre-fill comment
appCode = appCode.replace('Pre-fill all 27 slots', 'Pre-fill all 24 slots');
appCode = appCode.replace('🤖 27-Symbol Accumulator Wave Engine Ready.', '🤖 24-Symbol Accumulator Wave Engine Ready.');
appCode = appCode.replace("'Volatility 1s': '── Volatility 1s Indices (11) ──',", "'Volatility 1s': '── Volatility 1s Indices (8) ──',");
appCode = appCode.replace('// ── Render 27 symbol slot cards', '// ── Render 24 symbol slot cards');
appCode = appCode.replace('DEFAULT_SLOTS (27 slots)', 'DEFAULT_SLOTS (24 slots)');
appCode = appCode.replace('🌟 All 27 bot slots enabled.', '🌟 All 24 bot slots enabled.');
appCode = appCode.replace('📊 All 16 Volatility bots enabled.', '📊 All 13 Volatility bots enabled.');

fs.writeFileSync(appJsPath, appCode, 'utf8');
console.log('app.js updated: removed 1HZ150V, 1HZ250V, 1HZ300V!');

// 2. Update index.html
const indexPath = path.join(baseDir, 'public', 'index.html');
let htmlCode = fs.readFileSync(indexPath, 'utf8');

htmlCode = htmlCode.replace('27 Customizable Multi-Bot Slots Grid', '24 Customizable Multi-Bot Slots Grid');
htmlCode = htmlCode.replace('<span>🤖 27 Deriv Symbol Slots</span>', '<span>🤖 24 Deriv Symbol Slots</span>');
htmlCode = htmlCode.replace('12 of 27 Enabled', '12 of 24 Enabled');
htmlCode = htmlCode.replace('title="Enable all 27 symbols">🌟 All 27</button>', 'title="Enable all 24 symbols">🌟 All 24</button>');
htmlCode = htmlCode.replace('title="Enable 13 Volatility symbols">📊 Volatility Accumulators (16)</button>', 'title="Enable 13 Volatility symbols">📊 Volatility Accumulators (13)</button>');
htmlCode = htmlCode.replace('(27 slots)', '(24 slots)');

// Bump version for cache-busting
htmlCode = htmlCode.replace(/v=4\.0/g, 'v=4.1');

fs.writeFileSync(indexPath, htmlCode, 'utf8');
console.log('index.html updated with 24 slots and bumped to v=4.1!');
