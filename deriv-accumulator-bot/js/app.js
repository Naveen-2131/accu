/**
 * Main Application Controller - Deriv Accumulator Trading Bot
 */

import { DerivWSClient } from './services/derivWS.js';
import { AccumulatorBotEngine } from './engine/accumulatorBot.js';
import { AccumulatorChart } from './components/chart.js';

class App {
  constructor() {
    // Services
    this.wsClient = new DerivWSClient();
    this.activeClient = this.wsClient;

    // Bot Engine & Chart
    this.botEngine = new AccumulatorBotEngine(this.activeClient);
    this.chart = null;

    // Tick History tracking
    this.tickHistory = [];

    // Load Saved Credentials
    this.loadSavedCredentials();
  }

  init() {
    // Initialize Canvas Chart
    this.chart = new AccumulatorChart('tickCanvas');

    // Bind DOM Event Listeners
    this.bindDOMEvents();

    // Bind Engine & Client Listeners
    this.bindEngineEvents();

    // Initial UI State Sync
    this.syncUIConfig();

    // Auto connect if credentials exist
    if (this.wsClient.apiToken && this.wsClient.apiToken.length > 5) {
      this.wsClient.connect().catch(() => {});
    } else {
      this.log('info', 'Please click "API KEYS" at top right to enter your Deriv API Token.');
      setTimeout(() => {
        const modal = document.getElementById('apiModal');
        if (modal) modal.classList.add('active');
      }, 500);
    }
  }

  loadSavedCredentials() {
    const defaultAppId = '1089';

    let savedAppId = localStorage.getItem('deriv_app_id');
    if (!savedAppId || savedAppId.trim().length === 0 || savedAppId.includes('345cWwq')) {
      savedAppId = defaultAppId;
      localStorage.setItem('deriv_app_id', savedAppId);
    }

    let savedToken = localStorage.getItem('deriv_api_token') || '';
    if (savedToken.includes('pat_48d08b') || savedToken.includes('90b1eef3')) {
      savedToken = '';
      localStorage.removeItem('deriv_api_token');
    }

    this.wsClient.setCredentials(savedAppId, savedToken);

    // Populate Modal Inputs
    const appIdInput = document.getElementById('inputAppId');
    const tokenInput = document.getElementById('inputApiToken');
    if (appIdInput) appIdInput.value = savedAppId;
    if (tokenInput) tokenInput.value = savedToken;
  }

  bindDOMEvents() {

    // API Modal Controls
    document.getElementById('btnOpenApiModal').addEventListener('click', () => {
      document.getElementById('apiModal').classList.add('active');
    });
    document.getElementById('btnCloseApiModal').addEventListener('click', () => {
      document.getElementById('apiModal').classList.remove('active');
    });
    document.getElementById('btnSaveApiCredentials').addEventListener('click', () => {
      const appId = document.getElementById('inputAppId').value.trim() || '1089';
      const token = document.getElementById('inputApiToken').value.trim();
      
      if (!token || token.length === 0) {
        this.log('error', 'API Token cannot be empty. Get your token from app.deriv.com -> Account Settings -> API Token.');
        return;
      }

      localStorage.setItem('deriv_app_id', appId);
      localStorage.setItem('deriv_api_token', token);
      this.wsClient.setCredentials(appId, token);

      document.getElementById('apiModal').classList.remove('active');
      this.log('success', `API credentials saved. Connecting to Deriv...`);

      this.wsClient.connect().catch(err => {
        this.log('error', `Connection failed: ${err.message}`);
      });
    });

    // Strategy Parameters Input Controls
    const symbolSelect = document.getElementById('selectSymbol');
    symbolSelect.addEventListener('change', (e) => {
      this.botEngine.updateConfig({ symbol: e.target.value });
      this.activeClient.subscribeTicks(e.target.value);
    });

    // Growth Rate Options Buttons (1% - 5%)
    document.querySelectorAll('.growth-option').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.growth-option').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        const rate = parseFloat(e.target.getAttribute('data-rate'));
        this.botEngine.updateConfig({ growthRate: rate });
      });
    });

    // Numeric Inputs helper
    const bindNumericInput = (id, key, isFloat = true) => {
      const input = document.getElementById(id);
      if (input) {
        input.addEventListener('change', (e) => {
          const val = isFloat ? parseFloat(e.target.value) : parseInt(e.target.value, 10);
          this.botEngine.updateConfig({ [key]: val });
        });
      }
    };

    bindNumericInput('inputBaseStake', 'baseStake', true);
    bindNumericInput('inputTargetTicks', 'targetTicks', false);
    bindNumericInput('inputGlobalTP', 'globalTakeProfit', true);
    bindNumericInput('inputGlobalSL', 'globalStopLoss', true);
    bindNumericInput('inputMaxCycles', 'maxCycles', false);

    // Bot Control Buttons
    const startBtn = document.getElementById('btnStartBot');
    const stopBtn = document.getElementById('btnStopBot');
    const emergencyBtn = document.getElementById('btnEmergencyCashout');

    startBtn.addEventListener('click', () => {
      this.syncUIConfig();
      if (!this.wsClient.isConnected || !this.wsClient.isAuthorized) {
        if (!this.wsClient.apiToken) {
          this.log('error', 'No API Token configured. Click API KEYS at top right to enter your token.');
          document.getElementById('apiModal').classList.add('active');
          return;
        }
        this.log('info', 'Connecting to Deriv WebSocket before starting trade...');
        this.wsClient.connect().then(() => {
          this.botEngine.start();
        }).catch(err => {
          this.log('error', `Connection failed: ${err.message}`);
        });
        return;
      }
      this.botEngine.start();
    });

    stopBtn.addEventListener('click', () => {
      this.botEngine.stop('User Action');
    });

    emergencyBtn.addEventListener('click', () => {
      this.botEngine.emergencyCashout();
    });

    // Export CSV
    document.getElementById('btnExportCsv').addEventListener('click', () => this.exportTradeHistoryCSV());
  }

  syncUIConfig() {
    const config = {
      symbol: document.getElementById('selectSymbol').value,
      growthRate: parseFloat(document.querySelector('.growth-option.active').getAttribute('data-rate')),
      baseStake: parseFloat(document.getElementById('inputBaseStake').value) || 10,
      targetTicks: parseInt(document.getElementById('inputTargetTicks').value, 10) || 10,
      globalTakeProfit: parseFloat(document.getElementById('inputGlobalTP').value) || 0,
      globalStopLoss: parseFloat(document.getElementById('inputGlobalSL').value) || 0,
      maxCycles: parseInt(document.getElementById('inputMaxCycles').value, 10) || 0
    };
    this.botEngine.updateConfig(config);
  }

  bindEngineEvents() {
    // WS Client events
    this.wsClient.on('connectionChange', ({ isConnected }) => {
      const dot = document.getElementById('statusDot');
      const statusText = document.getElementById('statusText');
      dot.className = isConnected ? 'status-dot connected' : 'status-dot';
      statusText.innerText = isConnected ? (this.wsClient.isAuthorized ? 'CONNECTED (AUTHORIZED)' : 'CONNECTED') : 'DISCONNECTED';
    });

    this.wsClient.on('balanceUpdate', ({ balance, currency }) => {
      document.getElementById('userBalance').innerText = `${currency} ${balance.toFixed(2)}`;
    });

    this.wsClient.on('tick', (tick) => {
      document.getElementById('spotPriceDisplay').innerText = tick.quote.toFixed(2);
      if (this.chart) this.chart.addTick(tick);
    });

    this.wsClient.on('log', ({ type, message }) => this.log(type, message));

    // Listen for proposal updates to capture tick history
    this.wsClient.on('proposal', (proposal) => {
      if (proposal && proposal.contract_details && proposal.contract_details.ticks_stayed_in) {
        this.updateTickHistory(proposal.contract_details.ticks_stayed_in);
      }
    });

    this.wsClient.on('apiError', (err) => {
      if (err.code === 'InvalidToken') {
        this.log('warning', '💡 Invalid API Token: Please update your API Token in API KEYS settings.');
      }
    });

    // Bot Engine Events
    this.botEngine.on('stateChange', ({ state, isRunning }) => {
      const startBtn = document.getElementById('btnStartBot');
      const stopBtn = document.getElementById('btnStopBot');
      const stateBadge = document.getElementById('botStateBadge');

      startBtn.style.display = isRunning ? 'none' : 'inline-flex';
      stopBtn.style.display = isRunning ? 'inline-flex' : 'none';
      stateBadge.innerText = state;
      stateBadge.className = isRunning ? 'brand-tag pulse-emerald' : 'brand-tag';
    });

    this.botEngine.on('contractUpdate', (poc) => {
      if (this.chart) this.chart.updateActiveContract(poc);
      this.renderActiveContractCard(poc);
    });

    this.botEngine.on('statsUpdate', (stats) => {
      this.renderStatsSummary(stats);
      this.renderTradeTable(stats.tradeHistory);
    });

    this.botEngine.on('log', ({ type, message }) => this.log(type, message));
  }

  renderActiveContractCard(poc) {
    const card = document.getElementById('activeContractCard');
    if (!poc || poc.status !== 'open') {
      card.style.display = 'none';
      return;
    }

    card.style.display = 'flex';
    document.getElementById('acContractId').innerText = `#${String(poc.contract_id || '').slice(-6)}`;
    
    const targetTicks = this.botEngine.config.targetTicks || 10;
    const currentTicks = poc.tick_passed !== undefined ? poc.tick_passed : (poc.tick_count || 0);
    const pct = Math.min(100, (currentTicks / targetTicks) * 100);

    document.getElementById('acTicksProgress').style.width = `${pct}%`;
    document.getElementById('acTickCount').innerText = `${currentTicks} / ${targetTicks}`;
    document.getElementById('acEntrySpot').innerText = parseFloat(poc.entry_spot || 0).toFixed(2);
    document.getElementById('acCurrentSpot').innerText = parseFloat(poc.current_spot || 0).toFixed(2);

    const profit = parseFloat(poc.profit || 0);
    const profitEl = document.getElementById('acProfitValue');
    profitEl.innerText = `${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`;
    profitEl.className = profit >= 0 ? 'stat-val val-profit' : 'stat-val val-loss';
  }

  renderStatsSummary(stats) {
    document.getElementById('statTotalTrades').innerText = stats.totalTrades;
    
    const winRate = stats.totalTrades > 0 ? ((stats.totalWin || stats.wins || 0) / stats.totalTrades * 100).toFixed(1) : '0.0';
    document.getElementById('statWinRate').innerText = `${winRate}%`;

    const cycles = this.botEngine.cyclesCompleted || 0;
    const maxCycles = this.botEngine.config.maxCycles || 0;
    document.getElementById('statCycles').innerText = maxCycles > 0 ? `${cycles} / ${maxCycles}` : `${cycles}`;

    const pnlEl = document.getElementById('statTotalPnL');
    pnlEl.innerText = `${stats.totalPnL >= 0 ? '+' : ''}$${stats.totalPnL.toFixed(2)}`;
    pnlEl.className = stats.totalPnL >= 0 ? 'stat-box-value val-profit' : 'stat-box-value val-loss';

    document.getElementById('statWinStreak').innerText = `${stats.currentWinStreak} (Max ${stats.maxWinStreak})`;
  }

  renderTradeTable(history) {
    const tbody = document.getElementById('tradeTableBody');
    if (!tbody) return;

    tbody.innerHTML = history.slice(0, 15).map(item => `
      <tr>
        <td>${item.time}</td>
        <td>${item.symbol}</td>
        <td>$${parseFloat(item.stake).toFixed(2)}</td>
        <td>${item.ticks} Ticks</td>
        <td class="${item.profit >= 0 ? 'val-profit' : 'val-loss'}">
          ${item.profit >= 0 ? '+' : ''}$${parseFloat(item.profit).toFixed(2)}
        </td>
        <td>
          <span class="${item.status === 'WIN' ? 'contract-badge' : 'contract-badge loss'}" style="${item.status === 'LOSS' ? 'background:rgba(244,63,94,0.2);color:#fca5a5;border-color:rgba(244,63,94,0.4);' : ''}">
            ${item.status}
          </span>
        </td>
      </tr>
    `).join('');
  }

  exportTradeHistoryCSV() {
    const history = this.botEngine.stats.tradeHistory;
    if (history.length === 0) {
      this.log('warning', 'No trade history available to export.');
      return;
    }

    const headers = ['Contract ID', 'Time', 'Symbol', 'Stake ($)', 'Ticks Survived', 'Profit/Loss ($)', 'Status'];
    const rows = history.map(h => [h.id, h.time, h.symbol, h.stake, h.ticks, h.profit, h.status]);

    const csvContent = 'data:text/csv;charset=utf-8,' 
      + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `deriv_accumulator_trades_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    this.log('success', 'Trade history exported to CSV.');
  }

  /**
   * Update the tick history grid from the proposal stream's ticks_stayed_in array
   */
  updateTickHistory(ticksStayedIn) {
    if (!ticksStayedIn || !Array.isArray(ticksStayedIn)) return;
    this.tickHistory = ticksStayedIn;
    this.renderTickHistory();
  }

  /**
   * Render the tick history grid in the UI
   */
  renderTickHistory() {
    const grid = document.getElementById('tickHistoryGrid');
    if (!grid) return;

    const ticks = this.tickHistory;
    if (ticks.length === 0) {
      grid.innerHTML = '<span style="color:var(--text-dim); font-size:0.8rem;">Waiting for data...</span>';
      return;
    }

    // Show last 100 ticks (10 rows x 10 cols)
    const displayTicks = ticks.slice(-100);

    grid.innerHTML = displayTicks.map(t => {
      let colorClass = '';
      if (t <= 5) colorClass = 'tick-cell-red';
      else if (t <= 20) colorClass = 'tick-cell-orange';
      else if (t <= 50) colorClass = 'tick-cell-yellow';
      else colorClass = 'tick-cell-green';
      return `<div class="tick-cell ${colorClass}">${t}</div>`;
    }).join('');
  }

  log(type, message) {
    const logContainer = document.getElementById('logContainer');
    if (!logContainer) return;

    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    const time = new Date().toLocaleTimeString();
    entry.innerHTML = `<span class="log-time">[${time}]</span> <span class="log-msg">${message}</span>`;

    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;
  }
}

// Instantiate and start app on DOM content loaded
document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
  window.app.init();
});
