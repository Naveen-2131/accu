const fs = require('fs');
const path = require('path');

const baseDir = 'C:\\Users\\ADMIN\\Desktop\\Accumulator-Bot';
const derivClientPath = path.join(baseDir, 'public', 'js', 'deriv-client.js');
let dcCode = fs.readFileSync(derivClientPath, 'utf8');

// 1. In this.buy(), remove req.symbol = cleanSymbol;
dcCode = dcCode.replace(
  '    req.symbol = cleanSymbol;\n    req.underlying_symbol = cleanSymbol;',
  '    req.underlying_symbol = cleanSymbol;'
);

// 2. In buyAccumulator ACCU direct buy parameters:
dcCode = dcCode.replace(
  '              growth_rate: rate,\n              symbol: sym,\n              underlying_symbol: sym,',
  '              growth_rate: rate,\n              underlying_symbol: sym,'
);

// 3. In buyAccumulator ACCU throttledProposal:
dcCode = dcCode.replace(
  '              growth_rate: rate,\n              symbol: sym,\n              underlying_symbol: sym,',
  '              growth_rate: rate,\n              underlying_symbol: sym,'
);

// 4. In buyAccumulator Call/Put direct buy parameters:
dcCode = dcCode.replace(
  '              duration_unit: \'t\',\n              symbol: sym,\n              underlying_symbol: sym',
  '              duration_unit: \'t\',\n              underlying_symbol: sym'
);

// 5. In buyAccumulator Multiplier direct buy parameters:
dcCode = dcCode.replace(
  '              multiplier: 100,\n              symbol: sym,\n              underlying_symbol: sym',
  '              multiplier: 100,\n              underlying_symbol: sym'
);

// 6. In buyAccumulator Multiplier throttledProposal:
dcCode = dcCode.replace(
  '            currency: this.currency || \'USD\',\n            symbol: sym,\n            underlying_symbol: sym,',
  '            currency: this.currency || \'USD\',\n            underlying_symbol: sym,'
);

fs.writeFileSync(derivClientPath, dcCode, 'utf8');
console.log('Removed invalid symbol properties from deriv-client.js!');

// 7. Bump index.html to v=3.9
const indexPath = path.join(baseDir, 'public', 'index.html');
let htmlCode = fs.readFileSync(indexPath, 'utf8');
htmlCode = htmlCode.replace(/v=3\.8/g, 'v=3.9');
fs.writeFileSync(indexPath, htmlCode, 'utf8');
console.log('index.html updated with v=3.9!');
