/* eslint-env node */
/* global globalThis */
/**
 * List the tradfi perpetual markets aggr detects (same connectors & rules as
 * the app) so an aggr-server can record them, like api.aggr.trade does for crypto.
 *
 * node scripts/tradfi-pairs.mjs                       -> print markets as JSON
 * node scripts/tradfi-pairs.mjs --config <file.json>  -> write them as "pairs" of an aggr-server config
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { build } from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

// exchanges with tradfi markets
const EXCHANGES = [
  'HYPERLIQUID',
  'BINANCE_FUTURES',
  'BYBIT',
  'OKEX',
  'BITGET',
  'ASTER',
  'LIGHTER'
]

// perpetuals only (no tokenized stocks spot, no dated futures)
const PERP_FILTERS = {
  BYBIT: pair => !/-SPOT$/.test(pair) && !/-\d/.test(pair),
  OKEX: pair => /-SWAP$/.test(pair),
  BITGET: pair => !/-SPOT$/.test(pair)
}

const STUB = `export default { state: {}, getters: {}, dispatchAsync: async () => null }`

async function loadExchanges() {
  const outfile = path.join(os.tmpdir(), `aggr-tradfi-pairs-${process.pid}.mjs`)

  await build({
    stdin: {
      contents: `export { exchanges } from '@/worker/exchanges/index'`,
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'error',
    plugins: [
      {
        name: 'aggr',
        setup(b) {
          // worker settings / app services aren't needed to format products
          b.onResolve(
            { filter: /(^|\/)settings$|^@\/store$|Service$/ },
            () => ({
              path: 'stub',
              namespace: 'stub'
            })
          )
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents: STUB,
            loader: 'js'
          }))
          b.onResolve({ filter: /^@\// }, args => {
            const file = path.join(root, 'src', args.path.slice(2))
            const ext = ['.ts', '.js', '/index.ts'].find(e =>
              fs.existsSync(file + e)
            )

            return { path: fs.existsSync(file) && !ext ? file : file + ext }
          })
        }
      }
    ]
  })

  Object.assign(globalThis, {
    self: globalThis,
    window: globalThis,
    postMessage: () => null,
    addEventListener: () => null
  })

  try {
    return (await import(outfile)).exchanges
  } finally {
    fs.unlinkSync(outfile)
  }
}

async function fetchJson(endpoint) {
  const {
    url,
    method = 'GET',
    data
  } = typeof endpoint === 'string' ? { url: endpoint } : endpoint

  const response = await fetch(url, {
    method,
    body: data,
    headers: data ? { 'Content-Type': 'application/json' } : {}
  })

  if (!response.ok) {
    throw new Error(`${url} -> HTTP ${response.status}`)
  }

  return response.json()
}

async function getTradfiMarkets(exchange) {
  let endpoints = exchange.endpoints.PRODUCTS
  endpoints = Array.isArray(endpoints) ? endpoints : [endpoints]

  const responses = await Promise.all(
    endpoints.map(endpoint =>
      fetchJson(endpoint).catch(error => {
        if (endpoint.optional) {
          console.warn(
            `${exchange.id}: optional endpoint failed (${error.message})`
          )
          return null
        }

        throw error
      })
    )
  )

  const products = exchange.formatProducts(
    responses.length === 1 ? responses[0] : responses
  )
  const isPerp = PERP_FILTERS[exchange.id] || (() => true)

  return (products.tradfi || [])
    .filter(isPerp)
    .map(pair => exchange.id + ':' + pair)
}

async function main() {
  const exchanges = (await loadExchanges()).filter(
    exchange => EXCHANGES.indexOf(exchange.id) !== -1
  )

  const markets = []
  const emptyExchanges = []

  for (const exchange of exchanges) {
    const exchangeMarkets = await getTradfiMarkets(exchange)
    console.error(`${exchange.id}: ${exchangeMarkets.length} tradfi markets`)
    markets.push(...exchangeMarkets)

    if (!exchangeMarkets.length) {
      emptyExchanges.push(exchange.id)
    }
  }

  const configIndex = process.argv.indexOf('--config')

  if (configIndex !== -1) {
    // an exchange temporarily failing would stop its markets from being recorded
    if (emptyExchanges.length) {
      throw new Error(
        `no tradfi markets for ${emptyExchanges.join(', ')}, config left unchanged`
      )
    }

    const file = process.argv[configIndex + 1]
    const config = JSON.parse(fs.readFileSync(file, 'utf8'))

    config.pairs = markets
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
    console.error(`wrote ${markets.length} pairs to ${file}`)
  } else {
    console.log(JSON.stringify(markets, null, 2))
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
