const fs = require('fs');
const path = require('path');

const baseDir = 'C:\\Users\\ADMIN\\Desktop\\Accumulator-Bot';

// 1. Update deriv-client.js
const derivClientPath = path.join(baseDir, 'public', 'js', 'deriv-client.js');
let dcCode = fs.readFileSync(derivClientPath, 'utf8');

// A. Add active symbols and contracts_for cache to constructor
if (!dcCode.includes('this._activeSymbols = [];')) {
  dcCode = dcCode.replace(
    'this.MIN_SELL_INTERVAL_MS = 1200;',
    'this.MIN_SELL_INTERVAL_MS = 1200;\n    this._activeSymbols = [];\n    this._contractsForCache = {};'
  );
}

// B. Add loadActiveSymbols, resolveExactSymbol, getContractsFor methods
const helperMethods = `
  // ── Dynamic Deriv Symbol Discovery & Resolution ───────────────
  async loadActiveSymbols() {
    if (this._activeSymbols && this._activeSymbols.length > 0) return this._activeSymbols;
    try {
      console.log('[DerivWS] Querying active_symbols from Deriv...');
      const res = await this.send({ active_symbols: 'brief', product_type: 'basic' });
      if (res && res.active_symbols && Array.isArray(res.active_symbols)) {
        this._activeSymbols = res.active_symbols;
        console.log(\`[DerivWS] Successfully loaded \${this._activeSymbols.length} active symbols from Deriv!\`);
        const cb = this._activeSymbols.filter(s => /CRASH|BOOM/i.test(s.symbol) || /CRASH|BOOM/i.test(s.display_name));
        console.log('[DerivWS] Available Crash & Boom symbols on Deriv:', cb.map(s => \`\${s.symbol} (\${s.display_name})\`));
        return this._activeSymbols;
      }
    } catch (err) {
      console.warn('[DerivWS] active_symbols query notice:', err.message || err);
    }
    return [];
  }

  resolveExactSymbol(userSymbol) {
    if (!userSymbol) return 'R_100';
    const clean = String(userSymbol).trim();
    if (!this._activeSymbols || this._activeSymbols.length === 0) {
      return clean;
    }

    // 1. Exact match
    const exact = this._activeSymbols.find(s => s.symbol === clean);
    if (exact) return exact.symbol;

    // 2. Case-insensitive
    const caseMatch = this._activeSymbols.find(s => s.symbol.toUpperCase() === clean.toUpperCase());
    if (caseMatch) return caseMatch.symbol;

    // 3. Alphanumeric match (handles CRASH_50, CRASH50, CRASH50N, etc.)
    const norm = clean.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const normMatch = this._activeSymbols.find(s => {
      const symNorm = s.symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
      return symNorm === norm || symNorm === norm + 'N' || norm === symNorm + 'N';
    });
    if (normMatch) return normMatch.symbol;

    // 4. Display name match (e.g. "Crash 50 Index")
    const dispMatch = this._activeSymbols.find(s => {
      const dispNorm = (s.display_name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      return dispNorm.includes(norm) || norm.includes(dispNorm);
    });
    if (dispMatch) return dispMatch.symbol;

    return clean;
  }

  async getContractsFor(symbol) {
    if (!this._contractsForCache) this._contractsForCache = {};
    if (this._contractsForCache[symbol]) return this._contractsForCache[symbol];

    try {
      const res = await this.send({ contracts_for: symbol });
      if (res && res.contracts_for && res.contracts_for.available) {
        this._contractsForCache[symbol] = res.contracts_for.available;
        return res.contracts_for.available;
      }
    } catch (err) {
      console.warn(\`[DerivWS] contracts_for query for \${symbol}:\`, err.message || err);
    }
    return null;
  }
`;

if (!dcCode.includes('loadActiveSymbols()')) {
  dcCode = dcCode.replace(
    '// ── Standard WS Flow ───────────────────────────────────────────',
    `${helperMethods}\n  // ── Standard WS Flow ───────────────────────────────────────────`
  );
}

// C. Ensure loadActiveSymbols is called after authorization in both OTP and Standard WS
if (!dcCode.includes('this.loadActiveSymbols().catch')) {
  dcCode = dcCode.replace(
    'this.subscribeOpenContract().catch(() => {});\n        resolve({ connected: true, authorized: true });\n      };\n\n      this.ws.onmessage = (event) => {\n        try {\n          const msg = JSON.parse(event.data);\n          this._handleMessage(msg);\n        } catch(e) {}\n      };\n\n      this.ws.onerror = () => {',
    'this.subscribeOpenContract().catch(() => {});\n        this.loadActiveSymbols().catch(() => {});\n        resolve({ connected: true, authorized: true });\n      };\n\n      this.ws.onmessage = (event) => {\n        try {\n          const msg = JSON.parse(event.data);\n          this._handleMessage(msg);\n        } catch(e) {}\n      };\n\n      this.ws.onerror = () => {'
  );
  dcCode = dcCode.replace(
    'this.subscribeOpenContract().catch(() => {});\n          resolve({ connected: true, authorized: true });\n        }).catch(err => {\n          this.emit(\'log\', { type: \'error\', msg: `Auth Failed: ${err.message}` });',
    'this.subscribeOpenContract().catch(() => {});\n          this.loadActiveSymbols().catch(() => {});\n          resolve({ connected: true, authorized: true });\n        }).catch(err => {\n          this.emit(\'log\', { type: \'error\', msg: `Auth Failed: ${err.message}` });'
  );
}

// D. Fix this.buy() to always supply BOTH symbol and underlying_symbol
dcCode = dcCode.replace(
  `    if (this.token && this.token.startsWith('pat_')) {\n      req.underlying_symbol = cleanSymbol;\n    } else {\n      req.symbol = cleanSymbol;\n    }`,
  `    req.symbol = cleanSymbol;\n    req.underlying_symbol = cleanSymbol;`
);

// E. Replace buyAccumulator method with robust multi-contract discovery & execution
const newBuyAccumulator = `  // ── Complete Adaptive Trading Engine (ACCU + Multipliers + Options) ──
  async buyAccumulator(symbol, amount, growthRate, maxTicks) {
    const cleanSymbol = symbol || 'R_100';
    const rate = parseFloat(growthRate) || 0.02;
    const targetTicks = parseInt(maxTicks, 10) || 5;

    // Calculate exact target profit for maxTicks to enable Deriv Server-Side Auto Exit
    let targetProfit = 0;
    if (targetTicks > 0 && rate > 0 && amount > 0) {
      const exactProfit = amount * (Math.pow(1 + rate, targetTicks) - 1);
      targetProfit = parseFloat((Math.floor(exactProfit * 100) / 100).toFixed(2));
      if (targetProfit <= 0) targetProfit = 0.01;
    }

    const uSym = cleanSymbol.toUpperCase();
    const isCrash = uSym.includes('CRASH');
    const isBoom  = uSym.includes('BOOM');

    // Dynamically resolve symbol using Deriv active symbols
    const resolvedSym = this.resolveExactSymbol(cleanSymbol);
    const candidateSet = new Set([resolvedSym, cleanSymbol]);

    // Format variants (e.g. CRASH300, CRASH_300, CRASH300N, CRASH_300N, etc.)
    const alpha = uSym.replace(/[^A-Z0-9]/g, '');
    candidateSet.add(alpha);
    if (!alpha.endsWith('N')) candidateSet.add(alpha + 'N');
    if (alpha.endsWith('N')) candidateSet.add(alpha.slice(0, -1));

    const withUnder = uSym.replace(/(CRASH|BOOM)(\\d+)/i, '$1_$2');
    if (withUnder !== uSym) {
      candidateSet.add(withUnder);
      candidateSet.add(withUnder + 'N');
      candidateSet.add(withUnder + '_INDEX');
    }

    const uniqueCandidates = [...candidateSet].filter(Boolean);
    console.log(\`[DerivWS] Trading candidates for \${cleanSymbol}:\`, uniqueCandidates);

    let lastErrorMsg = '';

    // 1. Try Native ACCU (Accumulator contract) on all candidate symbols
    for (const sym of uniqueCandidates) {
      try {
        const req = {
          buy: 1,
          price: amount,
          parameters: {
            amount: amount,
            basis: 'stake',
            contract_type: 'ACCU',
            currency: this.currency || 'USD',
            growth_rate: rate,
            symbol: sym,
            underlying_symbol: sym,
            ...(targetProfit > 0 ? {
              limit_order: {
                take_profit: targetProfit
              }
            } : {})
          }
        };
        const res = await this.send(req);
        if (res?.buy?.contract_id) {
          const cid = res.buy.contract_id;
          console.log(\`[DerivWS] ACCU opened on \${sym}: #\${cid}\`);
          this.openContractsCache.set(cid, {
            contract_id: cid,
            is_sold: false,
            profit: 0,
            status: 'open',
            tick_passed: 0,
            ticks: 0,
            stake: amount,
            growth_rate: rate,
            is_valid_to_sell: false,
            _lastUpdateTime: Date.now()
          });
          this.subscribeContract(cid).catch(() => {});

          if (targetProfit > 0 && cid) {
            this.send({
              contract_update: 1,
              contract_id: parseInt(cid, 10),
              limit_order: { take_profit: targetProfit }
            }).catch(err => {
              console.warn(\`[DerivWS] contract_update notice for #\${cid}:\`, err.message);
            });
          }

          return { contract_id: cid, contract_type: 'ACCU', symbol: sym };
        }
      } catch (directErr) {
        lastErrorMsg = directErr.message || String(directErr);
        // Try 2-step proposal for ACCU
        try {
          const propRes = await this.send({
            proposal: 1,
            amount: amount,
            basis: 'stake',
            contract_type: 'ACCU',
            currency: this.currency || 'USD',
            growth_rate: rate,
            symbol: sym,
            underlying_symbol: sym,
            ...(targetProfit > 0 ? {
              limit_order: { take_profit: targetProfit }
            } : {})
          });
          if (propRes?.proposal?.id) {
            const buyRes = await this.send({ buy: propRes.proposal.id, price: amount });
            if (buyRes?.buy?.contract_id) {
              const cid = buyRes.buy.contract_id;
              console.log(\`[DerivWS] ACCU opened via proposal on \${sym}: #\${cid}\`);
              this.openContractsCache.set(cid, {
                contract_id: cid,
                is_sold: false,
                profit: 0,
                status: 'open',
                tick_passed: 0,
                ticks: 0,
                stake: amount,
                growth_rate: rate,
                is_valid_to_sell: false,
                _lastUpdateTime: Date.now()
              });
              this.subscribeContract(cid).catch(() => {});
              return { contract_id: cid, contract_type: 'ACCU', symbol: sym };
            }
          }
        } catch (propErr) {
          lastErrorMsg = propErr.message || String(propErr);
        }
      }
    }

    // 2. Query contracts_for to discover available contract types on this symbol
    console.log(\`[DerivWS] ACCU not available for \${cleanSymbol}. Discovering available contracts via contracts_for...\`);

    for (const sym of uniqueCandidates) {
      let available = null;
      try {
        available = await this.getContractsFor(sym);
      } catch (_) {}

      // A. MULTIPLIER (Primary DTrader contract for Crash and Boom)
      const multContracts = available ? available.filter(c => c.contract_type === 'MULTUP' || c.contract_type === 'MULTDOWN') : [];
      if (multContracts.length > 0 || isCrash || isBoom) {
        // Crash indexes drift up slowly (MULTUP), Boom indexes drift down slowly (MULTDOWN)
        const multType = isCrash ? 'MULTUP' : (isBoom ? 'MULTDOWN' : 'MULTUP');
        let allowedMults = [100, 200, 400, 50, 500];

        const matchC = multContracts.find(c => c.contract_type === multType);
        if (matchC && Array.isArray(matchC.multiplier_range) && matchC.multiplier_range.length > 0) {
          allowedMults = matchC.multiplier_range;
        }

        // Test allowed multipliers
        for (const mult of allowedMults) {
          try {
            const propRes = await this.send({
              proposal: 1,
              amount: Math.max(1.0, amount),
              basis: 'stake',
              contract_type: multType,
              currency: this.currency || 'USD',
              symbol: sym,
              underlying_symbol: sym,
              multiplier: mult
            });
            if (propRes?.proposal?.id) {
              const askPrice = parseFloat(propRes.proposal.ask_price || amount);
              const buyRes = await this.send({ buy: propRes.proposal.id, price: askPrice });
              if (buyRes?.buy?.contract_id) {
                const cid = buyRes.buy.contract_id;
                console.log(\`[DerivWS] Multiplier \${multType} (x\${mult}) opened on \${sym}: #\${cid}\`);
                this.openContractsCache.set(cid, {
                  contract_id: cid,
                  is_sold: false,
                  profit: 0,
                  status: 'open',
                  tick_passed: 0,
                  ticks: 0,
                  stake: amount,
                  growth_rate: rate,
                  is_valid_to_sell: true,
                  _lastUpdateTime: Date.now()
                });
                this.subscribeContract(cid).catch(() => {});
                return { contract_id: cid, contract_type: multType, symbol: sym };
              }
            }
          } catch (mErr) {
            lastErrorMsg = mErr.message || String(mErr);
            console.warn(\`[DerivWS] Multiplier x\${mult} on \${sym} declined:\`, lastErrorMsg);
          }
        }
      }

      // B. RISE / FALL OPTIONS (CALL / PUT)
      const callPutType = isCrash ? 'CALL' : (isBoom ? 'PUT' : 'CALL');
      const dur = Math.max(5, Math.min(10, parseInt(maxTicks, 10) || 5));
      try {
        const buyRes = await this.buy(callPutType, amount, dur, 't', undefined, sym);
        if (buyRes && buyRes.contract_id) {
          console.log(\`[DerivWS] \${callPutType} (\${dur}t) opened on \${sym}: #\${buyRes.contract_id}\`);
          return { contract_id: buyRes.contract_id, contract_type: callPutType, symbol: sym };
        }
      } catch (cpErr) {
        lastErrorMsg = cpErr.message || String(cpErr);
        console.warn(\`[DerivWS] \${callPutType} on \${sym} declined:\`, lastErrorMsg);
        // If ticks duration is rejected, try minimum seconds duration (15s)
        try {
          const buyResSec = await this.buy(callPutType, amount, 15, 's', undefined, sym);
          if (buyResSec && buyResSec.contract_id) {
            console.log(\`[DerivWS] \${callPutType} (15s) opened on \${sym}: #\${buyResSec.contract_id}\`);
            return { contract_id: buyResSec.contract_id, contract_type: callPutType, symbol: sym };
          }
        } catch (_) {}
      }

      // C. DIGIT DIFFERS (DIGITDIFF - 1 tick, prediction 0)
      try {
        const buyRes = await this.buy('DIGITDIFF', amount, 1, 't', '0', sym);
        if (buyRes && buyRes.contract_id) {
          console.log(\`[DerivWS] DIGITDIFF opened on \${sym}: #\${buyRes.contract_id}\`);
          return { contract_id: buyRes.contract_id, contract_type: 'DIGITDIFF', symbol: sym };
        }
      } catch (ddErr) {
        lastErrorMsg = ddErr.message || String(ddErr);
      }
    }

    // 3. Fallback: If ALL contract proposals fail on this symbol
    console.warn(\`[DerivWS] No viable options accepted by Deriv for \${cleanSymbol}: \${lastErrorMsg}\`);
    this.emit('log', {
      type: 'warning',
      msg: \`⚠️ \${cleanSymbol}: Trade proposal rejected (\${lastErrorMsg || 'Symbol unavailable on Deriv'}). Safely skipping to next bot.\`
    });

    return {
      contract_id: null,
      result: 'skipped',
      symbol: cleanSymbol,
      message: lastErrorMsg || \`Deriv rejected proposals for \${cleanSymbol}\`
    };
  }`;

// Find start of buyAccumulator and replace up to subscribeContract
const buyAccuIndex = dcCode.indexOf('async buyAccumulator(');
const subContractIndex = dcCode.indexOf('// ── Dedicated Contract Subscription (Instant Tick Stream) ──────');

if (buyAccuIndex !== -1 && subContractIndex !== -1) {
  dcCode = dcCode.slice(0, buyAccuIndex) + newBuyAccumulator + '\n\n  ' + dcCode.slice(subContractIndex);
}

fs.writeFileSync(derivClientPath, dcCode, 'utf8');
console.log('deriv-client.js updated successfully!');

// 2. Update max-ticks-watcher.js to count ticks via spot updates as well
const watcherPath = path.join(baseDir, 'public', 'js', 'max-ticks-watcher.js');
let wCode = fs.readFileSync(watcherPath, 'utf8');

// In startWatch, initialize spot tracker
if (!wCode.includes('this._lastSpot')) {
  wCode = wCode.replace(
    'this._isPolling   = false;',
    'this._isPolling   = false;\n    this._lastSpot    = null;\n    this._spotUpdateCount = 0;'
  );
}

// In _processContract, add spot change counter
if (!wCode.includes('this._spotUpdateCount')) {
  wCode = wCode.replace(
    '// Never go backwards\n    if (ticks > this.currentTicks) this.currentTicks = ticks;',
    '// 4. Spot change tracker for Multipliers & Non-ACCU contracts\n    if (spot != null && spot !== this._lastSpot) {\n      this._lastSpot = spot;\n      this._spotUpdateCount = (this._spotUpdateCount || 0) + 1;\n      if (this._spotUpdateCount > 1) {\n        ticks = Math.max(ticks, this._spotUpdateCount - 1);\n      }\n    }\n\n    // Never go backwards\n    if (ticks > this.currentTicks) this.currentTicks = ticks;'
  );
}
fs.writeFileSync(watcherPath, wCode, 'utf8');
console.log('max-ticks-watcher.js updated successfully!');

// 3. Update index.html script tags to v=3.7 for cache busting
const indexPath = path.join(baseDir, 'public', 'index.html');
let htmlCode = fs.readFileSync(indexPath, 'utf8');
htmlCode = htmlCode.replace(/v=3\.6/g, 'v=3.7');
fs.writeFileSync(indexPath, htmlCode, 'utf8');
console.log('index.html updated successfully with v=3.7!');
