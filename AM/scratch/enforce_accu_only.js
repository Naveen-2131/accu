const fs = require('fs');
const path = require('path');

const baseDir = 'C:\\Users\\ADMIN\\Desktop\\Accumulator-Bot';
const derivClientPath = path.join(baseDir, 'public', 'js', 'deriv-client.js');
let dcCode = fs.readFileSync(derivClientPath, 'utf8');

const strictAccuMethod = `  // ── Pure Accumulator Trade Engine (Strictly ACCU, Zero Multipliers) ──
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

    // Resolve exact symbol string from Deriv active symbols
    const exactSym = this.resolveExactSymbol(cleanSymbol);
    const symList = [exactSym];
    if (exactSym !== cleanSymbol) symList.push(cleanSymbol);

    let lastErrorMsg = '';

    // Strictly trade ACCU (Accumulator Contract) ONLY on all symbols — Zero Multipliers!
    for (const sym of symList) {
      // Step 1: Direct Buy ACCU (0 proposals, instant execution)
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
        console.warn(\`[DerivWS] Direct ACCU buy for \${sym} notice:\`, lastErrorMsg);

        // Step 2: Throttled ACCU Proposal fallback (0 rate limit)
        try {
          const propRes = await this.throttledProposal({
            proposal: 1,
            amount: amount,
            basis: 'stake',
            contract_type: 'ACCU',
            currency: this.currency || 'USD',
            growth_rate: rate,
            underlying_symbol: sym,
            ...(targetProfit > 0 ? { limit_order: { take_profit: targetProfit } } : {})
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

              if (targetProfit > 0 && cid) {
                this.send({
                  contract_update: 1,
                  contract_id: parseInt(cid, 10),
                  limit_order: { take_profit: targetProfit }
                }).catch(() => {});
              }

              return { contract_id: cid, contract_type: 'ACCU', symbol: sym };
            }
          }
        } catch (propErr) {
          lastErrorMsg = propErr.message || String(propErr);
        }
      }
    }

    // If ACCU is not offered by Deriv on this symbol:
    console.warn(\`[DerivWS] Deriv ACCU contract unavailable for \${cleanSymbol}: \${lastErrorMsg}\`);
    this.emit('log', {
      type: 'warning',
      msg: \`⚠️ \${cleanSymbol}: Deriv does not offer Accumulator (ACCU) contracts on this symbol (\${lastErrorMsg || 'Not supported'}). Safely skipping bot (Multiplier strictly disabled).\`
    });

    return {
      contract_id: null,
      result: 'skipped',
      symbol: cleanSymbol,
      message: lastErrorMsg || \`ACCU contract unavailable on Deriv for \${cleanSymbol}\`
    };
  }`;

// Find start of buyAccumulator and replace up to throttledProposal
const buyAccuIndex = dcCode.indexOf('// ── High-Speed Multi-Asset Trade Engine');
const throttledIndex = dcCode.indexOf('// ── Centralized Proposal Rate-Limiter Queue');

if (buyAccuIndex !== -1 && throttledIndex !== -1) {
  dcCode = dcCode.slice(0, buyAccuIndex) + strictAccuMethod + '\n\n  ' + dcCode.slice(throttledIndex);
}

fs.writeFileSync(derivClientPath, dcCode, 'utf8');
console.log('deriv-client.js updated: Enforced STRICT ACCU ONLY (Multipliers completely removed)!');

// Update index.html version to v=4.0
const indexPath = path.join(baseDir, 'public', 'index.html');
let htmlCode = fs.readFileSync(indexPath, 'utf8');
htmlCode = htmlCode.replace(/v=3\.9/g, 'v=4.0');
fs.writeFileSync(indexPath, htmlCode, 'utf8');
console.log('index.html updated with v=4.0!');
