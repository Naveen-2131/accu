/**
 * Deriv Accumulator Bot Engine v2.8
 * Handles: Auto Buy, Take Profit, Stop Loss, Martingale, Max Ticks Cashout
 */
class AccumulatorBotEngine {
  constructor(client) {
    this.client = client;
    this.isRunning = false;
    this.isPaused = false;
    this.currentContractId = null;
    this.sessionProfit = 0;
    this.totalTrades = 0;
    this.wonTrades = 0;
    this.lostTrades = 0;
    this.currentStake = 0;
    this.originalStake = 0;
    this.martingaleCount = 0;
    this.listeners = {};

    this.config = {
      symbol: 'R_100',
      growthRate: 0.02,
      stake: 1.0,
      takeProfitPerTrade: 0,
      stopLossPerTrade: 0,
      maxTicks: 0,
      sessionTakeProfit: 0,
      sessionStopLoss: 0,
      martingale: false,
      martingaleMultiplier: 2.0,
      maxMartingaleSteps: 3,
      autoRestart: true,
      delayBetweenTrades: 1000
    };

    // Each bot gets its own dedicated watcher instance
    this.maxTicksWatcher = new DedicatedMaxTicksWatcher(this.client, this.config.symbol);
  }

  // ── Event Emitter ─────────────────────────────────────────────
  on(event, fn) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }
  emit(event, data) {
    (this.listeners[event] || []).forEach(fn => { try { fn(data); } catch(e) {} });
  }

  updateConfig(cfg) {
    this.config = { ...this.config, ...cfg };
    if (this.maxTicksWatcher) this.maxTicksWatcher.symbol = this.config.symbol;
  }

  log(type, msg) {
    const time = new Date().toLocaleTimeString('en-IN', { hour12: false });
    this.emit('log', { type, msg, time });
  }

  // ── Execute Single Trade (Used by Synchronized Batch Rounds) ──
  async executeSingleTrade() {
    this.isRunning = true;
    this.isPaused = false;
    if (this.martingaleCount === 0 || !this.currentStake || this.currentStake <= 0) {
      this.originalStake = parseFloat(this.config.stake) || 1.0;
      this.currentStake = this.originalStake;
    }
    try {
      this.emit('started', {});
      return await this._runOneTrade();
    } finally {
      this.isRunning = false;
      this.currentContractId = null;
      this.emit('stopped', { reason: 'Trade complete' });
    }
  }

  // ── Start Bot (Continuous Loop) ──────────────────────────────
  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isPaused = false;
    this.sessionProfit = 0;
    this.totalTrades = 0;
    this.wonTrades = 0;
    this.lostTrades = 0;
    this.currentStake = parseFloat(this.config.stake) || 1.0;
    this.originalStake = this.currentStake;
    this.martingaleCount = 0;
    this.log('info', `🚀 Bot Started | Symbol: ${this.config.symbol} | Growth: ${(this.config.growthRate * 100).toFixed(0)}% | Stake: ${this.currentStake}`);
    this.emit('started', {});
    await this._runLoop();
  }

  // ── Stop Bot ──────────────────────────────────────────────────
  async stop(reason = 'Manual Stop') {
    this.isRunning = false;
    this.isPaused = false;
    if (this.maxTicksWatcher) this.maxTicksWatcher.stopWatch();
    if (this.currentContractId) {
      try {
        this.log('warning', `💰 Cashing out contract #${this.currentContractId} before stopping...`);
        await this.client.sellContract(this.currentContractId);
        this.log('success', `✅ Cashed out contract #${this.currentContractId}`);
      } catch(e) {
        this.log('warning', `Cashout notice: ${e.message}`);
      }
      this.currentContractId = null;
    }
    this.log('info', `🛑 Bot Stopped: ${reason}`);
    this.emit('stopped', { reason });
  }

  // ── Main Loop ─────────────────────────────────────────────────
  async _runLoop() {
    while (this.isRunning) {
      if (this.isPaused) { await this._sleep(500); continue; }
      if (this.config.sessionTakeProfit > 0 && this.sessionProfit >= this.config.sessionTakeProfit) {
        await this.stop(`🎯 Session Take Profit hit! +${this.sessionProfit.toFixed(2)}`); break;
      }
      if (this.config.sessionStopLoss > 0 && this.sessionProfit <= -this.config.sessionStopLoss) {
        await this.stop(`🛑 Session Stop Loss hit! ${this.sessionProfit.toFixed(2)}`); break;
      }
      try {
        await this._runOneTrade();
        if (!this.isRunning) break;
        if (this.config.autoRestart && this.config.delayBetweenTrades > 0) {
          await this._sleep(this.config.delayBetweenTrades);
        } else if (!this.config.autoRestart) {
          this.isRunning = false;
          this.emit('stopped', { reason: 'One trade complete' }); break;
        }
      } catch(err) {
        this.log('error', `❌ Trade Error: ${err.message}`);
        this.emit('error', { msg: err.message });
        await this._sleep(2000);
      }
    }
  }

  // ── Run One Trade ─────────────────────────────────────────────
  async _runOneTrade() {
    this.log('info', `📥 Buying | Stake: ${this.currentStake.toFixed(2)} | Growth: ${(this.config.growthRate*100).toFixed(0)}% | MaxTicks: ${this.config.maxTicks}`);
    let buyResult;
    try {
      buyResult = await this.client.buyAccumulator(this.config.symbol, this.currentStake, this.config.growthRate, this.config.maxTicks);
    } catch(err) {
      throw new Error(`Buy failed: ${err.message}`);
    }

    if (!buyResult || !buyResult.contract_id) {
      const reason = buyResult?.message || 'Contract not offered on Deriv';
      this.log('warning', `⚠️ [${this.config.symbol}] Skipped: ${reason}`);
      return {
        contractId: null,
        profit: 0,
        isLoss: false,
        result: 'skipped',
        ticks: 0,
        reason
      };
    }

    const contractId = buyResult.contract_id;
    this.currentContractId = contractId;
    this.totalTrades++;
    this.log('success', `✅ Contract #${contractId} Opened!`);
    this.emit('contractOpened', { contractId, stake: this.currentStake });

    const tradeResult = await this._monitorContract(contractId);
    this.currentContractId = null;

    this.sessionProfit += tradeResult.profit;
    this.emit('statsUpdate', {
      sessionProfit: this.sessionProfit,
      totalTrades: this.totalTrades,
      wonTrades: this.wonTrades,
      lostTrades: this.lostTrades,
      currentStake: this.currentStake
    });

    // Martingale
    if (this.config.martingale) {
      if (tradeResult.isLoss) {
        if (this.martingaleCount < this.config.maxMartingaleSteps) {
          this.currentStake = parseFloat((this.currentStake * this.config.martingaleMultiplier).toFixed(2));
          this.martingaleCount++;
          this.log('warning', `📈 Martingale Step ${this.martingaleCount}: Stake=${this.currentStake.toFixed(2)}`);
        } else {
          this.currentStake = this.originalStake;
          this.martingaleCount = 0;
          this.log('info', `🔄 Max Martingale reached. Reset to ${this.currentStake.toFixed(2)}`);
        }
      } else {
        this.currentStake = this.originalStake;
        this.martingaleCount = 0;
      }
    }

    return tradeResult;
  }

  // ── Monitor Contract via Dedicated Watcher ────────────────────
  async _monitorContract(contractId) {
    return new Promise((resolve) => {
      let tickCount = 0;
      let finalProfit = 0;
      let isLoss = false;
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (this.maxTicksWatcher) this.maxTicksWatcher.stopWatch();
        resolve(result);
      };

      // Guard: if bot is stopped externally, force-end
      const stopGuard = setInterval(() => {
        if (!this.isRunning && !settled) {
          clearInterval(stopGuard);
          if (this.maxTicksWatcher) this.maxTicksWatcher.triggerCut('Bot Stopped Externally');
          setTimeout(() => finish({ profit: finalProfit, isLoss, ticks: tickCount }), 800);
        }
        if (settled) clearInterval(stopGuard);
      }, 100);

      this.maxTicksWatcher.startWatch({
        contractId,
        maxTicks:   this.config.maxTicks,
        stake:      this.currentStake,
        growthRate: this.config.growthRate,

        onTick: ({ ticks, profit, spot, targetMaxTicks }) => {
          if (settled) return;
          tickCount     = ticks;
          finalProfit   = profit;

          this.emit('contractUpdate', { contractId, profit, ticks, spot, targetMaxTicks, status: 'open' });

          // TP / SL check — also trigger through watcher's _doSell
          if (this.config.takeProfitPerTrade > 0 && profit >= this.config.takeProfitPerTrade) {
            this.maxTicksWatcher._doSell(`TakeProfit +${this.config.takeProfitPerTrade} (+${profit.toFixed(2)})`);
          } else if (this.config.stopLossPerTrade > 0 && profit <= -this.config.stopLossPerTrade) {
            this.maxTicksWatcher._doSell(`StopLoss -${this.config.stopLossPerTrade} (${profit.toFixed(2)})`);
          }
        },

        onCut: ({ reason, ticks, profit }) => {
          this.log('info', `⚡ [${this.config.symbol}] Cashout triggered: ${reason}`);
          this.emit('contractCutting', { contractId, ticks, profit, reason });
        },

        onEnded: ({ isLoss: endedLoss, profit, ticks }) => {
          clearInterval(stopGuard);
          finalProfit = profit;
          isLoss      = endedLoss;

          if (isLoss) {
            this.lostTrades++;
            this.log('error', `💥 [${this.config.symbol}] Knockout @ Tick ${ticks} | PnL: ${profit.toFixed(2)}`);
          } else {
            this.wonTrades++;
            this.log('success', `💰 [${this.config.symbol}] Cashed Out @ Tick ${ticks} | Profit: +${profit.toFixed(2)}`);
          }
          this.emit('contractClosed', { contractId, profit, ticks, result: isLoss ? 'lost' : 'won' });
          finish({ profit, isLoss, ticks });
        }
      });
    });
  }

  // ── Manual Cashout ────────────────────────────────────────────
  async manualCashout() {
    if (!this.currentContractId) { this.log('warning', 'No open contract to cashout'); return; }
    this.log('info', `💸 Manual Cashout: Contract #${this.currentContractId}...`);
    try {
      await this.client.sellContract(this.currentContractId);
      this.log('success', `✅ Manual Cashout Done!`);
    } catch(e) {
      this.log('error', `Cashout error: ${e.message}`);
    }
  }

  _sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

  getStats() {
    return {
      isRunning: this.isRunning,
      sessionProfit: this.sessionProfit,
      totalTrades: this.totalTrades,
      wonTrades: this.wonTrades,
      lostTrades: this.lostTrades,
      currentStake: this.currentStake,
      martingaleCount: this.martingaleCount
    };
  }
}

window.AccumulatorBotEngine = AccumulatorBotEngine;
