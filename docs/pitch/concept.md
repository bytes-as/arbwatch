# ArbWatch — Concept & Pitch

## What is a prediction market?

A prediction market is a platform where people buy and sell contracts on the outcome of future events.

Each contract pays **$1 if the event happens, $0 if it doesn't**. So if a contract is trading at **$0.17**, the market is collectively saying there is a **17% probability** that the event will happen. The price *is* the probability — no external reference point needed.

Examples of questions traded:
- "Will the Fed cut rates in June 2026?" → trading at 4% = market thinks very unlikely
- "Will the US confirm alien existence before 2027?" → trading at 17% on Polymarket

This is called the **implied probability** — what the crowd of traders collectively implies about the likelihood of the event.

---

## How do prices move?

Prices change continuously as people place bets. There are two market mechanisms in use:

### Order Book (CLOB) — Polymarket, Robinhood, Kalshi
Works like a stock exchange. Buyers post bids ("I'll pay 17¢ for YES"), sellers post asks ("I want 18¢ to sell YES"). When a bid meets an ask, a trade executes and the price updates. The `best_bid` and `best_ask` we show are live order book quotes — they can change every second during active trading.

### Automated Market Maker (AMM) — Manifold
Works like a DeFi liquidity pool. A mathematical formula (constant product) sets the price. Every single bet — even tiny ones — moves the price immediately. There is no order book; the formula just rebalances. More YES buyers → price rises automatically.

### Key difference: real money vs. play money

| Platform    | Currency         | Implication |
|-------------|------------------|-------------|
| Kalshi      | Real USD         | Highly incentivised to be accurate |
| Polymarket  | Real USDC        | Highly incentivised to be accurate |
| Robinhood   | Real USD         | Highly incentivised to be accurate |
| Manifold    | Mana (fake)      | Lower stakes = noisier, may lag news |

Real-money markets tend to be better calibrated because traders with wrong views lose actual money. This is why Manifold often diverges from the other three — there is less financial pressure to update beliefs quickly.

---

## What is the spread?

The **spread** is `max(platform prices) − min(platform prices)` across all platforms tracking the same question.

Example from the aliens question:
```
Manifold    →  5.0%
Polymarket  → 17.5%
Robinhood   → 19.1%

Spread = 19.1% − 5.0% = 14.1%
```

A spread of 14% means the same future event is priced **very differently** across venues. This can happen because:

1. **Information lag** — one platform's traders haven't reacted to recent news yet
2. **Liquidity differences** — a low-liquidity market can be moved easily and stay "wrong" longer
3. **Audience bias** — Manifold's play-money crowd skews differently than real-money Polymarket traders
4. **Arbitrage friction** — moving money between platforms takes time and effort, so gaps can persist

---

## The arbitrage opportunity

If the same event is genuinely priced at 5% on one platform and 19% on another, a trader can:

1. **Buy YES** on the cheap platform (Manifold at 5¢)
2. **Buy NO** on the expensive platform (Robinhood at ~81¢, since NO = 1 − 19%)
3. **Combined cost**: 5¢ + 81¢ = 86¢
4. **Guaranteed payout**: $1 regardless of outcome (YES wins → Manifold pays, NO wins → Robinhood pays)
5. **Risk-free profit**: 14¢ per $1 notional = 16% return

In practice, the friction is that:
- Manifold uses fake money, so position sizes are capped and profits aren't real
- Real-money platforms (Polymarket, Robinhood, Kalshi) have withdrawal delays
- Markets can close or resolve before you exit
- Large spreads often exist *because* one market is illiquid or the question is defined slightly differently

But even when pure arbitrage isn't possible, the spread is a strong **signal**:
- A widening spread = new information has hit one market but not others
- A collapsing spread = markets converging on consensus
- Persistent large spreads = potential inefficiency worth investigating

---

## Why ArbWatch?

Manually checking 4 platforms for every question you care about is tedious. ArbWatch automates:

1. **Cross-platform matching** — you type a question once, we find the equivalent market on Manifold, Polymarket, Robinhood, and Kalshi
2. **Live spread tracking** — we show the spread across platforms, updated on a regular cadence
3. **Alert threshold** — you set a minimum spread (e.g. 3%) and get notified when it's exceeded
4. **Spread history** — 7-day sparkline shows whether the gap is growing or closing
5. **One-click navigation** — each platform chip links directly to the market page so you can act immediately

The target user is anyone who actively trades prediction markets and wants to spot pricing inefficiencies across venues without manually checking each one.

---

## Platform coverage

| Platform    | Search | Live prices | Direct link |
|-------------|--------|-------------|-------------|
| Manifold    | ✓      | ✓           | ✓           |
| Polymarket  | ✓      | ✓           | ✓           |
| Robinhood   | ✓      | ✓           | ✓           |
| Kalshi      | —*     | ✓           | —           |

*Kalshi has no text search API — markets must be matched manually or via the cron refresh. Live price fetching works once a market ID is matched.
