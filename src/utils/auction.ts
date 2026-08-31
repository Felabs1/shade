import { Abi, Contract, RpcProvider, num, hash, CallData } from "starknet";

// Shade auction contract ABI (subset — only the functions we call from the frontend).
export const SHADE_ABI: Abi = [
  {
    type: "function",
    name: "create_auction",
    inputs: [
      { name: "item_name", type: "core::felt252" },
      { name: "token", type: "core::starknet::contract_address::ContractAddress" },
      { name: "auction_type", type: "core::integer::u8" },
      { name: "bidding_duration", type: "core::integer::u64" },
      { name: "reveal_duration", type: "core::integer::u64" },
      { name: "min_bid", type: "core::integer::u128" },
    ],
    outputs: [{ type: "core::integer::u64" }],
    state_mutability: "external",
  },
  {
    type: "function",
    name: "place_bid",
    inputs: [
      { name: "auction_id", type: "core::integer::u64" },
      { name: "commitment", type: "core::felt252" },
      { name: "deposit_amount", type: "core::integer::u128" },
    ],
    outputs: [],
    state_mutability: "external",
  },
  {
    type: "function",
    name: "reveal_bid",
    inputs: [
      { name: "auction_id", type: "core::integer::u64" },
      { name: "amount", type: "core::integer::u128" },
      { name: "salt", type: "core::felt252" },
    ],
    outputs: [],
    state_mutability: "external",
  },
  {
    type: "function",
    name: "settle",
    inputs: [{ name: "auction_id", type: "core::integer::u64" }],
    outputs: [],
    state_mutability: "external",
  },
  {
    type: "function",
    name: "claim_refund",
    inputs: [{ name: "auction_id", type: "core::integer::u64" }],
    outputs: [],
    state_mutability: "external",
  },
  {
    type: "function",
    name: "cancel_auction",
    inputs: [{ name: "auction_id", type: "core::integer::u64" }],
    outputs: [],
    state_mutability: "external",
  },
  {
    type: "struct",
    name: "shade::Shade::AuctionInfo",
    members: [
      { name: "id", type: "core::integer::u64" },
      { name: "seller", type: "core::starknet::contract_address::ContractAddress" },
      { name: "item_name", type: "core::felt252" },
      { name: "token", type: "core::starknet::contract_address::ContractAddress" },
      { name: "auction_type", type: "core::integer::u8" },
      { name: "bidding_end", type: "core::integer::u64" },
      { name: "reveal_end", type: "core::integer::u64" },
      { name: "min_bid", type: "core::integer::u128" },
      { name: "settled", type: "core::bool" },
      { name: "cancelled", type: "core::bool" },
      { name: "winner", type: "core::starknet::contract_address::ContractAddress" },
      { name: "winning_amount", type: "core::integer::u128" },
      { name: "bid_count", type: "core::integer::u32" },
    ],
  },
  {
    type: "function",
    name: "get_auction",
    inputs: [{ name: "auction_id", type: "core::integer::u64" }],
    outputs: [{ type: "shade::Shade::AuctionInfo" }],
    state_mutability: "view",
  },
  {
    type: "struct",
    name: "shade::Shade::BidInfo",
    members: [
      { name: "bidder", type: "core::starknet::contract_address::ContractAddress" },
      { name: "auction_id", type: "core::integer::u64" },
      { name: "revealed", type: "core::bool" },
      { name: "amount", type: "core::integer::u128" },
      { name: "deposit", type: "core::integer::u128" },
    ],
  },
  {
    type: "function",
    name: "get_bid",
    inputs: [
      { name: "auction_id", type: "core::integer::u64" },
      { name: "bidder", type: "core::starknet::contract_address::ContractAddress" },
    ],
    outputs: [{ type: "shade::Shade::BidInfo" }],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "get_auction_count",
    inputs: [],
    outputs: [{ type: "core::integer::u64" }],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "compute_commitment",
    inputs: [
      { name: "amount", type: "core::integer::u128" },
      { name: "salt", type: "core::felt252" },
    ],
    outputs: [{ type: "core::felt252" }],
    state_mutability: "view",
  },
];

// ERC20 ABI (approve only).
const ERC20_APPROVE_ABI: Abi = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "core::starknet::contract_address::ContractAddress" },
      { name: "amount", type: "core::integer::u256" },
    ],
    outputs: [{ type: "core::bool" }],
    state_mutability: "external",
  },
];

export interface AuctionData {
  id: number;
  seller: string;
  itemName: string;
  token: string;
  auctionType: "first_price" | "vickrey";
  biddingEnd: number;
  revealEnd: number;
  minBid: bigint;
  settled: boolean;
  cancelled: boolean;
  winner: string;
  winningAmount: bigint;
  bidCount: number;
}

export interface BidData {
  bidder: string;
  auctionId: number;
  revealed: boolean;
  amount: bigint;
  deposit: bigint;
}

// Parse raw contract response into AuctionData.
export function parseAuction(raw: any): AuctionData {
  return {
    id: Number(raw.id ?? raw[0] ?? 0),
    seller: raw.seller ?? raw[1] ?? "0x0",
    itemName: raw.item_name ?? raw[2] ?? "0x0",
    token: raw.token ?? raw[3] ?? "0x0",
    auctionType: Number(raw.auction_type ?? raw[4] ?? 0) === 1 ? "vickrey" : "first_price",
    biddingEnd: Number(raw.bidding_end ?? raw[5] ?? 0),
    revealEnd: Number(raw.reveal_end ?? raw[6] ?? 0),
    minBid: BigInt(raw.min_bid ?? raw[7] ?? 0),
    settled: Boolean(raw.settled ?? raw[8] ?? false),
    cancelled: Boolean(raw.cancelled ?? raw[9] ?? false),
    winner: raw.winner ?? raw[10] ?? "0x0",
    winningAmount: BigInt(raw.winning_amount ?? raw[11] ?? 0),
    bidCount: Number(raw.bid_count ?? raw[12] ?? 0),
  };
}

export function parseBid(raw: any): BidData {
  return {
    bidder: raw.bidder ?? raw[0] ?? "0x0",
    auctionId: Number(raw.auction_id ?? raw[1] ?? 0),
    revealed: Boolean(raw.revealed ?? raw[2] ?? false),
    amount: BigInt(raw.amount ?? raw[3] ?? 0),
    deposit: BigInt(raw.deposit ?? raw[4] ?? 0),
  };
}

// Compute commitment hash client-side (matches contract's poseidon_hash_span).
export function computeCommitment(amount: bigint, salt: bigint): string {
  return hash.computePoseidonHashOnElements([amount, salt]);
}

// Generate a random salt.
export function randomSalt(): bigint {
  return BigInt("0x" + Array.from(crypto.getRandomValues(new Uint8Array(31)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(""));
}

// Format a felt as a human-readable token amount (18 decimals for STRK).
export function formatAmount(amount: bigint, decimals: number = 18): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const frac = (amount % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// Parse a human-readable amount to the token's smallest unit.
export function parseAmount(input: string, decimals: number = 18): bigint {
  const parts = input.split(".");
  const whole = BigInt(parts[0] || "0") * 10n ** BigInt(decimals);
  if (!parts[1]) return whole;
  const fracStr = parts[1].padEnd(decimals, "0").slice(0, decimals);
  return whole + BigInt(fracStr);
}

// Seconds remaining until a timestamp.
export function timeRemaining(targetTimestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = targetTimestamp - now;
  if (diff <= 0) return "Ended";
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// Get a Contract instance for read calls.
export function getAuctionContract(
  address: string,
  provider: RpcProvider,
): Contract {
  return new Contract({ abi: SHADE_ABI, address, providerOrAccount: provider });
}

// Get a Contract instance for ERC20 approve calls.
export function getErc20Contract(
  address: string,
  account: any,
): Contract {
  return new Contract({ abi: ERC20_APPROVE_ABI, address, providerOrAccount: account });
}
