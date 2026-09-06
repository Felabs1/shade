"use client";

import { useEffect, useState } from "react";
import { Contract, RpcProvider, num, shortString, validateAndParseAddress } from "starknet";
import type { WALLET_API } from "@starknet-io/types-js";
import styles from "../uni.module.css";
import * as constants from "@/utils/constants";
import {
  SHADE_ABI,
  AuctionData,
  BidData,
  parseAuction,
  parseBid,
  computeCommitment,
  randomSalt,
  formatAmount,
  parseAmount,
  timeRemaining,
  getAuctionContract,
} from "@/utils/auction";
import {
  getAuctionPhase,
  timeUntil,
  formatCountdown,
  computeStrategy,
  generateAgentMessages,
  AgentMessage,
  StrategyResult,
  AuctionPhase,
} from "@/utils/strategy";
import { useStoreWallet } from "./Wallet/walletContext";
import { useFrontendProvider } from "./client/provider/providerContext";

// SVG icons for tabs.
const Icons = {
  plus: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>,
  grid: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
  lock: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>,
  unlock: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 019.9-1"/></svg>,
  check: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>,
  refresh: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 105.64-12.36L1 10"/></svg>,
  brain: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9.5 2a5.5 5.5 0 00-4.88 8.01A4.5 4.5 0 006 19h.5"/><path d="M14.5 2a5.5 5.5 0 014.88 8.01A4.5 4.5 0 0118 19h-.5"/><path d="M12 2v20"/></svg>,
};

type TabKey = "create" | "browse" | "bid" | "reveal" | "settle" | "strategist";
const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: "create", label: "Create", icon: Icons.plus },
  { key: "browse", label: "Browse", icon: Icons.grid },
  { key: "bid", label: "Bid", icon: Icons.lock },
  { key: "reveal", label: "Reveal", icon: Icons.unlock },
  { key: "settle", label: "Settle", icon: Icons.check },
  { key: "strategist", label: "Strategist", icon: Icons.brain },
];

// Local storage for bid secrets (amount + salt) so user can reveal later.
interface BidSecret {
  auctionId: number;
  amount: bigint;
  salt: bigint;
  commitment: string;
}

function loadSecrets(): BidSecret[] {
  try {
    const raw = localStorage.getItem("shade_secrets");
    if (!raw) return [];
    return JSON.parse(raw).map((s: any) => ({
      ...s,
      amount: BigInt(s.amount),
      salt: BigInt(s.salt),
    }));
  } catch {
    return [];
  }
}

function saveSecret(secret: BidSecret) {
  const secrets = loadSecrets();
  secrets.push(secret);
  localStorage.setItem("shade_secrets", JSON.stringify(secrets, (_, v) =>
    typeof v === "bigint" ? v.toString() : v
  ));
}

// ─── Strategist Tab (Agent UI) ────────────────────────────────────────────

const PHASE_LABELS: Record<AuctionPhase, string> = {
  bidding: "Bidding Open",
  reveal: "Reveal Phase",
  ready_to_settle: "Ready to Settle",
  settled: "Settled",
  cancelled: "Cancelled",
};

const PHASE_COLORS: Record<AuctionPhase, string> = {
  bidding: "rgba(0, 255, 200, 0.06)",
  reveal: "rgba(255, 171, 0, 0.06)",
  ready_to_settle: "rgba(0, 230, 118, 0.06)",
  settled: "rgba(0, 230, 118, 0.06)",
  cancelled: "rgba(255, 61, 113, 0.06)",
};

function decodeItemName(raw: any): string {
  try { return shortString.decodeShortString(raw.toString()); } catch { return "Unnamed"; }
}

// Countdown ring — SVG circle that depletes as time runs out.
function CountdownRing({ total, remaining }: { total: number; remaining: number }) {
  const pct = total > 0 ? Math.min(1, remaining / total) : 0;
  const r = 18;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - pct);
  const color = pct > 0.5 ? "var(--green)" : pct > 0.15 ? "#e5a000" : "var(--danger)";
  return (
    <svg width="44" height="44" viewBox="0 0 44 44" style={{ flexShrink: 0 }}>
      <circle cx="22" cy="22" r={r} fill="none" stroke="var(--line)" strokeWidth="3" />
      <circle cx="22" cy="22" r={r} fill="none" stroke={color} strokeWidth="3"
        strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
        transform="rotate(-90 22 22)" style={{ transition: "stroke-dashoffset 1s linear, stroke 300ms" }} />
      <text x="22" y="23" textAnchor="middle" dominantBaseline="central"
        style={{ fontSize: 9, fontWeight: 700, fill: "var(--ink)", fontFamily: "var(--font-mono-ui), monospace" }}>
        {remaining > 3600 ? `${Math.floor(remaining / 3600)}h` : remaining > 60 ? `${Math.floor(remaining / 60)}m` : `${remaining}s`}
      </text>
    </svg>
  );
}

// Agent avatar bubble.
function AgentBubble({ msg }: { msg: AgentMessage }) {
  const bgMap: Record<string, string> = {
    warning: msg.urgency === "critical" ? "rgba(255, 61, 113, 0.08)" : "rgba(255, 171, 0, 0.06)",
    action: "rgba(0, 255, 200, 0.06)",
    analysis: "rgba(168, 85, 247, 0.06)",
    info: "var(--inset)",
  };
  const borderMap: Record<string, string> = {
    warning: msg.urgency === "critical" ? "rgba(255, 61, 113, 0.3)" : "rgba(255, 171, 0, 0.25)",
    action: "rgba(0, 255, 200, 0.2)",
    analysis: "rgba(168, 85, 247, 0.2)",
    info: "var(--line)",
  };
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      {/* Agent avatar */}
      <div style={{
        width: 28, height: 28, borderRadius: 8, flexShrink: 0,
        background: msg.type === "warning" ? "rgba(255, 61, 113, 0.15)" : msg.type === "action" ? "rgba(0, 255, 200, 0.12)" : "rgba(168, 85, 247, 0.12)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 14,
      }}>
        {msg.type === "warning" ? "⚡" : msg.type === "action" ? "→" : msg.type === "analysis" ? "📊" : "💡"}
      </div>
      <div style={{
        flex: 1, padding: "10px 14px", borderRadius: "4px 14px 14px 14px",
        background: bgMap[msg.type] || "var(--inset)",
        border: `1px solid ${borderMap[msg.type] || "var(--line)"}`,
        fontSize: 13, lineHeight: 1.55,
        color: msg.type === "warning" ? "#ff6b8a" : "var(--ink)",
      }}>
        {msg.text}
      </div>
    </div>
  );
}

function StrategistTab({
  provider, contractAddr, isStrk20Network, auctions, onRefresh,
}: {
  provider: RpcProvider; contractAddr: string; isStrk20Network: boolean;
  auctions: AuctionData[]; onRefresh: () => void;
}) {
  const [selectedId, setSelectedId] = useState<number>(0);
  const [trueValue, setTrueValue] = useState("");
  const [strategy, setStrategy] = useState<StrategyResult | null>(null);
  const [tick, setTick] = useState(0);
  const [copied, setCopied] = useState(false);

  // Auto-select first auction.
  useEffect(() => {
    if (auctions.length > 0 && selectedId === 0) setSelectedId(auctions[0].id);
  }, [auctions, selectedId]);

  // Tick every second for countdown.
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  // Compute strategy when value changes.
  useEffect(() => {
    const auction = auctions.find((a) => a.id === selectedId);
    if (!auction || !trueValue) { setStrategy(null); return; }
    try {
      const val = parseAmount(trueValue);
      if (val > 0n) setStrategy(computeStrategy(auction, val));
      else setStrategy(null);
    } catch { setStrategy(null); }
  }, [trueValue, selectedId, auctions]);

  const selected = auctions.find((a) => a.id === selectedId);
  const phase = selected ? getAuctionPhase(selected) : null;

  // Check saved bid.
  const hasBid = (() => {
    try {
      const raw = localStorage.getItem("shade_secrets");
      if (!raw || !selected) return false;
      return JSON.parse(raw).some((s: any) => s.auctionId === selected.id);
    } catch { return false; }
  })();

  const messages: AgentMessage[] = selected ? generateAgentMessages(selected, hasBid, false) : [];

  const copyBid = () => {
    if (!strategy) return;
    navigator.clipboard.writeText(formatAmount(strategy.recommendedBid));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Countdown values.
  const countdownTotal = selected
    ? (phase === "bidding"
      ? selected.biddingEnd - (selected.biddingEnd - (selected.revealEnd - selected.biddingEnd > 0 ? selected.biddingEnd : selected.revealEnd))
      : selected.revealEnd - selected.biddingEnd)
    : 0;
  const countdownRemaining = selected
    ? (phase === "bidding" ? timeUntil(selected.biddingEnd) : phase === "reveal" ? timeUntil(selected.revealEnd) : 0)
    : 0;

  if (!isStrk20Network) {
    return <div className={styles.warn}>Switch to Mainnet or Sepolia to use the strategist.</div>;
  }

  if (auctions.length === 0) {
    return (
      <div className={styles.inputBlock}>
        <div className={styles.inputLabel} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {Icons.brain} Strategist
        </div>
        <div style={{ textAlign: "center", padding: "30px 10px", color: "var(--muted)" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🧠</div>
          <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 4, color: "var(--ink)" }}>Your AI Auction Advisor</p>
          <p style={{ fontSize: 13, lineHeight: 1.5 }}>
            I analyze active auctions using game theory and recommend optimal bids.
            Create an auction first, then come back for strategy advice.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Auction selector */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, display: "block", marginBottom: 4 }}>
          Select Auction to Analyze
        </label>
        <select
          value={selectedId}
          onChange={(e) => { setSelectedId(Number(e.target.value)); setTrueValue(""); setStrategy(null); }}
          style={{ width: "100%", padding: "10px 14px", borderRadius: 12, border: "1px solid var(--line)", fontSize: 14 }}
        >
          {auctions.map((a) => (
            <option key={a.id} value={a.id}>
              #{a.id} — {decodeItemName(a.itemName)} ({PHASE_LABELS[getAuctionPhase(a)]})
            </option>
          ))}
        </select>
      </div>

      {selected && (
        <>
          {/* Phase status with countdown ring */}
          <div style={{
            padding: "12px 16px", borderRadius: 14, background: PHASE_COLORS[phase!],
            marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
          }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>{PHASE_LABELS[phase!]}</div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>
                {decodeItemName(selected.itemName)} · {selected.auctionType === "vickrey" ? "Vickrey" : "First Price"} · {selected.bidCount} bid{selected.bidCount !== 1 ? "s" : ""}
              </div>
            </div>
            {(phase === "bidding" || phase === "reveal") && (
              <CountdownRing total={countdownTotal || 300} remaining={countdownRemaining} />
            )}
          </div>

          {/* Agent chat messages */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
            {messages.map((msg, i) => <AgentBubble key={i} msg={msg} />)}
          </div>

          {/* Strategy input (bidding phase only) */}
          {phase === "bidding" && (
            <div style={{
              padding: "16px", borderRadius: 16, border: "1px solid var(--line)", background: "rgba(16, 20, 36, 0.6)", marginBottom: 12,
            }}>
              <label style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, display: "block", marginBottom: 6 }}>
                What is this item worth to you? (STRK)
              </label>
              <input
                placeholder="Your true value, e.g. 10"
                value={trueValue}
                onChange={(e) => setTrueValue(e.target.value)}
                style={{ width: "100%", padding: "10px 14px", borderRadius: 12, border: "1px solid var(--line)", fontSize: 14 }}
              />

              {strategy && (
                <div style={{
                  marginTop: 14, padding: "14px 16px", borderRadius: 14,
                  background: "rgba(0, 230, 118, 0.06)", border: "1px solid rgba(0, 230, 118, 0.2)",
                }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 15 }}>
                      Recommended: {formatAmount(strategy.recommendedBid)} STRK
                    </span>
                    <button onClick={copyBid} style={{
                      background: copied ? "var(--green)" : "rgba(100, 120, 180, 0.1)", border: "none", borderRadius: 8,
                      padding: "4px 10px", cursor: "pointer", fontSize: 11, fontWeight: 600,
                      color: copied ? "#080b14" : "var(--ink-dim)", display: "inline-flex", alignItems: "center", gap: 4,
                      transition: "all 200ms",
                    }}>
                      {copied ? "✓ Copied" : "Copy bid"}
                    </button>
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
                      background: strategy.confidence === "high" ? "var(--green)" : strategy.confidence === "medium" ? "#ffab00" : "var(--muted)",
                      color: "#080b14", textTransform: "uppercase", letterSpacing: 0.5,
                    }}>
                      {strategy.confidence} confidence
                    </span>
                  </div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>
                    {strategy.reasoning.map((r, i) => (
                      <div key={i} style={{
                        marginBottom: 4,
                        color: i === strategy.reasoning.length - 1 ? "var(--ink)" : "var(--muted)",
                        fontWeight: i === strategy.reasoning.length - 1 ? 600 : 400,
                      }}>
                        {r}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Stats grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, fontSize: 12 }}>
            <div style={{ padding: "10px 12px", borderRadius: 12, background: "var(--inset)", textAlign: "center" }}>
              <div style={{ color: "var(--muted)", marginBottom: 2, fontSize: 11 }}>Bids</div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{selected.bidCount}</div>
            </div>
            <div style={{ padding: "10px 12px", borderRadius: 12, background: "var(--inset)", textAlign: "center" }}>
              <div style={{ color: "var(--muted)", marginBottom: 2, fontSize: 11 }}>Min Bid</div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{formatAmount(selected.minBid)}</div>
            </div>
            <div style={{ padding: "10px 12px", borderRadius: 12, background: "var(--inset)", textAlign: "center" }}>
              <div style={{ color: "var(--muted)", marginBottom: 2, fontSize: 11 }}>Format</div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{selected.auctionType === "vickrey" ? "Vickrey" : "1st Price"}</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main Auction Panel ───────────────────────────────────────────────────

export default function AuctionPanel() {
  const myFrontendProviderIndex = useFrontendProvider((s) => s.currentFrontendProviderIndex);
  const myWalletAccount = useStoreWallet((s) => s.myWalletAccount);
  const connectedAddress = useStoreWallet((s) => s.address);
  const isConnected = useStoreWallet((s) => s.isConnected);

  const networkName = constants.Strk20Networks[myFrontendProviderIndex];
  const isStrk20Network = networkName !== undefined;

  const [tab, setTab] = useState<TabKey>("browse");
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");

  // Auction contract address (set after deployment).
  const [contractAddr, setContractAddr] = useState<string>(
    process.env.NEXT_PUBLIC_SHADE_ADDR && process.env.NEXT_PUBLIC_SHADE_ADDR !== "0x0"
      ? process.env.NEXT_PUBLIC_SHADE_ADDR
      : constants.ShadeMainnetAddress
  );

  // Provider for read calls.
  const provider = constants.myFrontendProviders[myFrontendProviderIndex] as RpcProvider;

  // ── Create Auction ──
  const [createItem, setCreateItem] = useState("Rare NFT");
  const [createDuration, setCreateDuration] = useState("300"); // 5 min for demo
  const [createReveal, setCreateReveal] = useState("300");
  const [createMinBid, setCreateMinBid] = useState("0.1");
  const [createType, setCreateType] = useState<"first_price" | "vickrey">("first_price");

  // ── Browse ──
  const [auctions, setAuctions] = useState<AuctionData[]>([]);
  const [loading, setLoading] = useState(false);

  // ── Bid ──
  const [bidAuctionId, setBidAuctionId] = useState("1");
  const [bidAmount, setBidAmount] = useState("1");

  // ── Reveal ──
  const [revealAuctionId, setRevealAuctionId] = useState("1");
  const [secrets, setSecrets] = useState<BidSecret[]>([]);

  // ── Settle ──
  const [settleAuctionId, setSettleAuctionId] = useState("1");

  // Load secrets on mount.
  useEffect(() => {
    setSecrets(loadSecrets());
  }, []);

  // Fetch auctions when browsing tab is active.
  useEffect(() => {
    if (tab === "browse" && isStrk20Network && contractAddr !== "0x0") {
      fetchAuctions();
    }
  }, [tab, myFrontendProviderIndex, contractAddr]);

  async function fetchAuctions() {
    if (!provider || contractAddr === "0x0") return;
    setLoading(true);
    try {
      const contract = getAuctionContract(contractAddr, provider);
      const count: any = await contract.get_auction_count();
      const n = Number(count);
      const list: AuctionData[] = [];
      for (let i = 1; i <= n; i++) {
        try {
          const raw = await contract.get_auction(i);
          list.push(parseAuction(raw));
        } catch { /* skip individual auction errors */ }
      }
      setAuctions(list);
    } catch (e: any) {
      console.error("fetchAuctions:", e?.message ?? e);
      setAuctions([]);
      // Don't show error to user — contract might not be deployed yet.
    } finally {
      setLoading(false);
    }
  }

  // ── Actions ──

  async function handleCreate() {
    setError("");
    setStatus("");
    if (!myWalletAccount) { setError("Connect wallet first"); return; }
    if (contractAddr === "0x0") { setError("Set auction contract address first"); return; }

    try {
      const itemFelt = shortString.encodeShortString(createItem);
      const minBidParsed = parseAmount(createMinBid);
      const atByte = createType === "vickrey" ? 1 : 0;

      setStatus("Confirm transaction in wallet…");
      const result = await myWalletAccount.execute([{
        contractAddress: contractAddr,
        entrypoint: "create_auction",
        calldata: [
          num.toHex(itemFelt),
          constants.addrSTRK,
          atByte,
          Number(createDuration),
          Number(createReveal),
          num.toHex(minBidParsed),
        ],
      }]);

      setStatus(`Creating auction… tx: ${result.transaction_hash.slice(0, 10)}…`);
      await provider.waitForTransaction(result.transaction_hash, { retries: 200, retryInterval: 3000 });
      setStatus(`Auction created! tx: ${result.transaction_hash}`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setStatus("");
    }
  }

  async function handleBid() {
    setError("");
    setStatus("");
    if (!myWalletAccount) { setError("Connect wallet first"); return; }
    if (contractAddr === "0x0") { setError("Set auction contract address first"); return; }

    try {
      const amountParsed = parseAmount(bidAmount);
      const salt = randomSalt();
      const commitment = computeCommitment(amountParsed, salt);

      // Step 1: Approve the auction contract to spend tokens.
      // ERC20 approve takes u256 = (low: u128, high: u128) — two felts.
      setStatus("Approving token spend…");
      const approveLow = (amountParsed & ((1n << 128n) - 1n)).toString();
      const approveHigh = (amountParsed >> 128n).toString();
      const approveResult = await myWalletAccount.execute([{
        contractAddress: constants.addrSTRK,
        entrypoint: "approve",
        calldata: [contractAddr, approveLow, approveHigh],
      }]);
      await provider.waitForTransaction(approveResult.transaction_hash, { retries: 200, retryInterval: 3000 });

      // Step 2: Place the bid.
      setStatus("Placing bid…");
      const bidResult = await myWalletAccount.execute([{
        contractAddress: contractAddr,
        entrypoint: "place_bid",
        calldata: [Number(bidAuctionId), num.toHex(commitment), num.toHex(amountParsed)],
      }]);
      await provider.waitForTransaction(bidResult.transaction_hash, { retries: 200, retryInterval: 3000 });

      // Save secret for reveal.
      saveSecret({
        auctionId: Number(bidAuctionId),
        amount: amountParsed,
        salt,
        commitment,
      });
      setSecrets(loadSecrets());

      setStatus(`Bid placed! tx: ${bidResult.transaction_hash}. Secret saved for reveal.`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setStatus("");
    }
  }

  async function handleReveal() {
    setError("");
    setStatus("");
    if (!myWalletAccount) { setError("Connect wallet first"); return; }

    const secret = secrets.find(
      (s) => s.auctionId === Number(revealAuctionId)
    );
    if (!secret) {
      setError("No saved secret for this auction. Place a bid first.");
      return;
    }

    try {
      setStatus("Revealing bid…");
      const result = await myWalletAccount.execute([{
        contractAddress: contractAddr,
        entrypoint: "reveal_bid",
        calldata: [Number(revealAuctionId), num.toHex(secret.amount), num.toHex(secret.salt)],
      }]);
      await provider.waitForTransaction(result.transaction_hash, { retries: 200, retryInterval: 3000 });
      setStatus(`Bid revealed! Amount: ${formatAmount(secret.amount)} STRK. tx: ${result.transaction_hash}`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setStatus("");
    }
  }

  async function handleSettle() {
    setError("");
    setStatus("");
    if (!myWalletAccount) { setError("Connect wallet first"); return; }

    try {
      setStatus("Settling auction…");
      const result = await myWalletAccount.execute([{
        contractAddress: contractAddr,
        entrypoint: "settle",
        calldata: [Number(settleAuctionId)],
      }]);
      await provider.waitForTransaction(result.transaction_hash, { retries: 200, retryInterval: 3000 });
      setStatus(`Auction settled! tx: ${result.transaction_hash}`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setStatus("");
    }
  }

  async function handleRefund() {
    setError("");
    setStatus("");
    if (!myWalletAccount) { setError("Connect wallet first"); return; }

    try {
      setStatus("Claiming refund…");
      const result = await myWalletAccount.execute([{
        contractAddress: contractAddr,
        entrypoint: "claim_refund",
        calldata: [Number(settleAuctionId)],
      }]);
      await provider.waitForTransaction(result.transaction_hash, { retries: 200, retryInterval: 3000 });
      setStatus(`Refund claimed! tx: ${result.transaction_hash}`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setStatus("");
    }
  }

  // ── Render helpers ──

  // Decode hex error strings from Cairo contracts into readable messages.
  function decodeError(msg: string): string {
    const known: Record<string, string> = {
      "AUCTION_NOT_FOUND": "Auction not found",
      "BIDDING_CLOSED": "Bidding phase has ended",
      "REVEAL_NOT_OPEN": "Reveal phase hasn't started yet — wait for bidding to end",
      "REVEAL_CLOSED": "Reveal phase has ended",
      "ALREADY_BID": "You already placed a bid on this auction",
      "BAD_COMMITMENT": "Commitment mismatch — bid amount or salt is wrong",
      "ALREADY_REVEALED": "Bid already revealed",
      "BELOW_MIN_BID": "Bid amount is below the minimum",
      "NOT_SELLER": "Only the seller can do this",
      "NOT_SETTLED": "Auction hasn't been settled yet",
      "ALREADY_SETTLED": "Auction already settled",
      "AUCTION_STILL_ACTIVE": "Auction is still active — wait for reveal phase to end",
      "NO_BIDS": "No bids were placed",
      "WINNER_CANT_REFUND": "You're the winner — winners can't claim refunds",
      "IS_WINNER": "You're the winner — winners can't claim refunds",
      "NO_DEPOSIT": "No deposit to refund",
      "AUCTION_CANCELLED": "Auction was cancelled",
      "NOT_CANCELLED": "Auction was not cancelled",
      "BIDDING_STILL_OPEN": "Bidding is still open",
      "DEPOSIT_TOO_LOW": "Deposit is below the minimum bid",
      "CANCELLED": "Auction was cancelled",
    };
    // Check if any known error is in the message (hex-encoded).
    for (const [key, val] of Object.entries(known)) {
      // Check both the raw key and hex-encoded version.
      const hexKey = "0x" + Array.from(new TextEncoder().encode(key))
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      if (msg.includes(key) || msg.includes(hexKey)) return val;
    }
    return msg;
  }

  const auctionPhase = (a: AuctionData): string => {
    const now = Math.floor(Date.now() / 1000);
    if (a.cancelled) return "Cancelled";
    if (a.settled) return "Settled";
    if (now < a.biddingEnd) return `Bidding (${timeRemaining(a.biddingEnd)})`;
    if (now < a.revealEnd) return `Reveal (${timeRemaining(a.revealEnd)})`;
    return "Ready to settle";
  };

  return (
    <div className={styles.panel}>
      <h2 style={{ textAlign: "center", fontSize: 22, fontWeight: 600, marginBottom: 4 }}>
        Shade Auctions
      </h2>
      <p style={{ textAlign: "center", color: "var(--muted)", fontSize: 13, marginBottom: 16 }}>
        Private sealed-bid auctions — bids stay hidden until reveal
      </p>

      {/* Contract address input */}
      <div style={{ marginBottom: 12 }}>
        <input
          type="text"
          placeholder="Auction contract address (0x…)"
          value={contractAddr}
          onChange={(e) => setContractAddr(e.target.value)}
          style={{
            width: "100%",
            padding: "10px 14px",
            borderRadius: 12,
            border: "1px solid var(--line)",
            fontFamily: "var(--font-mono-ui), monospace",
            fontSize: 12,
            background: "var(--inset)",
          }}
        />
      </div>

      {/* Tabs */}
      <div className={styles.tabs}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`${styles.tab} ${tab === t.key ? styles.tabActive : ""}`}
            onClick={() => setTab(t.key)}
            style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
          >
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {!isStrk20Network && (
        <div className={styles.warn}>
          Switch to Mainnet or Sepolia to use auctions.
        </div>
      )}

      {/* ── CREATE ── */}
      {tab === "create" && (
        <div className={styles.inputBlock}>
          <div className={styles.inputLabel}>Create Auction</div>
          <p style={{ fontSize: 12, color: "var(--muted)", margin: "4px 0 12px" }}>
            List an item for sealed-bid auction. Bidders won't see each other's amounts.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <label style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, display: "block", marginBottom: 4 }}>Item Name</label>
              <input
                placeholder="e.g. Rare NFT, Domain Name, Art Piece"
                value={createItem}
                onChange={(e) => setCreateItem(e.target.value)}
                style={{ width: "100%", padding: "10px 14px", borderRadius: 12, border: "1px solid var(--line)", fontSize: 14 }}
              />
            </div>
            <div>
              <label style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, display: "block", marginBottom: 4 }}>Auction Format</label>
              <select
                value={createType}
                onChange={(e) => setCreateType(e.target.value as any)}
                style={{ width: "100%", padding: "10px 14px", borderRadius: 12, border: "1px solid var(--line)", fontSize: 14 }}
              >
                <option value="first_price">First Price — winner pays their bid</option>
                <option value="vickrey">Vickrey — winner pays 2nd highest bid</option>
              </select>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, display: "block", marginBottom: 4 }}>Bidding Window</label>
                <input
                  placeholder="seconds"
                  value={createDuration}
                  onChange={(e) => setCreateDuration(e.target.value)}
                  style={{ width: "100%", padding: "10px 14px", borderRadius: 12, border: "1px solid var(--line)", fontSize: 14 }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, display: "block", marginBottom: 4 }}>Reveal Window</label>
                <input
                  placeholder="seconds"
                  value={createReveal}
                  onChange={(e) => setCreateReveal(e.target.value)}
                  style={{ width: "100%", padding: "10px 14px", borderRadius: 12, border: "1px solid var(--line)", fontSize: 14 }}
                />
              </div>
            </div>
            <div>
              <label style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, display: "block", marginBottom: 4 }}>Minimum Bid (STRK)</label>
              <input
                placeholder="e.g. 0.1"
                value={createMinBid}
                onChange={(e) => setCreateMinBid(e.target.value)}
                style={{ width: "100%", padding: "10px 14px", borderRadius: 12, border: "1px solid var(--line)", fontSize: 14 }}
              />
            </div>
          </div>
          {isConnected ? (
            <button className={styles.btnCta} onClick={handleCreate} style={{ marginTop: 12 }}>
              Create Auction
            </button>
          ) : (
            <p style={{ textAlign: "center", color: "var(--muted)", marginTop: 12, fontSize: 13 }}>
              Connect wallet to create
            </p>
          )}
        </div>
      )}

      {/* ── BROWSE ── */}
      {tab === "browse" && (
        <div>
          <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>
            View all auctions on the contract. Refresh to see the latest state.
          </p>
          {loading && <p style={{ textAlign: "center", color: "var(--muted)" }}>Loading auctions…</p>}
          {!loading && auctions.length === 0 && (
            <p style={{ textAlign: "center", color: "var(--muted)", fontSize: 13, padding: 20 }}>
              No auctions yet. Switch to the Create tab to list one.
            </p>
          )}
          {auctions.map((a) => (
            <div key={a.id} className={styles.feeRow} style={{ marginBottom: 8, flexDirection: "column", alignItems: "flex-start" }}>
              <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
                <span style={{ fontWeight: 600 }}>
                  #{a.id} {shortString.decodeShortString(a.itemName.toString())}
                </span>
                <span style={{
                  fontSize: 11,
                  padding: "3px 8px",
                  borderRadius: 999,
                  background: a.settled ? "rgba(0, 230, 118, 0.08)" : a.cancelled ? "rgba(255, 61, 113, 0.08)" : "rgba(0, 255, 200, 0.06)",
                  color: a.settled ? "var(--green)" : a.cancelled ? "var(--danger)" : "var(--pink-text)",
                  fontWeight: 600,
                }}>
                  {auctionPhase(a)}
                </span>
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
                {a.auctionType === "vickrey" ? "Vickrey" : "First Price"} · {a.bidCount} bids · Min: {formatAmount(a.minBid)} STRK
              </div>
              {a.settled && !num.toHex(BigInt(a.winner)).startsWith("0x0") && (
                <div style={{ fontSize: 12, color: "var(--green)", marginTop: 2, fontWeight: 600 }}>
                  Winner: {shortHex(a.winner)} · {formatAmount(a.winningAmount)} STRK
                </div>
              )}
            </div>
          ))}
          <button
            className={styles.btn}
            style={{ width: "100%", marginTop: 8, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}
            onClick={fetchAuctions}
          >
            {Icons.refresh} Refresh Auctions
          </button>
        </div>
      )}

      {/* ── BID ── */}
      {tab === "bid" && (
        <div className={styles.inputBlock}>
          <div className={styles.inputLabel} style={{ display: "flex", alignItems: "center", gap: 6 }}>{Icons.lock} Place Sealed Bid</div>
          <p style={{ fontSize: 12, color: "var(--muted)", margin: "4px 0 12px" }}>
            Your bid amount is hidden via cryptographic commitment. No one can see it until you reveal.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <label style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, display: "block", marginBottom: 4 }}>Auction ID</label>
              <input
                placeholder="e.g. 1"
                value={bidAuctionId}
                onChange={(e) => setBidAuctionId(e.target.value)}
                style={{ width: "100%", padding: "10px 14px", borderRadius: 12, border: "1px solid var(--line)", fontSize: 14 }}
              />
            </div>
            <div>
              <label style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, display: "block", marginBottom: 4 }}>Your Bid (STRK)</label>
              <input
                placeholder="e.g. 5.0"
                value={bidAmount}
                onChange={(e) => setBidAmount(e.target.value)}
                style={{ width: "100%", padding: "10px 14px", borderRadius: 12, border: "1px solid var(--line)", fontSize: 14 }}
              />
            </div>
          </div>
          <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 8, lineHeight: 1.5 }}>
            A deposit equal to your bid is locked in the contract. Your secret key is saved locally — you'll need it to reveal your bid later.
          </p>
          {isConnected ? (
            <button className={styles.btnCta} onClick={handleBid} style={{ marginTop: 12 }}>
              Seal & Submit Bid
            </button>
          ) : (
            <p style={{ textAlign: "center", color: "var(--muted)", marginTop: 12, fontSize: 13 }}>
              Connect wallet to bid
            </p>
          )}
        </div>
      )}

      {/* ── REVEAL ── */}
      {tab === "reveal" && (
        <div className={styles.inputBlock}>
          <div className={styles.inputLabel} style={{ display: "flex", alignItems: "center", gap: 6 }}>{Icons.unlock} Reveal Your Bid</div>
          <p style={{ fontSize: 12, color: "var(--muted)", margin: "4px 0 12px" }}>
            After the bidding window closes, reveal your bid amount to participate in settlement.
          </p>
          <div>
            <label style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, display: "block", marginBottom: 4 }}>Auction ID</label>
            <input
              placeholder="e.g. 1"
              value={revealAuctionId}
              onChange={(e) => setRevealAuctionId(e.target.value)}
              style={{ width: "100%", padding: "10px 14px", borderRadius: 12, border: "1px solid var(--line)", fontSize: 14 }}
            />
          </div>
          {secrets.filter((s) => s.auctionId === Number(revealAuctionId)).length > 0 ? (
            <div style={{ fontSize: 12, color: "var(--green)", marginTop: 8, padding: "8px 12px", borderRadius: 10, background: "var(--green-soft)", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ display: "inline-flex" }}>{Icons.check}</span> Secret found for auction #{revealAuctionId}: <strong>{formatAmount(secrets.find((s) => s.auctionId === Number(revealAuctionId))!.amount)} STRK</strong>
            </div>
          ) : (
            <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
              No saved secret for this auction. Place a bid first to generate your secret key.
            </p>
          )}
          {isConnected ? (
            <button className={styles.btnCta} onClick={handleReveal} style={{ marginTop: 12 }}>
              Reveal Bid
            </button>
          ) : (
            <p style={{ textAlign: "center", color: "var(--muted)", marginTop: 12, fontSize: 13 }}>
              Connect wallet to reveal
            </p>
          )}
        </div>
      )}

      {/* ── SETTLE ── */}
      {tab === "settle" && (
        <div className={styles.inputBlock}>
          <div className={styles.inputLabel} style={{ display: "flex", alignItems: "center", gap: 6 }}>{Icons.check} Settle & Refunds</div>
          <p style={{ fontSize: 12, color: "var(--muted)", margin: "4px 0 12px" }}>
            After the reveal window closes, settle the auction or claim your refund.
          </p>
          <div>
            <label style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, display: "block", marginBottom: 4 }}>Auction ID</label>
            <input
              placeholder="e.g. 1"
              value={settleAuctionId}
              onChange={(e) => setSettleAuctionId(e.target.value)}
              style={{ width: "100%", padding: "10px 14px", borderRadius: 12, border: "1px solid var(--line)", fontSize: 14 }}
            />
          </div>
          {isConnected ? (
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button className={styles.btnCta} onClick={handleSettle} style={{ flex: 1 }}>
                Settle Auction
              </button>
              <button className={styles.btnCta} onClick={handleRefund} style={{ flex: 1, background: "var(--green)" }}>
                Claim Refund
              </button>
            </div>
          ) : (
            <p style={{ textAlign: "center", color: "var(--muted)", marginTop: 12, fontSize: 13 }}>
              Connect wallet to settle
            </p>
          )}
          <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 8, lineHeight: 1.5 }}>
            <strong>Settle</strong> — pays the seller (anyone can trigger). <strong>Claim Refund</strong> — returns your deposit if you didn't win.
          </p>
        </div>
      )}

      {/* ── STRATEGIST ── */}
      {tab === "strategist" && (
        <StrategistTab
          provider={provider}
          contractAddr={contractAddr}
          isStrk20Network={isStrk20Network}
          auctions={auctions}
          onRefresh={fetchAuctions}
        />
      )}

      {/* Status / Error alerts */}
      {status && (
        <div style={{
          marginTop: 12,
          padding: "14px 18px",
          borderRadius: 16,
          background: "rgba(0, 230, 118, 0.06)",
          border: "1px solid rgba(0, 230, 118, 0.2)",
          fontSize: 13,
          wordBreak: "break-all",
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
        }}>
          <span style={{ fontSize: 16, lineHeight: 1 }}>✅</span>
          <span>{status}</span>
        </div>
      )}
      {error && (
        <div style={{
          marginTop: 12,
          padding: "14px 18px",
          borderRadius: 16,
          background: "rgba(255, 61, 113, 0.08)",
          border: "1px solid rgba(255, 61, 113, 0.3)",
          fontSize: 13,
          color: "#ff6b8a",
          wordBreak: "break-word",
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          fontWeight: 500,
        }}>
          <span style={{ fontSize: 16, lineHeight: 1 }}>⚠️</span>
          <span>{decodeError(error)}</span>
        </div>
      )}
    </div>
  );
}

function shortHex(h: string): string {
  const hex = num.toHex(h);
  return hex.length <= 13 ? hex : `${hex.slice(0, 7)}…${hex.slice(-4)}`;
}
