/**
 * Deriv Browser WebSocket Client (Dual-Mode: REST OTP + Standard WS)
 * Connects directly to Deriv API from the browser tab
 */
class DerivBrowserClient {
  constructor() {
    this.ws = null;
    this.appId = '1089';
    this.token = '';
    this.balance = 0;
    this.currency = 'USD';
    this.accountId = '';
    this.accountType = 'demo';
    this.isConnected = false;
    this.isAuthorized = false;
    this.reqIdCounter = 1;
    this.callbacks = new Map();
    this.pingInterval = null;
    this.listeners = {};
    this._tickSubIds = {};
    this.openContractsCache = new Map();
    this._lastContractPoll = new Map();
    this.contractSubscriptions = new Map();
    this.sellQueue = [];
    this.isProcessingSellQueue = false;
    this.lastSellTime = 0;
    this.MIN_SELL_INTERVAL_MS = 1200;
    this._activeSymbols = [];
    this._contractsForCache = {};
    this._proposalQueue = [];
    this._isProcessingProposalQueue = false;
    this._lastProposalTime = 0; // 1200ms spacing between manual sell calls complies with Deriv API limits
  }

  // ── Event Emitter ──────────────────────────────────────────────
  on(event, fn) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }
  off(event, fn) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter(cb => cb !== fn);
  }
  emit(event, data) {
    (this.listeners[event] || []).forEach(fn => { try { fn(data); } catch(e) {} });
  }


  // ── Global Open Contracts Push Subscription ───────────────────
  subscribeOpenContract() {
    if (this._isSubscribedToOpenContracts) {
      return Promise.resolve({ already_subscribed: true });
    }
    this._isSubscribedToOpenContracts = true;
    console.log('[DerivWS] Subscribing to global proposal_open_contract stream...');
    return this.send({
      proposal_open_contract: 1,
      subscribe: 1
    }).catch(err => {
      this._isSubscribedToOpenContracts = false;
      console.warn('[DerivWS] Global proposal_open_contract notice:', err.message || err);
    });
  }

  subscribeOpenContractsGlobal() {
    return this.subscribeOpenContract();
  }

  parseContractTicks(poc, knownStake = 1.0, knownGrowth = 0.02) {
    if (!poc) return 0;
    let ticks = 0;

    // ⚠️ DO NOT USE poc.tick_count — that is the MAX DURATION LIMIT (e.g. 85, 125 ticks), NOT current ticks!
    // ✅ USE poc.tick_passed — that is the actual accumulated tick count (0, 1, 2, 3...)

    // 1. tick_passed = actual current accumulated tick count
    if (poc.tick_passed !== undefined && poc.tick_passed !== null) {
      const tp = parseInt(poc.tick_passed, 10) || 0;
      if (tp > ticks) ticks = tp;
    }

    // 2. tick_stream array for THIS active contract (first item is entry spot, so length - 1)
    if (Array.isArray(poc.tick_stream) && poc.tick_stream.length > 1) {
      const stTicks = poc.tick_stream.length - 1;
      if (stTicks > ticks) ticks = stTicks;
    }

    // 3. Mathematical formula — ONLY when profit > 0 (not at entry tick)
    const p = parseFloat(poc.profit || 0);
    const s = parseFloat(poc.buy_price || poc.stake || knownStake || 1.0);
    const g = parseFloat(poc.growth_rate || knownGrowth || 0.02);
    if (p > 0 && s > 0 && g > 0) {
      const ratio = (p + s) / s;
      if (ratio > 1.0) {
        const calcTicks = Math.round(Math.log(ratio) / Math.log(1 + g));
        if (calcTicks > ticks) ticks = calcTicks;
      }
    }

    return ticks;
  }

  async fetchOpenContract(contractId) {
    if (!this.isConnected || !contractId) return null;
    const cidNum = parseInt(contractId, 10);
    try {
      const res = await this.send({ proposal_open_contract: 1, contract_id: cidNum });
      if (res && res.proposal_open_contract) {
        const poc = res.proposal_open_contract;
        const cidStr = String(poc.contract_id);
        const isSold = Boolean(poc.is_sold || poc.status !== 'open');
        const cached = this.openContractsCache.get(cidStr) || this.openContractsCache.get(cidNum) || {};
        const g = parseFloat(poc.growth_rate || cached.growth_rate || 0.02);
        const s = parseFloat(poc.buy_price || poc.stake || cached.stake || 1.0);
        const ticks = this.parseContractTicks(poc, s, g);
        const p = parseFloat(poc.profit || 0);

        const data = {
          contract_id: poc.contract_id,
          is_sold: isSold,
          profit: p,
          status: poc.status,
          tick_passed: ticks,
          ticks: ticks,
          growth_rate: g,
          stake: s,
          is_valid_to_sell: Boolean(poc.is_valid_to_sell),
          current_spot: poc.current_spot || poc.spot,
          _lastUpdateTime: Date.now()
        };
        this.openContractsCache.set(cidStr, data);
        this.openContractsCache.set(poc.contract_id, data);
        this.emit('contractUpdate', { ...poc, computed_ticks: ticks });
        return data;
      }
    } catch(e) {}
    return null;
  }

  // ── Main Connect Method ────────────────────────────────────────
  async connect(appId, token) {
    this.appId = (appId && String(appId).trim()) || '1089';
    this.token = (token && String(token).trim()) || '';

    if (!this.token) {
      throw new Error('API Token is required');
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      try { this.ws.close(); } catch(e) {}
    }

    // Try REST OTP flow first (for pat_ tokens or REST API credentials)
    if (this.token.startsWith('pat_') || this.appId.length > 10) {
      try {
        this.emit('log', { type: 'info', msg: 'Attempting REST API OTP connection...' });
        return await this.connectOTP();
      } catch(otpErr) {
        this.emit('log', { type: 'warning', msg: `REST API notice (${otpErr.message}). Trying Standard WS...` });
      }
    }

    // Standard WebSocket flow fallback
    return await this.connectStandardWS();
  }

  // ── OTP Flow ───────────────────────────────────────────────────
  async connectOTP() {
    // 1. Fetch Accounts
    const accRes = await fetch('https://api.derivws.com/trading/v1/options/accounts', {
      method: 'GET',
      headers: {
        'Deriv-App-ID': this.appId,
        'Authorization': `Bearer ${this.token}`
      }
    });

    if (!accRes.ok) {
      const errText = await accRes.text();
      throw new Error(`Accounts API error (${accRes.status}): ${errText}`);
    }

    const accData = await accRes.json();
    let accounts = accData.data || accData.accounts || (Array.isArray(accData) ? accData : [accData]);
    if (!accounts || accounts.length === 0) throw new Error('No accounts found for token');

    // Pick Demo or Real account
    let selected = accounts.find(a => (a.account_type || a.type || '').toLowerCase().includes('demo')) || accounts[0];
    this.accountId = selected.account_id || selected.id || selected.loginid;
    this.balance = parseFloat(selected.balance || 0);
    this.currency = selected.currency || 'USD';
    const isDemo = (selected.account_type || '').toLowerCase().includes('demo');

    // 2. Generate OTP
    const otpRes = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${this.accountId}/otp`, {
      method: 'POST',
      headers: {
        'Deriv-App-ID': this.appId,
        'Authorization': `Bearer ${this.token}`
      }
    });

    if (!otpRes.ok) throw new Error(`OTP generation failed (${otpRes.status})`);
    const otpData = await otpRes.json();
    const wsUrl = otpData.data?.url || otpData.url;
    if (!wsUrl) throw new Error('OTP WS URL missing in response');

    // 3. Connect to OTP WS URL
    return new Promise((resolve, reject) => {
      this.emit('log', { type: 'info', msg: `Connecting to OTP WebSocket...` });
      this.ws = new WebSocket(wsUrl);

      const timeout = setTimeout(() => reject(new Error('OTP WS timeout (15s)')), 15000);

      this.ws.onopen = () => {
        clearTimeout(timeout);
        this.isConnected = true;
        this.isAuthorized = true;
        this.startPing();

        const authObj = {
          loginid: this.accountId,
          balance: this.balance,
          currency: this.currency,
          is_virtual: isDemo ? 1 : 0
        };

        this.emit('authorized', authObj);
        this.emit('balanceUpdate', { balance: this.balance, currency: this.currency });
        this.emit('log', {
          type: 'success',
          msg: `✅ Connected & Authorized: ${this.accountId} (${isDemo ? 'Demo' : 'Real'}) | Balance: ${this.currency} ${this.balance.toFixed(2)}`
        });

        this.send({ balance: 1, subscribe: 1 }).catch(() => {});
        this.subscribeOpenContract().catch(() => {});
        this.loadActiveSymbols().catch(() => {});
        resolve({ connected: true, authorized: true });
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this._handleMessage(msg);
        } catch(e) {}
      };

      this.ws.onerror = () => {
        clearTimeout(timeout);
        this.isConnected = false;
        reject(new Error('OTP WS connection error'));
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        this.isAuthorized = false;
        this._isSubscribedToOpenContracts = false;
        this.stopPing();
        this.emit('disconnected', {});

        if (this.token && !this._manualDisconnect) {
          this.emit('log', { type: 'warning', msg: '⚡ Disconnected from Deriv. Auto-reconnecting in 2 seconds...' });
          setTimeout(() => {
            if (!this.isConnected && this.token) {
              this.connect(this.appId, this.token).catch(err => {
                this.emit('log', { type: 'error', msg: `Auto-reconnect failed: ${err.message}` });
              });
            }
          }, 2000);
        }
      };
    });
  }

  
  // ── Dynamic Deriv Symbol Discovery & Resolution ───────────────
  async loadActiveSymbols() {
    if (this._activeSymbols && this._activeSymbols.length > 0) return this._activeSymbols;
    try {
      console.log('[DerivWS] Querying active_symbols from Deriv...');
      const res = await this.send({ active_symbols: 'brief', product_type: 'basic' });
      if (res && res.active_symbols && Array.isArray(res.active_symbols)) {
        this._activeSymbols = res.active_symbols;
        console.log(`[DerivWS] Successfully loaded ${this._activeSymbols.length} active symbols from Deriv!`);
        const cb = this._activeSymbols.filter(s => /CRASH|BOOM/i.test(s.symbol) || /CRASH|BOOM/i.test(s.display_name));
        console.log('[DerivWS] Available Crash & Boom symbols on Deriv:', cb.map(s => `${s.symbol} (${s.display_name})`));
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
      console.warn(`[DerivWS] contracts_for query for ${symbol}:`, err.message || err);
    }
    return null;
  }

  // ── Standard WS Flow ───────────────────────────────────────────
  connectStandardWS() {
    const cleanAppId = (this.appId && !isNaN(this.appId)) ? this.appId : '1089';
    const url = `wss://ws.binaryws.com/websockets/v3?app_id=${cleanAppId}`;
    this.emit('log', { type: 'info', msg: `Connecting to Standard WS (${url})...` });

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      const timeout = setTimeout(() => reject(new Error('WS connection timed out (15s)')), 15000);

      this.ws.onopen = () => {
        clearTimeout(timeout);
        this.isConnected = true;
        this.startPing();
        this.emit('log', { type: 'info', msg: 'WebSocket connected. Authorizing Token...' });

        this.send({ authorize: this.token }).then(res => {
          if (res.error) {
            throw new Error(`[${res.error.code || 'AUTH_ERR'}]: ${res.error.message || 'Auth failed'}`);
          }

          this.isAuthorized = true;
          this.accountId = res.authorize.loginid;
          this.balance = parseFloat(res.authorize.balance || 0);
          this.currency = res.authorize.currency || 'USD';
          const isDemo = res.authorize.is_virtual === 1;

          this.emit('authorized', res.authorize);
          this.emit('balanceUpdate', { balance: this.balance, currency: this.currency });
          this.emit('log', {
            type: 'success',
            msg: `✅ Authorized: ${this.accountId} (${isDemo ? 'Demo' : 'Real'}) | Balance: ${this.currency} ${this.balance.toFixed(2)}`
          });

          this.send({ balance: 1, subscribe: 1 }).catch(() => {});
          this.subscribeOpenContract().catch(() => {});
          this.loadActiveSymbols().catch(() => {});
          resolve({ connected: true, authorized: true });
        }).catch(err => {
          this.emit('log', { type: 'error', msg: `Auth Failed: ${err.message}` });
          reject(err);
        });
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this._handleMessage(msg);
        } catch(e) {}
      };

      this.ws.onerror = () => {
        clearTimeout(timeout);
        this.isConnected = false;
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        this.isAuthorized = false;
        this._isSubscribedToOpenContracts = false;
        this.stopPing();
        this.emit('disconnected', {});

        if (this.token && !this._manualDisconnect) {
          this.emit('log', { type: 'warning', msg: '⚡ Disconnected from Deriv. Auto-reconnecting in 2 seconds...' });
          setTimeout(() => {
            if (!this.isConnected && this.token) {
              this.connect(this.appId, this.token).catch(err => {
                this.emit('log', { type: 'error', msg: `Auto-reconnect failed: ${err.message}` });
              });
            }
          }, 2000);
        }
      };
    });
  }

  // ── Message Handler ────────────────────────────────────────────
  _handleMessage(msg) {
    const reqId = msg.req_id;

    if (reqId && this.callbacks.has(reqId)) {
      const { resolve, reject } = this.callbacks.get(reqId);
      this.callbacks.delete(reqId);
      if (msg.error) {
        const err = new Error(msg.error.message || msg.error.code || 'API Error');
        err.code    = msg.error.code;
        err.details = msg.error;
        reject(err);
      } else {
        resolve(msg);
      }
    }

    switch (msg.msg_type) {
      case 'balance':
        if (msg.balance) {
          this.balance = parseFloat(msg.balance.balance);
          this.currency = msg.balance.currency;
          this.emit('balanceUpdate', { balance: this.balance, currency: this.currency });
        }
        break;

      case 'tick':
        if (msg.tick) this.emit('tick', msg.tick);
        break;

      case 'proposal':
        if (msg.proposal) {
          this.emit('proposal', {
            ...msg.proposal,
            echo_req: msg.echo_req
          });
        }
        break;

      case 'buy':
        if (msg.buy) {
          this.emit('buy', {
            ...msg.buy,
            echo_req: msg.echo_req
          });
        }
        break;

      case 'proposal_open_contract':
        if (msg.proposal_open_contract) {
          const poc = msg.proposal_open_contract;
          const cidStr = String(poc.contract_id);
          const isSold = Boolean(poc.is_sold || poc.status !== 'open');
          const cached = this.openContractsCache.get(cidStr) || this.openContractsCache.get(poc.contract_id) || {};
          const g = parseFloat(poc.growth_rate || cached.growth_rate || 0.02);
          const s = parseFloat(poc.buy_price || poc.stake || cached.stake || 1.0);
          const ticks = this.parseContractTicks(poc, s, g);
          const p = parseFloat(poc.profit || 0);

          const data = {
            contract_id: poc.contract_id,
            is_sold: isSold,
            profit: p,
            status: poc.status,
            tick_passed: ticks,
            ticks: ticks,
            growth_rate: g,
            stake: s,
            current_spot: poc.current_spot || poc.spot,
            is_valid_to_sell: Boolean(poc.is_valid_to_sell),
            _lastUpdateTime: Date.now()
          };

          this.openContractsCache.set(cidStr, data);
          this.openContractsCache.set(poc.contract_id, data);

          if (isSold) {
            this.unsubscribeContract(poc.contract_id).catch(() => {});
          }

          this.emit('proposalOpenContract', { ...poc, ...data, computed_ticks: ticks });
          this.emit('contractUpdate',       { ...poc, ...data, computed_ticks: ticks });
        }
        break;

      case 'sell':
        if (msg.sell) {
          this.emit('sell', {
            ...msg.sell,
            echo_req: msg.echo_req
          });
        }
        break;
    }
  }

  // ── Send ───────────────────────────────────────────────────────
  send(payload) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket not connected'));
      }
      const reqId = this.reqIdCounter++;
      const data = { ...payload, req_id: reqId };
      this.callbacks.set(reqId, { resolve, reject });
      this.ws.send(JSON.stringify(data));

      setTimeout(() => {
        if (this.callbacks.has(reqId)) {
          this.callbacks.delete(reqId);
          reject(new Error(`Request timeout req_id:${reqId}`));
        }
      }, 12000);
    });
  }

  // ── Subscribe Ticks ────────────────────────────────────────────
  async subscribeTicks(symbol) {
    if (this._tickSubIds[symbol]) return;
    try {
      const res = await this.send({ ticks: symbol, subscribe: 1 });
      if (res && res.subscription) this._tickSubIds[symbol] = res.subscription.id;
    } catch(e) {}
  }

  // ── Bot Interface ──────────────────────────────────────────────
  async buy(contractType, amount, duration, unit, prediction, symbol) {
    let cleanType = contractType;
    let barrier = null;

    if (prediction !== undefined && prediction !== null && prediction !== '') {
      barrier = prediction.toString().trim();
    }

    if (barrier !== null && (cleanType === 'CALL' || cleanType === 'PUT' || cleanType === 'HIGHER' || cleanType === 'LOWER' || cleanType === 'RISE' || cleanType === 'FALL')) {
      if (cleanType === 'RISE' || cleanType === 'CALL' || cleanType === 'HIGHER') {
        cleanType = 'HIGHER';
        if (!barrier.startsWith('+') && !barrier.startsWith('-')) barrier = '+' + barrier;
        else if (barrier.startsWith('-')) barrier = '+' + barrier.substring(1);
      } else if (cleanType === 'FALL' || cleanType === 'PUT' || cleanType === 'LOWER') {
        cleanType = 'LOWER';
        if (!barrier.startsWith('+') && !barrier.startsWith('-')) barrier = '-' + barrier;
        else if (barrier.startsWith('+')) barrier = '-' + barrier.substring(1);
      }
    } else {
      if (cleanType === 'RISE' || cleanType === 'HIGHER') cleanType = 'CALL';
      if (cleanType === 'FALL' || cleanType === 'LOWER') cleanType = 'PUT';
    }

    const cleanSymbol = symbol || 'R_100';
    let dur = parseInt(duration) || 1;
    let durUnit = unit || 't';
    if (durUnit === 't') {
      if (dur < 5) dur = 5;
      if (dur > 10) dur = 10;
    }

    const req = {
      proposal: 1,
      contract_type: cleanType,
      currency: this.currency || 'USD',
      duration: dur,
      duration_unit: durUnit,
      basis: 'stake',
      amount: parseFloat(parseFloat(amount).toFixed(2))
    };

    req.underlying_symbol = cleanSymbol;

    if (barrier !== null) {
      if (cleanType === 'DIGITOVER' || cleanType === 'DIGITUNDER' || cleanType === 'DIGITMATCH') {
        req.barrier = barrier;
      } else if (cleanType === 'DIGITDIFF') {
        req.last_digit_prediction = parseInt(barrier);
      } else {
        req.barrier = barrier;
      }
    }

    let propRes;
    try {
      propRes = await this.throttledProposal(req);
    } catch (err) {
      const msg = err && (err.message || err.code || (typeof err === 'object' ? JSON.stringify(err) : err));
      throw new Error(`Proposal Error: ${msg}`);
    }

    if (propRes.error) throw new Error(propRes.error.message || propRes.error.code);
    if (!propRes.proposal) throw new Error('Proposal not received');

    const askPrice = (propRes.proposal && propRes.proposal.ask_price) ? parseFloat(propRes.proposal.ask_price) : parseFloat(amount);
    let buyRes;
    try {
      buyRes = await this.send({ buy: propRes.proposal.id, price: askPrice });
    } catch (err) {
      const msg = err && (err.message || err.code || (typeof err === 'object' ? JSON.stringify(err) : err));
      throw new Error(`Buy Error: ${msg}`);
    }

    if (buyRes.error) throw new Error(buyRes.error.message || buyRes.error.code);
    const cid = buyRes.buy.contract_id;
    // Initialize cache immediately so checkContract never returns null or polls
    this.openContractsCache.set(cid, { is_sold: false, profit: 0, status: 'open' });
    this.subscribeOpenContract().catch(() => {});
    return { contract_id: cid };
  }

  // ── Sell Contract (Rate-Limited Queue Execution) ────────────────
  sellContract(contractId) {
    if (!contractId) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const cidNum = parseInt(contractId, 10);

      // Fast-path: Check if already sold or ended on Deriv
      const cached = this.openContractsCache.get(String(cidNum)) || this.openContractsCache.get(cidNum);
      if (cached && (cached.is_sold || cached.status === 'sold' || cached.status === 'lost')) {
        console.log(`[DerivWS] Contract #${cidNum} already closed, resolving immediately.`);
        return resolve({ sell: { contract_id: cidNum, sold_for: cached.stake || 0 } });
      }

      if (this.sellQueue.some(item => parseInt(item.contractId, 10) === cidNum)) {
        return resolve({ duplicate: true });
      }
      this.sellQueue.push({
        contractId: cidNum,
        resolve,
        reject,
        retries: 0
      });
      this._processSellQueue();
    });
  }

  async _processSellQueue() {
    if (this.isProcessingSellQueue) return;
    this.isProcessingSellQueue = true;

    while (this.sellQueue.length > 0) {
      // Throttle: Deriv enforces at least 1.0s to 1.2s between sell requests per token
      const now = Date.now();
      const elapsed = now - this.lastSellTime;
      const minInterval = 1200; // 1200ms spacing completely prevents Deriv sell rate limits
      if (elapsed < minInterval) {
        await new Promise(r => setTimeout(r, minInterval - elapsed));
      }

      const item = this.sellQueue.shift();
      if (!item) break;

      const cidNum = parseInt(item.contractId, 10);

      // Check if closed by Deriv's Take Profit while waiting in queue
      const cached = this.openContractsCache.get(String(cidNum)) || this.openContractsCache.get(cidNum);
      if (cached && (cached.is_sold || cached.status === 'sold' || cached.status === 'lost')) {
        console.log(`[DerivWS] #${cidNum} already closed via Take Profit while in queue. Skipping API sell.`);
        item.resolve({ sell: { contract_id: cidNum, sold_for: cached.stake || 0 } });
        continue;
      }

      try {
        this.lastSellTime = Date.now();
        console.log(`[DerivWS] Sending Queued Sell for #${cidNum}...`);
        const res = await this.send({ sell: cidNum, price: 0 });
        console.log(`[DerivWS] Sell confirmed for #${cidNum}:`, res);

        if (res && res.sell) {
          const key = String(cidNum);
          const c = this.openContractsCache.get(key) || this.openContractsCache.get(cidNum) || {};
          const soldFor = parseFloat(res.sell.sold_for || 0);
          const stake = parseFloat(c.stake || 1.0);
          const profit = soldFor > 0 ? (soldFor - stake) : (c.profit || 0);
          const updated = {
            ...c,
            is_sold: true,
            status: 'sold',
            profit: profit,
            is_valid_to_sell: false,
            _lastUpdateTime: Date.now()
          };
          this.openContractsCache.set(key, updated);
          this.openContractsCache.set(cidNum, updated);
          this.unsubscribeContract(cidNum).catch(() => {});
          this.emit('contractUpdate',       { ...updated, contract_id: cidNum, computed_ticks: updated.ticks || 0 });
          this.emit('proposalOpenContract', { ...updated, contract_id: cidNum, computed_ticks: updated.ticks || 0 });
        }
        item.resolve(res);
      } catch (err) {
        const msg = (err && (err.message || err.code || String(err))) || '';
        console.warn(`[DerivWS] Sell notice for #${cidNum}:`, msg);

        // Deriv Rate Limit catch: back off a full 1500ms before retrying!
        if (msg.toLowerCase().includes('rate limit')) {
          if (item.retries < 6) {
            item.retries++;
            console.warn(`[DerivWS] Rate limit on #${cidNum}, backing off 1500ms (attempt ${item.retries}/6)...`);
            this.sellQueue.unshift(item); // prepend to retry
            await new Promise(r => setTimeout(r, 1500));
            continue;
          }
        }

        if (msg.includes('already been sold') || msg.includes('has expired') || msg.includes('not found')) {
          const key = String(cidNum);
          const c = this.openContractsCache.get(key) || {};
          const updated = { ...c, is_sold: true, status: 'sold' };
          this.openContractsCache.set(key, updated);
          this.openContractsCache.set(cidNum, updated);
          this.emit('contractUpdate', { ...updated, contract_id: cidNum, computed_ticks: updated.ticks || 0 });
          item.resolve({ sell: { contract_id: cidNum, sold_for: c.stake || 0 } });
          continue;
        }

        item.reject(err);
      }
    }

    this.isProcessingSellQueue = false;
  }

  // ── Accumulator Proposal / Market Stats Check ─────────────────
  async getAccumulatorProposal(symbol, stake = 1, growthRate = 0.05) {
    if (!this.isConnected) return null;
    const cleanSymbol = (symbol || this.activeSymbol || 'R_100').trim();
    const rate = parseFloat(growthRate) || 0.05;
    const amount = parseFloat(stake) || 1.0;

    const propReq = {
      proposal: 1,
      amount: amount,
      basis: 'stake',
      contract_type: 'ACCU',
      currency: this.currency || 'USD',
      growth_rate: rate,
      underlying_symbol: cleanSymbol
    };

    try {
      const res = await this.send(propReq);
      if (res && res.proposal) {
        const details = res.proposal.contract_details || {};
        const ticksStayedIn = details.ticks_stayed_in || res.proposal.ticks_stayed_in || [];
        const currentTicks = ticksStayedIn.length > 0 ? ticksStayedIn[ticksStayedIn.length - 1] : 0;
        return {
          id: res.proposal.id,
          ask_price: res.proposal.ask_price,
          spot: res.proposal.spot,
          current_ticks: currentTicks,
          ticks_stayed_in: ticksStayedIn
        };
      }
    } catch (err) {
      // Ignore transient errors
    }
    return null;
  }

  // ── Accumulator Direct Buy (With Multi-Contract Adaptive Fallback) ──
          // ── High-Speed Trade Engine (Crash 150/300 & Boom 150/300 Resolution) ──
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
    console.log(`[DerivWS] buy targets for ${cleanSymbol}:`, symList);

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
          console.log(`[DerivWS] Native ACCU opened directly on ${sym}: #${cid}`);
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
        console.warn(`[DerivWS] Direct ACCU buy for ${sym} declined:`, lastErrorMsg);

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
              console.log(`[DerivWS] ACCU opened via proposal on ${sym}: #${cid}`);
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
            console.log(`[DerivWS] Option ${callPutType} (${dur}t) opened on ${sym}: #${cid}`);
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
          console.warn(`[DerivWS] Direct ${callPutType} on ${sym} notice:`, lastErrorMsg);
        }

        // Throttled Proposal Buy 5-Tick Option fallback
        try {
          const buyOptRes = await this.buy(callPutType, amount, dur, 't', undefined, sym);
          if (buyOptRes?.contract_id) {
            console.log(`[DerivWS] Throttled Option ${callPutType} (${dur}t) opened on ${sym}: #${buyOptRes.contract_id}`);
            return { contract_id: buyOptRes.contract_id, contract_type: callPutType, symbol: sym };
          }
        } catch (propOptErr) {
          lastErrorMsg = propOptErr.message || String(propOptErr);
        }
      }
    }

    // 3. Fallback: If completely unavailable
    console.warn(`[DerivWS] No contract available for ${cleanSymbol}: ${lastErrorMsg}`);
    this.emit('log', {
      type: 'warning',
      msg: `⚠️ ${cleanSymbol}: Trade request failed (${lastErrorMsg || 'Symbol unavailable on Deriv'}). Skipping bot.`
    });

    return {
      contract_id: null,
      result: 'skipped',
      symbol: cleanSymbol,
      message: lastErrorMsg || `Contract unavailable for ${cleanSymbol}`
    };
  }

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
          console.warn(`[DerivWS] Rate limit on proposal, backing off 1200ms (attempt ${item.retries}/3)...`);
          await new Promise(r => setTimeout(r, 1200));
          this._proposalQueue.unshift(item); // Re-queue at front
        } else {
          item.reject(err);
        }
      }
    }

    this._isProcessingProposalQueue = false;
  }

  // ── Dedicated Contract Subscription (Instant Tick Stream) ──────
  async subscribeContract(contractId) {
    if (!contractId || !this.isConnected) return;
    const cidNum = parseInt(contractId, 10);
    try {
      console.log(`[DerivWS] Subscribing specifically to contract #${cidNum}...`);
      const res = await this.send({
        proposal_open_contract: 1,
        contract_id: cidNum,
        subscribe: 1
      });
      if (res && res.subscription && res.subscription.id) {
        this.contractSubscriptions.set(cidNum, res.subscription.id);
        this.contractSubscriptions.set(String(cidNum), res.subscription.id);
      }
    } catch(err) {
      console.warn(`[DerivWS] Subscribe contract notice for #${cidNum}:`, err.message || err);
    }
  }

  async unsubscribeContract(contractId) {
    if (!contractId) return;
    const cidNum = parseInt(contractId, 10);
    const subId = this.contractSubscriptions.get(cidNum) || this.contractSubscriptions.get(String(cidNum));
    if (subId) {
      this.contractSubscriptions.delete(cidNum);
      this.contractSubscriptions.delete(String(cidNum));
      try {
        await this.send({ forget: subId });
      } catch(e) {}
    }
  }

  // ── Exact methods from derivWS.js for AccumulatorBotEngine ──────
  buyAccumulatorDirect({ symbol, stake, growthRate, currency = 'USD' }) {
    let cleanSymbol = (symbol || 'R_100').trim();
    const rate = parseFloat(growthRate) || 0.05;
    const amount = parseFloat(stake) || 1.0;
    const curr = currency || this.currency || 'USD';

    const buildReq = (sym) => ({
      buy: 1,
      price: amount,
      parameters: {
        amount: amount,
        basis: 'stake',
        contract_type: 'ACCU',
        currency: curr,
        underlying_symbol: sym,
        growth_rate: rate
      }
    });

    return this.send(buildReq(cleanSymbol)).catch(err => {
      if (cleanSymbol === 'BOOM300') return this.send(buildReq('BOOM300N'));
      if (cleanSymbol === 'BOOM300N') return this.send(buildReq('BOOM300'));
      if (cleanSymbol === 'CRASH300') return this.send(buildReq('CRASH300N'));
      if (cleanSymbol === 'CRASH300N') return this.send(buildReq('CRASH300'));
      throw err;
    });
  }

  buyContract(proposalId, price) {
    return this.send({
      buy: proposalId,
      price: parseFloat(price)
    });
  }

  requestAccumulatorProposal({ symbol, stake, growthRate, currency = 'USD' }) {
    let cleanSymbol = (symbol || 'R_100').trim();
    const rate = parseFloat(growthRate) || 0.05;
    const amount = parseFloat(stake) || 1.0;
    const curr = currency || this.currency || 'USD';

    const buildReq = (sym) => ({
      proposal: 1,
      amount: amount,
      basis: 'stake',
      contract_type: 'ACCU',
      currency: curr,
      underlying_symbol: sym,
      growth_rate: rate
    });

    return this.send(buildReq(cleanSymbol)).catch(err => {
      if (cleanSymbol === 'BOOM300') return this.send(buildReq('BOOM300N'));
      if (cleanSymbol === 'BOOM300N') return this.send(buildReq('BOOM300'));
      if (cleanSymbol === 'CRASH300') return this.send(buildReq('CRASH300N'));
      if (cleanSymbol === 'CRASH300N') return this.send(buildReq('CRASH300'));
      throw err;
    });
  }

  unsubscribeOpenContract(contractId) {
    this.unsubscribeContract(contractId).catch(() => {});
  }

  forgetAllSubscriptions() {
    return this.send({ forget_all: 'proposal' }).catch(() => {});
  }

  getPortfolio() {
    return this.send({ portfolio: 1 });
  }

  async checkContract(contractId) {
    if (!contractId) return null;

    const cidNum = parseInt(contractId, 10);
    const cached = this.openContractsCache.get(contractId) || this.openContractsCache.get(cidNum);

    if (cached) {
      if (cached.is_sold) {
        setTimeout(() => {
          this.openContractsCache.delete(contractId);
          this.openContractsCache.delete(cidNum);
        }, 10000);
      } else {
        // High-speed active safety net: if no push update arrived for > 300ms, refresh from Deriv
        const now = Date.now();
        const lastUpdate = cached._lastUpdateTime || 0;
        if (now - lastUpdate > 300) {
          cached._lastUpdateTime = now;
          const fresh = await this.fetchOpenContract(cidNum);
          if (fresh) return fresh;
        }
      }
      return cached;
    }

    // Default open state while awaiting Deriv push event
    return (await this.fetchOpenContract(cidNum)) || { is_sold: false, profit: 0, status: 'open' };
  }

  // ── Ping / Disconnect ──────────────────────────────────────────
  startPing() {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.isConnected) this.send({ ping: 1 }).catch(() => {});
    }, 10000);
  }

  stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  disconnect() {
    this.stopPing();
    if (this.ws) this.ws.close();
  }
}

window.DerivBrowserClient = DerivBrowserClient;
window.DerivClient = DerivBrowserClient;
