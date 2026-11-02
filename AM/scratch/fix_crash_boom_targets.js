const fs = require('fs');
const path = require('path');

const baseDir = 'C:\\Users\\ADMIN\\Desktop\\Accumulator-Bot';

// 1. Update deriv-client.js
const derivClientPath = path.join(baseDir, 'public', 'js', 'deriv-client.js');
let dcCode = fs.readFileSync(derivClientPath, 'utf8');

const updatedBuyMethod = `  // ── High-Speed Trade Engine (Crash 150/300 & Boom 150/300 Resolution) ──
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

    // Resolve exact symbol string from Deriv active symbols
    const exactSym = this.resolveExactSymbol(cleanSymbol);
    const symSet = new Set();

    if (isCrash || isBoom) {
      // Deriv options and synthetics for Crash & Boom prioritize N suffix (e.g. CRASH300N, BOOM300N, CRASH150N, BOOM150N)
      if (!exactSym.endsWith('N')) symSet.add(exactSym + 'N');
      symSet.add(exactSym);
      if (!cleanSymbol.endsWith('N')) symSet.add(cleanSymbol + 'N');
      symSet.add(cleanSymbol);
      if (exactSym.endsWith('N')) symSet.add(exactSym.slice(0, -1));
      if (cleanSymbol.endsWith('N')) symSet.add(cleanSymbol.slice(0, -1));
    } else {
      symSet.add(exactSym);
      symSet.add(cleanSymbol);
    }

    const symList = [...symSet].filter(Boolean);
    console.log(\`[DerivWS] buy targets for \${cleanSymbol}:\`, symList);

    let lastErrorMsg = '';

    // ═════════════════════════════════════════════════════════════
    // 1. TRY ACCU FIRST ON ALL CANDIDATE SYMBOLS
    // ═════════════════════════════════════════════════════════════
    for (const sym of symList) {
      // Step A: Direct Buy ACCU (0 proposals, instant execution)
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
        console.warn(\`[DerivWS] Direct ACCU buy for \${sym} declined:\`, lastErrorMsg);

        // Step B: Throttled ACCU Proposal fallback (0 rate limit)
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

    // ═════════════════════════════════════════════════════════════
    // 2. FOR CRASH & BOOM: IF ACCU NOT OFFERED, USE 5-TICK OPTIONS (ZERO MULTIPLIERS!)
    // ═════════════════════════════════════════════════════════════
    if (isCrash || isBoom) {
      const callPutType = isCrash ? 'CALL' : 'PUT';
      const dur = Math.max(5, Math.min(10, parseInt(maxTicks, 10) || 5));

      for (const sym of symList) {
        // Direct Buy 5-Tick Option (No proposal, zero rate limit)
        try {
          const directOptRes = await this.send({
            buy: 1,
            price: parseFloat((amount * 1.5).toFixed(2)),
            parameters: {
              amount: parseFloat(parseFloat(amount).toFixed(2)),
              basis: 'stake',
              contract_type: callPutType,
              currency: this.currency || 'USD',
              duration: dur,
              duration_unit: 't',
              underlying_symbol: sym
            }
          });
          if (directOptRes?.buy?.contract_id) {
            const cid = directOptRes.buy.contract_id;
            console.log(\`[DerivWS] Option \${callPutType} (\${dur}t) opened on \${sym}: #\${cid}\`);
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
        } catch (dirOptErr) {
          lastErrorMsg = dirOptErr.message || String(dirOptErr);
          console.warn(\`[DerivWS] Direct \${callPutType} on \${sym} notice:\`, lastErrorMsg);
        }

        // Throttled Proposal Buy 5-Tick Option fallback
        try {
          const buyOptRes = await this.buy(callPutType, amount, dur, 't', undefined, sym);
          if (buyOptRes?.contract_id) {
            console.log(\`[DerivWS] Throttled Option \${callPutType} (\${dur}t) opened on \${sym}: #\${buyOptRes.contract_id}\`);
            return { contract_id: buyOptRes.contract_id, contract_type: callPutType, symbol: sym };
          }
        } catch (propOptErr) {
          lastErrorMsg = propOptErr.message || String(propOptErr);
        }
      }
    }

    // 3. Fallback: If completely unavailable
    console.warn(\`[DerivWS] No contract available for \${cleanSymbol}: \${lastErrorMsg}\`);
    this.emit('log', {
      type: 'warning',
      msg: \`⚠️ \${cleanSymbol}: Trade request failed (\${lastErrorMsg || 'Symbol unavailable on Deriv'}). Skipping bot.\`
    });

    return {
      contract_id: null,
      result: 'skipped',
      symbol: cleanSymbol,
      message: lastErrorMsg || \`Contract unavailable for \${cleanSymbol}\`
    };
  }`;

// Find start of buyAccumulator and replace up to throttledProposal
const buyAccuIndex = dcCode.indexOf('// ── Pure Accumulator Trade Engine (Strictly ACCU, Zero Multipliers) ──');
const throttledIndex = dcCode.indexOf('// ── Centralized Proposal Rate-Limiter Queue');

if (buyAccuIndex !== -1 && throttledIndex !== -1) {
  dcCode = dcCode.slice(0, buyAccuIndex) + updatedBuyMethod + '\n\n  ' + dcCode.slice(throttledIndex);
}

fs.writeFileSync(derivClientPath, dcCode, 'utf8');
console.log('deriv-client.js updated with prioritized N-suffix resolution for Crash & Boom 150/300!');

// 2. Update app.js ALL_SYMBOLS for Crash 150/300 and Boom 150/300 to use N suffix as default
const appJsPath = path.join(baseDir, 'public', 'js', 'app.js');
let appCode = fs.readFileSync(appJsPath, 'utf8');

appCode = appCode.replace("{ v: 'CRASH150',   l: 'Crash 150 Index'", "{ v: 'CRASH150N',  l: 'Crash 150 Index'");
appCode = appCode.replace("{ v: 'CRASH300',   l: 'Crash 300 Index'", "{ v: 'CRASH300N',  l: 'Crash 300 Index'");
appCode = appCode.replace("{ v: 'BOOM150',    l: 'Boom 150 Index'",  "{ v: 'BOOM150N',   l: 'Boom 150 Index'");
appCode = appCode.replace("{ v: 'BOOM300',    l: 'Boom 300 Index'",  "{ v: 'BOOM300N',   l: 'Boom 300 Index'");

fs.writeFileSync(appJsPath, appCode, 'utf8');
console.log('app.js updated: CRASH150N, CRASH300N, BOOM150N, BOOM300N set in ALL_SYMBOLS!');

// 3. Bump index.html to v=4.2
const indexPath = path.join(baseDir, 'public', 'index.html');
let htmlCode = fs.readFileSync(indexPath, 'utf8');
htmlCode = htmlCode.replace(/v=4\.1/g, 'v=4.2');
fs.writeFileSync(indexPath, htmlCode, 'utf8');
console.log('index.html updated with v=4.2!');
