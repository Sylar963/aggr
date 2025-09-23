import Exchange from '../exchange'

export default class THALEX extends Exchange {
  id = 'THALEX'

  protected endpoints = {
    PRODUCTS: 'https://testnet.thalex.com/api/v2/public/instruments'
  }

  /**
   * Get THALEX WebSocket URL
   */
  async getUrl(): Promise<string> {
    return 'wss://testnet.thalex.com/ws/api/v2'
  }

  /**
   * Subscribe to THALEX trade data
   */
  async subscribe(api: any, pair: string): Promise<boolean> {
    if (!(await super.subscribe(api, pair))) {
      return
    }

    api.send(JSON.stringify({
      method: 'public/subscribe',
      params: {
        channels: [`trades.${pair}`]
      },
      id: Date.now()
    }))

    return true
  }

  /**
   * Unsubscribe from THALEX trade data
   */
  async unsubscribe(api: any, pair: string): Promise<boolean> {
    if (!(await super.unsubscribe(api, pair))) {
      return
    }

    api.send(JSON.stringify({
      method: 'public/unsubscribe',
      params: {
        channels: [`trades.${pair}`]
      },
      id: Date.now()
    }))

    return true
  }

  /**
   * Handle WebSocket messages from THALEX
   */
  onMessage(event: MessageEvent, api: any): boolean {
    try {
      const json = JSON.parse(event.data)

      if (json.method === 'subscription') {
        const { channel, data } = json.params

        if (channel.startsWith('trades.') && Array.isArray(data)) {
          const pair = channel.split('.')[1]

          const trades = data.map(trade => this.formatTrade(pair, trade))

          if (trades.length > 0) {
            this.emitTrades(api.id, trades)
          }
        }
      }

      return true
    } catch (error) {
      console.error(`[${this.id}] Error parsing message:`, error)
      return false
    }
  }

  /**
   * Format trade data
   */
  formatTrade(market: string, trade: any) {
    return {
      exchange: this.id,
      pair: market,
      timestamp: trade.timestamp || Date.now(),
      price: parseFloat(trade.price),
      size: parseFloat(trade.amount),
      side: trade.direction === 'buy' ? 'buy' : 'sell'
    }
  }

  /**
   * Format products from THALEX API response
   */
  formatProducts(response: any): string[] {
    if (!response || !response.result) {
      return ['BTC-PERPETUAL']
    }

    const instruments = response.result
    const products = instruments
      .filter(
        (instrument: any) =>
          instrument.is_active && instrument.kind === 'future'
      )
      .map((instrument: any) => instrument.instrument_name)

    return products.length > 0 ? products : ['BTC-PERPETUAL']
  }
}
