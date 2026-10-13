import Exchange from '../exchange'
import { ASTER_TRADFI_SYMBOLS } from '@/utils/tradfi'

export default class ASTER extends Exchange {
  id = 'ASTER'

  protected endpoints = {
    PRODUCTS: ['https://fapi.asterdex.com/fapi/v1/exchangeInfo']
  }

  // Binance-style fstream clone
  async getUrl() {
    return 'wss://fstream.asterdex.com/ws'
  }

  /**
   * Map /fapi/v1/exchangeInfo to a flat list of tradable perp symbols
   * (you can adapt filters depending on what you want to show in aggr)
   */
  validateProducts(data) {
    if (!data.tradfi) {
      return false
    }

    return true
  }

  formatProducts(response) {
    const products = []
    const tradfi = []

    if (response && Array.isArray(response.symbols)) {
      for (const s of response.symbols) {
        if (s.contractType === 'PERPETUAL' && s.status === 'TRADING') {
          products.push(s.symbol) // e.g. 'BTCUSDT'

          // aster doesn't flag stocks & commodities
          if (ASTER_TRADFI_SYMBOLS.has(s.symbol)) {
            tradfi.push(s.symbol)
          }
        }
      }
    }

    return { products, tradfi }
  }

  /**
   * Subscribe to trades
   * @param {WebSocket} api
   * @param {string} pair  e.g. 'BTCUSDT'
   */
  async subscribe(api, pair) {
    if (!(await super.subscribe(api, pair))) {
      return
    }

    // Aster = Binance clone → SUBSCRIBE / UNSUBSCRIBE with params: ["btcusdt@aggTrade"]
    api.send(
      JSON.stringify({
        method: 'SUBSCRIBE',
        params: [`${pair.toLowerCase()}@aggTrade`],
        id: Date.now()
      })
    )

    return true
  }

  /**
   * Unsubscribe from trades
   * @param {WebSocket} api
   * @param {string} pair
   */
  async unsubscribe(api, pair) {
    if (!(await super.unsubscribe(api, pair))) {
      return
    }

    api.send(
      JSON.stringify({
        method: 'UNSUBSCRIBE',
        params: [`${pair.toLowerCase()}@aggTrade`],
        id: Date.now()
      })
    )

    return true
  }

  /**
   * Handle incoming WS messages
   */
  onMessage(event, api) {
    const json = JSON.parse(event.data)

    // Aster supports either raw event or the Binance /stream wrapper
    if (json.stream && json.data && json.data.e === 'aggTrade') {
      const t = this.formatResponse(json.data)
      return this.emitTrades(api.id, [t])
    }

    if (json.e === 'aggTrade') {
      const t = this.formatResponse(json)
      return this.emitTrades(api.id, [t])
    }
  }

  /**
   * Normalize Aster/Binance aggTrade to aggr internal trade format
   *
   * Example aggTrade payload:
   * {
   *   "e": "aggTrade",
   *   "E": 123456789,
   *   "s": "BTCUSDT",
   *   "a": 5933014,
   *   "p": "0.001",
   *   "q": "100",
   *   "f": 100,
   *   "l": 105,
   *   "T": 123456785,   // trade time
   *   "m": true,        // buyer is maker
   *   "M": true         // ignore
   * }
   */
  formatResponse(t) {
    // Derive taker side from isBuyerMaker flag:
    // if buyer is maker => taker is seller => 'sell'
    // if buyer is not maker => taker is buyer => 'buy'
    const takerSide = t.m ? 'sell' : 'buy'

    return {
      exchange: this.id,
      pair: t.s, // 'BTCUSDT'
      timestamp: +t.T, // ms
      price: +t.p,
      size: +t.q,
      side: takerSide
    }
  }
}
