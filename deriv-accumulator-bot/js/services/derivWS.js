/**
 * Deriv WebSocket API Client (New v1 Options Trading API)
 * Uses REST-based OTP authentication + WebSocket for trading
 * 
 * Authentication Flow:
 * 1. GET  /trading/v1/options/accounts           → Get account list
 * 2. POST /trading/v1/options/accounts/{id}/otp   → Get one-time WS URL
 * 3. Connect to wss://api.derivws.com/...?otp=XXX → Trading WebSocket
 */

export class DerivWSClient {
  constructor() {
    this.ws = null;
    this.appId = '';           // Deriv-App-ID header (alphanumeric)
    this.apiToken = '';        // Bearer PAT token
    this.accountId = '';       // Account ID from /accounts endpoint
    this.accountType = 'demo'; // 'demo' or 'real'
    this.isConnected = false;
    this.isAuthorized = false;
    this.accountInfo = null;
    this.balance = 0;
    this.currency = 'USD';
    this.pingInterval = null;
    this.reqIdCounter = 1;
    this.callbacks = new Map();
    this.listeners = new Map();
    this.activeSubscriptions = new Set();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this._shouldReconnect = true;
  }

  /**
   * Set API credentials
   */
  setCredentials(appId, token) {
    if (appId) this.appId = String(appId).trim();
    if (token) this.apiToken = String(token).trim();
  }

  /**
   * Step 1: Fetch trading accounts via REST API
   */
  async fetchAccounts() {
    this.emit('log', { type: 'info', message: 'Fetching trading accounts from Deriv API...' });

    const res = await fetch('https://api.derivws.com/trading/v1/options/accounts', {
      method: 'GET',
      headers: {
        'Deriv-App-ID': this.appId,
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Failed to fetch accounts (HTTP ${res.status}): ${errBody}`);
    }

    const data = await res.json();
    this.emit('log', { type: 'success', message: `Account data received successfully.` });
    return data;
  }

  /**
   * Step 2: Generate one-time password for WebSocket connection
   */
  async generateOTP(accountId) {
    this.emit('log', { type: 'info', message: `Generating OTP for account ${accountId}...` });

    const res = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${accountId}/otp`, {
      method: 'POST',
      headers: {
        'Deriv-App-ID': this.appId,
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Failed to generate OTP (HTTP ${res.status}): ${errBody}`);
    }

    const data = await res.json();
    this.emit('log', { type: 'success', message: 'OTP generated (valid for 120 seconds).' });
    return data;
  }

  /**
   * Main connect flow: fetch accounts → pick account → OTP → WebSocket
   */
  async connect() {
    try {
      if (!this.appId || !this.apiToken) {
        throw new Error('App ID and API Token are required. Please configure in API KEYS modal.');
      }

      // Close existing connection
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
        this.ws.close();
      }

      this._shouldReconnect = true;

      // Step 1: Fetch accounts
      const accountsData = await this.fetchAccounts();
      // Response may be nested: { data: [...], meta: {...} }
      let rawAccounts = accountsData;
      if (accountsData.data && !Array.isArray(accountsData)) {
        rawAccounts = accountsData.data;
      }
      let accounts = Array.isArray(rawAccounts) 
        ? rawAccounts 
        : (rawAccounts.accounts || [rawAccounts]);

      if (!accounts || accounts.length === 0) {
        throw new Error('No trading accounts found. Check your API token has "trade" scope enabled.');
      }

      this.emit('log', { type: 'info', message: `Found ${accounts.length} trading account(s).` });

      // Pick demo or real account based on preference
      let selectedAccount = null;
      for (const acc of accounts) {
        const accType = String(acc.account_type || acc.type || acc.loginid || '').toLowerCase();
        const isDemo = accType.includes('demo') || accType.includes('virtual') || accType.includes('vrtc');
        if (this.accountType === 'demo' && isDemo) {
          selectedAccount = acc;
          break;
        } else if (this.accountType === 'real' && !isDemo) {
          selectedAccount = acc;
          break;
        }
      }
      // Fallback to first account
      if (!selectedAccount) selectedAccount = accounts[0];

      this.accountId = selectedAccount.account_id || selectedAccount.id || selectedAccount.loginid || '';
      this.accountInfo = selectedAccount;
      this.balance = parseFloat(selectedAccount.balance || 0);
      this.currency = selectedAccount.currency || 'USD';
      
      const accTypeStr = String(selectedAccount.account_type || selectedAccount.type || '').toLowerCase();
      const isDemo = accTypeStr.includes('demo') || accTypeStr.includes('virtual');

      this.emit('log', { 
        type: 'info', 
        message: `Selected account: ${this.accountId} (${isDemo ? 'Demo' : 'Real'} | ${this.currency} ${this.balance.toFixed(2)})` 
      });

      // Step 2: Generate OTP
      const otpData = await this.generateOTP(this.accountId);
      // Response is nested: { data: { url: 'wss://...' }, meta: {...} }
      const wsUrl = (otpData.data && otpData.data.url) || otpData.url || otpData.websocket_url || '';

      if (!wsUrl) {
        throw new Error('No WebSocket URL in OTP response: ' + JSON.stringify(otpData));
      }

      this.emit('log', { type: 'info', message: 'Connecting to Deriv Trading WebSocket...' });

      // Step 3: Connect WebSocket using OTP URL
      return new Promise((resolve, reject) => {
        this.ws = new WebSocket(wsUrl);

        const connTimeout = setTimeout(() => {
          reject(new Error('WebSocket connection timed out (15s).'));
        }, 15000);

        this.ws.onopen = () => {
          clearTimeout(connTimeout);
          this.isConnected = true;
          this.isAuthorized = true; // OTP handles authentication
          this.reconnectAttempts = 0;
          this.startPing();

          this.emit('connectionChange', { isConnected: true });
          this.emit('log', { 
            type: 'success', 
            message: `✅ WebSocket connected & authorized! Account: ${this.accountId} (${isDemo ? 'Demo' : 'Real'} - Balance: ${this.currency} ${this.balance.toFixed(2)})` 
          });

          // Emit authorized event for UI
          this.emit('authorized', {
            email: selectedAccount.email || this.accountId,
            balance: this.balance,
            currency: this.currency,
            is_virtual: isDemo ? 1 : 0,
            loginid: this.accountId
          });
          this.emit('balanceUpdate', { balance: this.balance, currency: this.currency });

          // Subscribe to balance stream
          this.subscribeBalance().catch(() => {});

          resolve({ connected: true, authorized: true });
        };

        this.ws.onmessage = (event) => {
          try {
            this.handleMessage(JSON.parse(event.data));
          } catch (e) {
            console.error('[DerivWS] Message parse error:', e);
          }
        };

        this.ws.onerror = (error) => {
          clearTimeout(connTimeout);
          this.emit('log', { type: 'error', message: 'WebSocket error encountered.' });
          this.emit('error', error);
          reject(error);
        };

        this.ws.onclose = (event) => {
          this.isConnected = false;
          this.isAuthorized = false;
          this._isSubscribedToOpenContracts = false;
          this.stopPing();
          this.emit('connectionChange', { isConnected: false });
          this.emit('log', { 
            type: 'warning', 
            message: `WebSocket closed (Code: ${event.code}). OTP expired or connection lost.` 
          });

          // Auto-reconnect with fresh OTP
          if (this._shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(3000 * this.reconnectAttempts, 15000);
            this.emit('log', { 
              type: 'info', 
              message: `Auto-reconnect ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${(delay / 1000).toFixed(0)}s (generating fresh OTP)...` 
            });
            setTimeout(() => {
              this.connect().catch(err => {
                this.emit('log', { type: 'error', message: `Reconnect failed: ${err.message}` });
              });
            }, delay);
          }
        };
      });
    } catch (err) {
      this.emit('log', { type: 'error', message: `Connection failed: ${err.message}` });
      throw err;
    }
  }

  /**
   * Disconnect WebSocket
   */
  disconnect() {
    this._shouldReconnect = false;
    this.reconnectAttempts = this.maxReconnectAttempts; // prevent auto-reconnect
    this.stopPing();
    this._isSubscribedToOpenContracts = false;
    if (this.ws) {
      this.ws.close();
    }
  }

  /**
   * Keep Connection Alive
   */
  startPing() {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.isConnected) {
        this.send({ ping: 1 }).catch(() => {});
      }
    }, 30000);
  }

  stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Send JSON request over WebSocket
   */
  send(payload) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket is not connected.'));
      }

      const reqId = this.reqIdCounter++;
      const requestPayload = { ...payload, req_id: reqId };

      this.callbacks.set(reqId, { resolve, reject });
      this.ws.send(JSON.stringify(requestPayload));

      // Timeout safety after 15 seconds
      setTimeout(() => {
        if (this.callbacks.has(reqId)) {
          this.callbacks.delete(reqId);
          reject(new Error(`Request timeout for req_id: ${reqId}`));
        }
      }, 15000);
    });
  }

  /**
   * Message Handler
   */
  handleMessage(msg) {
    const reqId = msg.req_id;
    const msgType = msg.msg_type;

    if (msg.error) {
      this.emit('log', { type: 'error', message: `API Error [${msg.error.code}]: ${msg.error.message}` });
      if (reqId && this.callbacks.has(reqId)) {
        this.callbacks.get(reqId).reject(msg.error);
        this.callbacks.delete(reqId);
      }
      this.emit('apiError', msg.error);
      return;
    }

    // Resolve callback promises
    if (reqId && this.callbacks.has(reqId)) {
      const cb = this.callbacks.get(reqId);
      cb.resolve(msg);
      this.callbacks.delete(reqId);
    }

    // Dispatch stream events
    switch (msgType) {
      case 'authorize':
        this.isAuthorized = true;
        this.accountInfo = msg.authorize;
        this.balance = parseFloat(msg.authorize.balance);
        this.currency = msg.authorize.currency;
        this.emit('authorized', this.accountInfo);
        this.emit('log', { 
          type: 'success', 
          message: `Authorized as ${msg.authorize.email || this.accountId}` 
        });
        this.subscribeBalance();
        break;

      case 'balance':
        if (msg.balance) {
          this.balance = parseFloat(msg.balance.balance);
          this.currency = msg.balance.currency;
          this.emit('balanceUpdate', { balance: this.balance, currency: this.currency });
        }
        break;

      case 'tick':
        if (msg.tick) {
          this.emit('tick', msg.tick);
        }
        break;

      case 'proposal':
        if (msg.proposal) {
          this.emit('proposal', msg.proposal);
        }
        break;

      case 'buy':
        if (msg.buy) {
          this.emit('buy', msg.buy);
        }
        break;

      case 'proposal_open_contract':
        if (msg.proposal_open_contract) {
          this.emit('proposalOpenContract', msg.proposal_open_contract);
        }
        break;

      case 'sell':
        if (msg.sell) {
          this.emit('sell', msg.sell);
        }
        break;
    }
  }

  /**
   * Authorize — not needed with OTP flow, kept for compatibility
   */
  authorize() {
    return Promise.resolve({ connected: true, authorized: true });
  }

  /**
   * Subscribe to Balance Stream
   */
  subscribeBalance() {
    return this.send({ balance: 1, subscribe: 1 });
  }

  /**
   * Subscribe to Ticks for symbol
   */
  subscribeTicks(symbol) {
    this.send({ forget_all: 'ticks' }).catch(() => {});
    return this.send({ ticks: symbol, subscribe: 1 });
  }

  /**
   * Request Accumulator Proposal
   */
  requestAccumulatorProposal({ symbol, stake, growthRate, currency = 'USD' }) {
    return this.send({ forget_all: 'proposal' })
      .catch(() => {})
      .then(() => {
        return this.send({
          proposal: 1,
          amount: parseFloat(stake),
          basis: 'stake',
          contract_type: 'ACCU',
          currency: currency || this.currency || 'USD',
          underlying_symbol: symbol,
          growth_rate: parseFloat(growthRate),
          subscribe: 1
        });
      });
  }

  /**
   * Buy Accumulator Contract Directly (1-Step Execution)
   */
  buyAccumulatorDirect({ symbol, stake, growthRate, currency = 'USD' }) {
    return this.send({
      buy: 1,
      price: parseFloat(stake),
      parameters: {
        amount: parseFloat(stake),
        basis: 'stake',
        contract_type: 'ACCU',
        currency: currency || this.currency || 'USD',
        underlying_symbol: symbol,
        growth_rate: parseFloat(growthRate)
      }
    });
  }

  /**
   * Buy Contract from Proposal ID
   */
  buyContract(proposalId, price) {
    return this.send({
      buy: proposalId,
      price: parseFloat(price)
    });
  }

  /**
   * Get Portfolio
   */
  getPortfolio() {
    return this.send({ portfolio: 1 });
  }

  /**
   * Subscribe to Proposal Open Contract stream (Globally)
   */
  subscribeOpenContract(contractId) {
    if (this._isSubscribedToOpenContracts) {
      return Promise.resolve({ already_subscribed: true });
    }
    this._isSubscribedToOpenContracts = true;
    return this.send({
      proposal_open_contract: 1,
      subscribe: 1
    }).catch(err => {
      this._isSubscribedToOpenContracts = false;
      throw err;
    });
  }

  /**
   * Sell Contract (Cashout) at Market
   */
  sellContract(contractId) {
    return this.send({
      sell: contractId,
      price: 0
    });
  }

  /**
   * Event Emitter implementation
   */
  on(event, handler) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(handler);
  }

  off(event, handler) {
    if (this.listeners.has(event)) {
      const handlers = this.listeners.get(event).filter(h => h !== handler);
      this.listeners.set(event, handlers);
    }
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(handler => {
        try {
          handler(data);
        } catch (e) {
          console.error(`Error in event listener for ${event}:`, e);
        }
      });
    }
  }
}
