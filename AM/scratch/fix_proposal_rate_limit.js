const fs = require('fs');
const path = require('path');

const baseDir = 'C:\\Users\\ADMIN\\Desktop\\Accumulator-Bot';
const derivClientPath = path.join(baseDir, 'public', 'js', 'deriv-client.js');
let dcCode = fs.readFileSync(derivClientPath, 'utf8');

// 1. Add proposal queue properties to constructor
if (!dcCode.includes('this._proposalQueue = [];')) {
  dcCode = dcCode.replace(
    'this._contractsForCache = {};',
    'this._contractsForCache = {};\n    this._proposalQueue = [];\n    this._isProcessingProposalQueue = false;\n    this._lastProposalTime = 0;'
  );
}

// 2. Add throttledProposal method
const throttledProposalMethod = `
  // ── Centralized Proposal Rate-Limiter Queue ───────────────────
  throttledProposal(payload) {
    return new Promise((resolve, reject) => {
      this._proposalQueue = this._proposalQueue || [];
      this._proposalQueue.push({ payload, resolve, reject, retries: 0 });
      this._processProposalQueue();
    });
  }

  async _processProposalQueue() {
    if (this._isProcessingProposalQueue) return;
    this._isProcessingProposalQueue = true;

    while (this._proposalQueue && this._proposalQueue.length > 0) {
      const now = Date.now();
      const elapsed = now - (this._lastProposalTime || 0);
      const minInterval = 350; // At least 350ms between proposals guarantees zero Deriv rate limit triggers
      if (elapsed < minInterval) {
        await new Promise(r => setTimeout(r, minInterval - elapsed));
      }

      const item = this._proposalQueue.shift();
      if (!item) break;

      try {
        this._lastProposalTime = Date.now();
        const res = await this.send(item.payload);
        item.resolve(res);
      } catch (err) {
        const msg = String(err?.message || err || '');
        if (msg.includes('rate limit') && item.retries < 3) {
          item.retries++;
          console.warn(\`[DerivWS] Rate limit on proposal, backing off 1200ms (attempt \${item.retries}/3)...\`);
          await new Promise(r => setTimeout(r, 1200));
          this._proposalQueue.unshift(item); // Re-queue at front
        } else {
          item.reject(err);
        }
      }
    }

    this._isProcessingProposalQueue = false;
  }
`;

if (!dcCode.includes('throttledProposal(')) {
  dcCode = dcCode.replace(
    '// ── Dedicated Contract Subscription (Instant Tick Stream) ──────',
    `${throttledProposalMethod}\n  // ── Dedicated Contract Subscription (Instant Tick Stream) ──────`
  );
}

// 3. Update this.buy to use throttledProposal instead of raw this.send(req)
dcCode = dcCode.replace(
  '    let propRes;\n    try {\n      propRes = await this.send(req);\n    } catch (err) {\n      const msg = err && (err.message || err.code || (typeof err === \'object\' ? JSON.stringify(err) : err));\n      throw new Error(`Proposal Error: ${msg}`);\n    }',
  '    let propRes;\n    try {\n      propRes = await this.throttledProposal(req);\n    } catch (err) {\n      const msg = err && (err.message || err.code || (typeof err === \'object\' ? JSON.stringify(err) : err));\n      throw new Error(`Proposal Error: ${msg}`);\n    }'
);

// 4. Clean, High-Speed, Zero-Rate-Limit buyAccumulator
const newBuyAccumulator = `  // ── High-Speed Multi-Asset Trade Engine (Direct-Buy-First, Zero Rate Limits) ──
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
    const isVol   = !isCrash && !isBoom;

    // Resolve exact symbol string from Deriv
    const exactSym = this.resolveExactSymbol(cleanSymbol);
    const symList = [exactSym];
    if (exactSym !== cleanSymbol) symList.push(cleanSymbol);

    let lastErrorMsg = '';

    // ═════════════════════════════════════════════════════════════
    // 1. VOLATILITY INDICES → NATIVE ACCUMULATOR (Direct Buy)
    // ═════════════════════════════════════════════════════════════
    if (isVol) {
      for (const sym of symList) {
        // Direct buy: 0 proposals, 0 rate limit!
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
                limit_order: { take_profit: targetProfit }
              } : {})
            }
          };
          const res = await this.send(req);
          if (res?.buy?.contract_id) {
            const cid = res.buy.contract_id;
            console.log(\`[DerivWS] Native ACCU opened directly on \${sym}: #\${cid}\`);
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
              }).catch(() => {});
            }

            return { contract_id: cid, contract_type: 'ACCU', symbol: sym };
          }
        } catch (dirErr) {
          lastErrorMsg = dirErr.message || String(dirErr);
          // Try throttled proposal fallback
          try {
            const propRes = await this.throttledProposal({
              proposal: 1,
              amount: amount,
              basis: 'stake',
              contract_type: 'ACCU',
              currency: this.currency || 'USD',
              growth_rate: rate,
              symbol: sym,
              underlying_symbol: sym,
              ...(targetProfit > 0 ? { limit_order: { take_profit: targetProfit } } : {})
            });
            if (propRes?.proposal?.id) {
              const buyRes = await this.send({ buy: propRes.proposal.id, price: amount });
              if (buyRes?.buy?.contract_id) {
                const cid = buyRes.buy.contract_id;
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
    }

    // ═════════════════════════════════════════════════════════════
    // 2. CRASH & BOOM INDICES → DIRECT-BUY OPTIONS / MULTIPLIERS
    // ═════════════════════════════════════════════════════════════
    if (isCrash || isBoom) {
      const callPutType = isCrash ? 'CALL' : 'PUT';
      const dur = Math.max(5, Math.min(10, parseInt(maxTicks, 10) || 5));

      for (const sym of symList) {
        // A. Direct Buy Rise/Fall Option (duration in ticks) — 0 PROPOSALS!
        try {
          const directRes = await this.send({
            buy: 1,
            price: parseFloat((amount * 1.5).toFixed(2)),
            parameters: {
              amount: parseFloat(parseFloat(amount).toFixed(2)),
              basis: 'stake',
              contract_type: callPutType,
              currency: this.currency || 'USD',
              duration: dur,
              duration_unit: 't',
              symbol: sym,
              underlying_symbol: sym
            }
          });
          if (directRes?.buy?.contract_id) {
            const cid = directRes.buy.contract_id;
            console.log(\`[DerivWS] Direct \${callPutType} (\${dur}t) opened on \${sym}: #\${cid}\`);
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
            return { contract_id: cid, contract_type: callPutType, symbol: sym };
          }
        } catch (dirCallErr) {
          lastErrorMsg = dirCallErr.message || String(dirCallErr);
          console.log(\`[DerivWS] Direct \${callPutType} on \${sym} notice: \${lastErrorMsg}\`);
        }

        // B. Direct Buy Multiplier (MULTUP for Crash, MULTDOWN for Boom) — 0 PROPOSALS!
        const multType = isCrash ? 'MULTUP' : 'MULTDOWN';
        try {
          const multDirectRes = await this.send({
            buy: 1,
            price: parseFloat((amount * 1.5).toFixed(2)),
            parameters: {
              amount: Math.max(1.0, parseFloat(parseFloat(amount).toFixed(2))),
              basis: 'stake',
              contract_type: multType,
              currency: this.currency || 'USD',
              multiplier: 100,
              symbol: sym,
              underlying_symbol: sym
            }
          });
          if (multDirectRes?.buy?.contract_id) {
            const cid = multDirectRes.buy.contract_id;
            console.log(\`[DerivWS] Direct Multiplier \${multType} (x100) opened on \${sym}: #\${cid}\`);
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
        } catch (dirMultErr) {
          lastErrorMsg = dirMultErr.message || String(dirMultErr);
        }

        // C. Throttled Proposal Buy (Rise / Fall Option) — Safe & rate-limit-free!
        try {
          const buyRes = await this.buy(callPutType, amount, dur, 't', undefined, sym);
          if (buyRes?.contract_id) {
            console.log(\`[DerivWS] Throttled \${callPutType} opened on \${sym}: #\${buyRes.contract_id}\`);
            return { contract_id: buyRes.contract_id, contract_type: callPutType, symbol: sym };
          }
        } catch (propCallErr) {
          lastErrorMsg = propCallErr.message || String(propCallErr);
        }

        // D. Throttled Proposal Buy (Multiplier) — Safe & rate-limit-free!
        try {
          const propRes = await this.throttledProposal({
            proposal: 1,
            amount: Math.max(1.0, amount),
            basis: 'stake',
            contract_type: multType,
            currency: this.currency || 'USD',
            symbol: sym,
            underlying_symbol: sym,
            multiplier: 100
          });
          if (propRes?.proposal?.id) {
            const askPrice = parseFloat(propRes.proposal.ask_price || amount);
            const buyRes = await this.send({ buy: propRes.proposal.id, price: askPrice });
            if (buyRes?.buy?.contract_id) {
              const cid = buyRes.buy.contract_id;
              console.log(\`[DerivWS] Throttled Multiplier \${multType} opened on \${sym}: #\${cid}\`);
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
        } catch (propMultErr) {
          lastErrorMsg = propMultErr.message || String(propMultErr);
        }
      }
    }

    // 3. Fallback: Symbol unavailable
    console.warn(\`[DerivWS] No viable contract accepted for \${cleanSymbol}: \${lastErrorMsg}\`);
    this.emit('log', {
      type: 'warning',
      msg: \`⚠️ \${cleanSymbol}: \${lastErrorMsg || 'Unable to open contract'}. Skipping.\`
    });

    return {
      contract_id: null,
      result: 'skipped',
      symbol: cleanSymbol,
      message: lastErrorMsg || \`Contract unavailable for \${cleanSymbol}\`
    };
  }`;

// Find start of buyAccumulator and replace up to throttledProposalMethod
const buyAccuIndex = dcCode.indexOf('// ── Complete Adaptive Trading Engine (ACCU + Multipliers + Options) ──');
const subContractIndex = dcCode.indexOf('// ── Centralized Proposal Rate-Limiter Queue ───────────────────');

if (buyAccuIndex !== -1 && subContractIndex !== -1) {
  dcCode = dcCode.slice(0, buyAccuIndex) + newBuyAccumulator + '\n\n  ' + dcCode.slice(subContractIndex);
}

fs.writeFileSync(derivClientPath, dcCode, 'utf8');
console.log('deriv-client.js updated successfully with Direct-Buy-First & Throttled Proposals!');

// 5. Update index.html script tags to v=3.8
const indexPath = path.join(baseDir, 'public', 'index.html');
let htmlCode = fs.readFileSync(indexPath, 'utf8');
htmlCode = htmlCode.replace(/v=3\.7/g, 'v=3.8');
fs.writeFileSync(indexPath, htmlCode, 'utf8');
console.log('index.html updated successfully with v=3.8!');
