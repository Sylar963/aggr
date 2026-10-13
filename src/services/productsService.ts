import store from '@/store'
import { ProductsData, ProductsStorage } from '@/types/types'
import { PRODUCTS_EXPIRES_AFTER } from '@/utils/constants'
import { getApiUrl } from '../utils/helpers'
import aggregatorService from './aggregatorService'
import workspacesService from './workspacesService'
import { getTradfiMarketAlias, normalizeTradfiPair } from '../utils/tradfi'

const COINBASE_INTX_REGEX = /-INTX$/
const BITFINEX_PERP_REGEX = /F0$/
const BITFINEX_FUTURES_REGEX = /(.*)F0:(\w+)F0/
const BITFINEX_UST_REGEX = /UST($|F0)/
const HUOBI_FUTURES_REGEX = /_(CW|CQ|NW|NQ)$/
const UNDERSCORE_REGEX = /_/
const DASH_REGEX = /-/
const DASH_SPOT_REGEX = /-SPOT$/
const SWAP_OR_PERP_REGEX = /(-|_)swap$|(-|_|:)perp/i
const SWAP_SUFFIX_REGEX = /-swap$/i
const TWO_DIGITS_REGEX = /\d{2}/
const KRAKEN_FUTURES_REGEX = /(PI|FI|PF|FF)_/
const HUOBI_SUFFIXES_REGEX = /_CW|_CQ|_NW|_NQ/i
const DERIBIT_PERP_REGEX = /_(\w+)-PERPETUAL/i
const KUCOIN_SUFFIX_REGEX = /M$/
const PERP_QUOTE_REGEX = /-PERP(ETUAL)?/i
const XBT_BASE_REGEX = /xbt$|^xbt/i
const PERP_SUFFIX_REGEX = /[^a-z0-9](perp|swap|perpetual)$/i
const DIGIT_PREFIX_REGEX = /[^a-z0-9]\d+$/i
const SYMBOL_DELIMITER_REGEX = /[-_/:]/
const EVERYTHING_BINANCE_REGEX = /BINANCE/
const REVERSE_MATCH_REGEX = /(\w+)[^a-z0-9]/i
const COMMON_FUTURES_SUFFIX_REGEX = /[HUZ_-]\d{2}/
// perpetuals only, digits never mean an expiry there (H100, xyz:XYZ100)
const PERP_ONLY_EXCHANGES = ['DYDX', 'HYPERLIQUID', 'ASTER', 'LIGHTER']
const PARSE_MARKET_REGEX = /([^:]*):(.*)/
const BITUNIX_PERP_REGEX = /[A-Z]/
const HIP3_DEX_PREFIX_REGEX = /^[a-z0-9]+:/
const USD_PAIR_REGEX = /^[A-Z0-9]{3,}USD$|^USD[A-Z]{3}$/
const TRADFI_STORAGE_KEY = 'TRADFI_MARKETS'

const stablecoins = [
  'USDT',
  'USDC',
  'TUSD',
  'BUSD',
  'USDD',
  'USDK',
  'USDP',
  'FDUSD',
  'UST',
  'USD1'
]

const normalStablecoinLookup = /^U/

const normalStablecoins = stablecoins.filter(s =>
  normalStablecoinLookup.test(s)
)

const reverseStablecoins = stablecoins.filter(
  s => !normalStablecoinLookup.test(s)
)

const currencies = ['EUR', 'USD', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'CNH']

// trailing letter or 1: USDT, USDC, USD1 -> USD
const genericQuoteCurrencyLookup = new RegExp(
  `[a-z]*(${currencies.join('|')})(?:[a-z]|1)?$`,
  'i'
)
const reverseStablecoinPairLookup = new RegExp(
  `(\\w{3,})(${reverseStablecoins.join('|')})$`,
  'i'
)
const standardCurrencyPairLookup = new RegExp(
  `(\\w{3})?(${currencies.join('|')})(?:[a-z]|1)?$`,
  'i'
)
const currencyPairLookup = new RegExp(
  `^([A-Z0-9]+)[-/:]?(${currencies.join('|')})$`
)

// one letter bases are fine for normal stablecoins (SUSDT -> S/USDT), 3+ for reversed
// not infallible but avoids coin with symbol finishing with T or B to be labeled as TUSD or BUSD quoted markets
const stablecoinPairLookup = new RegExp(
  `^([A-Z0-9]+)[-/:_]?(${normalStablecoins.join(
    '|'
  )})$|^([A-Z0-9]{3,})[-/:_]?(${reverseStablecoins.join('|')})$`
)
const simplePairLookup = new RegExp(`^([A-Z0-9]{2,})[-/_]?([A-Z0-9]{3,})$`)
// one letter base only when delimited (A_BTC), adau is ADA/U not A/DAU
const delimitedPairLookup = new RegExp(`^([A-Z0-9]+)[-/_]([A-Z][A-Z0-9]{2,})$`)

const promisesOfProducts = {}

// same endpoint requested by multiple exchanges (tradfi references)
const REQUESTS_CACHE_DURATION = 1000 * 60 * 2
const requestsCache: {
  [key: string]: { timestamp: number; promise: Promise<any> }
} = {}

function fetchJson(url: string, method: string, body?: string) {
  const key = method + url + (body || '')
  const now = Date.now()

  if (
    requestsCache[key] &&
    now - requestsCache[key].timestamp < REQUESTS_CACHE_DURATION
  ) {
    return requestsCache[key].promise
  }

  const headers: Record<string, string> = {}

  if (method === 'POST' && body) {
    headers['Content-Type'] = 'application/json'
  }

  const promise = fetch(url, {
    headers,
    method,
    body
  }).then(response => response.json())

  requestsCache[key] = { timestamp: now, promise }

  promise.catch(() => {
    delete requestsCache[key]
  })

  return promise
}

export const indexedProducts = {}

export const marketDecimals = {}

// exchange -> tradfi symbols, persisted so getMarketProduct can stay sync
const tradfiMarkets: { [exchangeId: string]: Set<string> } = {}

try {
  const stored = JSON.parse(localStorage.getItem(TRADFI_STORAGE_KEY)) || {}

  for (const exchangeId in stored) {
    tradfiMarkets[exchangeId] = new Set(stored[exchangeId])
  }
} catch (error) {
  // no stored tradfi markets
}

function registerTradfiMarkets(exchangeId: string, productsData: ProductsData) {
  if (!productsData || Array.isArray(productsData) || !productsData.tradfi) {
    return
  }

  tradfiMarkets[exchangeId] = new Set(productsData.tradfi)

  try {
    localStorage.setItem(
      TRADFI_STORAGE_KEY,
      JSON.stringify(
        Object.keys(tradfiMarkets).reduce((acc, id) => {
          acc[id] = Array.from(tradfiMarkets[id])
          return acc
        }, {})
      )
    )
  } catch (error) {
    console.error('[products] failed to persist tradfi markets', error)
  }
}

export function isTradfiMarket(exchangeId: string, symbol: string) {
  return !!(tradfiMarkets[exchangeId] && tradfiMarkets[exchangeId].has(symbol))
}

/**
 * 1. app send products request to worker
 * 2. worker send products request endpoints
 * 3. app call getStoredProductsOrFetch with worker's endpoints
 * 4. getStoredProductsOrFetch first try to retrieve from workspace storage
 * 5. if not found or forceFetch is true, getStoredProductsOrFetch will fetch using worker's endpoints
 * 6. aquired productsData are sent back to worker for assignation in the exchange class
 * @param exchangeId
 * @param {boolean} forceFetch
 * @returns
 */
export function requestExchangeProductsData(
  exchangeId: string,
  forceFetch = false
) {
  if (promisesOfProducts[exchangeId]) {
    console.debug(`[products.${exchangeId}] use promise of products`)
    return promisesOfProducts[exchangeId]
  }

  promisesOfProducts[exchangeId] = aggregatorService
    .dispatchAsync({
      op: 'fetchExchangeProducts',
      data: { exchangeId, forceFetch }
    })
    .then(data => {
      delete promisesOfProducts[exchangeId]
      return data
    })

  return promisesOfProducts[exchangeId]
}

async function getExchangeStoredProductsData(exchangeId: string) {
  console.debug(`[products.${exchangeId}] reading stored products`)

  const storage = await workspacesService.getProducts(exchangeId)

  if (storage) {
    return storage
  }

  return null
}

function saveExchangeProductsData(
  exchangeId: string,
  productsData: ProductsData
) {
  console.log(`[products.${exchangeId}] saving products`)

  return workspacesService.saveProducts({
    exchange: exchangeId,
    data: productsData,
    timestamp: Date.now()
  })
}

/**
 * 1. get raw symbols data from exchange API
 * 2. send response(s) to worker for formatting
 * 3. worker returns formatted products data (productsData)
 * 4. return productsData
 * @param {string} exchangeId exchange to fetch products for
 * @param {string[]} endpoints list of URL to fetch
 * @returns {Promise<ProductsData>}
 */
async function fetchExchangeProducts(
  exchangeId: string,
  endpoints: string[]
): Promise<ProductsData> {
  if (!Array.isArray(endpoints)) {
    endpoints = [endpoints]
  }

  console.debug(
    `[products.${exchangeId}] fetching latest products...`,
    endpoints
  )

  let data = []
  let failed = false

  for (const instruction of endpoints) {
    let endpoint: {
      url: string
      method: string
      data?: string
      proxy?: boolean
      optional?: boolean
    }

    if (typeof instruction === 'string') {
      endpoint = {
        url: instruction,
        method: 'GET'
      }
    } else {
      endpoint = { ...instruction }
    }

    if (
      endpoint.proxy !== false &&
      import.meta.env.VITE_APP_PROXY_URL &&
      !/^https:\/\/raw.githubusercontent.com\//.test(endpoint.url)
    ) {
      endpoint.url = import.meta.env.VITE_APP_PROXY_URL + endpoint.url
    }

    try {
      data[endpoints.indexOf(instruction)] = await fetchJson(
        endpoint.url,
        endpoint.method,
        endpoint.data
      )
    } catch (error) {
      console.error(`[${exchangeId}] couldn't parse non-json products`, error)

      data[endpoints.indexOf(instruction)] = null

      if (endpoint.optional) {
        continue
      }

      failed = true
    }
  }

  if (failed) {
    // today if one of the endpoint fail, consider they all failed
    // todo => accept this set of products without saving
    data = null
  } else if (data.length === 1) {
    data = data[0]
  }

  if (data) {
    const productsData = (await aggregatorService.dispatchAsync({
      op: 'formatExchangeProducts',
      data: {
        exchangeId: exchangeId,
        response: data
      }
    })) as ProductsStorage

    if (productsData) {
      return saveExchangeProductsData(exchangeId, productsData).then(
        () => productsData
      )
    }

    return null
  } else {
    return null
  }
}

export async function getStoredProductsOrFetch(
  exchangeId: string,
  endpoints: string[],
  forceFetch?: boolean
): Promise<ProductsData> {
  let productsStorage: ProductsStorage
  let productsData: ProductsData

  if (
    forceFetch ||
    !(productsStorage = await getExchangeStoredProductsData(exchangeId)) ||
    Date.now() - productsStorage.timestamp > PRODUCTS_EXPIRES_AFTER
  ) {
    console.debug(
      `[products.${exchangeId}] fetch products using provided endpoints`
    )

    if (indexedProducts[exchangeId]) {
      delete indexedProducts[exchangeId]
    }

    productsData = await fetchExchangeProducts(exchangeId, endpoints)
  } else {
    console.debug(`[products.${exchangeId}] using products exchange storage`)
    productsData = productsStorage.data
  }

  registerTradfiMarkets(exchangeId, productsData)

  return productsData
}

export function stripStablePair(pair) {
  return pair
    .replace(reverseStablecoinPairLookup, '$1USD')
    .replace(standardCurrencyPairLookup, '$1$2')
}

export function stripStableQuote(quote) {
  return quote.replace(genericQuoteCurrencyLookup, '$1')
}

export async function getExchangeSymbols(
  exchangeId: string,
  forceFetch = false
) {
  let symbols

  const data = await requestExchangeProductsData(exchangeId, forceFetch)

  if (data) {
    if (Array.isArray(data)) {
      symbols = data
    } else {
      symbols = data.products
    }
  }

  if (!symbols) {
    symbols = []
  }

  return symbols
}

export function parseMarket(market: string) {
  return market.match(PARSE_MARKET_REGEX).slice(1, 3)
}

export function getMarketProduct(exchangeId, symbol, noStable?: boolean) {
  const id = exchangeId + ':' + symbol

  let type = 'spot'

  if (PERP_ONLY_EXCHANGES.indexOf(exchangeId) !== -1) {
    type = 'perp'
  } else if (COMMON_FUTURES_SUFFIX_REGEX.test(symbol)) {
    type = 'future'
  } else if (exchangeId === 'BINANCE_FUTURES') {
    type = 'perp'
  } else if (exchangeId === 'COINBASE' && COINBASE_INTX_REGEX.test(symbol)) {
    type = 'perp'
  } else if (exchangeId === 'BITFINEX' && BITFINEX_PERP_REGEX.test(symbol)) {
    type = 'perp'
  } else if (exchangeId === 'HUOBI' && HUOBI_FUTURES_REGEX.test(symbol)) {
    type = 'future'
  } else if (exchangeId === 'BITMART' && !UNDERSCORE_REGEX.test(symbol)) {
    type = 'perp'
  } else if (exchangeId === 'MEXC' && UNDERSCORE_REGEX.test(symbol)) {
    type = 'perp'
  } else if (exchangeId === 'HUOBI' && DASH_REGEX.test(symbol)) {
    type = 'perp'
  } else if (
    (exchangeId === 'BYBIT' ||
      exchangeId === 'GATEIO' ||
      exchangeId === 'BITGET') &&
    !DASH_SPOT_REGEX.test(symbol)
  ) {
    if (exchangeId === 'BYBIT' && TWO_DIGITS_REGEX.test(symbol)) {
      type = 'future'
    } else {
      type = 'perp'
    }
  } else if (exchangeId === 'BITMEX' || SWAP_OR_PERP_REGEX.test(symbol)) {
    // swaps never expire, digits belong to the base (US500-USDT-SWAP)
    if (TWO_DIGITS_REGEX.test(symbol) && !SWAP_SUFFIX_REGEX.test(symbol)) {
      type = 'future'
    } else {
      type = 'perp'
    }
  } else if (exchangeId === 'PHEMEX' && symbol[0] !== 's') {
    type = 'perp'
  } else if (
    exchangeId === 'KRAKEN' &&
    UNDERSCORE_REGEX.test(symbol) &&
    type === 'spot'
  ) {
    type = 'perp'
  } else if (exchangeId === 'KUCOIN' && symbol.indexOf('-') === -1) {
    type = 'perp'
  } else if (exchangeId === 'BITUNIX' && BITUNIX_PERP_REGEX.test(symbol)) {
    type = 'perp'
  }

  const tradfi = isTradfiMarket(exchangeId, symbol)

  let localSymbol =
    (tradfi && getTradfiMarketAlias(exchangeId, symbol)) || symbol

  if (exchangeId === 'BYBIT' || exchangeId === 'GATEIO') {
    localSymbol = localSymbol.replace(DASH_SPOT_REGEX, '')
  } else if (exchangeId === 'KRAKEN') {
    localSymbol = localSymbol.replace(KRAKEN_FUTURES_REGEX, '')
  } else if (exchangeId === 'BITFINEX') {
    localSymbol = localSymbol
      .replace(BITFINEX_FUTURES_REGEX, '$1-$2')
      .replace(BITFINEX_UST_REGEX, 'USDT$1')
  } else if (exchangeId === 'HUOBI') {
    localSymbol = localSymbol.replace(HUOBI_SUFFIXES_REGEX, 'USD')
  } else if (exchangeId === 'DERIBIT') {
    localSymbol = localSymbol.replace(DERIBIT_PERP_REGEX, '$1')
  } else if (exchangeId === 'KUCOIN') {
    localSymbol = localSymbol.replace(KUCOIN_SUFFIX_REGEX, '')
  } else if (exchangeId === 'COINBASE' && type === 'perp') {
    localSymbol = localSymbol.replace(COINBASE_INTX_REGEX, '')
  } else if (exchangeId === 'HYPERLIQUID') {
    localSymbol = localSymbol.replace(HIP3_DEX_PREFIX_REGEX, '')

    if (!tradfi || !USD_PAIR_REGEX.test(localSymbol)) {
      localSymbol = localSymbol.replace(/^k/, '') + 'USD'
    }
  } else if (exchangeId === 'LIGHTER') {
    // FX pairs and some stocks already are USD pairs (EURUSD, HYUNDAIUSD)
    if (!tradfi || !USD_PAIR_REGEX.test(localSymbol)) {
      localSymbol = localSymbol + 'USD'
    }
  } else if (exchangeId === 'PHEMEX') {
    localSymbol = localSymbol.replace(/^[a-z]/, '')
  } else if (exchangeId === 'WHITEBIT') {
    localSymbol = localSymbol.replace(/_PERP$/, 'USDT')
  } else if (exchangeId === 'BITGET') {
    localSymbol = localSymbol
      .replace(DASH_SPOT_REGEX, '')
      .replace(/PERP$/, 'USDC')
  }

  localSymbol = localSymbol
    .replace(XBT_BASE_REGEX, 'BTC')
    .replace(PERP_QUOTE_REGEX, '-USD')
    .replace(PERP_SUFFIX_REGEX, '')
    .replace(DIGIT_PREFIX_REGEX, '')
    .toUpperCase()

  let localSymbolAlpha = localSymbol.replace(SYMBOL_DELIMITER_REGEX, '')

  let match
  if (!EVERYTHING_BINANCE_REGEX.test(exchangeId)) {
    match = localSymbol.match(currencyPairLookup)
  }

  if (!match) {
    match = localSymbol.match(stablecoinPairLookup)

    if (!match) {
      match = localSymbol.match(delimitedPairLookup)
    }

    if (!match) {
      match = localSymbolAlpha.match(simplePairLookup)
    }

    if (!match && (exchangeId === 'DERIBIT' || exchangeId === 'HUOBI')) {
      match = localSymbolAlpha.match(REVERSE_MATCH_REGEX)

      if (match) {
        match[2] = match[1]
      }
    }
  }
  if (!match) {
    return null
  }

  let base
  let quote

  if (match[1] === undefined && match[2] === undefined) {
    base = match[3]
    quote = match[4] || ''
  } else {
    base = match[1]
    quote = match[2] || ''
  }

  if (tradfi) {
    const normalized = normalizeTradfiPair(base, quote)
    base = normalized[0]
    quote = normalized[1]
  }

  if (noStable) {
    localSymbolAlpha = stripStablePair(base + quote)
  } else {
    localSymbolAlpha = base + quote
  }

  return {
    id,
    base,
    quote,
    pair: symbol,
    local: localSymbolAlpha,
    exchange: exchangeId,
    type,
    tradfi
  }
}

// markets served by an extra history server (VITE_APP_EXTRA_API_URLS) -> its url
export const historicalMarketsSources: { [market: string]: string } = {}

const EXTRA_API_URLS = (import.meta.env.VITE_APP_EXTRA_API_URLS || '')
  .split(',')
  .map(url => url.trim())
  .filter(url => url.length)
  .map(url => (/\/$/.test(url) ? url : url + '/'))

async function fetchApiProducts(url: string, cacheKey: string) {
  const now = Date.now()

  try {
    const cache = JSON.parse(localStorage.getItem(cacheKey))

    if (!cache || !cache.products) {
      throw new Error('api supported pairs products cache is invalid')
    }

    if (!cache.products.length) {
      throw new Error('api supported pairs need a refresh')
    }

    if (now - cache.timestamp > 1000 * 60 * 5) {
      throw new Error('api supported pairs products cache has expired')
    }

    return cache.products
  } catch (error) {
    // console.error(error)
  }

  try {
    const products = await fetch(url).then(response => {
      if (!response.ok) {
        throw new Error(`${url} responded with HTTP ${response.status}`)
      }

      return response.json()
    })

    if (!Array.isArray(products) || !products.length) {
      throw new Error('invalid supported markets list')
    }

    localStorage.setItem(
      cacheKey,
      JSON.stringify({
        products,
        timestamp: now
      })
    )

    return products
  } catch (error) {
    console.error(error)
  }

  return null
}

export async function getApiSupportedMarkets() {
  let products = import.meta.env.VITE_APP_API_SUPPORTED_PAIRS as
    | string
    | string[]
  if (products && products.length) {
    products = (products as string).split(',').map(market => market.trim())
  } else {
    products = []
  }

  if (import.meta.env.VITE_APP_API_URL) {
    products =
      (await fetchApiProducts(getApiUrl('products'), 'API_SUPPORTED_PAIRS')) ||
      products
  }

  // tradfi (or any other) markets recorded by another aggr-server
  const extraProductsByUrl = await Promise.all(
    EXTRA_API_URLS.map(url =>
      fetchApiProducts(url + 'products', 'API_SUPPORTED_PAIRS:' + url)
    )
  )

  for (let i = 0; i < EXTRA_API_URLS.length; i++) {
    const url = EXTRA_API_URLS[i]
    const extraProducts = extraProductsByUrl[i]

    if (!extraProducts) {
      continue
    }

    const markets = products as string[]

    for (const market of extraProducts) {
      if (markets.indexOf(market) === -1) {
        historicalMarketsSources[market] = url
        markets.push(market)
      }
    }
  }

  return products
}

export async function indexProducts(exchangeId: string, symbols: string[]) {
  console.debug(`[products.${exchangeId}] indexed ${symbols.length} products`)

  indexedProducts[exchangeId] = symbols.reduce((acc, symbol) => {
    const product = getMarketProduct(exchangeId, symbol)

    if (product) {
      acc.push(product)
    }

    return acc
  }, [])

  return indexedProducts[exchangeId]
}

export async function ensureIndexedProducts(filter?: {
  [id: string]: boolean
}) {
  let indexChanged = false

  for (const exchangeId of store.getters['exchanges/getExchanges']) {
    if (
      (filter && !filter[exchangeId]) ||
      store.state.exchanges[exchangeId].disabled === true ||
      indexedProducts[exchangeId]
    ) {
      continue
    }

    await indexProducts(exchangeId, await getExchangeSymbols(exchangeId))

    indexChanged = true
  }

  return indexChanged
}

export async function resolvePairs(pairs: string[]) {
  const markets = []

  const historicalMarkets = store.state.app.historicalMarkets
  const searchPreference = store.state.settings.searchTypes
  const historicalOnly = searchPreference.historical
  const searchTypes = {
    spot: searchPreference.spots,
    perp: searchPreference.perpetuals,
    future: searchPreference.futures
  }
  const allTypes = !(searchTypes.spot || searchTypes.perp || searchTypes.future)
  const searchTradfi = !!searchPreference.tradfi
  const allCategories = searchTradfi === !!searchPreference.crypto
  const searchQuotes = store.state.settings.searchQuotes
  const allQuotes = !Object.values(searchQuotes).find(filtered => !!filtered)

  for (const exchangeId of store.getters['exchanges/getExchanges']) {
    if (store.state.exchanges[exchangeId].disabled === true) {
      continue
    }

    const symbols = await getExchangeSymbols(exchangeId)

    for (const symbol of symbols) {
      const product = getMarketProduct(exchangeId, symbol, true)

      if (!product) {
        continue
      }

      if (
        historicalOnly &&
        !(searchTradfi && product.tradfi) &&
        historicalMarkets.indexOf(product.id) === -1
      ) {
        continue
      }

      if (!allTypes && !searchTypes[product.type]) {
        continue
      }

      if (!allCategories && product.tradfi !== searchTradfi) {
        continue
      }

      if (!allQuotes && !searchQuotes[product.quote]) {
        continue
      }

      if (pairs.indexOf(product.local) !== -1) {
        markets.push(product.id)
      }
    }
  }

  if (!markets.length) {
    return null
  }

  return markets
}

export async function resolvePair(base: string, quote: string) {
  const markets = []

  const stripedStableQuote = stripStableQuote(quote)

  for (const exchangeId in indexedProducts) {
    if (store.state.exchanges[exchangeId].disabled === true) {
      continue
    }

    for (const product of indexedProducts[exchangeId]) {
      if (
        product.base === base &&
        stripStableQuote(product.quote) === stripedStableQuote
      ) {
        markets.push(product.id)
      }
    }
  }

  return markets
}

export function formatAmount(amount, decimals?: number) {
  const negative = amount < 0

  amount = Math.abs(amount)

  if (amount >= 1000000000) {
    amount =
      +(amount / 1000000000).toFixed(isNaN(decimals) ? 1 : decimals) + ' B'
  } else if (amount >= 1000000) {
    amount = +(amount / 1000000).toFixed(isNaN(decimals) ? 1 : decimals) + ' M'
  } else if (amount >= 1000) {
    amount = +(amount / 1000).toFixed(isNaN(decimals) ? 1 : decimals) + ' K'
  } else {
    amount = +amount.toFixed(isNaN(decimals) ? 2 : decimals)
  }

  if (negative) {
    return '-' + amount
  } else {
    return amount
  }
}

export function countDecimals(value) {
  const parts = value.toString().split('.')

  if (parts.length === 2) {
    return parts[1].length
  }

  return 0
}

export function formatMarketPrice(price, market): string {
  if (typeof marketDecimals[market] === 'undefined') {
    return price
  }

  if (!price) {
    price = 0
  }

  return price.toFixed(marketDecimals[market])
}

export function formatPrice(price, precision?: number): number {
  if (!precision) {
    return parseInt(price)
  }

  if (!price) {
    price = 0
  }

  return price.toFixed(precision)
}
