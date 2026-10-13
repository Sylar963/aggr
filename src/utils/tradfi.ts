/**
 * TradFi / RWA markets (stocks, ETFs, indices, commodities, FX)
 *
 * Exchanges flag those markets in their products endpoint when they can
 * (binance contractType, bybit symbolType, okx instCategory, bitget isRwa).
 * Exchanges that don't (aster, lighter) are matched against those flags, by
 * name and price, see TRADFI_REFERENCE_ENDPOINTS. HIP-3 dexes are tradfi by design.
 *
 * Aliases rename tradfi bases so the same asset share one pair across exchanges
 * (xyz:GOLD, XAUUSDT, XAU-USDT-SWAP -> XAUUSD). Only aliases with matching
 * price scale belong here, SPX is the SPX6900 memecoin on most exchanges.
 */

// HIP-3 dexes are tradfi unless listed here
export const HIP3_CRYPTO_DEXES = new Set(['hyna'])
export const HIP3_CRYPTO_BASES = new Set([
  'BTC',
  'ETH',
  'SOL',
  'HYPE',
  'BTCD',
  'TOTAL2',
  'OTHERS',
  'ANSEM',
  'DRV',
  'TREAD'
])

export function isHip3TradfiMarket(symbol: string) {
  const [dex, base] = symbol.split(':')

  return (
    typeof base !== 'undefined' &&
    !HIP3_CRYPTO_DEXES.has(dex) &&
    !HIP3_CRYPTO_BASES.has(base)
  )
}

// base -> canonical base
const TRADFI_BASE_ALIASES = {
  GOLD: 'XAU',
  SILVER: 'XAG',
  PLATINUM: 'XPT',
  PALLADIUM: 'XPD',
  XCU: 'COPPER',
  WTI: 'CL',
  USOIL: 'CL',
  BRENTOIL: 'BZ',
  NG: 'NATGAS',
  US500: 'SP500',
  XYZ100: 'US100',
  JPN225: 'JP225',
  SKHX: 'SKHYNIX',
  SMSN: 'SAMSUNG',
  TCNT: 'TENCENT',
  ANTH: 'ANTHROPIC',
  OAI: 'OPENAI'
}

// exchange:symbol -> canonical symbol, when a base alias would be wrong
const TRADFI_MARKET_ALIASES = {
  'HYPERLIQUID:xyz:JPY': 'USDJPY', // quoted as USD/JPY (~150)
  'HYPERLIQUID:mkts:US500': 'SPY', // 1/10 of S&P 500
  'HYPERLIQUID:mkts:USTECH': 'QQQ',
  'HYPERLIQUID:mkts:SMALL2000': 'IWM'
}

const FX_PAIR_REGEX = /^(EUR|GBP|AUD|NZD|USD|CHF|CAD|JPY)([A-Z]{3})$/
const FX_CURRENCIES =
  'USD|EUR|GBP|JPY|AUD|NZD|CAD|CHF|HKD|KRW|CNH|CNY|SGD|BRL|MXN|TRY|INR|ZAR'
const FX_SYMBOL_REGEX = new RegExp(`^(${FX_CURRENCIES})(${FX_CURRENCIES})$`)

// max distance to the flagged exchanges median price (crypto with stock ticker: BB, QNT, ON)
const REFERENCE_PRICE_TOLERANCE = 0.25

export function getTradfiMarketAlias(exchangeId: string, symbol: string) {
  return TRADFI_MARKET_ALIASES[exchangeId + ':' + symbol]
}

/**
 * Canonical base & quote of a tradfi market
 * EURUSD/USDT -> EUR/USD, GOLD/USD -> XAU/USD
 */
export function normalizeTradfiPair(base: string, quote: string) {
  const fx = base.match(FX_PAIR_REGEX)

  if (fx) {
    return [fx[1], fx[2]]
  }

  return [TRADFI_BASE_ALIASES[base] || base, quote]
}

// extra words a tradfi market can be searched by (gold -> XAU)
const TRADFI_SEARCH_EXTRAS = {
  CL: ['OIL'],
  BZ: ['OIL', 'BRENT'],
  NATGAS: ['GAS'],
  SP500: ['SPX'],
  US100: ['NDX', 'NASDAQ'],
  JP225: ['NIKKEI'],
  SKHYNIX: ['HYNIX']
}

const TRADFI_SEARCH_KEYWORDS = Object.keys(TRADFI_BASE_ALIASES).reduce(
  (acc, alias) => {
    const base = TRADFI_BASE_ALIASES[alias]

    if (!acc[base]) {
      acc[base] = []
    }

    acc[base].push(alias)

    return acc
  },
  Object.keys(TRADFI_SEARCH_EXTRAS).reduce((acc, base) => {
    acc[base] = [...TRADFI_SEARCH_EXTRAS[base]]
    return acc
  }, {})
)

export function getTradfiSearchKeywords(base: string): string[] {
  return TRADFI_SEARCH_KEYWORDS[base] || []
}

export function getTradfiBase(base: string) {
  return TRADFI_BASE_ALIASES[base] || base
}

/**
 * Flagged exchanges' tradfi markets + prices, to recognize tradfi markets
 * on exchanges without flags. Optional: products still load if they fail.
 * proxy: false for urls the production proxy doesn't allow (they send CORS
 * headers), the others are the same requests as their exchange's products.
 */
export const TRADFI_REFERENCE_ENDPOINTS = [
  ['https://fapi.binance.com/fapi/v1/exchangeInfo', true],
  ['https://fapi.binance.com/fapi/v1/ticker/price', false],
  [
    'https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000',
    false
  ],
  ['https://api.bybit.com/v5/market/tickers?category=linear', false],
  ['https://www.okx.com/api/v5/public/instruments?instType=SWAP', true],
  ['https://www.okx.com/api/v5/market/tickers?instType=SWAP', false],
  [
    'https://api.bitget.com/api/v3/market/instruments?category=USDT-FUTURES',
    true
  ],
  [
    'https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES',
    false
  ]
].map(([url, proxy]) => ({ url, method: 'GET', proxy, optional: true }))

export type TradfiReference = { [base: string]: number }

/**
 * @param responses responses of TRADFI_REFERENCE_ENDPOINTS (null if failed)
 * @returns canonical base -> median price across flagged exchanges
 */
export function buildTradfiReference(responses: any[]): TradfiReference {
  const [
    binanceInfo,
    binancePrices,
    bybitInfo,
    bybitPrices,
    okxInfo,
    okxPrices,
    bitgetInfo,
    bitgetPrices
  ] = responses
  const prices: { [base: string]: number[] } = {}

  const add = (base: string, price: number) => {
    if (!base || !(price > 0)) {
      return
    }

    base = getTradfiBase(base)

    if (!prices[base]) {
      prices[base] = []
    }

    prices[base].push(price)
  }

  // geo blocked / errored endpoints may answer with an object
  const index = (list: any[], key: string, value: string) =>
    (Array.isArray(list) ? list : []).reduce((acc, item) => {
      acc[item[key]] = +item[value]
      return acc
    }, {})

  if (binanceInfo && binancePrices) {
    const last = index(binancePrices, 'symbol', 'price')

    for (const product of Array.isArray(binanceInfo.symbols)
      ? binanceInfo.symbols
      : []) {
      if (product.contractType === 'TRADIFI_PERPETUAL') {
        add(product.baseAsset, last[product.symbol])
      }
    }
  }

  if (bybitInfo && bybitPrices) {
    const last = index(
      bybitPrices.result && bybitPrices.result.list,
      'symbol',
      'lastPrice'
    )

    const products = bybitInfo.result && bybitInfo.result.list

    for (const product of Array.isArray(products) ? products : []) {
      if (/^(stock|ETF|commodity|forex|index)$/.test(product.symbolType)) {
        add(product.baseCoin, last[product.symbol])
      }
    }
  }

  if (okxInfo && okxPrices) {
    const last = index(okxPrices.data, 'instId', 'last')

    for (const product of Array.isArray(okxInfo.data) ? okxInfo.data : []) {
      if (product.instCategory && product.instCategory !== '1') {
        add(product.instId.split('-')[0], last[product.instId])
      }
    }
  }

  if (bitgetInfo && bitgetPrices) {
    const last = index(bitgetPrices.data, 'symbol', 'lastPr')

    for (const product of Array.isArray(bitgetInfo.data)
      ? bitgetInfo.data
      : []) {
      if (product.isRwa === 'YES') {
        add(product.baseCoin, last[product.symbol])
      }
    }
  }

  const reference: TradfiReference = {}

  for (const base in prices) {
    const sorted = prices[base].sort((a, b) => a - b)
    reference[base] = sorted[Math.floor(sorted.length / 2)]
  }

  return reference
}

/**
 * Is a market from an exchange without tradfi flags a tradfi market
 * @param symbol raw symbol, FX pairs are matched on it (EURUSD, USDJPY)
 * @param base canonical base (getTradfiBase)
 * @param price current price, required (except for FX)
 */
export function matchTradfiReference(
  reference: TradfiReference,
  symbol: string,
  base: string,
  price?: number
) {
  const fx = symbol.match(FX_SYMBOL_REGEX)

  if (fx && fx[1] !== fx[2]) {
    return true
  }

  // unknown price can't rule out a coin with a stock ticker (BB, QNT)
  if (!reference[base] || !(price > 0)) {
    return false
  }

  return Math.abs(price / reference[base] - 1) <= REFERENCE_PRICE_TOLERANCE
}
