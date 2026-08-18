/**
 * Accumulator Trading Bot Engine
 * Manages automated entry, execution, auto-cashout logic, risk rules, and statistics.
 */

export class AccumulatorBotEngine {
  constructor(client) {
    this.client = client;
    this.isRunning = false;
    this.state = 'IDLE'; // IDLE, PREPARING, IN_CONTRACT, COOLDOWN, STOPPED

    // Strategy Parameters
    this.config = {
      symbol: 'R_100',
      growthRate: 0.05,         // 5%
      baseStake: 1.0,           // Default $1 stake
      targetTicks: 10,          // Auto cashout after N ticks
      globalTakeProfit: 50.0,   // Session TP ($)
      globalStopLoss: 30.0,     // Session SL ($)
      maxCycles: 10             // Default 10 cycles
    };

    // Current Trading Session State
    this.currentStake = 1.0;
    this.activeProposalId = null;
    this.activeContract = null;
    this.cooldownTimer = null;
    this._lastStatsString = undefined;
    this.isImmediateNextBuy = false;

    // Statistics
    this.stats = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalPnL: 0.0,
      currentWinStreak: 0,
      currentLossStreak: 0,
      maxWinStreak: 0,
      maxLossStreak: 0,
      tradeHistory: []
    };

    this.listeners = new Map();
    this.bindClientEvents();
  }

  /**
   * Set configuration
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    if (this.state === 'IDLE') {
      this.currentStake = this.config.baseStake;
    }
    this.emit('configChange', this.config);
  }

  /**
   * Bind events from WebSocket Client / Simulator
   */
  bindClientEvents() {
    this.client.on('proposal', (proposal) => this.onProposalReceived(proposal));
    this.client.on('buy', (buyInfo) => this.onBuyExecuted(buyInfo));
    this.client.on('proposalOpenContract', (poc) => this.onOpenContractUpdate(poc));
    this.client.on('sell', (sellInfo) => {
      if (this.activeContract) this.onContractCompleted(this.activeContract);
    });
  }

  /**
   * Start Automated Trading Bot
   */
  start() {
    if (this.isRunning) return;

    if (!this.client.isConnected) {
      this.emit('log', { type: 'error', message: 'Cannot start bot: WebSocket is not connected.' });
      return;
    }

    if (!this.client.isAuthorized) {
      this.emit('log', { type: 'error', message: 'Cannot start bot: Account is not authorized. Please check your API Token in API KEYS modal.' });
      return;
    }

    this.isRunning = true;
    this.state = 'PREPARING';
    this.currentStake = this.config.baseStake;
    this.cyclesCompleted = 0;
    this._lastStatsString = undefined;
    this._crashBuyTriggered = false;
    this.isImmediateNextBuy = false;
    this.emit('stateChange', { state: this.state, isRunning: true });
    this.emit('log', { type: 'success', message: '=== ACCUMULATOR BOT STARTED ===' });

    // Initiate symbol subscription & first trade loop with auto-retry
    const startSubscription = () => {
      return this.client.subscribeTicks(this.config.symbol)
        .then(() => {
          this.triggerNextTrade();
        });
    };

    startSubscription().catch(err => {
      this.emit('log', { type: 'warning', message: `Subscription notice (${err.message}). Auto-reconnecting WebSocket...` });
      this.client.connect().then(() => {
        return startSubscription();
      }).catch(retryErr => {
        this.emit('log', { type: 'error', message: `Failed to subscribe to ticks: ${retryErr.message}` });
        this.stop('Subscription Error');
      });
    });
  }

  /**
   * Stop Automated Trading Bot
   */
  stop(reason = 'User Requested') {
    this.isRunning = false;
    this.state = 'STOPPED';
    this.stopCrashMonitoring();
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this.emit('stateChange', { state: this.state, isRunning: false });
    this.emit('log', { type: 'warning', message: `=== BOT STOPPED (${reason}) ===` });
  }

  /**
   * Start Polling Proposal for Crash Monitoring
   */
  startCrashMonitoring() {
    this.stopCrashMonitoring();

    const poll = () => {
      if (this.state !== 'WAITING_FOR_CRASH' || !this.isRunning) {
        this.stopCrashMonitoring();
        return;
      }
      this.client.requestAccumulatorProposal({
        symbol: this.config.symbol,
        stake: this.currentStake,
        growthRate: this.config.growthRate,
        currency: this.client.currency || 'USD'
      }).catch(() => {});
    };

    poll();
    this.crashPollTimer = setInterval(poll, 1200); // Poll proposal every 1.2s to detect crash in real time
  }

  stopCrashMonitoring() {
    if (this.crashPollTimer) {
      clearInterval(this.crashPollTimer);
      this.crashPollTimer = null;
    }
  }

  /**
   * Emergency Cash Out Current Contract
   */
  emergencyCashout() {
    this.emit('log', { type: 'warning', message: `[EMERGENCY] Fetching portfolio to close all open Accumulator contracts...` });

    this.client.getPortfolio().then(res => {
      const contracts = res?.portfolio?.contracts || [];
      const accuContracts = contracts.filter(c => c.contract_type === 'ACCU');

      if (accuContracts.length === 0) {
        this.emit('log', { type: 'info', message: `No open Accumulator contracts found.` });
        return;
      }

      accuContracts.forEach(c => {
        this.emit('log', { type: 'warning', message: `[EMERGENCY] Selling contract #${c.contract_id}...` });
        this.client.sellContract(c.contract_id).catch(err => {
          this.emit('log', { type: 'error', message: `Cashout error for #${c.contract_id}: ${err.message}` });
        });
      });
    }).catch(err => {
      this.emit('log', { type: 'error', message: `Failed to fetch portfolio: ${err.message}` });
    });
  }

  /**
   * Trigger Next Trade - Handles crash wait for initial start & wins, instant buy for losses
   */
  triggerNextTrade() {
    if (!this.isRunning) return;

    // Verify Risk Guards
    if (this.checkRiskLimits()) return;

    if (!this.client.isConnected || !this.client.isAuthorized) {
      this.emit('log', { type: 'error', message: 'Trade paused: Client not authorized or connected.' });
      this.stop('Not Authorized');
      return;
    }

    // Check Max Cycles limit
    if (this.config.maxCycles > 0 && (this.cyclesCompleted || 0) >= this.config.maxCycles) {
      this.emit('log', { type: 'success', message: `Reached max cycles (${this.config.maxCycles}). Stopping bot.` });
      this.stop('Max Cycles Reached');
      return;
    }

    // Unless an immediate buy is triggered (e.g. following a Loss), wait for current market tick count to finish
    if (!this.isImmediateNextBuy && this.state !== 'WAITING_FOR_CRASH') {
      this.state = 'WAITING_FOR_CRASH';
      this._lastStatsString = undefined;
      this._crashBuyTriggered = false;
      this.emit('stateChange', { state: this.state, isRunning: true });
      this.emit('log', { type: 'info', message: 'Waiting for ongoing market tick count to finish (watching for 0 in stats)...' });

      this.startCrashMonitoring();
      return;
    }

    this.isImmediateNextBuy = false; // Reset instant buy flag
    this.executeBuy();
  }

  /**
   * Execute actual buy order
   */
  executeBuy() {
    if (!this.isRunning) return;
    if (this.checkRiskLimits()) return;

    this.stopCrashMonitoring();

    this.state = 'PREPARING';
    this.emit('stateChange', { state: this.state, isRunning: true });

    const growthPercent = (this.config.growthRate * 100).toFixed(0);
    this.emit('log', { 
      type: 'info', 
      message: `Placing ACCU Buy Order (${growthPercent}% Growth | Symbol: ${this.config.symbol} | Stake: $${this.currentStake.toFixed(2)})...` 
    });

    // Cancel any open proposal subscription first to avoid AlreadySubscribed errors
    this.client.send({ forget_all: 'proposal' }).catch(() => {}).finally(() => {
      // Direct 1-Step Buy
      this.client.buyAccumulatorDirect({
        symbol: this.config.symbol,
        stake: this.currentStake,
        growthRate: this.config.growthRate,
        currency: this.client.currency || 'USD'
      }).then(res => {
        if (res.buy && res.buy.contract_id) {
          this.emit('log', { type: 'success', message: `Buy order confirmed! Contract #${res.buy.contract_id}` });
          this.onBuyExecuted(res.buy);
        }
      }).catch(directErr => {
        this.emit('log', { type: 'warning', message: `Buy notice [${directErr.code || 'ERR'}]: ${directErr.message || directErr}.` });

        if (directErr.code === 'OpenPositionLimitExceeded') {
          this.emit('log', { type: 'info', message: `Attempting auto-recovery: closing stuck contracts...` });
          this.emergencyCashout();
          setTimeout(() => { if (this.isRunning) this.executeBuy(); }, 5000);
          return;
        }

        // Fallback 2-Step Proposal -> Buy
        this.emit('log', { type: 'info', message: `Trying proposal method...` });
        this.client.requestAccumulatorProposal({
          symbol: this.config.symbol,
          stake: this.currentStake,
          growthRate: this.config.growthRate,
          currency: this.client.currency || 'USD'
        }).then(propRes => {
          const propId = propRes.proposal ? propRes.proposal.id : this.activeProposalId;
          if (!propId) throw new Error('Proposal ID not received');
          return this.client.buyContract(propId, this.currentStake);
        }).then(buyRes => {
          if (buyRes && buyRes.buy) {
            this.emit('log', { type: 'success', message: `Proposal buy confirmed! Contract #${buyRes.buy.contract_id}` });
            this.onBuyExecuted(buyRes.buy);
          }
        }).catch(buyErr => {
          this.emit('log', { type: 'error', message: `Buy execution failed [${buyErr.code || 'FAIL'}]: ${buyErr.message || buyErr}` });
          if (buyErr.code === 'OpenPositionLimitExceeded') {
            this.emergencyCashout();
          }
          setTimeout(() => { if (this.isRunning) this.executeBuy(); }, 5000);
        });
      });
    });
  }

  /**
   * Handle incoming proposal and monitor for crash (0 appearing in stats)
   */
  onProposalReceived(proposal) {
    if (proposal && proposal.id) {
      this.activeProposalId = proposal.id;
    }

    if (this.state !== 'WAITING_FOR_CRASH') return;

    const stats = proposal?.contract_details?.ticks_stayed_in || proposal?.ticks_stayed_in;
    if (!stats || !Array.isArray(stats) || stats.length === 0) return;

    // The last value in ticks_stayed_in represents the CURRENT ongoing run's tick count.
    // When it is 0, the market accumulator just crashed/reset — that is our buy signal!
    const currentRunTicks = stats[stats.length - 1];

    if (currentRunTicks === 0) {
      // Additional guard: make sure we haven't already triggered
      if (this._crashBuyTriggered) return;
      this._crashBuyTriggered = true;

      this.stopCrashMonitoring();
      const prevRunTicks = stats.length >= 2 ? stats[stats.length - 2] : '?';
      this.emit('log', { type: 'success', message: `Market crashed after ${prevRunTicks} ticks! Count reset to 0 — Buying NOW!` });
      this.executeBuy();
    }
  }

  /**
   * Handle buy execution confirmation
   */
  onBuyExecuted(buyInfo) {
    if (!this.isRunning) return;

    this.state = 'IN_CONTRACT';
    const contractId = buyInfo.contract_id;
    this.activeContractId = contractId;
    this.activeContract = null; // Reset until first update arrives

    this.client.subscribeOpenContract(contractId).catch(() => {});
    this.emit('stateChange', { state: this.state, isRunning: this.isRunning });
  }

  /**
   * Monitor live contract updates & apply auto-cashout logic
   */
  onOpenContractUpdate(poc) {
    if (this.activeContractId && String(poc.contract_id) !== String(this.activeContractId)) {
      return; // Ignore updates for other contracts
    }

    this.activeContract = poc;
    this.emit('contractUpdate', poc);

    if (!this.isRunning) return;

    // Check if contract is closed/sold/lost
    if (poc.is_sold === 1 || poc.status === 'won' || poc.status === 'lost' || poc.status === 'sold' || poc.is_expired === 1) {
      if (this._processedContractId === poc.contract_id) return;
      this._processedContractId = poc.contract_id;

      this.onContractCompleted(poc);
      return;
    }

    if (poc.status !== 'open') return;

    const currentTicks = poc.tick_passed !== undefined ? poc.tick_passed : (poc.tick_count || 0);
    const currentProfit = parseFloat(poc.profit || 0);

    // Prevent selling at entry tick or if contract is not valid to sell yet
    if (!poc.is_valid_to_sell || currentTicks === 0) return;

    // Rule 1: Target Ticks Auto-Cashout
    if (this.config.targetTicks > 0 && currentTicks >= this.config.targetTicks) {
      this.emit('log', { 
        type: 'success', 
        message: `[AUTO CASHOUT] Reached target ${currentTicks}/${this.config.targetTicks} ticks! Cashing out...` 
      });
      this.client.sellContract(poc.contract_id).catch(err => {
        this.emit('log', { type: 'error', message: `Auto-cashout error: ${err.message}` });
      });
      return;
    }

    // Rule 2: Target Profit Auto-Cashout ($)
    if (this.config.targetProfitPerTrade > 0 && currentProfit >= this.config.targetProfitPerTrade) {
      this.emit('log', { 
        type: 'success', 
        message: `[AUTO CASHOUT] Target profit achieved (+$${currentProfit.toFixed(2)})! Cashing out...` 
      });
      this.client.sellContract(poc.contract_id).catch(err => {
        this.emit('log', { type: 'error', message: `Auto-cashout error: ${err.message}` });
      });
    }
  }

  /**
   * Handle completed / sold / lost contract
   */
  onContractCompleted(poc) {
    this.activeContract = null;
    this.activeContractId = null;

    if (!poc) return;

    const isWin = poc.status === 'won' || (parseFloat(poc.profit) > 0);
    const profitLoss = parseFloat(poc.profit || (isWin ? (poc.sell_price - poc.stake) : -poc.stake));
    // tick_passed = actual ticks survived; tick_count = max allowed ticks (e.g. 250)
    const ticksSurvived = poc.tick_passed ?? poc.tick_count ?? 0;

    // Update Session Statistics
    this.stats.totalTrades += 1;
    this.stats.totalPnL += profitLoss;

    if (isWin) {
      this.stats.wins += 1;
      this.stats.currentWinStreak += 1;
      this.stats.currentLossStreak = 0;
      if (this.stats.currentWinStreak > this.stats.maxWinStreak) {
        this.stats.maxWinStreak = this.stats.currentWinStreak;
      }
      this.isImmediateNextBuy = false; // After WIN: Wait for ongoing market tick count to finish
      this.emit('log', { type: 'success', message: `Trade #${this.stats.totalTrades} WON (+$${profitLoss.toFixed(2)} | ${ticksSurvived} Ticks)` });
    } else {
      this.stats.losses += 1;
      this.stats.currentLossStreak += 1;
      this.stats.currentWinStreak = 0;
      if (this.stats.currentLossStreak > this.stats.maxLossStreak) {
        this.stats.maxLossStreak = this.stats.currentLossStreak;
      }
      this.emit('log', { type: 'error', message: `Trade #${this.stats.totalTrades} LOST (-$${Math.abs(profitLoss).toFixed(2)} | Breached at tick #${ticksSurvived}) — Re-entering immediately!` });
    }

    // Add Record to Trade History
    this.stats.tradeHistory.unshift({
      id: poc.contract_id,
      time: new Date().toLocaleTimeString(),
      symbol: poc.underlying,
      stake: poc.stake,
      profit: profitLoss,
      status: isWin ? 'WIN' : 'LOSS',
      ticks: ticksSurvived
    });

    this.emit('statsUpdate', this.stats);

    // One full trade cycle completed
    this.cyclesCompleted = (this.cyclesCompleted || 0) + 1;

    // Reset state to IDLE
    this.state = 'IDLE';

    // Verify Session Risk Guards before next cycle
    if (this.checkRiskLimits()) return;

    if (!this.isRunning) return;

    if (isWin) {
      // After WIN: wait for market to reset (watch for 0 in stats)
      this.triggerNextTrade();
    } else {
      // After LOSS: buy IMMEDIATELY, no waiting
      this.isImmediateNextBuy = false;
      this.executeBuy();
    }
  }

  /**
   * Schedule trade execution with cooldown
   */
  scheduleNextTrade(seconds) {
    this.state = 'COOLDOWN';
    this.emit('stateChange', { state: this.state, isRunning: this.isRunning });

    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);

    this.cooldownTimer = setTimeout(() => {
      if (this.isRunning) {
        this.triggerNextTrade();
      }
    }, seconds * 1000);
  }

  /**
   * Risk Guard Verification
   */
  checkRiskLimits() {
    // 1. Session Take Profit Check
    if (this.config.globalTakeProfit > 0 && this.stats.totalPnL >= this.config.globalTakeProfit) {
      this.stop(`Global Take Profit reached (+$${this.stats.totalPnL.toFixed(2)})`);
      return true;
    }

    // 2. Session Stop Loss Check
    if (this.config.globalStopLoss > 0 && this.stats.totalPnL <= -Math.abs(this.config.globalStopLoss)) {
      this.stop(`Global Stop Loss reached (-$${Math.abs(this.stats.totalPnL).toFixed(2)})`);
      return true;
    }

    // 3. Max Cycles Check
    if (this.config.maxCycles > 0 && (this.cyclesCompleted || 0) >= this.config.maxCycles) {
      this.stop(`Max cycles reached (${this.cyclesCompleted}/${this.config.maxCycles} trades completed)`);
      return true;
    }

    return false;
  }

  /**
   * Event Emitter implementation
   */
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
