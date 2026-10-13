/**
 * TradFi / RWA markets (stocks, ETFs, indices, commodities, FX)
 *
 * Exchanges flag those markets in their products endpoint when they can
 * (binance contractType, bybit symbolType, okx instCategory, bitget isRwa).
 * The lists below cover exchanges that don't (aster, lighter, hyperliquid HIP-3).
 *
 * Aliases rename tradfi bases so the same asset share one pair across exchanges
 * (xyz:GOLD, XAUUSDT, XAU-USDT-SWAP -> XAUUSD). Only aliases with matching
 * price scale belong here, SPX is the SPX6900 memecoin on most exchanges.
 */

// raw symbols, verified against flagged exchanges prices
export const ASTER_TRADFI_SYMBOLS = new Set(
  'AAOIUSDT AAPLUSDT ADBEUSDT AGPUUSDT AMATUSDT AMDUSDT AMZNUSDT ANTHROPICUSDT ARMUSDT ASMLUSDT ASTSUSDT AVGOUSDT AXTIUSDT BABAUSDT BBXUSDT BEUSDT BMNRUSDT BRKBUSDT BXUSDT BZUSDT CBRSUSDT CLUSDT COHRUSDT COINUSDT COSTUSDT CRCLUSDT CRDOUSDT CRMUSDT CRWDUSDT CRWVUSDT CSCOUSDT CXMTUSDT DELLUSDT DISUSDT DKNGUSDT DRAMUSDT EBAYUSDT EWJUSDT EWTUSDT EWYUSDT EWZUSDT FLNCUSDT FUTUUSDT GLWUSDT GMEUSDT GOOGLUSDT HDUSDT HIMSUSDT HOODUSDT HPEUSDT HYUNDAIUSDT IBMUSDT INTCUSDT IRENUSDT IWMUSDT JPMUSDT KORUUSDT KSTRUSDT KUAISHOUUSDT LITEUSDT LLYUSDT LYTEUSDT MEITUANUSDT METAUSDT MINIMAXUSDT MRNAUSDT MRVLUSDT MSFTUSDT MSTRUSDT MUUSDT MUUUSDT NATGASUSDT NBISUSDT NFLXUSDT NOKUSDT NOWUSDT NVDAUSDT NVOUSDT ONDSUSDT OPENAIUSDT ORCLUSDT PAXGUSDT PAYPUSDT PLTRUSDT POPMARTUSDT QCOMUSDT QNTXUSDT QQQUSDT RIVNUSDT RKLBUSDT SAMSUNGUSDT SKHYNIXUSDT SKHYUSDT SNDKUSDT SNXXUSDT SOXLUSDT SPCXUSDT SPYUSDT STRCUSDT STXXUSDT TENCENTUSDT TQQQUSDT TSLAUSDT TSMUSDT UBERUSDT UNITREEUSDT URNMUSDT USARUSDT UVXYUSDT VUSDT WDCUSDT WMTUSDT XAGUSDT XAUUSDT XCUUSDT XIAOMIUSDT XLEUSDT XPDUSDT XPTUSDT ZHIPUUSDT ZMUSDT EURUSD GBPUSD JPYUSD'.split(
    ' '
  )
)

export const LIGHTER_TRADFI_SYMBOLS = new Set(
  'AAOI AAPL AMD AMZN ANTHROPIC ARM ASML AUDUSD AVGO AXTI BABA BB BE BMNR BOT BRENTOIL BYD CBRS COIN CRCL CRWV CXMT DELL DRAM EURUSD EWY GBPUSD GEV GME GOOGL H100 HOOD HYUNDAIUSD IBM INTC IWM KIOXIA KORU LITE META MINIMAX MRNA MRVL MSFT MSTR MU NATGAS NBIS NOK NOW NVDA NZDUSD OPENAI ORCL OURA PAXG PLTR POPMART QCOM QQQ RKLB SAMSUNGUSD SHEIN SKHY SKHYNIXUSD SMIC SNDK SOXL SOXS SPCX SPY STRC TENCENT TSLA TSM TTWO UNITREE US100 US10Y US500 USDCAD USDCHF USDHKD USDJPY USDKRW WDC WEN WTI XAG XAU XCU XIAOMI XPD XPT ZHIPU'.split(
    ' '
  )
)

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
