import Exchange, { Api } from '../exchange'
import { sleep } from '../helpers/utils'
import settings from '../settings'

type BinanceFuturesApi = Api & {
  _liquidationApi?: WebSocket | null
  _liquidationApiClosing?: boolean
}

export default class BINANCE_FUTURES extends Exchange {
  id = 'BINANCE_FUTURES'
  private lastSubscriptionId = 0
  private subscriptions: { [channel: string]: number } = {}
  private specs: { [pair: string]: number }
  private dapi: { [pair: string]: boolean }
  protected maxConnectionsPerApi = 100
  protected delayBetweenMessages = 100
  protected endpoints = {
    PRODUCTS: [
      'https://fapi.binance.com/fapi/v1/exchangeInfo',
      'https://dapi.binance.com/dapi/v1/exchangeInfo'
    ]
  }

  private getTradeChannel() {
    return settings.aggregationLength === -1 ? 'trade' : 'aggTrade'
  }

  private needsParallelLiquidationStream(pair: string) {
    return !this.dapi[pair] && this.getTradeChannel() === 'trade'
  }

  private isDapiApi(api: BinanceFuturesApi) {
    return (api._originalUrl || api.url).includes('dstream.binance.com')
  }

  private getMainSubscriptionParams(pair: string) {
    const channel = this.getTradeChannel()

    if (this.dapi[pair]) {
      return [pair + '@' + channel, pair + '@forceOrder']
    }

    return channel === 'trade'
      ? [pair + '@trade']
      : [pair + '@aggTrade', pair + '@forceOrder']
  }

  async getUrl(pair: string) {
    if (this.dapi[pair]) {
      return 'wss://dstream.binance.com/ws'
    }

    return this.getTradeChannel() === 'trade'
      ? 'wss://fstream.binance.com/public/ws'
      : 'wss://fstream.binance.com/market/ws'
  }

  formatProducts(response) {
    const products = []
    const specs = {}
    const dapi = {}

    for (const data of response) {
      const type = ['fapi', 'dapi'][response.indexOf(data)]

      for (const product of data.symbols) {
        if (
          (product.contractStatus && product.contractStatus !== 'TRADING') ||
          (product.status && product.status !== 'TRADING')
        ) {
          continue
        }

        const symbol = product.symbol.toLowerCase()

        if (type === 'dapi') {
          dapi[symbol] = true
        }

        if (product.contractSize) {
          specs[symbol] = product.contractSize
        }

        products.push(symbol)
      }
    }

    return {
      products,
      specs,
      dapi
    }
  }

  /**
   * Sub
   * @param {WebSocket} api
   * @param {string} pair
   */
  async subscribe(api: BinanceFuturesApi, pair: string) {
    if (!(await super.subscribe(api, pair))) {
      return
    }

    this.subscriptions[pair] = ++this.lastSubscriptionId

    const params = this.getMainSubscriptionParams(pair)

    api.send(
      JSON.stringify({
        method: 'SUBSCRIBE',
        params,
        id: this.subscriptions[pair]
      })
    )

    if (this.needsParallelLiquidationStream(pair)) {
      this.openLiquidationApi(api)
      this.subscribeLiquidations(api, pair)
    }

    await sleep(250 * this.apis.length)

    return true
  }

  /**
   * Unsub
   * @param {WebSocket} api
   * @param {string} pair
   */
  async unsubscribe(api: BinanceFuturesApi, pair: string) {
    if (!(await super.unsubscribe(api, pair))) {
      delete this.subscriptions[pair]

      this.unsubscribeLiquidations(api, pair)

      return
    }

    const params = this.getMainSubscriptionParams(pair)

    api.send(
      JSON.stringify({
        method: 'UNSUBSCRIBE',
        params,
        id: this.subscriptions[pair]
      })
    )

    delete this.subscriptions[pair]

    this.unsubscribeLiquidations(api, pair)

    return true
  }

  onMessage(event, api: BinanceFuturesApi) {
    const json = JSON.parse(event.data)

    if (!json) {
      return
    }

    // Binance SUBSCRIBE / UNSUBSCRIBE ack
    if (json.result === null && typeof json.id !== 'undefined') {
      return true
    }

    if (json.T && (!json.X || json.X === 'MARKET' || json.X === 'RPI')) {
      const symbol = json.s.toLowerCase()
      const price = +json.p
      let size = +json.q

      if (typeof this.specs[symbol] === 'number') {
        size = (size * this.specs[symbol]) / price
      }

      return this.emitTrades(api._id, [
        {
          exchange: this.id,
          pair: symbol,
          timestamp: json.T,
          price: +price,
          size: size,
          side: json.m ? 'sell' : 'buy',
          count:
            typeof json.l === 'number' && typeof json.f === 'number'
              ? json.l - json.f + 1
              : 1
        }
      ])
    }

    if (json.e === 'forceOrder') {
      let size = +json.o.q

      const symbol = json.o.s.toLowerCase()

      if (typeof this.specs[symbol] === 'number') {
        size = (size * this.specs[symbol]) / json.o.p
      }

      return this.emitLiquidations(api._id, [
        {
          exchange: this.id,
          pair: symbol,
          timestamp: json.o.T,
          price: +json.o.p,
          size: size,
          side: json.o.S === 'BUY' ? 'buy' : 'sell',
          liquidation: true
        }
      ])
    }
  }

  openLiquidationApi(api: BinanceFuturesApi) {
    if (this.isDapiApi(api) || this.getTradeChannel() !== 'trade') {
      return
    }

    if (
      api._liquidationApi &&
      (api._liquidationApi.readyState === WebSocket.OPEN ||
        api._liquidationApi.readyState === WebSocket.CONNECTING)
    ) {
      return
    }

    api._liquidationApiClosing = false

    const liquidationApi = new WebSocket('wss://fstream.binance.com/market/ws')
    api._liquidationApi = liquidationApi

    liquidationApi.onopen = () => {
      for (const pair of api._connected) {
        this.subscribeLiquidations(api, pair)
      }
    }

    liquidationApi.onmessage = event => this.onMessage(event, api)

    liquidationApi.onclose = () => {
      if (api._liquidationApi !== liquidationApi) {
        return
      }

      api._liquidationApi = null

      for (const pair of api._connected || []) {
        delete this.subscriptions[pair + '@forceOrder']
      }

      if (api._liquidationApiClosing) {
        return
      }

      if (api.readyState === WebSocket.OPEN) {
        console.debug(
          `[${this.id}] liquidation api closed unexpectedly, reopen now`
        )

        this.openLiquidationApi(api)
      }
    }

    liquidationApi.onerror = event => {
      console.debug(`[${this.id}] liquidation api errored`, event)
    }
  }

  subscribeLiquidations(api: BinanceFuturesApi, pair: string) {
    if (!this.needsParallelLiquidationStream(pair)) {
      return
    }

    if (
      !api._liquidationApi ||
      api._liquidationApi.readyState !== WebSocket.OPEN
    ) {
      return
    }

    const param = pair + '@forceOrder'

    if (this.subscriptions[param]) {
      return
    }

    this.subscriptions[param] = ++this.lastSubscriptionId

    api._liquidationApi.send(
      JSON.stringify({
        method: 'SUBSCRIBE',
        params: [param],
        id: this.subscriptions[param]
      })
    )
  }

  unsubscribeLiquidations(api: BinanceFuturesApi, pair: string) {
    const param = pair + '@forceOrder'

    if (!this.needsParallelLiquidationStream(pair)) {
      return
    }

    if (
      !this.subscriptions[param] ||
      !api._liquidationApi ||
      api._liquidationApi.readyState !== WebSocket.OPEN
    ) {
      delete this.subscriptions[param]
      return
    }

    api._liquidationApi.send(
      JSON.stringify({
        method: 'UNSUBSCRIBE',
        params: [param],
        id: this.subscriptions[param]
      })
    )

    delete this.subscriptions[param]
  }

  onApiCreated(api: BinanceFuturesApi) {
    api._liquidationApiClosing = false
    this.openLiquidationApi(api)
  }

  onApiRemoved(api: BinanceFuturesApi) {
    api._liquidationApiClosing = true

    if (
      api._liquidationApi &&
      (api._liquidationApi.readyState === WebSocket.OPEN ||
        api._liquidationApi.readyState === WebSocket.CONNECTING)
    ) {
      api._liquidationApi.close()
    }
  }
}
