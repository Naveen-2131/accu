
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

