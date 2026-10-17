import Exchange from '../exchange'
import { isHip3TradfiMarket } from '@/utils/tradfi'

export default class HYPERLIQUID extends Exchange {
  id = 'HYPERLIQUID'
  protected endpoints: { [id: string]: any } = {
    PRODUCTS: [
      {
        url: 'https://api.hyperliquid.xyz/info',
        method: 'POST',
        // main dex + every HIP-3 dex (xyz:TSLA, xyz:GOLD...)
        data: JSON.stringify({ type: 'allPerpMetas' }),
        proxy: false
      }
    ]
  }

  // last trade received per coin, see isNewTrade
  private lastTrades: {
    [coin: string]: { time: number; tids: { [tid: number]: boolean } }
  } = {}

  async getUrl() {
    return 'wss://api.hyperliquid.xyz/ws'
  }

  validateProducts(data) {
    if (!data.tradfi) {
      return false
    }

    return true
  }

  formatProducts(response) {
    const products = []
    const tradfi = []

    for (const meta of response) {
      if (!meta || !meta.universe) {
        continue
      }

      for (const product of meta.universe) {
        if (product.isDelisted) {
          continue
        }

        products.push(product.name)

        if (isHip3TradfiMarket(product.name)) {
          tradfi.push(product.name)
        }
      }
    }

    return {
      products,
      tradfi
    }
  }

  /**
   * Sub
   * @param {WebSocket} api
   * @param {string} pair
   */
  async subscribe(api, pair) {
    if (!(await super.subscribe(api, pair))) {
      return
    }

    if (!this.lastTrades[pair]) {
      // the snapshot of a first subscribe is already in the chart history
      this.lastTrades[pair] = { time: Date.now(), tids: {} }
    }

    api.send(
      JSON.stringify({
        method: 'subscribe',
        subscription: {
          type: 'trades',
          coin: pair
        }
      })
    )

    return true
  }

  /**
   * Sub
   * @param {WebSocket} api
   * @param {string} pair
   */
  async unsubscribe(api, pair) {
    if (!(await super.unsubscribe(api, pair))) {
      return
    }

    api.send(
      JSON.stringify({
        method: 'unsubscribe',
        subscription: {
          type: 'trades',
          coin: pair
        }
      })
    )

    return true
  }

  onMessage(event, api) {
    const json = JSON.parse(event.data)

    if (json && json.channel === 'trades') {
      return this.emitTrades(
        api.id,
        json.data
          .filter(t => this.isNewTrade(t))
          .map(t => this.formatResponse(t))
      )
    }
  }

  /**
   * every subscribe starts with the last trades again (a reconnect would count them twice)
   * keep what came after the last trade seen, or after the first subscribe
   */
  isNewTrade(t) {
    let last = this.lastTrades[t.coin]

    if (!last) {
      last = this.lastTrades[t.coin] = { time: 0, tids: {} }
    }

    if (t.time < last.time || (t.time === last.time && last.tids[t.tid])) {
      return false
    }

    if (t.time > last.time) {
      last.time = t.time
      last.tids = {}
    }

    last.tids[t.tid] = true

    return true
  }

  formatResponse(t) {
    return {
      exchange: this.id,
      pair: t.coin,
      timestamp: +new Date(t.time),
      price: +t.px,
      size: +t.sz,
      side: t.side === 'B' ? 'buy' : 'sell'
    }
  }
}
