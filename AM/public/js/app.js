/**
 * Accumulator Multi-Bot — Complete 24-Symbol Wave Engine
 * Supports all 24 Volatility, Volatility 1s, Crash, and Boom Symbols from Deriv
 */

let client = null;
let manager = null;
let isConnected = false;

// ── Complete 24 Symbols from User Screenshots ─────────────────
const ALL_SYMBOLS = [
  // ── Volatility Indices (5) ──
  { v: 'R_10',       l: 'Volatility 10 Index (ACCU)',       group: 'Volatility' },
  { v: 'R_25',       l: 'Volatility 25 Index (ACCU)',       group: 'Volatility' },
  { v: 'R_50',       l: 'Volatility 50 Index (ACCU)',       group: 'Volatility' },
  { v: 'R_75',       l: 'Volatility 75 Index (ACCU)',       group: 'Volatility' },
  { v: 'R_100',      l: 'Volatility 100 Index (ACCU)',      group: 'Volatility' },

  // ── Volatility (1s) Indices (8) ──
  { v: '1HZ10V',     l: 'Volatility 10 (1s) Index (ACCU)',  group: 'Volatility 1s' },
  { v: '1HZ15V',     l: 'Volatility 15 (1s) Index (ACCU)',  group: 'Volatility 1s' },
  { v: '1HZ25V',     l: 'Volatility 25 (1s) Index (ACCU)',  group: 'Volatility 1s' },
  { v: '1HZ30V',     l: 'Volatility 30 (1s) Index (ACCU)',  group: 'Volatility 1s' },
  { v: '1HZ50V',     l: 'Volatility 50 (1s) Index (ACCU)',  group: 'Volatility 1s' },
  { v: '1HZ75V',     l: 'Volatility 75 (1s) Index (ACCU)',  group: 'Volatility 1s' },
  { v: '1HZ90V',     l: 'Volatility 90 (1s) Index (ACCU)',  group: 'Volatility 1s' },
  { v: '1HZ100V',    l: 'Volatility 100 (1s) Index (ACCU)', group: 'Volatility 1s' },

  // ── Crash Indices (7) ──
  { v: 'CRASH50',    l: 'Crash 50 Index',            group: 'Crash' },
  { v: 'CRASH150N',  l: 'Crash 150 Index',           group: 'Crash' },
  { v: 'CRASH300N',  l: 'Crash 300 Index',           group: 'Crash' },
  { v: 'CRASH500',   l: 'Crash 500 Index',           group: 'Crash' },
  { v: 'CRASH600',   l: 'Crash 600 Index',           group: 'Crash' },
  { v: 'CRASH900',   l: 'Crash 900 Index',           group: 'Crash' },
  { v: 'CRASH1000',  l: 'Crash 1000 Index',          group: 'Crash' },

  // ── Boom Indices (7) ──
  { v: 'BOOM50',     l: 'Boom 50 Index',             group: 'Boom' },
  { v: 'BOOM150N',   l: 'Boom 150 Index',            group: 'Boom' },
  { v: 'BOOM300N',   l: 'Boom 300 Index',            group: 'Boom' },
  { v: 'BOOM500',    l: 'Boom 500 Index',            group: 'Boom' },
  { v: 'BOOM600',    l: 'Boom 600 Index',            group: 'Boom' },
  { v: 'BOOM900',    l: 'Boom 900 Index',            group: 'Boom' },
  { v: 'BOOM1000',   l: 'Boom 1000 Index',           group: 'Boom' },
];

// Pre-fill all 24 slots (First 12 enabled by default)
const DEFAULT_SLOTS = ALL_SYMBOLS.map((s, idx) => ({
  symbol: s.v,
  label: s.l,
  group: s.group,
  enabled: idx < 12 // Top 12 enabled by default
}));

// Per-slot session stats
const slotStats = {};
DEFAULT_SLOTS.forEach((_, idx) => { slotStats[idx] = { session: 0, trades: 0 }; });

// ── DOM Ready ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  client  = new DerivBrowserClient();
  manager = new MultiBotManager(client);

  setupClientEvents();
  setupManagerEvents();
  renderSlots();
  setupGlobalUI();
  setupMobileUI();
  loadSavedSettings();

  addLog('info', '🤖 24-Symbol Accumulator Wave Engine Ready.');
});

// ── Build grouped symbol options ──────────────────────────────
function buildSymbolOptions(selectedSymbol) {
  const groups = {
    'Volatility': '── Volatility Indices (5) ──',
    'Volatility 1s': '── Volatility 1s Indices (8) ──',
    'Crash': '── Crash Indices (7) ──',
    'Boom': '── Boom Indices (7) ──'
  };

  let html = '';
  for (const [grpKey, grpLabel] of Object.entries(groups)) {
    html += `<optgroup label="${grpLabel}">`;
    ALL_SYMBOLS.filter(s => s.group === grpKey).forEach(s => {
      html += `<option value="${s.v}" ${s.v === selectedSymbol ? 'selected' : ''}>${s.l}</option>`;
    });
    html += `</optgroup>`;
  }
  return html;
}

// ── Render 24 symbol slot cards ───────────────────────────────
function renderSlots() {
  const grid = document.getElementById('slotsGrid');
  grid.innerHTML = '';

  DEFAULT_SLOTS.forEach((slot, idx) => {
    const card = document.createElement('div');
    card.className = 'slot-card' + (slot.enabled ? ' slot-enabled' : '');
    card.id = `slot_${idx}`;
    card.innerHTML = buildSlotHTML(slot, idx);
    grid.appendChild(card);
  });

  DEFAULT_SLOTS.forEach((_, idx) => attachSlotEvents(idx));
  updateSlotCountBadge();
}

function buildSlotHTML(slot, idx) {
  const symbolOptions = buildSymbolOptions(slot.symbol);

  return `
    <div class="slot-header">
      <label class="slot-toggle-wrap">
        <input type="checkbox" class="slot-enable" data-idx="${idx}" ${slot.enabled ? 'checked' : ''} />
        <span class="slot-label" id="slotLabel_${idx}">#${idx+1} ${slot.label}</span>
      </label>
      <span class="slot-status-badge idle" id="slotBadge_${idx}">⚪ Idle</span>
    </div>

    <div class="slot-body" id="slotBody_${idx}" style="${slot.enabled ? '' : 'display:none'}">
      <div class="slot-form">
        <div class="sf-row">
          <label>Symbol</label>
          <select class="slot-symbol" data-idx="${idx}">${symbolOptions}</select>
        </div>
        <div class="sf-row sf-2col">
          <div>
            <label>Growth Rate</label>
            <select class="slot-growth" data-idx="${idx}">
              <option value="0.01">1%</option>
              <option value="0.02" selected>2%</option>
              <option value="0.03">3%</option>
              <option value="0.04">4%</option>
              <option value="0.05">5%</option>
            </select>
          </div>
          <div>
            <label>Stake ($)</label>
            <input type="number" class="slot-stake" data-idx="${idx}" value="1.00" min="0.35" step="0.01" />
          </div>
        </div>
        <div class="sf-row sf-3col">
          <div>
            <label>TP ($) <span class="dim">0=off</span></label>
            <input type="number" class="slot-tp" data-idx="${idx}" value="0" min="0" step="0.01" />
          </div>
          <div>
            <label>SL ($) <span class="dim">0=off</span></label>
            <input type="number" class="slot-sl" data-idx="${idx}" value="0" min="0" step="0.01" />
          </div>
          <div>
            <label>Max Ticks <span class="dim">0=off</span></label>
            <input type="number" class="slot-maxticks" data-idx="${idx}" value="5" min="0" step="1" />
          </div>
        </div>
        <div class="sf-row sf-2col">
          <div>
            <label>Martingale x</label>
            <input type="number" class="slot-mg" data-idx="${idx}" value="1" min="1" step="0.1" title="1 = disabled" />
          </div>
          <div>
            <label>Max MG Steps</label>
            <input type="number" class="slot-mgsteps" data-idx="${idx}" value="3" min="1" step="1" />
          </div>
        </div>
      </div>

      <!-- Dedicated Max Ticks Progress Bar & Target Display -->
      <div class="slot-progress-wrap" id="slotProgressWrap_${idx}" style="display:none">
        <div class="slot-progress-header">
          <span class="slot-progress-label" id="slotProgressText_${idx}">🎯 Ticks: 0 / 5</span>
          <span class="slot-cut-badge" id="slotCutBadge_${idx}" style="display:none">⚡ CUTTING</span>
        </div>
        <div class="slot-progress-bar-bg">
          <div class="slot-progress-bar-fill" id="slotProgressBar_${idx}" style="width:0%"></div>
        </div>
      </div>

      <!-- Live stats for this slot -->
      <div class="slot-live" id="slotLive_${idx}" style="display:none">
        <div class="slot-live-row">
          <span class="sl-item"><span class="sl-label">Ticks</span><span class="sl-val" id="slotTicks_${idx}">0</span></span>
          <span class="sl-item"><span class="sl-label">Live P&L</span><span class="sl-val profit-neutral" id="slotProfit_${idx}">0.00</span></span>
          <span class="sl-item"><span class="sl-label">Trades</span><span class="sl-val" id="slotTrades_${idx}">0</span></span>
          <span class="sl-item"><span class="sl-label">Session</span><span class="sl-val profit-neutral" id="slotSession_${idx}">0.00</span></span>
        </div>
      </div>

      <!-- Slot buttons -->
      <div class="slot-buttons">
        <button class="sbtn sbtn-start" data-idx="${idx}" id="slotBtnStart_${idx}" disabled>▶ Start</button>
        <button class="sbtn sbtn-cashout" data-idx="${idx}" id="slotBtnCashout_${idx}" disabled>💸 Cashout</button>
      </div>
    </div>
  `;
}

function attachSlotEvents(idx) {
  const chk = document.querySelector(`.slot-enable[data-idx="${idx}"]`);
  chk.addEventListener('change', () => {
    DEFAULT_SLOTS[idx].enabled = chk.checked;
    const body = document.getElementById(`slotBody_${idx}`);
    const card = document.getElementById(`slot_${idx}`);
    body.style.display = chk.checked ? '' : 'none';
    card.classList.toggle('slot-enabled', chk.checked);
    updateSlotLabel(idx);
    updateSlotCountBadge();
  });

  const symSel = document.querySelector(`.slot-symbol[data-idx="${idx}"]`);
  symSel.addEventListener('change', () => updateSlotLabel(idx));

  document.getElementById(`slotBtnStart_${idx}`).addEventListener('click', async () => {
    const sym = getSlotSymbol(idx);
    const bot = manager.bots[sym];
    if (bot && bot.isRunning) {
      await manager.stopBot(sym);
    } else {
      await startSlot(idx);
    }
  });

  document.getElementById(`slotBtnCashout_${idx}`).addEventListener('click', async () => {
    await manager.cashoutBot(getSlotSymbol(idx));
  });
}

function updateSlotCountBadge() {
  const enabledCount = DEFAULT_SLOTS.filter(s => s.enabled).length;
  const badge = document.getElementById('activeSlotsBadge');
  if (badge) badge.textContent = `${enabledCount} of ${DEFAULT_SLOTS.length} Enabled`;
}

function updateSlotLabel(idx) {
  const sym = getSlotSymbol(idx);
  const found = ALL_SYMBOLS.find(s => s.v === sym);
  const label = found ? found.l : sym;
  document.getElementById(`slotLabel_${idx}`).textContent = `#${idx+1} ${label}`;
  DEFAULT_SLOTS[idx].symbol = sym;
  DEFAULT_SLOTS[idx].label = label;
}

function getSlotSymbol(idx) {
  const sel = document.querySelector(`.slot-symbol[data-idx="${idx}"]`);
  return sel ? sel.value : DEFAULT_SLOTS[idx].symbol;
}

function getSlotConfig(idx) {
  const growth = parseFloat(document.querySelector(`.slot-growth[data-idx="${idx}"]`)?.value || 0.02);
  const stake  = parseFloat(document.querySelector(`.slot-stake[data-idx="${idx}"]`)?.value  || 1.0);
  const tp     = parseFloat(document.querySelector(`.slot-tp[data-idx="${idx}"]`)?.value     || 0);
  const sl     = parseFloat(document.querySelector(`.slot-sl[data-idx="${idx}"]`)?.value     || 0);
  const maxT   = parseInt(document.querySelector(`.slot-maxticks[data-idx="${idx}"]`)?.value  || 5);
  const mg     = parseFloat(document.querySelector(`.slot-mg[data-idx="${idx}"]`)?.value     || 1);
  const mgSteps= parseInt(document.querySelector(`.slot-mgsteps[data-idx="${idx}"]`)?.value  || 3);

  return {
    symbol: getSlotSymbol(idx),
    growthRate: growth,
    stake,
    takeProfitPerTrade: tp,
    stopLossPerTrade: sl,
    maxTicks: maxT,
    martingale: mg > 1,
    martingaleMultiplier: mg,
    maxMartingaleSteps: mgSteps,
    autoRestart: false,
    delayBetweenTrades: 500
  };
}

async function startSlot(idx) {
  const symbol = getSlotSymbol(idx);
  const config = getSlotConfig(idx);
  await manager.startBot(symbol, config);
}

// ── Preset Selection Helper ───────────────────────────────────
function applySlotPreset(filterFn) {
  DEFAULT_SLOTS.forEach((slot, idx) => {
    const shouldEnable = filterFn(slot, idx);
    slot.enabled = shouldEnable;
    const chk = document.querySelector(`.slot-enable[data-idx="${idx}"]`);
    if (chk) chk.checked = shouldEnable;
    const body = document.getElementById(`slotBody_${idx}`);
    if (body) body.style.display = shouldEnable ? '' : 'none';
    const card = document.getElementById(`slot_${idx}`);
    if (card) card.classList.toggle('slot-enabled', shouldEnable);
  });
  updateSlotCountBadge();
}

// ── Local Storage Management (Remember Token on Refresh) ──────
function loadSavedSettings() {
  const savedToken = localStorage.getItem('deriv_api_token') || '';
  const savedAppId = localStorage.getItem('deriv_app_id') || '1089';

  if (savedToken) {
    const tokenInput = document.getElementById('apiToken');
    if (tokenInput) tokenInput.value = savedToken;
  }
  if (savedAppId) {
    const appIdInput = document.getElementById('appId');
    if (appIdInput) appIdInput.value = savedAppId;
  }

  // Restore Quick Settings
  const savedGrowth = localStorage.getItem('deriv_global_growth');
  if (savedGrowth && document.getElementById('globalGrowth')) {
    document.getElementById('globalGrowth').value = savedGrowth;
  }
  const savedStake = localStorage.getItem('deriv_global_stake');
  if (savedStake && document.getElementById('globalStake')) {
    document.getElementById('globalStake').value = savedStake;
  }
  const savedTP = localStorage.getItem('deriv_global_tp');
  if (savedTP && document.getElementById('globalTP')) {
    document.getElementById('globalTP').value = savedTP;
  }
  const savedSL = localStorage.getItem('deriv_global_sl');
  if (savedSL && document.getElementById('globalSL')) {
    document.getElementById('globalSL').value = savedSL;
  }
  const savedMaxTicks = localStorage.getItem('deriv_global_max_ticks');
  if (savedMaxTicks && document.getElementById('globalMaxTicks')) {
    document.getElementById('globalMaxTicks').value = savedMaxTicks;
  }
  const savedRoundDelay = localStorage.getItem('deriv_global_round_delay');
  if (savedRoundDelay && document.getElementById('globalRoundDelay')) {
    document.getElementById('globalRoundDelay').value = savedRoundDelay;
  }
  const savedMG = localStorage.getItem('deriv_global_mg');
  if (savedMG && document.getElementById('globalMG')) {
    document.getElementById('globalMG').value = savedMG;
  }
  const savedExecMode = localStorage.getItem('deriv_execution_mode');
  const savedAutoRepeat = localStorage.getItem('deriv_auto_repeat');
  if (savedAutoRepeat !== null && document.getElementById('autoRepeatWaves')) {
    document.getElementById('autoRepeatWaves').checked = savedAutoRepeat === 'true';
  }
  if (savedExecMode && document.getElementById('executionMode')) {
    document.getElementById('executionMode').value = savedExecMode;
  }
  const savedMaxMGSteps = localStorage.getItem('deriv_global_max_mg_steps');
  if (savedMaxMGSteps && document.getElementById('globalMaxMGSteps')) {
    document.getElementById('globalMaxMGSteps').value = savedMaxMGSteps;
  }

  // Restore Dedicated Volatility (10-100) Quick Settings
  const savedVolGrowth = localStorage.getItem('deriv_vol_growth');
  if (savedVolGrowth && document.getElementById('volGrowth')) {
    document.getElementById('volGrowth').value = savedVolGrowth;
  }
  const savedVolStake = localStorage.getItem('deriv_vol_stake');
  if (savedVolStake && document.getElementById('volStake')) {
    document.getElementById('volStake').value = savedVolStake;
  }
  const savedVolTP = localStorage.getItem('deriv_vol_tp');
  if (savedVolTP && document.getElementById('volTP')) {
    document.getElementById('volTP').value = savedVolTP;
  }
  const savedVolSL = localStorage.getItem('deriv_vol_sl');
  if (savedVolSL && document.getElementById('volSL')) {
    document.getElementById('volSL').value = savedVolSL;
  }
  const savedVolMaxTicks = localStorage.getItem('deriv_vol_max_ticks');
  if (savedVolMaxTicks && document.getElementById('volMaxTicks')) {
    document.getElementById('volMaxTicks').value = savedVolMaxTicks;
  }
  const savedVolMG = localStorage.getItem('deriv_vol_mg');
  if (savedVolMG && document.getElementById('volMG')) {
    document.getElementById('volMG').value = savedVolMG;
  }
  const savedVolMaxMGSteps = localStorage.getItem('deriv_vol_max_mg_steps');
  if (savedVolMaxMGSteps && document.getElementById('volMaxMGSteps')) {
    document.getElementById('volMaxMGSteps').value = savedVolMaxMGSteps;
  }

  // Auto-connect if token is saved so user never has to re-connect manually!
  if (savedToken) {
    addLog('info', '🔑 Saved API Token detected! Auto-connecting to Deriv...');
    setTimeout(() => {
      if (!isConnected) {
        document.getElementById('btnConnect').click();
      }
    }, 300);
  }
}

function saveAPICredentials(token, appId) {
  if (token) localStorage.setItem('deriv_api_token', token);
  if (appId) localStorage.setItem('deriv_app_id', appId);
}

// ── Global UI ─────────────────────────────────────────────────
function setupGlobalUI() {
  document.getElementById('btnConnect').addEventListener('click', async () => {
    if (isConnected) {
      client._manualDisconnect = true;
      client.disconnect();
      return;
    }
    const token = document.getElementById('apiToken').value.trim();
    const appId  = document.getElementById('appId').value.trim() || '1089';
    if (!token) return addLog('error', '❌ API Token required!');

    // Persist credentials in browser localStorage
    saveAPICredentials(token, appId);

    addLog('info', '🔄 Connecting to Deriv...');
    try { await client.connect(appId, token); }
    catch(e) { addLog('error', `Connection failed: ${e.message}`); }
  });

  const autoRepeatChk = document.getElementById('autoRepeatWaves');
  if (autoRepeatChk) {
    autoRepeatChk.addEventListener('change', () => {
      localStorage.setItem('deriv_auto_repeat', autoRepeatChk.checked ? 'true' : 'false');
    });
  }

  const modeSelect = document.getElementById('executionMode');
  if (modeSelect) {
    modeSelect.addEventListener('change', () => {
      const mode = modeSelect.value;
      localStorage.setItem('deriv_execution_mode', mode);
      const descEl = document.getElementById('modeDescription');
      if (descEl) {
        if (mode === 'simultaneous') {
          descEl.innerHTML = '⚡ <b>Simultaneous Mode:</b> All enabled bots buy at the SAME TIME! As soon as each bot hits Max Ticks, it CUTS IMMEDIATELY and locks profit!';
        } else {
          descEl.innerHTML = '🔄 <b>Relay Mode:</b> First bot runs alone -> hits Max Ticks -> closes & takes profit -> then next bot starts automatically -> repeats one-by-one.';
        }
      }
      updateStartAllBtn();
    });
  }

  document.getElementById('btnStartAll').addEventListener('click', async () => {
    if (manager.isAnyRunning()) {
      await manager.stopAll();
    } else {
      const enabled = DEFAULT_SLOTS
        .map((slot, idx) => ({ slot, idx }))
        .filter(({ slot }) => slot.enabled)
        .map(({ idx }) => ({ symbol: getSlotSymbol(idx), config: getSlotConfig(idx) }));

      if (enabled.length === 0) return addLog('warning', '⚠️ No symbol slots enabled!');

      const delaySec = parseFloat(document.getElementById('globalRoundDelay')?.value || 1.0);
      const delayMs = Math.max(300, Math.round(delaySec * 1000));

      const mode = document.getElementById('executionMode')?.value || 'simultaneous';
      if (mode === 'simultaneous') {
        addLog('info', `🚀 Starting Simultaneous Wave for ${enabled.length} Bots! All bots buy at the SAME TIME and cut at Max Ticks!`);
      } else {
        addLog('info', `🚀 Starting Sequential Relay for ${enabled.length} Bots! Each bot runs one by one until Max Ticks, then next starts.`);
      }
      const autoRepeat = Boolean(document.getElementById('autoRepeatWaves')?.checked);
      await manager.startAll(enabled, delayMs, mode, autoRepeat);
    }
  });

  document.getElementById('btnCashoutAll').addEventListener('click', async () => {
    addLog('info', '💸 Cashing out all open contracts across all symbols...');
    await manager.cashoutAll();
  });

  // Preset Buttons
  document.getElementById('btnSelectAllSlots')?.addEventListener('click', () => {
    applySlotPreset(() => true);
    addLog('info', '🌟 All 24 bot slots enabled.');
  });

  document.getElementById('btnSelect12Slots')?.addEventListener('click', () => {
    applySlotPreset((_, idx) => idx < 12);
    addLog('info', '🎯 First 12 bot slots enabled.');
  });

  document.getElementById('btnSelectVolSlots')?.addEventListener('click', () => {
    applySlotPreset((s) => s.group === 'Volatility' || s.group === 'Volatility 1s');
    addLog('info', '📊 All 13 Volatility bots enabled.');
  });

  document.getElementById('btnSelectCrashBoomSlots')?.addEventListener('click', () => {
    applySlotPreset((s) => s.group === 'Crash' || s.group === 'Boom');
    addLog('info', '💥 All 14 Crash & Boom bots enabled.');
  });

  document.getElementById('btnDeselectAllSlots')?.addEventListener('click', () => {
    applySlotPreset(() => false);
    addLog('info', '⚪ All bot slots disabled.');
  });

  document.getElementById('btnClearLog').addEventListener('click', () => {
    document.getElementById('logContainer').innerHTML = '';
  });

  const btnClearHist = document.getElementById('btnClearHistory');
  if (btnClearHist) {
    btnClearHist.addEventListener('click', () => {
      document.getElementById('tradeHistoryBody').innerHTML = '';
      manager.resetStats();
      updateGlobalStats(manager.getGlobalStats());
      DEFAULT_SLOTS.forEach((_, idx) => {
        if (slotStats[idx]) {
          slotStats[idx].session = 0;
          slotStats[idx].trades = 0;
        }
        const sEl = document.getElementById(`slotSession_${idx}`);
        if (sEl) {
          sEl.textContent = '0.00';
          sEl.className = 'sl-val profit-neutral';
        }
        const tEl = document.getElementById(`slotTrades_${idx}`);
        if (tEl) tEl.textContent = '0';
      });
      addLog('info', '🧹 Trade history and session stats cleared.');
    });
  }

  document.getElementById('btnApplyAll').addEventListener('click', () => {
    const growth = document.getElementById('globalGrowth').value;
    const stake  = document.getElementById('globalStake').value;
    const tp     = document.getElementById('globalTP').value;
    const sl     = document.getElementById('globalSL').value;
    const maxT   = document.getElementById('globalMaxTicks').value;
    const mg     = document.getElementById('globalMG')?.value || '1.0';
    const mgSteps= document.getElementById('globalMaxMGSteps')?.value || '3';
    const roundDelay = document.getElementById('globalRoundDelay')?.value || '1.0';

    // Persist quick settings across page refresh
    localStorage.setItem('deriv_global_growth', growth);
    localStorage.setItem('deriv_global_stake', stake);
    localStorage.setItem('deriv_global_tp', tp);
    localStorage.setItem('deriv_global_sl', sl);
    localStorage.setItem('deriv_global_max_ticks', maxT);
    localStorage.setItem('deriv_global_mg', mg);
    localStorage.setItem('deriv_global_max_mg_steps', mgSteps);
    localStorage.setItem('deriv_global_round_delay', roundDelay);

    DEFAULT_SLOTS.forEach((slot, idx) => {
      if (!slot.enabled) return;
      if (growth)  document.querySelector(`.slot-growth[data-idx="${idx}"]`).value = growth;
      if (stake)   document.querySelector(`.slot-stake[data-idx="${idx}"]`).value  = stake;
      if (tp)      document.querySelector(`.slot-tp[data-idx="${idx}"]`).value     = tp;
      if (sl)      document.querySelector(`.slot-sl[data-idx="${idx}"]`).value     = sl;
      if (maxT)    document.querySelector(`.slot-maxticks[data-idx="${idx}"]`).value = maxT;
      if (mg)      document.querySelector(`.slot-mg[data-idx="${idx}"]`).value     = mg;
      if (mgSteps) document.querySelector(`.slot-mgsteps[data-idx="${idx}"]`).value= mgSteps;
    });
    addLog('info', '✅ Global settings (Stake, TP, SL, Max Ticks, Martingale & Max MG Steps) applied & saved!');
  });

  // Dedicated Volatility (10, 25, 50, 75, 100) Quick Config Apply
  document.getElementById('btnApplyVol')?.addEventListener('click', () => {
    const growth = document.getElementById('volGrowth').value;
    const stake  = document.getElementById('volStake').value;
    const tp     = document.getElementById('volTP').value;
    const sl     = document.getElementById('volSL').value;
    const maxT   = document.getElementById('volMaxTicks').value;
    const mg     = document.getElementById('volMG')?.value || '1.0';
    const mgSteps= document.getElementById('volMaxMGSteps')?.value || '3';

    // Persist vol quick settings across page refresh
    localStorage.setItem('deriv_vol_growth', growth);
    localStorage.setItem('deriv_vol_stake', stake);
    localStorage.setItem('deriv_vol_tp', tp);
    localStorage.setItem('deriv_vol_sl', sl);
    localStorage.setItem('deriv_vol_max_ticks', maxT);
    localStorage.setItem('deriv_vol_mg', mg);
    localStorage.setItem('deriv_vol_max_mg_steps', mgSteps);

    const targetSymbols = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'];
    let count = 0;
    DEFAULT_SLOTS.forEach((slot, idx) => {
      const sym = getSlotSymbol(idx);
      if (targetSymbols.includes(sym) || slot.group === 'Volatility') {
        if (growth)  document.querySelector(`.slot-growth[data-idx="${idx}"]`).value = growth;
        if (stake)   document.querySelector(`.slot-stake[data-idx="${idx}"]`).value  = stake;
        if (tp)      document.querySelector(`.slot-tp[data-idx="${idx}"]`).value     = tp;
        if (sl)      document.querySelector(`.slot-sl[data-idx="${idx}"]`).value     = sl;
        if (maxT)    document.querySelector(`.slot-maxticks[data-idx="${idx}"]`).value = maxT;
        if (mg)      document.querySelector(`.slot-mg[data-idx="${idx}"]`).value     = mg;
        if (mgSteps) document.querySelector(`.slot-mgsteps[data-idx="${idx}"]`).value= mgSteps;
        count++;
      }
    });
    addLog('info', `✅ Volatility Quick Config applied specifically to ${count} slots (Vol 10, 25, 50, 75, 100)!`);
  });

  // Dedicated Volatility (10-100) Preset Select Button
  document.getElementById('btnSelectMainVolSlots')?.addEventListener('click', () => {
    const targetSymbols = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'];
    applySlotPreset((s) => targetSymbols.includes(s.symbol) || s.group === 'Volatility');
    addLog('info', '🎯 Volatility 10, 25, 50, 75, 100 slots enabled.');
  });
}

// ── Client Events ─────────────────────────────────────────────
function setupClientEvents() {
  client.on('log', ({ type, msg }) => addLog(type, msg));

  client.on('authorized', (data) => {
    isConnected = true;
    document.getElementById('btnConnect').textContent = '🔌 Disconnect';
    document.getElementById('btnConnect').className = 'btn btn-disconnect';
    document.getElementById('statusDot').className = 'status-dot connected';
    document.getElementById('statusText').textContent = 'Connected';
    document.getElementById('btnStartAll').disabled = false;
    document.getElementById('btnCashoutAll').disabled = false;
    syncMobileButtons();

    DEFAULT_SLOTS.forEach((_, idx) => {
      const btn = document.getElementById(`slotBtnStart_${idx}`);
      if (btn) btn.disabled = false;
      const co = document.getElementById(`slotBtnCashout_${idx}`);
      if (co) co.disabled = false;
    });
  });

  client.on('balanceUpdate', ({ balance, currency }) => {
    document.getElementById('balanceDisplay').textContent = `${currency} ${parseFloat(balance).toFixed(2)}`;
  });

  client.on('disconnected', () => {
    isConnected = false;
    document.getElementById('btnConnect').textContent = '🔗 Connect';
    document.getElementById('btnConnect').className = 'btn btn-connect';
    document.getElementById('statusDot').className = 'status-dot disconnected';
    document.getElementById('statusText').textContent = 'Disconnected';
    document.getElementById('btnStartAll').disabled = true;
    document.getElementById('btnCashoutAll').disabled = true;
    syncMobileButtons();
    DEFAULT_SLOTS.forEach((_, idx) => {
      const btn = document.getElementById(`slotBtnStart_${idx}`);
      if (btn) btn.disabled = true;
    });
  });
}

// ── Manager Events ────────────────────────────────────────────
function getSlotIdxBySymbol(symbol) {
  return DEFAULT_SLOTS.findIndex((_, idx) => getSlotSymbol(idx) === symbol);
}

function setupManagerEvents() {
  manager.on('log', ({ type, msg, symbol }) => {
    addLog(type, `[${symbol}] ${msg}`);
  });

  manager.on('botStarted', ({ symbol }) => {
    const idx = getSlotIdxBySymbol(symbol);
    if (idx < 0) return;
    setSlotRunning(idx, true);
    document.getElementById(`slotLive_${idx}`).style.display = '';
  });

  manager.on('botStopped', ({ symbol }) => {
    const idx = getSlotIdxBySymbol(symbol);
    if (idx < 0) return;
    const startBtn = document.getElementById(`slotBtnStart_${idx}`);
    if (startBtn) {
      startBtn.textContent = '▶ Start';
      startBtn.classList.remove('running');
    }
    const card = document.getElementById(`slot_${idx}`);
    if (card) {
      card.classList.remove('slot-running');
    }
    updateStartAllBtn();
  });

  manager.on('slotRoundStatus', ({ symbol, status, round, step, total, res, mode }) => {
    const idx = getSlotIdxBySymbol(symbol);
    if (idx < 0) return;
    const badge = document.getElementById(`slotBadge_${idx}`);
    const card  = document.getElementById(`slot_${idx}`);
    if (status === 'trading') {
      badge.textContent = mode === 'simultaneous' ? '🟢 Live Trading' : `🟢 Step #${step || 1} Trading`;
      badge.className = 'slot-status-badge running';
      card.classList.add('slot-running');
      card.classList.remove('slot-waiting');
      document.getElementById(`slotLive_${idx}`).style.display = '';
    } else if (status === 'queued') {
      badge.textContent = mode === 'simultaneous' ? '⏳ Ready in Wave' : `⏳ In Queue (#${step || 1}/${total || 1})`;
      badge.className = 'slot-status-badge waiting';
      card.classList.remove('slot-running');
      card.classList.add('slot-waiting');
    } else if (status === 'finished') {
      const isWon = res && res.result === 'won';
      badge.textContent = isWon ? `✅ Won (${res.ticks || 0}t)` : `💥 Lost (${res.ticks || 0}t)`;
      badge.className = `slot-status-badge ${isWon ? 'won' : 'lost'}`;
      card.classList.remove('slot-running');
      card.classList.remove('slot-waiting');
    } else if (status === 'skipped') {
      badge.textContent = '⏩ Skipped (N/A)';
      badge.className = 'slot-status-badge waiting';
      card.classList.remove('slot-running');
      card.classList.remove('slot-waiting');
    } else if (status === 'error') {
      badge.textContent = '❌ Error';
      badge.className = 'slot-status-badge idle';
      card.classList.remove('slot-running');
      card.classList.remove('slot-waiting');
    } else {
      badge.textContent = '⚪ Idle';
      badge.className = 'slot-status-badge idle';
      card.classList.remove('slot-running');
      card.classList.remove('slot-waiting');
    }
  });

  manager.on('roundStarted', ({ round, totalBots, mode }) => {
    const banner = document.getElementById('roundStatusBanner');
    if (banner) {
      banner.style.display = 'flex';
      document.getElementById('currentRoundBadge').textContent = `Round #${round}`;
      const subtext = document.getElementById('roundModeSubtext');
      if (mode === 'simultaneous') {
        document.getElementById('roundProgressText').textContent = `⚡ Simultaneous Wave: Buying all ${totalBots} bots at the SAME TIME...`;
        if (subtext) subtext.textContent = '⚡ Simultaneous Wave: All bots buy together • Immediate cut on Max Ticks';
      } else {
        document.getElementById('roundProgressText').textContent = `🔄 Sequential Relay Active: Starting Bot #1 of ${totalBots}...`;
        if (subtext) subtext.textContent = '🔄 Sequential Relay: Each bot runs one-by-one until Max Ticks, then next starts';
      }
    }
    updateStartAllBtn();
  });

  manager.on('roundProgress', ({ round, currentStep, currentSymbol, completed, total, mode }) => {
    const textEl = document.getElementById('roundProgressText');
    if (textEl) {
      if (mode === 'simultaneous') {
        textEl.textContent = `⚡ Wave #${round}: ${completed} of ${total} bots finished (All running simultaneously)`;
      } else {
        textEl.textContent = `🔄 Running Bot ${currentStep} of ${total} (${currentSymbol})... Next bot starts on close.`;
      }
    }
  });

  manager.on('roundFinished', ({ round, total, mode }) => {
    const textEl = document.getElementById('roundProgressText');
    if (textEl) {
      if (mode === 'simultaneous') {
        textEl.textContent = `🎉 Wave #${round} complete! All ${total} bots finished. Preparing next round...`;
      } else {
        textEl.textContent = `🎉 Relay Round #${round} complete! All ${total} bots executed. Preparing next round...`;
      }
    }
  });

  manager.on('batchStopped', () => {
    const banner = document.getElementById('roundStatusBanner');
    if (banner) banner.style.display = 'none';
    DEFAULT_SLOTS.forEach((_, idx) => {
      setSlotRunning(idx, false);
      const card = document.getElementById(`slot_${idx}`);
      if (card) card.classList.remove('slot-waiting');
    });
    updateStartAllBtn();
  });

  manager.on('contractOpened', ({ symbol }) => {
    const idx = getSlotIdxBySymbol(symbol);
    if (idx < 0) return;
    document.getElementById(`slotTicks_${idx}`).textContent = '0';
    document.getElementById(`slotProfit_${idx}`).textContent = '0.00';

    const pWrap = document.getElementById(`slotProgressWrap_${idx}`);
    if (pWrap) pWrap.style.display = 'block';

    const pFill = document.getElementById(`slotProgressBar_${idx}`);
    if (pFill) {
      pFill.style.width = '0%';
      pFill.style.background = 'linear-gradient(90deg, #7c4dff, #00e5ff)';
    }

    const cBadge = document.getElementById(`slotCutBadge_${idx}`);
    if (cBadge) cBadge.style.display = 'none';

    const maxT = parseInt(document.querySelector(`.slot-maxticks[data-idx="${idx}"]`)?.value || 5, 10);
    const pText = document.getElementById(`slotProgressText_${idx}`);
    if (pText) pText.textContent = `🎯 Ticks: 0 / ${maxT}`;
  });

  manager.on('contractUpdate', ({ symbol, profit, ticks, targetMaxTicks }) => {
    const idx = getSlotIdxBySymbol(symbol);
    if (idx < 0) return;
    document.getElementById(`slotTicks_${idx}`).textContent = ticks;
    const pEl = document.getElementById(`slotProfit_${idx}`);
    pEl.textContent = profit >= 0 ? `+${profit.toFixed(2)}` : profit.toFixed(2);
    pEl.className = `sl-val ${profit > 0 ? 'profit-pos' : profit < 0 ? 'profit-neg' : 'profit-neutral'}`;

    const maxT = targetMaxTicks || parseInt(document.querySelector(`.slot-maxticks[data-idx="${idx}"]`)?.value || 5, 10);
    const pct = Math.min(100, Math.round((ticks / (maxT || 5)) * 100));

    const pFill = document.getElementById(`slotProgressBar_${idx}`);
    if (pFill) pFill.style.width = `${pct}%`;

    const pText = document.getElementById(`slotProgressText_${idx}`);
    if (pText) pText.textContent = `🎯 Ticks: ${ticks} / ${maxT}`;
  });

  manager.on('contractCutting', ({ symbol, ticks, profit, reason }) => {
    const idx = getSlotIdxBySymbol(symbol);
    if (idx < 0) return;
    const cBadge = document.getElementById(`slotCutBadge_${idx}`);
    if (cBadge) {
      cBadge.style.display = 'inline-block';
      cBadge.textContent = `⚡ CUTTING @ T${ticks}`;
    }
    const pFill = document.getElementById(`slotProgressBar_${idx}`);
    if (pFill) {
      pFill.style.width = '100%';
      pFill.style.background = 'linear-gradient(90deg, #ff9100, #ff1744)';
    }
    const badge = document.getElementById(`slotBadge_${idx}`);
    if (badge) {
      badge.textContent = `⚡ Cutting @ T${ticks}`;
      badge.className = 'slot-status-badge waiting';
    }
  });

  manager.on('contractClosed', ({ symbol, profit, ticks, result }) => {
    const idx = getSlotIdxBySymbol(symbol);
    if (idx >= 0) {
      if (!slotStats[idx]) slotStats[idx] = { session: 0, trades: 0 };
      slotStats[idx].session += parseFloat(profit || 0);
      slotStats[idx].trades++;
      const sEl = document.getElementById(`slotSession_${idx}`);
      const s = slotStats[idx].session;
      sEl.textContent = s >= 0 ? `+${s.toFixed(2)}` : s.toFixed(2);
      sEl.className = `sl-val ${s > 0 ? 'profit-pos' : s < 0 ? 'profit-neg' : 'profit-neutral'}`;
      document.getElementById(`slotTrades_${idx}`).textContent = slotStats[idx].trades;

      const cBadge = document.getElementById(`slotCutBadge_${idx}`);
      if (cBadge) cBadge.style.display = 'none';

      const pText = document.getElementById(`slotProgressText_${idx}`);
      const pFill = document.getElementById(`slotProgressBar_${idx}`);
      if (result === 'won') {
        if (pText) pText.textContent = `✅ Won @ ${ticks} Ticks (+${parseFloat(profit).toFixed(2)})`;
        if (pFill) {
          pFill.style.width = '100%';
          pFill.style.background = 'var(--green)';
        }
      } else {
        if (pText) pText.textContent = `💥 Knockout @ ${ticks} Ticks (${parseFloat(profit).toFixed(2)})`;
        if (pFill) {
          pFill.style.width = '100%';
          pFill.style.background = 'var(--red)';
        }
      }
    }
    addTradeHistory(symbol, profit, ticks, result);
  });

  manager.on('globalStats', (stats) => {
    updateGlobalStats(stats);
  });

  manager.on('error', ({ symbol, msg }) => {
    addLog('error', `[${symbol}] ❌ ${msg}`);
  });
}

function setSlotRunning(idx, running) {
  const badge   = document.getElementById(`slotBadge_${idx}`);
  const startBtn = document.getElementById(`slotBtnStart_${idx}`);
  const card    = document.getElementById(`slot_${idx}`);

  if (running) {
    badge.textContent = '🟢 Running';
    badge.className = 'slot-status-badge running';
    startBtn.textContent = '⏹ Stop';
    startBtn.classList.add('running');
    card.classList.add('slot-running');
  } else {
    badge.textContent = '⚪ Idle';
    badge.className = 'slot-status-badge idle';
    startBtn.textContent = '▶ Start';
    startBtn.classList.remove('running');
    card.classList.remove('slot-running');
  }
  updateStartAllBtn();
}

function updateStartAllBtn() {
  const anyRunning = manager.isAnyRunning();
  const btn = document.getElementById('btnStartAll');
  if (!btn) return;
  const mode = document.getElementById('executionMode')?.value || 'simultaneous';
  if (anyRunning) {
    btn.textContent = '⏹ Stop All Bots';
    btn.classList.add('running');
  } else {
    btn.textContent = mode === 'simultaneous'
      ? '▶ Start All Bots (Simultaneous Buy)'
      : '▶ Start All Bots (Sequential Relay)';
    btn.classList.remove('running');
  }
  syncMobileButtons();
}

function updateGlobalStats(stats) {
  const p = stats.sessionProfit;
  const pEl = document.getElementById('globalProfit');
  pEl.textContent = p >= 0 ? `+${p.toFixed(2)}` : p.toFixed(2);
  pEl.className = `stat-val ${p > 0 ? 'profit-pos' : p < 0 ? 'profit-neg' : 'profit-neutral'}`;
  document.getElementById('globalTrades').textContent = stats.totalTrades;
  document.getElementById('globalWon').textContent = stats.wonTrades;
  document.getElementById('globalLost').textContent = stats.lostTrades;
  const wr = stats.totalTrades > 0 ? ((stats.wonTrades / stats.totalTrades) * 100).toFixed(1) : '0.0';
  document.getElementById('globalWinRate').textContent = `${wr}%`;
  document.getElementById('globalRunning').textContent = stats.runningCount;
  if (document.getElementById('globalRoundDisplay')) {
    document.getElementById('globalRoundDisplay').textContent = stats.currentRound || 0;
  }
}

// ── Log ───────────────────────────────────────────────────────
function addLog(type, msg) {
  const container = document.getElementById('logContainer');
  const div = document.createElement('div');
  div.className = `log-entry log-${type}`;
  const icons = { info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️' };
  const time = new Date().toLocaleTimeString('en-IN', { hour12: false });
  div.textContent = `${icons[type] || ''} [${time}] ${msg}`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  while (container.children.length > 300) container.removeChild(container.firstChild);
}

// ── Trade History ─────────────────────────────────────────────
let histCount = 0;
function addTradeHistory(symbol, profit, ticks, result) {
  histCount++;
  const tbody = document.getElementById('tradeHistoryBody');
  const tr = document.createElement('tr');
  tr.className = result === 'won' ? 'row-won' : 'row-lost';
  const time = new Date().toLocaleTimeString('en-IN', { hour12: false });
  tr.innerHTML = `
    <td>${histCount}</td>
    <td>${time}</td>
    <td>${symbol}</td>
    <td>${ticks}</td>
    <td class="${profit >= 0 ? 'profit-pos' : 'profit-neg'}">${profit >= 0 ? '+' : ''}${parseFloat(profit).toFixed(2)}</td>
    <td>${result === 'won' ? '✅ Won' : '💥 Lost'}</td>
  `;
  tbody.insertBefore(tr, tbody.firstChild);
  while (tbody.children.length > 200) tbody.removeChild(tbody.lastChild);
}

// ── Mobile UI Setup & Floating Bottom Bar Sync ────────────────
function setupMobileUI() {
  const tabs = document.querySelectorAll('.mobile-tab-btn');
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      tabs.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const targetTab = btn.getAttribute('data-tab');
      document.body.classList.remove('tab-slots', 'tab-controls', 'tab-logs');
      document.body.classList.add(`tab-${targetTab}`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  // Default active view on mobile is slots
  document.body.classList.add('tab-slots');

  // Floating bottom bar click actions
  const mStart = document.getElementById('mobileBtnStart');
  const mCashout = document.getElementById('mobileBtnCashout');
  const btnStart = document.getElementById('btnStartAll');
  const btnCashout = document.getElementById('btnCashoutAll');

  if (mStart && btnStart) {
    mStart.addEventListener('click', () => btnStart.click());
  }
  if (mCashout && btnCashout) {
    mCashout.addEventListener('click', () => btnCashout.click());
  }

  // Observe main buttons so mobile bottom bar stays 100% synchronized
  if (btnStart) {
    const startObserver = new MutationObserver(syncMobileButtons);
    startObserver.observe(btnStart, { attributes: true, childList: true, characterData: true });
  }
  if (btnCashout) {
    const cashObserver = new MutationObserver(syncMobileButtons);
    cashObserver.observe(btnCashout, { attributes: true });
  }

  syncMobileButtons();
}

function syncMobileButtons() {
  const mStart = document.getElementById('mobileBtnStart');
  const mCashout = document.getElementById('mobileBtnCashout');
  const btnStart = document.getElementById('btnStartAll');
  const btnCashout = document.getElementById('btnCashoutAll');

  if (mStart && btnStart) {
    mStart.disabled = btnStart.disabled;
    mStart.textContent = btnStart.textContent.includes('Stop') ? '⏹ Stop All' : '▶ Start All';
    if (btnStart.classList.contains('running')) {
      mStart.classList.add('running');
    } else {
      mStart.classList.remove('running');
    }
  }

  if (mCashout && btnCashout) {
    mCashout.disabled = btnCashout.disabled;
  }
}
