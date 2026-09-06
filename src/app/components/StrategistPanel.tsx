"use client";

import { useEffect, useState, useCallback } from "react";
import { RpcProvider, num } from "starknet";
import styles from "../uni.module.css";
import * as constants from "@/utils/constants";
import {
  AuctionData,
  parseAuction,
  getAuctionContract,
  formatAmount,
  parseAmount,
} from "@/utils/auction";
import {
  getAuctionPhase,
  timeUntil,
  formatCountdown,
  computeStrategy,
  getRevealUrgency,
  getBidUrgency,
  generateAgentMessages,
  AgentMessage,
  StrategyResult,
  AuctionPhase,
} from "@/utils/strategy";
import { useStoreWallet } from "./Wallet/walletContext";
import { useFrontendProvider } from "./client/provider/providerContext";

// SVG icons.
const Icons = {
  brain: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 2a7 7 0 017 7c0 2.5-1.3 4.7-3.3 6L12 22l-3.7-7C6.3 13.7 5 11.5 5 9a7 7 0 017-7z"/><circle cx="12" cy="9" r="2"/></svg>,
  clock: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>,
  alert: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>,
  copy: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>,
};

const PHASE_LABELS: Record<AuctionPhase, string> = {
  bidding: "Bidding Open",
  reveal: "Reveal Phase",
  ready_to_settle: "Ready to Settle",
  settled: "Settled",
  cancelled: "Cancelled",
};

const PHASE_COLORS: Record<AuctionPhase, string> = {
  bidding: "var(--pink-soft)",
  reveal: "#fff3cd",
  ready_to_settle: "var(--green-soft)",
  settled: "var(--green-soft)",
  cancelled: "#fdecec",
};

export default function StrategistPanel() {
  const myFrontendProviderIndex = useFrontendProvider((s) => s.currentFrontendProviderIndex);
  const connectedAddress = useStoreWallet((s) => s.address);
  const networkName = constants.Strk20Networks[myFrontendProviderIndex];
  const isStrk20Network = networkName !== undefined;
  const provider = constants.myFrontendProviders[myFrontendProviderIndex] as RpcProvider;

  // Auction contract address.
  const contractAddr =
    process.env.NEXT_PUBLIC_SHADE_ADDR && process.env.NEXT_PUBLIC_SHADE_ADDR !== "0x0"
      ? process.env.NEXT_PUBLIC_SHADE_ADDR
      : constants.ShadeMainnetAddress;

  // State.
  const [auctions, setAuctions] = useState<AuctionData[]>([]);
  const [selectedId, setSelectedId] = useState<number>(0);
  const [trueValue, setTrueValue] = useState("");
  const [strategy, setStrategy] = useState<StrategyResult | null>(null);
  const [tick, setTick] = useState(0);
  const [copied, setCopied] = useState(false);

  // Refresh auctions.
  const fetchAuctions = useCallback(async () => {
    if (!provider || contractAddr === "0x0") return;
    try {
      const contract = getAuctionContract(contractAddr, provider);
      const count: any = await contract.get_auction_count();
      const n = Number(count);
      const list: AuctionData[] = [];
      for (let i = 1; i <= n; i++) {
        try {
          const raw = await contract.get_auction(i);
          list.push(parseAuction(raw));
        } catch { /* skip */ }
      }
      setAuctions(list);
      if (list.length > 0 && selectedId === 0) setSelectedId(list[0].id);
    } catch { /* contract not deployed yet */ }
  }, [provider, contractAddr, selectedId]);

  useEffect(() => {
    if (isStrk20Network) fetchAuctions();
  }, [isStrk20Network, myFrontendProviderIndex]);

  // Countdown timer — ticks every second.
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Compute strategy when true value changes.
  useEffect(() => {
    const auction = auctions.find((a) => a.id === selectedId);
    if (!auction || !trueValue) { setStrategy(null); return; }
    try {
      const val = parseAmount(trueValue);
      if (val > 0n) setStrategy(computeStrategy(auction, val));
      else setStrategy(null);
    } catch { setStrategy(null); }
  }, [trueValue, selectedId, auctions]);

  const selectedAuction = auctions.find((a) => a.id === selectedId);
  const phase = selectedAuction ? getAuctionPhase(selectedAuction) : null;

  // Check if user has a saved bid for this auction.
  const hasBidSecret = (() => {
    try {
      const raw = localStorage.getItem("shade_secrets");
      if (!raw || !selectedAuction) return false;
      const secrets = JSON.parse(raw);
      return secrets.some((s: any) => s.auctionId === selectedAuction.id);
    } catch { return false; }
  })();

  // Agent messages.
  const agentMessages: AgentMessage[] = selectedAuction
    ? generateAgentMessages(selectedAuction, hasBidSecret, false)
    : [];

  // Copy bid to clipboard.
  const copyBid = () => {
    if (!strategy) return;
    navigator.clipboard.writeText(formatAmount(strategy.recommendedBid));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Re-fetch handler (uses `tick` to force re-fetch periodically).
  useEffect(() => {
    if (tick % 30 === 0 && isStrk20Network) fetchAuctions();
  }, [tick]);

  return (
    <div className={styles.panel}>
      <h2 style={{ textAlign: "center", fontSize: 22, fontWeight: 600, marginBottom: 4, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
        {Icons.brain} Shade Strategist
      </h2>
      <p style={{ textAlign: "center", color: "var(--muted)", fontSize: 13, marginBottom: 16 }}>
        AI-powered bid analysis using game theory
      </p>

      {!isStrk20Network && (
        <div className={styles.warn}>
          Switch to Mainnet or Sepolia to use the strategist.
        </div>
      )}

      {auctions.length === 0 && isStrk20Network && (
        <p style={{ textAlign: "center", color: "var(--muted)", fontSize: 13, padding: 20 }}>
          No auctions to analyze. Create one first.
        </p>
      )}

      {auctions.length > 0 && (
        <>
          {/* Auction selector */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, display: "block", marginBottom: 4 }}>
              Analyze Auction
            </label>
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(Number(e.target.value))}
              style={{ width: "100%", padding: "10px 14px", borderRadius: 12, border: "1px solid var(--line)", fontSize: 14 }}
            >
              {auctions.map((a) => (
                <option key={a.id} value={a.id}>
                  #{a.id} — {a.itemName ? String.fromCharCode(...a.itemName.toString().split(",").map(Number)) : `Auction ${a.id}`} ({PHASE_LABELS[getAuctionPhase(a)]})
                </option>
              ))}
            </select>
          </div>

          {selectedAuction && (
            <>
              {/* Phase status bar */}
              <div style={{
                padding: "12px 16px",
                borderRadius: 12,
                background: PHASE_COLORS[phase!],
                marginBottom: 12,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>
                  {PHASE_LABELS[phase!]}
                </span>
                <span style={{ fontFamily: "var(--font-mono-ui), monospace", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
                  {Icons.clock}
                  {phase === "bidding" && formatCountdown(timeUntil(selectedAuction.biddingEnd))}
                  {phase === "reveal" && formatCountdown(timeUntil(selectedAuction.revealEnd))}
                  {(phase === "settled" || phase === "cancelled" || phase === "ready_to_settle") && "—"}
                </span>
              </div>

              {/* Agent messages */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                {agentMessages.map((msg, i) => (
                  <div key={i} style={{
                    padding: "10px 14px",
                    borderRadius: 12,
                    fontSize: 13,
                    lineHeight: 1.5,
                    background: msg.type === "warning"
                      ? (msg.urgency === "critical" ? "#fdecec" : "#fff3cd")
                      : msg.type === "action"
                        ? "var(--pink-soft)"
                        : "var(--inset)",
                    border: msg.type === "warning"
                      ? `1px solid ${msg.urgency === "critical" ? "#f4cccb" : "#ffc107"}`
                      : "1px solid var(--line)",
                    color: msg.type === "warning" ? "#856404" : "var(--ink)",
                  }}>
                    {msg.text}
                  </div>
                ))}
              </div>

              {/* Strategy input (only during bidding) */}
              {phase === "bidding" && (
                <div style={{
                  padding: "14px 16px",
                  borderRadius: 16,
                  border: "1px solid var(--line)",
                  background: "#fff",
                  marginBottom: 12,
                }}>
                  <label style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, display: "block", marginBottom: 6 }}>
                    What's this item worth to you? (STRK)
                  </label>
                  <input
                    placeholder="Your true value, e.g. 10"
                    value={trueValue}
                    onChange={(e) => setTrueValue(e.target.value)}
                    style={{ width: "100%", padding: "10px 14px", borderRadius: 12, border: "1px solid var(--line)", fontSize: 14 }}
                  />

                  {strategy && (
                    <div style={{ marginTop: 12 }}>
                      <div style={{
                        padding: "12px 16px",
                        borderRadius: 12,
                        background: "var(--green-soft)",
                        border: "1px solid #cdeede",
                      }}>
                        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <span>Recommended Bid: {formatAmount(strategy.recommendedBid)} STRK</span>
                          <button
                            onClick={copyBid}
                            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11 }}
                          >
                            {Icons.copy} {copied ? "Copied!" : "Copy"}
                          </button>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 8 }}>
                          <span style={{
                            fontSize: 10,
                            fontWeight: 700,
                            padding: "2px 6px",
                            borderRadius: 4,
                            background: strategy.confidence === "high" ? "var(--green)" : strategy.confidence === "medium" ? "#ffc107" : "var(--muted)",
                            color: "#fff",
                            textTransform: "uppercase",
                          }}>
                            {strategy.confidence} confidence
                          </span>
                        </div>
                        <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--ink)" }}>
                          {strategy.reasoning.map((r, i) => (
                            <div key={i} style={{ marginBottom: 4 }}>
                              {i === strategy.reasoning.length - 1 ? <strong>{r}</strong> : <span style={{ color: "var(--muted)" }}>{r}</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Auction stats */}
              <div style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: 8,
                fontSize: 12,
              }}>
                <div style={{ padding: "8px 12px", borderRadius: 10, background: "var(--inset)", textAlign: "center" }}>
                  <div style={{ color: "var(--muted)", marginBottom: 2 }}>Bids</div>
                  <div style={{ fontWeight: 600 }}>{selectedAuction.bidCount}</div>
                </div>
                <div style={{ padding: "8px 12px", borderRadius: 10, background: "var(--inset)", textAlign: "center" }}>
                  <div style={{ color: "var(--muted)", marginBottom: 2 }}>Min Bid</div>
                  <div style={{ fontWeight: 600 }}>{formatAmount(selectedAuction.minBid)}</div>
                </div>
                <div style={{ padding: "8px 12px", borderRadius: 10, background: "var(--inset)", textAlign: "center" }}>
                  <div style={{ color: "var(--muted)", marginBottom: 2 }}>Format</div>
                  <div style={{ fontWeight: 600 }}>{selectedAuction.auctionType === "vickrey" ? "Vickrey" : "1st Price"}</div>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
