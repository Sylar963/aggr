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
        json.data.map(t => this.formatResponse(t))
      )
    }
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
