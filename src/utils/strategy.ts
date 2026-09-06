import { AuctionData } from "./auction";

// ── Phase detection ────────────────────────────────────────────────────────

export type AuctionPhase = "bidding" | "reveal" | "settled" | "cancelled" | "ready_to_settle";

export function getAuctionPhase(auction: AuctionData): AuctionPhase {
  if (auction.cancelled) return "cancelled";
  if (auction.settled) return "settled";

  const now = Math.floor(Date.now() / 1000);
  if (now < auction.biddingEnd) return "bidding";
  if (now < auction.revealEnd) return "reveal";
  return "ready_to_settle";
}

export function timeUntil(timestamp: number): number {
  return Math.max(0, timestamp - Math.floor(Date.now() / 1000));
}

export function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "Ended";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── Game theory strategies ─────────────────────────────────────────────────

export interface StrategyResult {
  recommendedBid: bigint;
  reasoning: string[];
  confidence: "high" | "medium" | "low";
}

/**
 * Vickrey (second-price) auction: dominant strategy is to bid your true value.
 * This is a foundational result in auction theory (Vickrey, 1961, Nobel Prize 1996).
 */
export function vickreyStrategy(trueValue: bigint, minBid: bigint): StrategyResult {
  const bid = trueValue > minBid ? trueValue : minBid;
  return {
    recommendedBid: bid,
    reasoning: [
      "In a Vickrey auction, the winner pays the second-highest bid, not their own.",
      "This means bidding your true value is the dominant strategy — you never overpay.",
      "If you bid above your value, you risk winning at a price you'd regret.",
      "If you bid below your value, you risk losing an item you could have gotten at a price you'd accept.",
      `Recommended: bid your true value of ${formatStrk(trueValue)} STRK.`,
    ],
    confidence: "high",
  };
}

/**
 * First-price sealed-bid auction: Nash equilibrium for N bidders with
 * values drawn from a uniform distribution is to shade your bid:
 *   optimal_bid = true_value × (N - 1) / N
 *
 * With 2 bidders: bid 50% of your value
 * With 3 bidders: bid 67% of your value
 * With 5 bidders: bid 80% of your value
 */
export function firstPriceStrategy(
  trueValue: bigint,
  numBidders: number,
  minBid: bigint,
): StrategyResult {
  // Estimate N (at least 2, or use observed bid count + 1 for self).
  const n = Math.max(2, numBidders + 1);

  // Nash equilibrium bid shading: value × (N-1)/N
  const shadedBid = (trueValue * BigInt(n - 1)) / BigInt(n);
  const bid = shadedBid > minBid ? shadedBid : minBid;

  const shadePercent = Math.round(((n - 1) / n) * 100);
  const savingsPercent = 100 - shadePercent;

  return {
    recommendedBid: bid,
    reasoning: [
      `With ~${n} expected bidders, Nash equilibrium says to shade your bid to ${shadePercent}% of your true value.`,
      `This saves you ~${savingsPercent}% compared to bidding your full value.`,
      `Your true value: ${formatStrk(trueValue)} STRK → Shaded bid: ${formatStrk(bid)} STRK.`,
      "With more bidders, shade less (competition pushes bids closer to true value).",
      "With fewer bidders, shade more (less competition means more room to undercut).",
    ],
    confidence: numBidders >= 2 ? "medium" : "low",
  };
}

/**
 * Compute optimal bid for any auction type.
 */
export function computeStrategy(
  auction: AuctionData,
  trueValue: bigint,
): StrategyResult {
  if (auction.auctionType === "vickrey") {
    return vickreyStrategy(trueValue, auction.minBid);
  }
  return firstPriceStrategy(trueValue, auction.bidCount, auction.minBid);
}

// ── Urgency / alerts ───────────────────────────────────────────────────────

export type UrgencyLevel = "none" | "low" | "medium" | "high" | "critical";

export function getRevealUrgency(auction: AuctionData): UrgencyLevel {
  const phase = getAuctionPhase(auction);
  if (phase !== "reveal") return "none";

  const remaining = timeUntil(auction.revealEnd);
  if (remaining <= 60) return "critical";   // < 1 min
  if (remaining <= 300) return "high";      // < 5 min
  if (remaining <= 900) return "medium";    // < 15 min
  if (remaining <= 3600) return "low";      // < 1 hour
  return "none";
}

export function getBidUrgency(auction: AuctionData): UrgencyLevel {
  const phase = getAuctionPhase(auction);
  if (phase !== "bidding") return "none";

  const remaining = timeUntil(auction.biddingEnd);
  if (remaining <= 60) return "critical";
  if (remaining <= 300) return "high";
  if (remaining <= 900) return "medium";
  return "none";
}

// ── Agent messages ─────────────────────────────────────────────────────────

export interface AgentMessage {
  type: "info" | "warning" | "action" | "analysis";
  text: string;
  urgency?: UrgencyLevel;
}

export function generateAgentMessages(
  auction: AuctionData,
  hasBid: boolean,
  hasRevealed: boolean,
): AgentMessage[] {
  const messages: AgentMessage[] = [];
  const phase = getAuctionPhase(auction);
  const item = auction.itemName || `Auction #${auction.id}`;

  // Phase-specific messages.
  if (phase === "cancelled") {
    messages.push({ type: "info", text: `${item} was cancelled by the seller. Deposits will be refunded.` });
    return messages;
  }

  if (phase === "settled") {
    messages.push({ type: "info", text: `${item} is settled. Winner: ${auction.winner.slice(0, 10)}…` });
    return messages;
  }

  if (phase === "bidding") {
    const remaining = timeUntil(auction.biddingEnd);
    const urgency = getBidUrgency(auction);

    messages.push({
      type: "analysis",
      text: `${item} is in the bidding phase. ${auction.bidCount} bid${auction.bidCount !== 1 ? "s" : ""} placed so far. ${formatCountdown(remaining)} remaining.`,
    });

    if (!hasBid) {
      messages.push({
        type: "action",
        text: "You haven't bid yet. Enter your true value below and I'll compute the optimal sealed bid.",
      });
    } else {
      messages.push({
        type: "info",
        text: "Your bid is sealed and hidden. No one can see your amount until the reveal phase.",
      });
    }

    if (urgency === "critical" || urgency === "high") {
      messages.push({
        type: "warning",
        text: `⚡ Bidding closes in ${formatCountdown(remaining)}! Place your bid now if you haven't.`,
        urgency,
      });
    }
  }

  if (phase === "reveal") {
    const remaining = timeUntil(auction.revealEnd);
    const urgency = getRevealUrgency(auction);

    messages.push({
      type: "analysis",
      text: `${item} is in the reveal phase. Bidders are now revealing their sealed amounts. ${formatCountdown(remaining)} remaining.`,
    });

    if (hasBid && !hasRevealed) {
      messages.push({
        type: "warning",
        text: `🔓 You need to reveal your bid before the window closes! Unrevealed bids forfeit their deposit.`,
        urgency: urgency === "none" ? "high" : urgency,
      });
    } else if (hasBid && hasRevealed) {
      messages.push({ type: "info", text: "Your bid has been revealed. Waiting for other bidders and settlement." });
    } else {
      messages.push({ type: "info", text: "You didn't bid in this auction." });
    }

    if (urgency === "critical") {
      messages.push({
        type: "warning",
        text: `🚨 Reveal window closes in ${formatCountdown(remaining)}! Reveal NOW or lose your deposit!`,
        urgency: "critical",
      });
    }
  }

  if (phase === "ready_to_settle") {
    messages.push({
      type: "action",
      text: `${item} is ready for settlement. Anyone can trigger it. If you're a losing bidder, you can claim your refund after.`,
    });
  }

  return messages;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatStrk(amount: bigint): string {
  const whole = amount / 10n ** 18n;
  const frac = (amount % 10n ** 18n).toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
