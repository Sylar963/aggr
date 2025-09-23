import express from 'express'
import cors from 'cors'

const app = express()
const PORT = process.env.PORT || 3000

// Enable CORS for all routes
app.use(cors())
app.use(express.json())

// Products endpoint - returns a list of supported markets/pairs
app.get('/products', (req, res) => {
  // Return a basic list of supported products for now
  // This can be expanded later to dynamically fetch from exchanges
  const products = [
    'BINANCE_FUTURES:btcusd_perp',
    'BINANCE_FUTURES:btcusdt',
    'BINANCE:btcusdt',
    'BITFINEX:BTCUSD',
    'BITFINEX:BTCUST',
    'BITFINEX:BTCF0:USTF0',
    'BITMEX:XBTUSD',
    'BITMEX:XBTUSDT',
    'BYBIT:BTCUSD',
    'BYBIT:BTCUSDT',
    'COINBASE:BTC-USD',
    'COINBASE:BTC-USDT',
    'DERIBIT:BTC-PERPETUAL',
    'BITSTAMP:btcusd',
    'OKEX:BTC-USD-SWAP',
    'OKEX:BTC-USDT-SWAP',
    'THALEX:BTC-PERPETUAL' // Add THALEX to the list
  ]

  res.json(products)
})

// Alert endpoint (basic stub for now)
app.get('/alert', (req, res) => {
  res.json({ message: 'Alerts endpoint placeholder' })
})

app.post('/alert', (req, res) => {
  res.json({ message: 'Alert created' })
})

// Historical data endpoint (basic stub for now)
app.get('/historical', (req, res) => {
  res.json({
    message: 'Historical data endpoint placeholder',
    data: []
  })
})

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() })
})

app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`)
  console.log(`Products endpoint: http://localhost:${PORT}/products`)
  console.log(`Health check: http://localhost:${PORT}/health`)
})