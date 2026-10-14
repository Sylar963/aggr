import Exchange from '../exchange'
import {
  buildTradfiReference,
  getTradfiBase,
  matchTradfiReference,
  TRADFI_REFERENCE_ENDPOINTS
} from '@/utils/tradfi'

export default class ASTER extends Exchange {
  id = 'ASTER'

  protected endpoints = {
    PRODUCTS: [
      'https://fapi.asterdex.com/fapi/v1/exchangeInfo',
      // prices for tradfi detection, not allowed by the production proxy
      {
        url: 'https://fapi.asterdex.com/fapi/v1/premiumIndex',
        method: 'GET',
        proxy: false,
        optional: true
      },
      ...TRADFI_REFERENCE_ENDPOINTS
    ]
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

  formatProducts([info, premiumIndex, ...references]) {
    const products = []
    const tradfi = []

    // aster doesn't flag stocks & commodities, compare with exchanges that do
    const reference = buildTradfiReference(references)
    const prices = (Array.isArray(premiumIndex) ? premiumIndex : []).reduce(
      (acc, index) => {
        acc[index.symbol] = +index.markPrice
        return acc
      },
      {}
    )

    if (info && Array.isArray(info.symbols)) {
      for (const s of info.symbols) {
        if (s.contractType === 'PERPETUAL' && s.status === 'TRADING') {
          products.push(s.symbol) // e.g. 'BTCUSDT'

          if (
            matchTradfiReference(
              reference,
              s.symbol,
              getTradfiBase(s.baseAsset),
              prices[s.symbol]
            )
          ) {
            tradfi.push(s.symbol)
          }
        }
      }
    }

    return { products, tradfi }
  }

  getChannels(pair) {
    const symbol = pair.toLowerCase()

    return [`${symbol}@aggTrade`, `${symbol}@forceOrder`]
  }

  /**
   * Subscribe to trades and liquidations
   * @param {WebSocket} api
   * @param {string} pair  e.g. 'BTCUSDT'
   */
  async subscribe(api, pair) {
    if (!(await super.subscribe(api, pair))) {
      return
    }

    // Aster = Binance clone → SUBSCRIBE / UNSUBSCRIBE with params: ["btcusdt@aggTrade", "btcusdt@forceOrder"]
    api.send(
      JSON.stringify({
        method: 'SUBSCRIBE',
        params: this.getChannels(pair),
        id: Date.now()
      })
    )

    return true
  }

  /**
   * Unsubscribe from trades and liquidations
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
        params: this.getChannels(pair),
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

    if (json.e === 'forceOrder') {
      return this.emitLiquidations(api.id, [this.formatLiquidation(json.o)])
    }
  }

  /**
   * Normalize Aster/Binance forceOrder to aggr internal liquidation format
   * o.S is the side of the liquidation order: BUY = short liquidated
   */
  formatLiquidation(o) {
    return {
      exchange: this.id,
      pair: o.s,
      timestamp: +o.T,
      price: +o.p,
      size: +o.q,
      side: o.S === 'BUY' ? 'buy' : 'sell',
      liquidation: true
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
