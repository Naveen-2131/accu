/**
 * DEDICATED MAX TICKS WATCHER v3.1 (Multi-Bot Synchronized Edition)
 *
 * Designed for 1 to 27 Simultaneous Bots:
 * 1. PUSH-FIRST: Listens to Deriv WebSocket 'contractUpdate' push events (0ms latency, 0 API calls).
 * 2. SAFE BACKUP POLL: Polls Deriv every 800ms as a safety heartbeat (no WebSocket flood).
 * 3. CENTRALIZED SELL QUEUE: Uses client.sellContract() with FIFO rate-limited spacing (400ms).
 *    NEVER sends concurrent raw sell calls, completely eliminating "Rate limit for sell" errors!
 * 4. ACCURATE TICKS: Uses tick_passed + tick_stream + math formula (NEVER tick_count).
 */
class DedicatedMaxTicksWatcher {
  constructor(client, symbol) {
    this.client = client;
    this.symbol = symbol || 'R_100';

    // Per-watch state
    this.contractId     = null;
    this.targetMaxTicks = 0;
    this.stake          = 1.0;
    this.growthRate     = 0.02;

    this.isWatching     = false;
    this.isSelling      = false;
    this.hasEnded       = false;
    this.currentTicks   = 0;
    this.currentProfit  = 0;

    this._timer         = null;
    this._isPolling     = false;
    this._updateHandler = null;
    this.callbacks      = {};
  }

  /* ── Start watching a contract ── */
  startWatch({ contractId, maxTicks, stake, growthRate, onTick, onCut, onEnded }) {
    this.stopWatch();

    this.contractId      = contractId;
    this.targetMaxTicks  = parseInt(maxTicks,  10) || 0;
    this.stake           = parseFloat(stake)       || 1.0;
    this.growthRate      = parseFloat(growthRate)  || 0.02;
    this.callbacks       = { onTick, onCut, onEnded };

    this.isWatching   = true;
    this.isSelling    = false;
    this.hasEnded     = false;
    this.currentTicks = 0;
    this.currentProfit= 0;
    this._isPolling   = false;
    this._lastSpot    = null;
    this._spotUpdateCount = 0;

    console.log(`[Watcher-${this.symbol}] START #${contractId} maxTicks=${this.targetMaxTicks}`);

    // 1. Instant Push Event Listener (0ms latency, 0 API overhead)
    this._updateHandler = (data) => {
      if (!this.isWatching || this.hasEnded) return;
      if (!data) return;
      if (String(data.contract_id) !== String(this.contractId)) return;
      this._processContract(data);
    };
    this.client.on('contractUpdate', this._updateHandler);

    // 2. Safety Heartbeat Poll every 800ms (keeps connection alive without flooding Deriv API)
    this._timer = setInterval(() => this._poll(), 800);

    // Initial check from local cache or immediate poll
    const cached = this.client.openContractsCache.get(String(contractId)) ||
                   this.client.openContractsCache.get(parseInt(contractId, 10));
    if (cached) {
      this._processContract(cached);
    } else {
      this._poll();
    }
  }

  /* ── Process incoming contract state (Push or Poll) ── */
  _processContract(poc) {
    if (!this.isWatching || this.hasEnded) return;

    const profit  = parseFloat(poc.profit ?? 0);
    const isSold  = Boolean(poc.is_sold || poc.status === 'sold');
    const isLost  = Boolean(poc.status === 'lost');
    const spot    = poc.current_spot || poc.spot || null;

    // ── Calculate actual accumulated ticks ──
    let ticks = 0;

    // 1. tick_passed from Deriv
    if (poc.tick_passed != null) ticks = Math.max(ticks, parseInt(poc.tick_passed, 10) || 0);
    if (poc.computed_ticks != null) ticks = Math.max(ticks, parseInt(poc.computed_ticks, 10) || 0);

    // 2. tick_stream array length - 1 (entry spot is index 0)
    if (Array.isArray(poc.tick_stream) && poc.tick_stream.length > 1) {
      ticks = Math.max(ticks, poc.tick_stream.length - 1);
    }

    // 3. Mathematical formula: n = round(ln((p+s)/s) / ln(1+g))
    const g = parseFloat(poc.growth_rate || this.growthRate || 0.02);
    const s = parseFloat(poc.buy_price   || poc.stake || this.stake || 1.0);
    if (profit > 0 && s > 0 && g > 0) {
      const ratio = (profit + s) / s;
      if (ratio > 1.0) {
        const mathN = Math.round(Math.log(ratio) / Math.log(1 + g));
        if (mathN > ticks) ticks = mathN;
      }
    }

    // 4. Spot change tracker for Multipliers & Non-ACCU contracts
    if (spot != null && spot !== this._lastSpot) {
      this._lastSpot = spot;
      this._spotUpdateCount = (this._spotUpdateCount || 0) + 1;
      if (this._spotUpdateCount > 1) {
        ticks = Math.max(ticks, this._spotUpdateCount - 1);
      }
    }

    // Never go backwards
    if (ticks > this.currentTicks) this.currentTicks = ticks;
    this.currentProfit = profit;

    // Notify UI of live tick
    if (this.callbacks.onTick) {
      try {
        this.callbacks.onTick({
          contractId: this.contractId,
          symbol: this.symbol,
          ticks: this.currentTicks,
          profit,
          spot,
          targetMaxTicks: this.targetMaxTicks
        });
      } catch (_) {}
    }

    // Contract already closed by Deriv
    if (isSold || isLost) {
      this._finish(profit, isLost);
      return;
    }

    // ── Max Ticks Target Achieved → SELL NOW! ──
    if (this.targetMaxTicks > 0 && this.currentTicks >= this.targetMaxTicks && !this.isSelling) {
      // Ensure we are past entry tick (tick >= 1 or profit > 0)
      if (this.currentTicks >= 1 || profit > 0) {
        this._doSell(`MaxTicks ${this.currentTicks}/${this.targetMaxTicks}`);
      }
    }
  }

  /* ── Core poll: fallback query ── */
  async _poll() {
    if (!this.isWatching || this.hasEnded || this.isSelling) return;
    if (!this.client.isConnected || !this.contractId) return;
    if (this._isPolling) return; // Prevent duplicate in-flight requests

    this._isPolling = true;
    try {
      const res = await this.client.send({
        proposal_open_contract: 1,
        contract_id: parseInt(this.contractId, 10)
      });
      if (res && res.proposal_open_contract) {
        this._processContract(res.proposal_open_contract);
      }
    } catch (_) {
      // Transient socket error, push or next poll will catch
    } finally {
      this._isPolling = false;
    }
  }

  /* ── Trigger Sell via Centralized Rate-Limited Queue ── */
  async _doSell(reason) {
    if (this.isSelling || this.hasEnded) return;
    this.isSelling = true;

    console.log(`[Watcher-${this.symbol}] ⚡ SELL REQUESTED: ${reason} (#${this.contractId})`);

    if (this.callbacks.onCut) {
      try {
        this.callbacks.onCut({
          contractId: this.contractId,
          symbol: this.symbol,
          ticks: this.currentTicks,
          profit: this.currentProfit,
          reason
        });
      } catch (_) {}
    }

    // Clear heartbeat timer
    if (this._timer) { clearInterval(this._timer); this._timer = null; }

    try {
      // 🚀 CRITICAL FIX: Route through client.sellContract()!
      // This queues the sell through the central FIFO throttler (400ms interval),
      // ensuring multiple bots NEVER hit Deriv's simultaneous sell rate limit!
      const res = await this.client.sellContract(this.contractId);

      if (res && res.sell) {
        const soldFor = parseFloat(res.sell.sold_for || 0);
        const profit  = soldFor > 0 ? (soldFor - this.stake) : this.currentProfit;
        console.log(`[Watcher-${this.symbol}] ✅ SOLD #${this.contractId} for ${soldFor} (profit≈${profit.toFixed(4)})`);
        this._finish(profit, false);
        return;
      }
    } catch (err) {
      const msg = String(err?.message || err || '');
      if (msg.includes('already') || msg.includes('expired') || msg.includes('not found')) {
        this._finish(this.currentProfit, false);
        return;
      }
      console.warn(`[Watcher-${this.symbol}] sellContract warning: ${msg}`);
    }

    // Final check if contract was closed by Deriv's Take Profit
    try {
      const res2 = await this.client.send({
        proposal_open_contract: 1,
        contract_id: parseInt(this.contractId, 10)
      });
      if (res2?.proposal_open_contract) {
        const poc2 = res2.proposal_open_contract;
        if (poc2.is_sold || poc2.status === 'sold' || poc2.status === 'lost') {
          const p2   = parseFloat(poc2.profit ?? this.currentProfit);
          const loss = poc2.status === 'lost';
          this._finish(p2, loss);
          return;
        }
      }
    } catch (_) {}

    // If sell failed (e.g. rate limit), DO NOT finish with open contract!
    // Keep monitoring; Deriv take_profit will close it, or retry sell after 1500ms
    if (!this.hasEnded) {
      this.isSelling = false;
      if (!this._timer && this.isWatching) {
        this._timer = setInterval(() => this._poll(), 800);
      }
      setTimeout(() => {
        if (!this.hasEnded && !this.isSelling && this.isWatching) {
          this._doSell(`Retry Sell #${this.contractId}`);
        }
      }, 1500);
    }
  }

  /* ── External trigger cut alias ── */
  triggerCut(reason = 'Manual Cut') {
    return this._doSell(reason);
  }

  /* ── Fire onEnded callback ── */
  _finish(profit, isLoss) {
    if (this.hasEnded) return;
    this.hasEnded = true;
    this.stopWatch();
    if (this.callbacks.onEnded) {
      try {
        this.callbacks.onEnded({
          contractId: this.contractId,
          symbol: this.symbol,
          ticks: this.currentTicks,
          profit,
          isLoss,
          result: isLoss ? 'lost' : 'won'
        });
      } catch (_) {}
    }
  }

  /* ── Stop all timers / listeners ── */
  stopWatch() {
    this.isWatching = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._updateHandler) {
      this.client.off('contractUpdate', this._updateHandler);
      this._updateHandler = null;
    }
  }
}

window.DedicatedMaxTicksWatcher = DedicatedMaxTicksWatcher;
