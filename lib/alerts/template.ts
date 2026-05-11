export const DISCLAIMER = "arb ≠ profit; slippage and fees may eat spread";

const PLATFORM_ORDER = ["kalshi", "manifold", "polymarket", "robinhood"] as const;

export interface MatchLink {
  platform: string;
  marketUrl: string;
}

export interface AlertEmailParams {
  userEmail: string;
  questionText: string;
  spreadPct: number;
  matches: MatchLink[];
}

export function renderAlertEmail(params: AlertEmailParams): { html: string; text: string } {
  const { questionText, spreadPct, matches } = params;
  const spreadStr = (spreadPct * 100).toFixed(1) + "%";

  // Sort matches by platform order
  const sorted = [...matches].sort((a, b) => {
    const ai = PLATFORM_ORDER.indexOf(a.platform as typeof PLATFORM_ORDER[number]);
    const bi = PLATFORM_ORDER.indexOf(b.platform as typeof PLATFORM_ORDER[number]);
    const aIdx = ai === -1 ? 999 : ai;
    const bIdx = bi === -1 ? 999 : bi;
    return aIdx - bIdx;
  });

  const linksHtml = sorted
    .map((m) => `<a href="${m.marketUrl}">${m.platform}</a>`)
    .join(" | ");

  const linksText = sorted.map((m) => `${m.platform}: ${m.marketUrl}`).join("\n");

  const html = `<p><strong>Spread alert: ${questionText}</strong></p>
<p>Current spread: <strong>${spreadStr}</strong></p>
<p>Markets: ${linksHtml}</p>
<p><em>${DISCLAIMER}</em></p>`;

  const text = `Spread alert: ${questionText}
Current spread: ${spreadStr}

Markets:
${linksText}

${DISCLAIMER}`;

  return { html, text };
}
