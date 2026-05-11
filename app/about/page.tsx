import type { Metadata } from "next";
import SiteNav from "../components/SiteNav";

export const metadata: Metadata = {
  title: "About — ArbWatch",
  description:
    "How prediction market arbitrage works, why spreads exist, and how ArbWatch tracks them.",
};

export default function AboutPage() {
  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <SiteNav />
      <main id="main-content" className="about-main">

        {/* ── What is a prediction market ───────────────────────────── */}
        <section className="about-section">
          <h1 className="about-section-heading">WHAT IS A PREDICTION MARKET?</h1>
          <p>
            A prediction market is a platform where people buy and sell contracts on the
            outcome of future events. Each contract pays <strong>$1 if the event happens,
            $0 if it doesn&apos;t</strong>.
          </p>
          <p>
            If a contract is trading at <strong>$0.17</strong>, the market is collectively
            saying there is a <strong>17% probability</strong> the event will happen. The
            price <em>is</em> the probability — no external reference needed.
          </p>
          <p>
            Examples: &ldquo;Will the Fed cut rates in June 2026?&rdquo; trading at 4% means
            the crowd thinks it&apos;s very unlikely. &ldquo;Will the US confirm alien existence
            before 2027?&rdquo; trading at 17% on Polymarket.
          </p>
        </section>

        {/* ── The spread ───────────────────────────────────────────── */}
        <section className="about-section">
          <h2 className="about-section-heading">THE SPREAD</h2>
          <p>
            The spread is <code className="about-code">max(prices) − min(prices)</code> across
            all platforms tracking the same question. When the same event is priced differently
            on different venues, that difference is the spread.
          </p>
          <p>
            A 14% spread means the crowd on one platform thinks an event is nearly 3× more
            likely than the crowd on another. That discrepancy is either an opportunity or
            a signal — and usually both.
          </p>
        </section>

        {/* ── Worked example ───────────────────────────────────────── */}
        <section className="about-section">
          <h2 className="about-section-heading">WORKED EXAMPLE</h2>
          <p className="about-example-question">
            Will the US confirm that aliens exist before 2027?
          </p>

          <div className="about-platform-table" role="table" aria-label="Platform prices for aliens question">
            <div className="about-platform-table-head" role="row">
              <span role="columnheader">Platform</span>
              <span role="columnheader">Price (YES)</span>
              <span role="columnheader">Currency</span>
            </div>
            <div className="about-platform-table-row" role="row">
              <span role="cell" style={{ color: "#4337c9", fontWeight: 700 }}>MANIFOLD</span>
              <span role="cell" className="about-prob">5.0%</span>
              <span role="cell" className="about-currency-note">Mana (play money)</span>
            </div>
            <div className="about-platform-table-row" role="row">
              <span role="cell" style={{ color: "#0095e6", fontWeight: 700 }}>POLYMARKET</span>
              <span role="cell" className="about-prob">17.5%</span>
              <span role="cell" className="about-currency-note">USDC</span>
            </div>
            <div className="about-platform-table-row" role="row">
              <span role="cell" style={{ color: "#00c805", fontWeight: 700 }}>ROBINHOOD</span>
              <span role="cell" className="about-prob">19.1%</span>
              <span role="cell" className="about-currency-note">USD</span>
            </div>
          </div>

          <div className="about-trade-block">
            <p className="about-trade-heading">The trade</p>
            <ol className="about-trade-steps">
              <li>Buy YES on Manifold at <strong>5¢</strong></li>
              <li>Buy NO on Robinhood at <strong>81¢</strong> (NO = 1 − 19.1% ≈ 81¢)</li>
              <li>Combined cost: <strong>86¢</strong></li>
              <li>Payout: <strong>$1.00</strong> regardless of outcome</li>
              <li className="about-trade-profit">Profit: <strong>14¢</strong> &nbsp;·&nbsp; Return: <strong>16.3%</strong></li>
            </ol>
          </div>

          <p className="about-caveat">
            Note: Manifold uses play money (Mana), so this specific example isn&apos;t real
            arbitrage — profits aren&apos;t cash. But the spread signal is real: Manifold&apos;s
            play-money crowd consistently diverges from real-money markets, and tracking that
            divergence still tells you something.
          </p>
        </section>

        {/* ── Why spreads exist ────────────────────────────────────── */}
        <section className="about-section">
          <h2 className="about-section-heading">WHY SPREADS EXIST</h2>
          <ol className="about-reasons">
            <li>
              <strong>Information lag</strong> — one platform&apos;s traders haven&apos;t reacted
              to recent news yet. Real-money markets update faster because being wrong costs money.
            </li>
            <li>
              <strong>Liquidity differences</strong> — a low-liquidity market can be moved easily
              and stay &ldquo;wrong&rdquo; longer. Thin order books = slow price discovery.
            </li>
            <li>
              <strong>Audience bias</strong> — Manifold&apos;s play-money crowd skews differently
              than real-money Polymarket traders. Different priors, different incentives.
            </li>
            <li>
              <strong>Arbitrage friction</strong> — moving money between platforms takes time and
              effort. Gaps persist because the cost of closing them isn&apos;t always worth it.
            </li>
          </ol>
          <p>
            Even when pure arbitrage isn&apos;t possible (due to Manifold&apos;s play money, withdrawal
            delays, or resolution risk), the spread is a strong signal. A widening spread means
            new information hit one market but not others. A collapsing spread means markets
            are converging on consensus.
          </p>
        </section>

        {/* ── Platform comparison ──────────────────────────────────── */}
        <section className="about-section">
          <h2 className="about-section-heading">PLATFORM COMPARISON</h2>
          <div className="about-table-wrap">
            <table className="about-table">
              <thead>
                <tr>
                  <th>Platform</th>
                  <th>Currency</th>
                  <th>Mechanism</th>
                  <th>Real money</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ color: "#00b388", fontWeight: 700 }}>Kalshi</td>
                  <td>USD</td>
                  <td>Order book (CLOB)</td>
                  <td className="about-yes">Yes</td>
                </tr>
                <tr>
                  <td style={{ color: "#4337c9", fontWeight: 700 }}>Manifold</td>
                  <td>Mana (fake)</td>
                  <td>AMM (constant product)</td>
                  <td className="about-no">No</td>
                </tr>
                <tr>
                  <td style={{ color: "#0095e6", fontWeight: 700 }}>Polymarket</td>
                  <td>USDC</td>
                  <td>Order book (CLOB)</td>
                  <td className="about-yes">Yes</td>
                </tr>
                <tr>
                  <td style={{ color: "#00c805", fontWeight: 700 }}>Robinhood</td>
                  <td>USD</td>
                  <td>Order book (CLOB)</td>
                  <td className="about-yes">Yes</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="about-table-note">
            Real-money markets tend to be better calibrated: traders with wrong views lose
            actual money, which incentivises fast belief updating. Manifold often diverges
            from the others because there&apos;s less financial pressure to correct.
          </p>
        </section>

        {/* ── Why ArbWatch ─────────────────────────────────────────── */}
        <section className="about-section">
          <h2 className="about-section-heading">WHY ARBWATCH</h2>
          <p>
            Manually checking four platforms for every question you care about is tedious.
            ArbWatch automates the work:
          </p>
          <ul className="about-features-list">
            <li>
              <strong>Cross-platform matching</strong> — type a question once, we find
              the equivalent market on every platform
            </li>
            <li>
              <strong>Live spread tracking</strong> — real-time prices, computed spread,
              updated on a regular cadence
            </li>
            <li>
              <strong>Alert threshold</strong> — set a minimum spread (e.g. 3%) and get
              notified when it&apos;s exceeded
            </li>
            <li>
              <strong>Spread history</strong> — 7-day sparkline shows whether the gap is
              growing or closing
            </li>
            <li>
              <strong>One-click navigation</strong> — each platform chip links directly to
              the market page so you can act immediately
            </li>
          </ul>
          <div className="about-cta-row">
            <a href="/signin" className="landing-cta-primary">Get started →</a>
          </div>
        </section>

        <footer className="landing-footer">
          <p>ArbWatch &nbsp;&middot;&nbsp; arb &ne; profit; slippage and fees may eat spread</p>
        </footer>
      </main>
    </>
  );
}
