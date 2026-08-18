/**
 * Deriv Offline Synthetic Accumulator Simulator
 * Allows testing strategies & UI without needing live WebSocket connections
 */

export class DerivSimulator {
  constructor() {
    this.isConnected = false;
    this.isAuthorized = true;
    this.balance = 10000.00;
    this.currency = 'USD';
    this.currentSymbol = 'R_100';
    this.currentSpot = 1000.00;
    this.tickInterval = null;
    this.activeContract = null;
    this.listeners = new Map();
  }

  connect() {
    return new Promise((resolve) => {
      this.isConnected = true;
      this.emit('connectionChange', { isConnected: true });
      this.emit('log', { type: 'info', message: 'Simulator Mode initialized (Virtual Balance: $10,000.00 USD).' });
      this.startSyntheticTicks();
      resolve({ connected: true, authorized: true });
    });
  }

  disconnect() {
    this.stopSyntheticTicks();
    this.isConnected = false;
    this.emit('connectionChange', { isConnected: false });
  }

  setCredentials() {}

  authorize() {
    return Promise.resolve({
      authorize: {
        balance: this.balance,
        currency: 'USD',
        email: 'simulator@demo.deriv',
        is_virtual: 1,
        loginid: 'VRTC9999999'
      }
    });
  }

  startSyntheticTicks() {
    this.stopSyntheticTicks();
    this.tickInterval = setInterval(() => {
      // Geometric Brownian Motion / Random Walk step
      const volatility = 0.0015;
      const changePercent = (Math.random() - 0.495) * volatility;
      this.currentSpot = +(this.currentSpot * (1 + changePercent)).toFixed(4);

      const tickObj = {
        symbol: this.currentSymbol,
        quote: this.currentSpot,
        epoch: Math.floor(Date.now() / 1000),
        id: 'sim_tick_' + Date.now()
      };

      this.emit('tick', tickObj);

      // Advance active contract if present
      if (this.activeContract && this.activeContract.status === 'open') {
        this.processContractTick(this.currentSpot);
      }
    }, 1000); // 1 tick per second
  }

  stopSyntheticTicks() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  subscribeTicks(symbol) {
    this.currentSymbol = symbol;
    this.currentSpot = symbol.includes('100') ? 1000.00 : (symbol.includes('75') ? 750.00 : 500.00);
    this.emit('log', { type: 'info', message: `Simulator subscribed to ${symbol} synthetic ticks.` });
    return Promise.resolve({ tick: { symbol, quote: this.currentSpot } });
  }

  requestAccumulatorProposal({ symbol, stake, growthRate }) {
    const growth = parseFloat(growthRate);
    // Barrier offset percentage derived from growth rate
    const barrierOffset = (1 - (1 / (1 + growth))) * 0.45;
    const highBarrier = +(this.currentSpot * (1 + barrierOffset)).toFixed(4);
    const lowBarrier = +(this.currentSpot * (1 - barrierOffset)).toFixed(4);

    const proposalObj = {
      id: 'sim_prop_' + Math.random().toString(36).substring(2, 9),
      ask_price: parseFloat(stake),
      spot: this.currentSpot,
      high_barrier: highBarrier,
      low_barrier: lowBarrier,
      growth_rate: growth
    };

    this.lastProposal = proposalObj;
    this.emit('proposal', proposalObj);
    return Promise.resolve({ proposal: proposalObj });
  }

  buyAccumulatorDirect({ symbol, stake, growthRate }) {
    if (symbol) this.currentSymbol = symbol;
    this.requestAccumulatorProposal({ symbol: symbol || this.currentSymbol, stake, growthRate });
    return this.buyContract('sim_prop', stake);
  }

  buyContract(proposalId, price) {
    const stake = parseFloat(price);
    if (stake > this.balance) {
      return Promise.reject(new Error('Insufficient balance in simulator.'));
    }

    this.balance -= stake;
    this.emit('balanceUpdate', { balance: this.balance, currency: this.currency });

    const contractId = 'sim_contract_' + Date.now();
    const growthRate = this.lastProposal ? this.lastProposal.growth_rate : 0.01;
    const barrierOffset = (1 - (1 / (1 + growthRate))) * 0.45;

    this.activeContract = {
      contract_id: contractId,
      status: 'open',
      stake: stake,
      entry_spot: this.currentSpot,
      current_spot: this.currentSpot,
      growth_rate: growthRate,
      high_barrier: +(this.currentSpot * (1 + barrierOffset)).toFixed(4),
      low_barrier: +(this.currentSpot * (1 - barrierOffset)).toFixed(4),
      tick_count: 0,
      tick_passed: 0,
      payout: stake,
      profit: 0,
      profit_percentage: 0,
      is_valid_to_sell: 1,
      is_sold: 0
    };

    const buyRes = { buy: { contract_id: contractId, balance_after: this.balance } };
    this.emit('buy', buyRes.buy);
    this.emit('log', { type: 'success', message: `[Simulator] Purchased ACCU contract #${contractId.slice(-6)} (Stake: $${stake.toFixed(2)})` });

    // Emit initial POC
    this.emitPOC();

    return Promise.resolve(buyRes);
  }

  subscribeOpenContract(contractId) {
    this.emitPOC();
    return Promise.resolve({ proposal_open_contract: this.activeContract });
  }

  processContractTick(spot) {
    if (!this.activeContract) return;

    const c = this.activeContract;
    c.current_spot = spot;

    // Check if spot stays strictly within high and low boundaries
    const insideCorridor = (spot < c.high_barrier && spot > c.low_barrier);

    if (insideCorridor) {
      c.tick_count += 1;
      c.tick_passed += 1;
      // Exponential accumulator payout formula: stake * (1 + growth_rate)^tick_count
      const multiplier = Math.pow(1 + c.growth_rate, c.tick_count);
      c.payout = +(c.stake * multiplier).toFixed(2);
      c.profit = +(c.payout - c.stake).toFixed(2);
      c.profit_percentage = +((c.profit / c.stake) * 100).toFixed(2);

      // Update next tick high/low barriers relative to current spot
      const barrierOffset = (1 - (1 / (1 + c.growth_rate))) * 0.45;
      c.high_barrier = +(spot * (1 + barrierOffset)).toFixed(4);
      c.low_barrier = +(spot * (1 - barrierOffset)).toFixed(4);

      this.emitPOC();
    } else {
      // Boundary breached -> Contract lost!
      c.status = 'lost';
      c.is_sold = 1;
      c.is_valid_to_sell = 0;
      c.payout = 0;
      c.profit = -c.stake;
      c.profit_percentage = -100;
      c.exit_tick = spot;

      this.emitPOC();
      this.emit('log', { type: 'error', message: `[Simulator] Boundary breached! Contract #${c.contract_id.slice(-6)} lost (-$${c.stake.toFixed(2)}) after ${c.tick_count} ticks.` });
      
      const finishedContract = { ...c };
      this.activeContract = null;
      this.emit('sell', { contract_id: finishedContract.contract_id, sold_for: 0 });
    }
  }

  sellContract(contractId) {
    if (!this.activeContract || this.activeContract.contract_id !== contractId) {
      return Promise.reject(new Error('Active contract not found in simulator.'));
    }

    const c = this.activeContract;
    c.status = 'won';
    c.is_sold = 1;
    c.is_valid_to_sell = 0;
    c.sell_price = c.payout;

    this.balance += c.payout;
    this.emit('balanceUpdate', { balance: this.balance, currency: this.currency });

    this.emitPOC();
    this.emit('log', { type: 'success', message: `[Simulator] Cashed out contract #${c.contract_id.slice(-6)} on tick #${c.tick_count}! Payout: $${c.payout.toFixed(2)} (+$${c.profit.toFixed(2)})` });

    const finishedContract = { ...c };
    this.activeContract = null;
    
    this.emit('sell', { contract_id: finishedContract.contract_id, sold_for: finishedContract.payout });

    return Promise.resolve({ sell: { contract_id: contractId, sold_for: finishedContract.payout } });
  }

  emitPOC() {
    if (this.activeContract) {
      this.emit('proposalOpenContract', { ...this.activeContract });
    }
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(handler => handler(data));
    }
  }
}
