const fs = require('fs');
const path = require('path');

const baseDir = 'C:\\Users\\ADMIN\\Desktop\\Accumulator-Bot';

// 1. Update index.html
const indexPath = path.join(baseDir, 'public', 'index.html');
let htmlCode = fs.readFileSync(indexPath, 'utf8');

const volQuickConfigCard = `      <button class="btn btn-ghost" id="btnApplyAll" style="margin-top:4px;">⚡ Apply to All Enabled Slots</button>
    </div>

    <!-- 3B. Dedicated Quick Config for Volatility (10, 25, 50, 75, 100) Indices -->
    <div class="card" style="border: 1px solid rgba(0, 230, 118, 0.35); background: linear-gradient(180deg, rgba(0, 230, 118, 0.04) 0%, rgba(20, 22, 34, 0.95) 100%);">
      <div class="card-title" style="color: #00e676; display: flex; align-items: center; justify-content: space-between;">
        <span>📊 Quick Config (Vol 10, 25, 50, 75, 100)</span>
        <span style="font-size:0.68rem; background:rgba(0,230,118,0.15); color:#69f0ae; padding:1px 6px; border-radius:8px;">5 Slots</span>
      </div>
      <div class="inline-2">
        <div class="form-group">
          <label>Growth Rate</label>
          <select id="volGrowth">
            <option value="0.01">1%</option>
            <option value="0.02" selected>2%</option>
            <option value="0.03">3%</option>
            <option value="0.04">4%</option>
            <option value="0.05">5%</option>
          </select>
        </div>
        <div class="form-group">
          <label>Stake ($)</label>
          <input type="number" id="volStake" value="1.00" min="0.35" step="0.01" />
        </div>
      </div>
      <div class="inline-3">
        <div class="form-group">
          <label>TP ($)</label>
          <input type="number" id="volTP" value="0" min="0" step="0.01" placeholder="0=off" />
        </div>
        <div class="form-group">
          <label>SL ($)</label>
          <input type="number" id="volSL" value="0" min="0" step="0.01" placeholder="0=off" />
        </div>
        <div class="form-group">
          <label>Max Ticks</label>
          <input type="number" id="volMaxTicks" value="5" min="0" step="1" placeholder="5" />
        </div>
      </div>
      <div class="inline-2">
        <div class="form-group">
          <label>Martingale x</label>
          <input type="number" id="volMG" value="1.0" min="1.0" max="10.0" step="0.1" title="1 = disabled" />
        </div>
        <div class="form-group">
          <label>Max MG Steps</label>
          <input type="number" id="volMaxMGSteps" value="3" min="1" max="10" step="1" />
        </div>
      </div>
      <button class="btn btn-ghost" id="btnApplyVol" style="margin-top:4px; border:1px solid rgba(0,230,118,0.4); color:#69f0ae; background:rgba(0,230,118,0.06);">
        📊 Apply to Volatility 10, 25, 50, 75, 100
      </button>
    </div>`;

htmlCode = htmlCode.replace(
  '      <button class="btn btn-ghost" id="btnApplyAll" style="margin-top:4px;">⚡ Apply to All Enabled Slots</button>\n    </div>',
  volQuickConfigCard
);

// Add quick preset button for Vol 10-100
htmlCode = htmlCode.replace(
  '<button class="btn btn-ghost btn-sm" id="btnSelectVolSlots" title="Enable 13 Volatility symbols">📊 Volatility Accumulators (13)</button>',
  '<button class="btn btn-ghost btn-sm" id="btnSelectMainVolSlots" title="Enable only Vol 10, 25, 50, 75, 100" style="border-color:rgba(0,230,118,0.4); color:#69f0ae;">🎯 Vol (10-100)</button>\n          <button class="btn btn-ghost btn-sm" id="btnSelectVolSlots" title="Enable 13 Volatility symbols">📊 All Volatility (13)</button>'
);

// Bump version to v=4.3
htmlCode = htmlCode.replace(/v=4\.2/g, 'v=4.3');

fs.writeFileSync(indexPath, htmlCode, 'utf8');
console.log('index.html updated with Dedicated Volatility Quick Config & v=4.3!');

// 2. Update app.js
const appJsPath = path.join(baseDir, 'public', 'js', 'app.js');
let appCode = fs.readFileSync(appJsPath, 'utf8');

// A. In loadSavedSettings: restore vol settings
const volStorageRestore = `  // Restore Dedicated Volatility (10-100) Quick Settings
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

  // Auto-connect if token is saved so user never has to re-connect manually!`;

appCode = appCode.replace(
  '  // Auto-connect if token is saved so user never has to re-connect manually!',
  volStorageRestore
);

// B. In setupGlobalUI: add btnApplyVol & btnSelectMainVolSlots listeners
const volBtnListeners = `    addLog('info', '✅ Global settings (Stake, TP, SL, Max Ticks, Martingale & Max MG Steps) applied & saved!');
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
        if (growth)  document.querySelector(\`.slot-growth[data-idx="\${idx}"]\`).value = growth;
        if (stake)   document.querySelector(\`.slot-stake[data-idx="\${idx}"]\`).value  = stake;
        if (tp)      document.querySelector(\`.slot-tp[data-idx="\${idx}"]\`).value     = tp;
        if (sl)      document.querySelector(\`.slot-sl[data-idx="\${idx}"]\`).value     = sl;
        if (maxT)    document.querySelector(\`.slot-maxticks[data-idx="\${idx}"]\`).value = maxT;
        if (mg)      document.querySelector(\`.slot-mg[data-idx="\${idx}"]\`).value     = mg;
        if (mgSteps) document.querySelector(\`.slot-mgsteps[data-idx="\${idx}"]\`).value= mgSteps;
        count++;
      }
    });
    addLog('info', \`✅ Volatility Quick Config applied specifically to \${count} slots (Vol 10, 25, 50, 75, 100)!\`);
  });

  // Dedicated Volatility (10-100) Preset Select Button
  document.getElementById('btnSelectMainVolSlots')?.addEventListener('click', () => {
    const targetSymbols = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'];
    applySlotPreset((s) => targetSymbols.includes(s.symbol) || s.group === 'Volatility');
    addLog('info', '🎯 Volatility 10, 25, 50, 75, 100 slots enabled.');
  });`;

appCode = appCode.replace(
  "    addLog('info', '✅ Global settings (Stake, TP, SL, Max Ticks, Martingale & Max MG Steps) applied & saved!');\n  });",
  volBtnListeners
);

fs.writeFileSync(appJsPath, appCode, 'utf8');
console.log('app.js updated with Dedicated Volatility (10-100) Quick Config handlers!');
