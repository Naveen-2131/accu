/**
 * Multi-Bot Manager — Simultaneous Wave & Sequential Relay Engine v3.5
 *
 * SIMULTANEOUS WAVE ARCHITECTURE (Default):
 * 1. Launches all enabled bots AT THE SAME TIME (concurrent parallel execution).
 * 2. Each bot monitors its contract independently via DedicatedMaxTicksWatcher.
 * 3. As soon as ANY bot hits its target Max Ticks, it CUTS IMMEDIATELY and takes profit!
 * 4. Other bots continue running until each hits its own Max Ticks and cuts.
 * 5. Once all bots in the wave complete, after a brief round delay, the next simultaneous wave triggers.
 *
 * SEQUENTIAL RELAY ARCHITECTURE (Optional Alternative):
 * 1. Executes enabled bots strictly one-by-one in sequence.
 * 2. Next bot starts only after the previous bot closes.
 */
class MultiBotManager {
  constructor(client) {
    this.client = client;
    this.bots = {};       // { symbol: AccumulatorBotEngine }
    this.listeners = {};
    this.sessionProfit = 0;
    this.totalTrades = 0;
    this.wonTrades = 0;
    this.lostTrades = 0;

    // Multi-Bot Batch State
    this.isBatchRunning = false;
    this.currentRound = 0;
    this.activeConfigs = [];
    this.roundDelay = 1000;
    this.completedInRound = 0;
    this.currentRunningSymbol = null;
    this.mode = 'simultaneous'; // 'simultaneous' | 'sequential'
    this.autoRepeat = false; // When false, bots stop after hitting Max Ticks
  }

  on(event, fn) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }
  emit(event, data) {
    (this.listeners[event] || []).forEach(fn => { try { fn(data); } catch(e) {} });
  }

  // ── Register Bot for a Symbol ───────────────────────────────
  registerBot(symbol, config) {
    if (this.bots[symbol]) {
      this.bots[symbol].updateConfig(config);
      return this.bots[symbol];
    }

    const bot = new AccumulatorBotEngine(this.client);
    bot.updateConfig({ ...config, symbol });

    // Pipe bot events up with symbol tag
    bot.on('log',            (d) => this.emit('log',            { ...d, symbol }));
    bot.on('started',        (d) => this.emit('botStarted',     { ...d, symbol }));
    bot.on('stopped',        (d) => this.emit('botStopped',     { ...d, symbol }));
    bot.on('contractOpened', (d) => this.emit('contractOpened', { ...d, symbol }));
    bot.on('contractUpdate', (d) => this.emit('contractUpdate', { ...d, symbol }));
    bot.on('contractCutting', (d) => this.emit('contractCutting', { ...d, symbol }));
    bot.on('contractClosed', (d) => {
      this.sessionProfit += parseFloat(d.profit || 0);
      this.totalTrades++;
      if (d.result === 'won') this.wonTrades++; else this.lostTrades++;
      this.emit('contractClosed', { ...d, symbol });
      this.emit('globalStats', this._globalStats());
    });
    bot.on('statsUpdate',    (d) => this.emit('statsUpdate',    { ...d, symbol }));
    bot.on('error',          (d) => this.emit('error',          { ...d, symbol }));

    this.bots[symbol] = bot;
    return bot;
  }

  // ── Start All Bots (Supports Simultaneous Wave or Sequential Relay) ──
  async startAll(symbolConfigs, roundDelayMs = 1000, mode = 'simultaneous', autoRepeat = false) {
    if (this.isBatchRunning) return;
    this.isBatchRunning = true;
    this.currentRound = 0;
    this.activeConfigs = symbolConfigs;
    this.roundDelay = parseInt(roundDelayMs, 10) || 1000;
    this.mode = mode || 'simultaneous';
    this.autoRepeat = Boolean(autoRepeat);

    this.emit('batchStarted', {
      totalBots: symbolConfigs.length,
      roundDelay: this.roundDelay,
      mode: this.mode
    });

    const loopPromise = this.mode === 'sequential'
      ? this._runSequentialRelayLoop()
      : this._runSimultaneousWaveLoop();

    loopPromise.catch(err => {
      this.isBatchRunning = false;
      this.currentRunningSymbol = null;
      this.emit('error', { symbol: 'SYSTEM', msg: `Batch loop error: ${err.message}` });
    });
  }

  // ═════════════════════════════════════════════════════════════
  // ⚡ SIMULTANEOUS WAVE LOOP (All Bots Buy at Same Time & Cut Immediately)
  // ═════════════════════════════════════════════════════════════
  async _runSimultaneousWaveLoop() {
    while (this.isBatchRunning) {
      this.currentRound++;
      const totalBots = this.activeConfigs.length;
      this.completedInRound = 0;

      this.emit('roundStarted', {
        round: this.currentRound,
        totalBots: totalBots,
        mode: 'simultaneous'
      });
      this.emit('log', {
        type: 'info',
        symbol: 'WAVE',
        msg: `🚀 Wave Round #${this.currentRound} Started! Buying all ${totalBots} bots at the SAME TIME...`
      });

      // 1. Prepare bots
      const botEntries = this.activeConfigs.map(({ symbol, config }) => {
        const bot = this.registerBot(symbol, { ...config, autoRestart: false });
        return { symbol, bot, config };
      });

      // Mark all as queued in UI
      botEntries.forEach(({ symbol }, idx) => {
        this.emit('slotRoundStatus', {
          symbol,
          status: 'queued',
          round: this.currentRound,
          step: idx + 1,
          total: totalBots,
          mode: 'simultaneous'
        });
      });

      // 2. CONCURRENT PARALLEL EXECUTION:
      // Launch all enabled bots simultaneously (with 40ms micro-stagger to preserve WS stream integrity)
      const tradePromises = botEntries.map(async ({ symbol, bot }, idx) => {
        if (!this.isBatchRunning) return null;

        // 300ms stagger between bot purchases spaces out tick 5 hits so each bot cuts smoothly
        if (idx > 0) {
          await this._sleep(idx * 300);
        }
        if (!this.isBatchRunning) return null;

        this.emit('slotRoundStatus', {
          symbol,
          status: 'trading',
          round: this.currentRound,
          step: idx + 1,
          total: totalBots,
          mode: 'simultaneous'
        });

        this.emit('log', {
          type: 'info',
          symbol: symbol,
          msg: `▶ Buying ${symbol} (Target: ${bot.config.maxTicks} ticks • Auto-cuts immediately on hit)`
        });

        try {
          // Executes single trade: cuts immediately when Max Ticks reached via DedicatedMaxTicksWatcher
          const res = await bot.executeSingleTrade();
          this.completedInRound++;

          this.emit('roundProgress', {
            round: this.currentRound,
            completed: this.completedInRound,
            total: totalBots,
            symbol,
            mode: 'simultaneous'
          });

          if (res.result === 'skipped') {
            this.emit('slotRoundStatus', {
              symbol,
              status: 'skipped',
              round: this.currentRound,
              step: idx + 1,
              total: totalBots,
              res,
              mode: 'simultaneous'
            });
            this.emit('log', {
              type: 'warning',
              symbol: symbol,
              msg: `⏩ ${symbol} Skipped: ${res.reason || 'Not offered'}`
            });
          } else {
            this.emit('slotRoundStatus', {
              symbol,
              status: 'finished',
              round: this.currentRound,
              step: idx + 1,
              total: totalBots,
              res,
              mode: 'simultaneous'
            });
            this.emit('log', {
              type: res.result === 'won' ? 'success' : 'warning',
              symbol: symbol,
              msg: `✅ ${symbol} Done! (${res.result === 'won' ? 'WON' : 'LOST'} | PnL: ${res.profit >= 0 ? '+' : ''}${parseFloat(res.profit || 0).toFixed(2)} | Ticks: ${res.ticks || 0})`
            });
          }
          return res;
        } catch (err) {
          this.completedInRound++;
          this.emit('slotRoundStatus', {
            symbol,
            status: 'error',
            round: this.currentRound,
            step: idx + 1,
            total: totalBots,
            err,
            mode: 'simultaneous'
          });
          this.emit('error', { symbol, msg: err.message });
          return { error: err.message };
        }
      });

      // Wait for all bots in this simultaneous wave to finish their trades
      await Promise.allSettled(tradePromises);

      this.emit('roundFinished', {
        round: this.currentRound,
        completed: this.completedInRound,
        total: totalBots,
        mode: 'simultaneous'
      });

      this.emit('log', {
        type: 'success',
        symbol: 'WAVE',
        msg: `🎉 Wave Round #${this.currentRound} Complete! All ${totalBots} bots executed simultaneously.`
      });

      // If Auto-Repeat is OFF, stop batch execution here! Each bot stays stopped!
      if (!this.autoRepeat || !this.isBatchRunning) {
        this.isBatchRunning = false;
        this.emit('log', {
          type: 'success',
          symbol: 'WAVE',
          msg: `🛑 Wave Round #${this.currentRound} Complete! All bots reached Max Ticks and STOPPED.`
        });
        break;
      }

      // Configurable delay before repeating the next wave
      const delaySec = (this.roundDelay / 1000).toFixed(1);
      this.emit('log', {
        type: 'info',
        symbol: 'WAVE',
        msg: `⏳ Next Simultaneous Wave (#${this.currentRound + 1}) starting in ${delaySec}s... All bots will buy together again.`
      });
      await this._sleep(this.roundDelay);
    }

    this.currentRunningSymbol = null;
    this.emit('batchStopped', { round: this.currentRound });
  }

  // ═════════════════════════════════════════════════════════════
  // 🔄 SEQUENTIAL RELAY LOOP (Optional: Bot 1 -> Bot 2 -> Bot 3...)
  // ═════════════════════════════════════════════════════════════
  async _runSequentialRelayLoop() {
    while (this.isBatchRunning) {
      this.currentRound++;
      const totalBots = this.activeConfigs.length;
      this.completedInRound = 0;

      this.emit('roundStarted', {
        round: this.currentRound,
        totalBots: totalBots,
        mode: 'sequential'
      });
      this.emit('log', {
        type: 'info',
        symbol: 'RELAY',
        msg: `🚀 Relay Round #${this.currentRound} Started! Running ${totalBots} bots sequentially (one by one)...`
      });

      const botEntries = this.activeConfigs.map(({ symbol, config }) => {
        const bot = this.registerBot(symbol, { ...config, autoRestart: false });
        return { symbol, bot, config };
      });

      botEntries.forEach(({ symbol }, idx) => {
        this.emit('slotRoundStatus', {
          symbol,
          status: 'queued',
          round: this.currentRound,
          step: idx + 1,
          total: totalBots,
          mode: 'sequential'
        });
      });

      for (let i = 0; i < botEntries.length; i++) {
        if (!this.isBatchRunning) break;

        const { symbol, bot } = botEntries[i];
        const stepNum = i + 1;
        this.currentRunningSymbol = symbol;

        this.emit('roundProgress', {
          round: this.currentRound,
          currentStep: stepNum,
          currentSymbol: symbol,
          completed: this.completedInRound,
          total: totalBots,
          mode: 'sequential'
        });

        this.emit('log', {
          type: 'info',
          symbol: symbol,
          msg: `▶ [${stepNum}/${totalBots}] Starting ${symbol}... (Hits Max Ticks & closes before next starts)`
        });

        this.emit('slotRoundStatus', {
          symbol,
          status: 'trading',
          round: this.currentRound,
          step: stepNum,
          total: totalBots,
          mode: 'sequential'
        });

        try {
          const res = await bot.executeSingleTrade();
          this.completedInRound++;

          if (res.result === 'skipped') {
            this.emit('slotRoundStatus', {
              symbol,
              status: 'skipped',
              round: this.currentRound,
              step: stepNum,
              total: totalBots,
              res,
              mode: 'sequential'
            });
            this.emit('log', {
              type: 'warning',
              symbol: symbol,
              msg: `⏩ [${stepNum}/${totalBots}] ${symbol} Skipped: ${res.reason || 'Not offered'}`
            });
          } else {
            this.emit('slotRoundStatus', {
              symbol,
              status: 'finished',
              round: this.currentRound,
              step: stepNum,
              total: totalBots,
              res,
              mode: 'sequential'
            });
            this.emit('log', {
              type: res.result === 'won' ? 'success' : 'warning',
              symbol: symbol,
              msg: `✅ [${stepNum}/${totalBots}] ${symbol} Completed! (${res.result === 'won' ? 'WON' : 'LOST'} | PnL: ${res.profit >= 0 ? '+' : ''}${parseFloat(res.profit || 0).toFixed(2)} | Ticks: ${res.ticks || 0})`
            });
          }
        } catch (err) {
          this.completedInRound++;
          this.emit('slotRoundStatus', {
            symbol,
            status: 'error',
            round: this.currentRound,
            step: stepNum,
            total: totalBots,
            err,
            mode: 'sequential'
          });
          this.emit('error', { symbol, msg: err.message });
        }

        this.currentRunningSymbol = null;
        if (!this.isBatchRunning) break;

        if (i < botEntries.length - 1) {
          await this._sleep(300);
        }
      }

      this.emit('roundFinished', {
        round: this.currentRound,
        completed: this.completedInRound,
        total: totalBots,
        mode: 'sequential'
      });

      this.emit('log', {
        type: 'success',
        symbol: 'RELAY',
        msg: `🎉 Relay Round #${this.currentRound} Complete! All ${totalBots} bots executed sequentially.`
      });

      if (!this.isBatchRunning) break;

      const delaySec = (this.roundDelay / 1000).toFixed(1);
      this.emit('log', {
        type: 'info',
        symbol: 'RELAY',
        msg: `⏳ Next Relay Round (#${this.currentRound + 1}) starting in ${delaySec}s... Looping back to first bot.`
      });
      await this._sleep(this.roundDelay);
    }

    this.currentRunningSymbol = null;
    this.emit('batchStopped', { round: this.currentRound });
  }

  // ── Stop ALL running bots ─────────────────────────────────────
  async stopAll() {
    this.isBatchRunning = false;
    this.currentRunningSymbol = null;
    const promises = Object.keys(this.bots)
      .filter(sym => this.bots[sym].isRunning)
      .map(sym => this.bots[sym].stop('Stop All'));
    await Promise.allSettled(promises);
    this.emit('batchStopped', { round: this.currentRound });
  }

  // ── Cashout ALL open contracts ───────────────────────────────
  async cashoutAll() {
    const promises = Object.keys(this.bots)
      .filter(sym => this.bots[sym].currentContractId)
      .map(sym => this.bots[sym].manualCashout());
    await Promise.allSettled(promises);
  }

  // ── Start / Stop Individual Bot ───────────────────────────────
  async startBot(symbol, config) {
    const bot = this.registerBot(symbol, config);
    if (bot.isRunning) return;
    bot.updateConfig({ ...config, symbol });
    bot.start().catch(err => this.emit('error', { symbol, msg: err.message }));
  }

  async stopBot(symbol) {
    const bot = this.bots[symbol];
    if (bot) await bot.stop('Manual Stop');
  }

  async cashoutBot(symbol) {
    const bot = this.bots[symbol];
    if (bot) await bot.manualCashout();
  }

  isAnyRunning() {
    return this.isBatchRunning || Object.values(this.bots).some(b => b.isRunning);
  }

  _sleep(ms) {
    return new Promise(res => setTimeout(res, ms));
  }

  _globalStats() {
    return {
      sessionProfit: this.sessionProfit,
      totalTrades: this.totalTrades,
      wonTrades: this.wonTrades,
      lostTrades: this.lostTrades,
      runningCount: Object.values(this.bots).filter(b => b.isRunning).length,
      currentRound: this.currentRound
    };
  }

  getGlobalStats() { return this._globalStats(); }

  resetStats() {
    this.sessionProfit = 0;
    this.totalTrades = 0;
    this.wonTrades = 0;
    this.lostTrades = 0;
    this.currentRound = 0;
  }
}

window.MultiBotManager = MultiBotManager;
