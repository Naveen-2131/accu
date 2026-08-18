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
    // Subscription guards
    this._proposalSubId = null;   // active proposal subscription ID
    this._tickSubId = null;        // active tick subscription ID
    this._isSubscribingProposal = false; // prevent double proposal sub
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
  /**
   * Main connect flow: Try REST OTP → Fallback to Standard Deriv WS (authorize token)
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

      // Attempt 1: Try REST OTP Flow first
      try {
        const accountsData = await this.fetchAccounts();
        let rawAccounts = accountsData;
        if (accountsData.data && !Array.isArray(accountsData)) {
          rawAccounts = accountsData.data;
        }
        let accounts = Array.isArray(rawAccounts) 
          ? rawAccounts 
          : (rawAccounts.accounts || [rawAccounts]);

        if (accounts && accounts.length > 0) {
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
          if (!selectedAccount) selectedAccount = accounts[0];

          this.accountId = selectedAccount.account_id || selectedAccount.id || selectedAccount.loginid || '';
          this.accountInfo = selectedAccount;
          this.balance = parseFloat(selectedAccount.balance || 0);
          this.currency = selectedAccount.currency || 'USD';

          const otpData = await this.generateOTP(this.accountId);
          const wsUrl = (otpData.data && otpData.data.url) || otpData.url || otpData.websocket_url || '';

          if (wsUrl) {
            return await this.connectOTP(wsUrl, selectedAccount);
          }
        }
      } catch (restErr) {
        this.emit('log', { type: 'warning', message: `REST API notice (${restErr.message}). Trying Standard Deriv WS...` });
      }

      // Attempt 2: Fallback to Standard Deriv WebSocket (wss://ws.binaryws.com/websockets/v3?app_id=...)
      return await this.connectStandardWS();

    } catch (err) {
      this.emit('log', { type: 'error', message: `Connection failed: ${err.message}` });
      throw err;
    }
  }

  /**
   * Connect via OTP WebSocket URL
   */
  async connectOTP(wsUrl, selectedAccount) {
    const accTypeStr = String(selectedAccount.account_type || selectedAccount.type || '').toLowerCase();
    const isDemo = accTypeStr.includes('demo') || accTypeStr.includes('virtual');

    this.emit('log', { type: 'info', message: 'Connecting to Deriv Trading WebSocket...' });

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

        this.emit('authorized', {
          email: selectedAccount.email || this.accountId,
          balance: this.balance,
          currency: this.currency,
          is_virtual: isDemo ? 1 : 0,
          loginid: this.accountId
        });
        this.emit('balanceUpdate', { balance: this.balance, currency: this.currency });

        this.subscribeBalance().catch(() => {});
        resolve({ connected: true, authorized: true });
      };

      this.ws.onerror = (err) => {
        clearTimeout(connTimeout);
        reject(new Error('WebSocket connection error.'));
      };

      this.ws.onclose = () => {
        clearTimeout(connTimeout);
        this.isConnected = false;
        this.isAuthorized = false;
        this._isSubscribedToOpenContracts = false;
        this.stopPing();
        this.emit('connectionChange', { isConnected: false });
      };

      this.ws.onmessage = (event) => {
        try {
          this.handleMessage(JSON.parse(event.data));
        } catch (e) {
          console.error('[DerivWS] Message parse error:', e);
        }
      };
    });
  }

  /**
   * Connect via Standard Deriv WebSocket authorize (app.deriv.com tokens)
   */
  async connectStandardWS() {
    const cleanAppId = this.appId || '1089';
    const wsUrl = `wss://ws.binaryws.com/websockets/v3?app_id=${cleanAppId}`;

    this.emit('log', { type: 'info', message: `Connecting via Standard WebSocket (App ID: ${cleanAppId})...` });

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      const connTimeout = setTimeout(() => {
        reject(new Error('Standard WebSocket connection timed out (15s).'));
      }, 15000);

      this.ws.onopen = () => {
        clearTimeout(connTimeout);
        this.isConnected = true;
        this.startPing();
        this.emit('log', { type: 'info', message: 'WebSocket opened. Authorizing Token...' });

        this.send({ authorize: this.apiToken }).then(res => {
          if (res.error) {
            throw new Error(res.error.message || res.error.code || 'Authorization Failed');
          }

          this.isAuthorized = true;
          this.reconnectAttempts = 0;
          this.accountInfo = res.authorize;
          this.accountId = res.authorize.loginid;
          this.balance = parseFloat(res.authorize.balance || 0);
          this.currency = res.authorize.currency || 'USD';

          this.emit('connectionChange', { isConnected: true });
          this.emit('log', {
            type: 'success',
            message: `✅ Authorized! Account: ${res.authorize.loginid} (${res.authorize.fullname || 'Deriv User'} | Balance: ${this.currency} ${this.balance.toFixed(2)})`
          });

          this.emit('authorized', res.authorize);
          this.emit('balanceUpdate', { balance: this.balance, currency: this.currency });

          this.subscribeBalance().catch(() => {});
          resolve({ connected: true, authorized: true });
        }).catch(authErr => {
          this.emit('log', { type: 'error', message: `Auth Error: ${authErr.message}` });
          reject(authErr);
        });
      };

      this.ws.onerror = (err) => {
        clearTimeout(connTimeout);
        reject(new Error('WebSocket connection error.'));
      };

      this.ws.onclose = () => {
        clearTimeout(connTimeout);
        this.handleClose();
      };

      this.ws.onmessage = (event) => {
        try {
          this.handleMessage(JSON.parse(event.data));
        } catch (e) {
          this.handleMessage(event.data);
        }
      };
    });
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
   * Keep Connection Alive (10s Ping Heartbeat)
   */
  startPing() {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ ping: 1 }).catch(() => {});
      }
    }, 10000);
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
        if (this.apiToken) {
          return this.connect().then(() => this.send(payload)).then(resolve).catch(reject);
        }
        return reject(new Error('WebSocket is not connected.'));
      }

      const reqId = this.reqIdCounter++;
      const requestPayload = { ...payload, req_id: reqId };

      this.callbacks.set(reqId, { resolve, reject });
      this.ws.send(JSON.stringify(requestPayload));

      // Timeout safety after 12 seconds
      setTimeout(() => {
        if (this.callbacks.has(reqId)) {
          this.callbacks.delete(reqId);
          this.isConnected = false;
          reject(new Error(`Request timeout for req_id: ${reqId}`));
        }
      }, 12000);
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
   * Handle WebSocket Close (shared logic)
   */
  handleClose() {
    this.isConnected = false;
    this.isAuthorized = false;
    this._isSubscribedToOpenContracts = false;
    this.stopPing();
    this.emit('connectionChange', { isConnected: false });
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
    // Forget previous tick subscription if any
    const forgetPrev = this._tickSubId
      ? this.send({ forget: this._tickSubId }).catch(() => {})
      : this.send({ forget_all: 'ticks' }).catch(() => {});
    this._tickSubId = null;
    return forgetPrev.then(() => {
      return this.send({ ticks: symbol, subscribe: 1 }).then(res => {
        if (res && res.subscription) {
          this._tickSubId = res.subscription.id;
        }
        return res;
      });
    });
  }

  /**
   * Request Accumulator Proposal
   */
  requestAccumulatorProposal({ symbol, stake, growthRate, currency = 'USD' }) {
    // Prevent concurrent double-subscriptions
    if (this._isSubscribingProposal) return Promise.resolve({});
    this._isSubscribingProposal = true;

    // Forget specific previous subscription if we have its ID
    const forgetPrev = this._proposalSubId
      ? this.send({ forget: this._proposalSubId }).catch(() => {})
      : this.send({ forget_all: 'proposal' }).catch(() => {});
    this._proposalSubId = null;

    return forgetPrev.then(() => {
      return this.send({
        proposal: 1,
        amount: parseFloat(stake),
        basis: 'stake',
        contract_type: 'ACCU',
        currency: currency || this.currency || 'USD',
        underlying_symbol: symbol,
        growth_rate: parseFloat(growthRate),
        subscribe: 1
      }).then(res => {
        if (res && res.subscription) {
          this._proposalSubId = res.subscription.id;
        }
        return res;
      });
    }).finally(() => {
      this._isSubscribingProposal = false;
    });
  }

  /**
   * Forget all active subscriptions (call on bot stop)
   */
  forgetAllSubscriptions() {
    this._isSubscribingProposal = false;
    const tasks = [];
    if (this._proposalSubId) {
      tasks.push(this.send({ forget: this._proposalSubId }).catch(() => {}));
      this._proposalSubId = null;
    }
    if (this._tickSubId) {
      tasks.push(this.send({ forget: this._tickSubId }).catch(() => {}));
      this._tickSubId = null;
    }
    tasks.push(this.send({ forget_all: 'proposal' }).catch(() => {}));
    return Promise.all(tasks);
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
