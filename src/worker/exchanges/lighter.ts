import Exchange from '../exchange'
import {
  buildTradfiReference,
  getTradfiBase,
  matchTradfiReference,
  TRADFI_REFERENCE_ENDPOINTS
} from '@/utils/tradfi'

// HYUNDAIUSD -> HYUNDAI, but EURUSD stays a pair
const USD_SUFFIX_REGEX = /^([A-Z0-9]{4,})USD$/

export default class LIGHTER extends Exchange {
  id = 'LIGHTER'

  protected maxConnectionsPerApi = 50
  protected delayBetweenMessages = 50

  // symbol (XAU) -> market id (92), channels are by market id
  private marketIds: { [pair: string]: number }
  private pairs: { [marketId: string]: string }

  protected endpoints = {
    PRODUCTS: [
      'https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails',
      ...TRADFI_REFERENCE_ENDPOINTS
    ]
  }

  async getUrl() {
    return 'wss://mainnet.zklighter.elliot.ai/stream'
  }

  validateProducts(data) {
    if (!data.marketIds || !data.tradfi) {
      return false
    }

    return true
  }

  formatProducts([details, ...references]) {
    const products = []
    const marketIds = {}
    const pairs = {}
    const tradfi = []

    // lighter doesn't flag stocks, commodities & fx, compare with exchanges that do
    const reference = buildTradfiReference(references)

    for (const market of details.order_book_details) {
      if (market.market_type !== 'perp' || market.status !== 'active') {
        continue
      }

      products.push(market.symbol)
      marketIds[market.symbol] = market.market_id
      pairs[market.market_id] = market.symbol

      const base = getTradfiBase(market.symbol.replace(USD_SUFFIX_REGEX, '$1'))

      if (
        matchTradfiReference(
          reference,
          market.symbol,
          base,
          +market.last_trade_price || +market.mark_price
        )
      ) {
        tradfi.push(market.symbol)
      }
    }

    return {
      products,
      marketIds,
      pairs,
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
        type: 'subscribe',
        channel: 'trade/' + this.marketIds[pair]
      })
    )

    return true
  }

  /**
   * Unsub
   * @param {WebSocket} api
   * @param {string} pair
   */
  async unsubscribe(api, pair) {
    if (!(await super.unsubscribe(api, pair))) {
      return
    }

    api.send(
      JSON.stringify({
        type: 'unsubscribe',
        channel: 'trade/' + this.marketIds[pair]
      })
    )

    return true
  }

  onMessage(event, api) {
    const json = JSON.parse(event.data)

    // subscribed/trade is a snapshot of past trades
    if (!json || json.type !== 'update/trade') {
      return
    }

    const liquidationIds = {}

    if (json.liquidation_trades && json.liquidation_trades.length) {
      for (const trade of json.liquidation_trades) {
        liquidationIds[trade.trade_id] = true
      }

      this.emitLiquidations(
        api._id,
        json.liquidation_trades.map(trade => this.formatTrade(trade, true))
      )
    }

    if (json.trades && json.trades.length) {
      const trades = json.trades
        .filter(trade => !liquidationIds[trade.trade_id])
        .map(trade => this.formatTrade(trade))

      if (trades.length) {
        return this.emitTrades(api._id, trades)
      }
    }
  }

  formatTrade(trade, liquidation?: boolean) {
    const output: any = {
      exchange: this.id,
      pair: this.pairs[trade.market_id],
      timestamp: trade.timestamp,
      price: +trade.price,
      size: +trade.size,
      // maker is the ask -> taker bought
      side: trade.is_maker_ask ? 'buy' : 'sell'
    }

    if (liquidation) {
      output.liquidation = true
    }

    return output
  }

  onApiCreated(api) {
    // lighter closes connections without client message for ~2 min
    this.startKeepAlive(api, { type: 'ping' }, 30000)
  }

  onApiRemoved(api) {
    this.stopKeepAlive(api)
  }
}
