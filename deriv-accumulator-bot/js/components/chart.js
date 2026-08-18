/**
 * Live HTML5 Canvas Accumulator Corridor Chart Component
 * Visualizes real-time tick spot prices, high/low boundaries, entry spots, and step counters.
 */

export class AccumulatorChart {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    
    this.ticks = [];
    this.maxTicks = 40;
    this.activeContract = null;
    this.currentSpot = 0;

    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());
  }

  resizeCanvas() {
    if (!this.canvas) return;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = rect.width * window.devicePixelRatio;
    this.canvas.height = rect.height * window.devicePixelRatio;
    this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    this.draw();
  }

  addTick(tick) {
    this.currentSpot = tick.quote;
    this.ticks.push({
      quote: tick.quote,
      epoch: tick.epoch,
      highBarrier: this.activeContract ? this.activeContract.high_barrier : null,
      lowBarrier: this.activeContract ? this.activeContract.low_barrier : null
    });

    if (this.ticks.length > this.maxTicks) {
      this.ticks.shift();
    }

    this.draw();
  }

  updateActiveContract(contract) {
    this.activeContract = contract;
    this.draw();
  }

  draw() {
    if (!this.canvas || !this.ctx) return;
    const w = this.canvas.width / window.devicePixelRatio;
    const h = this.canvas.height / window.devicePixelRatio;
    const ctx = this.ctx;

    // Clear Background
    ctx.clearRect(0, 0, w, h);

    if (this.ticks.length < 2) {
      ctx.fillStyle = '#6b7280';
      ctx.font = '14px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for price ticks...', w / 2, h / 2);
      return;
    }

    // Determine Min & Max Price Bounds with Padding
    let prices = this.ticks.map(t => t.quote);
    if (this.activeContract) {
      if (this.activeContract.high_barrier) prices.push(this.activeContract.high_barrier);
      if (this.activeContract.low_barrier) prices.push(this.activeContract.low_barrier);
      if (this.activeContract.entry_spot) prices.push(this.activeContract.entry_spot);
    }

    let minPrice = Math.min(...prices);
    let maxPrice = Math.max(...prices);
    let range = (maxPrice - minPrice) || 1;
    let padding = range * 0.15;
    minPrice -= padding;
    maxPrice += padding;
    range = maxPrice - minPrice;

    const getY = (val) => h - ((val - minPrice) / range) * (h - 60) - 30;
    const getX = (idx) => (idx / (this.maxTicks - 1)) * (w - 80) + 40;

    // 1. Draw Grid Lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      let y = (h / 5) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // 2. Draw Accumulator High & Low Corridor Shades & Boundaries
    if (this.activeContract && this.activeContract.high_barrier && this.activeContract.low_barrier) {
      const highY = getY(this.activeContract.high_barrier);
      const lowY = getY(this.activeContract.low_barrier);
      const entryY = getY(this.activeContract.entry_spot || this.currentSpot);

      // Gradient Fill inside boundary corridor
      const corridorGrad = ctx.createLinearGradient(0, highY, 0, lowY);
      corridorGrad.addColorStop(0, 'rgba(16, 185, 129, 0.15)');
      corridorGrad.addColorStop(0.5, 'rgba(6, 182, 212, 0.08)');
      corridorGrad.addColorStop(1, 'rgba(244, 63, 94, 0.15)');

      ctx.fillStyle = corridorGrad;
      ctx.fillRect(0, highY, w - 60, lowY - highY);

      // Upper Boundary (High Barrier)
      ctx.strokeStyle = '#f43f5e';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, highY);
      ctx.lineTo(w - 60, highY);
      ctx.stroke();

      // Lower Boundary (Low Barrier)
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, lowY);
      ctx.lineTo(w - 60, lowY);
      ctx.stroke();

      // Entry Spot Line
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(0, entryY);
      ctx.lineTo(w - 60, entryY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Right Axis Barrier Labels
      ctx.font = '10px JetBrains Mono, monospace';
      ctx.fillStyle = '#f43f5e';
      ctx.fillText(`HIGH ${this.activeContract.high_barrier}`, w - 55, highY + 3);
      ctx.fillStyle = '#10b981';
      ctx.fillText(`LOW ${this.activeContract.low_barrier}`, w - 55, lowY + 3);
      ctx.fillStyle = '#f59e0b';
      ctx.fillText(`ENTRY ${this.activeContract.entry_spot}`, w - 55, entryY + 3);
    }

    // 3. Draw Price Curve Line
    ctx.setLineDash([]);
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 2.5;
    ctx.shadowColor = 'rgba(6, 182, 212, 0.4)';
    ctx.shadowBlur = 8;
    ctx.beginPath();

    this.ticks.forEach((t, i) => {
      let x = getX(i);
      let y = getY(t.quote);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.shadowBlur = 0; // reset shadow

    // 4. Draw Nodes and Active Contract Tick Counters
    const startIndex = Math.max(0, this.ticks.length - (this.activeContract ? (this.activeContract.tick_count + 1) : 0));

    this.ticks.forEach((t, i) => {
      let x = getX(i);
      let y = getY(t.quote);

      let isCurrent = (i === this.ticks.length - 1);
      let isContractTick = this.activeContract && i >= startIndex;

      ctx.beginPath();
      ctx.arc(x, y, isCurrent ? 5 : (isContractTick ? 4 : 2.5), 0, Math.PI * 2);

      if (isCurrent) {
        ctx.fillStyle = '#6366f1';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (isContractTick) {
        ctx.fillStyle = '#10b981';
      } else {
        ctx.fillStyle = '#4b5563';
      }
      ctx.fill();

      // Tick number label over active contract nodes
      if (this.activeContract && isContractTick && !isCurrent) {
        const tickNum = i - startIndex + 1;
        ctx.font = '10px JetBrains Mono, monospace';
        ctx.fillStyle = '#6ee7b7';
        ctx.textAlign = 'center';
        ctx.fillText(`#${tickNum}`, x, y - 8);
      }
    });

    // 5. Current Spot Axis Pointer
    const lastTick = this.ticks[this.ticks.length - 1];
    const lastY = getY(lastTick.quote);
    ctx.fillStyle = '#6366f1';
    ctx.fillRect(w - 60, lastY - 10, 58, 20);
    ctx.fillStyle = '#ffffff';
    ctx.font = '11px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(lastTick.quote.toFixed(2), w - 55, lastY + 4);
  }
}
