import Exchange from '../exchange'

export default class THALEX extends Exchange {
  id = 'THALEX'

  protected endpoints = {
    PRODUCTS: 'https://thalex.com/api/v2/public/instruments'
  }


  /**
   * Get THALEX WebSocket URL
   */
  async getUrl(): Promise<string> {
    return 'wss://thalex.com/ws/api/v2'
  }

  /**
   * Subscribe to THALEX order book trades
   */
  async subscribe(api: any, pair: string): Promise<boolean> {
    if (!(await super.subscribe(api, pair))) {
      return false
    }

    api.send(
      JSON.stringify({
        method: 'public/subscribe',
        params: {
          channels: [`book.${pair}.none.all.raw`]
        },
        id: Date.now()
      })
    )

    return true
  }



  /**
   * Unsubscribe from THALEX order book trades
   */
  async unsubscribe(api: any, pair: string): Promise<boolean> {
    if (!(await super.unsubscribe(api, pair))) {
      return false
    }

    api.send(
      JSON.stringify({
        method: 'public/unsubscribe',
        params: {
          channels: [`book.${pair}.none.all.raw`]
        },
        id: Date.now()
      })
    )

    return true
  }

  /**
   * Handle WebSocket messages from THALEX
   */
  onMessage(event: MessageEvent, api: any): boolean {
    try {
      const json = JSON.parse(event.data)

      // Handle subscription confirmations
      if (json.id && json.result === 'ok') {
        console.debug(`[${this.id}] ✅ Subscription confirmed`)
        return true
      }

      // Handle error responses
      if (json.error) {
        console.error(`[${this.id}] ❌ Error response:`, json.error)
        return false
      }

      // Handle market data notifications
      if (json.channel_name && json.notification) {
        // Handle book trade data
        if (json.channel_name.startsWith('book.')) {
          const pair = this.extractPairFromBookChannel(json.channel_name)
          console.debug(`[${this.id}] 🎯 Received book trades for ${pair}`)

          if (
            json.notification.trades &&
            Array.isArray(json.notification.trades) &&
            json.notification.trades.length > 0 &&
            !json.snapshot // Skip snapshot trades to avoid flooding with old data
          ) {
            const trades = json.notification.trades
              .map(tradeArray => this.formatBookTrade(pair, tradeArray))
              .filter(trade => trade !== null)

            if (trades.length > 0) {
              this.emitTrades(api.id, trades)
              console.debug(`[${this.id}] ✅ Emitted ${trades.length} book trades for ${pair}`)
            }
          }
        }
        // Handle recent trades data (fallback/backward compatibility)
        else if (json.channel_name.startsWith('recent_trades.')) {
          const pair = this.extractPairFromRecentTradesChannel(json.channel_name)
          console.debug(`[${this.id}] 🎯 Received trades for ${pair}`)

          if (Array.isArray(json.notification) && json.notification.length > 0) {
            const trades = json.notification
              .map(tradeArray => this.formatRecentTrade(pair, tradeArray))
              .filter(trade => trade !== null)

            if (trades.length > 0) {
              this.emitTrades(api.id, trades)
              console.debug(`[${this.id}] ✅ Emitted ${trades.length} trades for ${pair}`)
            }
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
   * Extract pair name from recent trades channel string
   */
  private extractPairFromRecentTradesChannel(channel: string): string {
    // Format: recent_trades.BTC-PERPETUAL.single
    const parts = channel.split('.')
    if (parts.length >= 3 && parts[0] === 'recent_trades') {
      return parts.slice(1, -1).join('.') // Remove first and last parts (recent_trades and single)
    }
    return channel // Fallback
  }

  /**
   * Extract pair name from book channel string
   */
  private extractPairFromBookChannel(channel: string): string {
    // Format: book.BTC-PERPETUAL.none.all.raw
    const parts = channel.split('.')
    if (parts.length >= 5 && parts[0] === 'book') {
      return parts[1] // The pair is the second part
    }
    return channel // Fallback
  }



  /**
   * Format recent trade data from THALEX API
   * Trade format: [price, size, side ("buy" or "sell"), timestamp, instrument_name, implied_taker]
   */
  formatRecentTrade(market: string, tradeArray: any[]): any | null {
    if (!Array.isArray(tradeArray) || tradeArray.length < 6) {
      console.warn(`[${this.id}] Invalid trade array format:`, tradeArray)
      return null
    }

    const [price, size, side, timestamp, instrument_name, implied_taker] = tradeArray

    return {
      exchange: this.id,
      pair: market,
      timestamp: parseFloat(timestamp) * 1000, // Convert to milliseconds
      price: parseFloat(price),
      size: parseFloat(size),
      side: side === 'buy' ? 'buy' : 'sell',
      instrument_name,
      implied_taker: Boolean(implied_taker),
      source: 'recent_trades' // Mark this as real trade data
    }
  }

  /**
   * Format book trade data from THALEX API
   * Trade format: [price, amount, direction, timestamp, implied_taker]
   */
  formatBookTrade(market: string, tradeArray: any[]): any | null {
    if (!Array.isArray(tradeArray) || tradeArray.length < 5) {
      console.warn(`[${this.id}] Invalid book trade array format:`, tradeArray)
      return null
    }

    const [price, amount, direction, timestamp, implied_taker] = tradeArray

    return {
      exchange: this.id,
      pair: market,
      timestamp: parseFloat(timestamp) * 1000, // Convert to milliseconds
      price: parseFloat(price),
      size: parseFloat(amount), // Use amount as size
      side: direction === 'buy' ? 'buy' : 'sell',
      instrument_name: market, // Set instrument_name to the pair since it's not provided
      implied_taker: Boolean(implied_taker),
      source: 'book' // Mark this as book trade data
    }
  }






  /**
   * Format products from THALEX API response
   */
  formatProducts(response: any): string[] {
    if (!response || !response.result) {
      return ['BTC-PERPETUAL', 'ETH-PERPETUAL']
    }

    const instruments = response.result
    const products = instruments
      .filter(
        (instrument: any) =>
          instrument.is_active &&
          (instrument.kind === 'future' || instrument.type === 'perpetual') &&
          (instrument.instrument_name.includes('BTC-PERPETUAL') || instrument.instrument_name.includes('ETH-PERPETUAL'))
      )
      .map((instrument: any) => instrument.instrument_name)

    return products.length > 0 ? products : ['BTC-PERPETUAL', 'ETH-PERPETUAL']
  }

  /**
   * Handle WebSocket API creation
   */
  onApiCreated(api: any): void {
    this.startKeepAlive(api, { method: 'public/heartbeat' }, 30000)
  }

  /**
   * Handle WebSocket API removal
   */
  onApiRemoved(api: any): void {
    this.stopKeepAlive(api)
  }
}
