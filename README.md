# Shade — Sealed-Bid Auctions on Starknet

Private sealed-bid auctions built on Starknet using the [STRK20](https://strk20.starknet.io/) privacy pool. Bids are hidden via Poseidon commitments until the reveal phase. Supports first-price and Vickrey (second-price) auction formats.

## Why Sealed-Bid Auctions?

In a transparent on-chain auction, every bid is visible. This creates problems:

- **Bid sniping**: Late bidders see the current highest and shade just above it.
- **Wash bidding**: Fake bids inflate prices.
- **Whale intimidation**: Large bids discourage participation.
- **Collusion**: Bidders coordinate knowing each other's positions.

Sealed-bid auctions solve all of these. Every bid is a cryptographic commitment — the amount is hidden until the reveal phase. No bidder (or observer) can see anyone else's bid during the bidding window.

**Vickrey (second-price) auctions** are considered the gold standard in auction theory: the winner pays the second-highest bid, which incentivizes truthful bidding. They were previously impossible on-chain without trusted intermediaries. Shade makes them trustless.

## How It Works

### Three-Phase Protocol

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│  LISTING  │ ──▶ │  BIDDING  │ ──▶ │  REVEAL   │ ──▶ Settlement
│           │     │           │     │           │
│ Seller    │     │ Sealed    │     │ Bid       │
│ creates   │     │ commits   │     │ amounts   │
│ auction   │     │ via hash  │     │ revealed  │
└──────────┘     └──────────┘     └──────────┘
```

1. **Listing**: Seller creates an auction with item name, token, auction type, bidding/reveal durations, and minimum bid.

2. **Bidding**: Bidders submit a Poseidon hash commitment (`poseidon(amount, salt)`) along with a token deposit. The actual bid amount is hidden inside the commitment. Other bidders and observers see only the hash — the amount is invisible.

3. **Reveal**: After the bidding window closes, bidders reveal their `amount` and `salt`. The contract verifies `poseidon(amount, salt) == commitment`. Revealed amounts update the highest and second-highest bid tracking.

4. **Settlement**: After the reveal window, anyone can trigger settlement. The winner is determined, the seller is paid, and losers can claim their deposit refunds.

### Auction Types

- **First-Price**: Winner pays their exact bid amount.
- **Vickrey (Second-Price)**: Winner pays the second-highest revealed bid. This incentivizes bidders to bid their true value — a foundational result in auction theory.

### STRK20 Integration

Shade integrates with the STRK20 privacy pool through the `privacy_invoke` anonymizer pattern:

- **Bid via pool**: Bidders can submit bids through the STRK20 privacy pool. The pool withdraws tokens to the auction contract, which records the bid and approves the pool to pull funds back into an encrypted note. This path keeps the bidder's identity hidden from on-chain observers.
- **Direct bid**: For simpler flows, bidders can approve and deposit tokens directly to the auction contract with a commitment hash.
- **Settlement via pool**: The seller's payment and loser refunds flow through the contract's ERC20 transfers, compatible with STRK20's shielded balance model.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Smart Contracts | Cairo (Scarb 2.18.0) |
| Settlement | Starknet (Mainnet + Sepolia) |
| Privacy | STRK20 Privacy Pool |
| Frontend | Next.js 16, React 19, TypeScript |
| Wallet | starknet.js v10.4.0, get-starknet v6, Ready wallet |
| State | Zustand |
| Deploy | Vercel |

## Repository Structure

```
shade/
├── cairo/
│   └── src/
│       └── lib.cairo              # Shade auction contract
├── src/
│   ├── app/
│   │   ├── page.tsx               # Main page (auction + wallet UI)
│   │   ├── components/
│   │   │   ├── AuctionPanel.tsx    # Auction UI (create, browse, bid, reveal, settle)
│   │   │   └── client/            # Wallet connect components (from starter kit)
│   │   └── uni.module.css         # Uniswap-style light theme
│   └── utils/
│       ├── auction.ts             # Contract ABI, helpers, commitment hashing
│       └── constants.ts           # Network config, addresses
├── scripts/
│   ├── deploy.ts                  # Deploy contract to Starknet
│   └── demo_flow.ts               # Full auction demo (3 bidders)
├── strk20.json                    # Hackathon submission file
└── .env.example                   # Environment variable template
```

## Getting Started

### Prerequisites

- Node.js 20+
- [Scarb](https://docs.swmansion.com/scarb/) 2.18.0
- A Starknet wallet ([Ready](https://www.ready.co/))
- An [Alchemy](https://alchemy.com) RPC key (free tier works)

### Setup

```bash
# Clone and install
git clone <repo-url>
cd shade
yarn install

# Configure environment
cp .env.example .env.local
# Edit .env.local with your Alchemy key and contract address

# Build the Cairo contract
cd cairo && scarb build && cd ..

# Run the dev server
yarn dev
```

### Deploy the Contract

```bash
# Set deployer credentials in .env.local, then:
npx tsx scripts/deploy.ts

# Copy the output address to .env.local:
# NEXT_PUBLIC_SHADE_ADDR=0x...
```

### Run the Demo

```bash
# Configure seller + 3 bidder accounts in .env.local, then:
npx tsx scripts/demo_flow.ts
```

### Frontend

Open [http://localhost:3000](http://localhost:3000) and connect your Ready wallet.

- **Create**: List a new auction with item name, type, durations, and minimum bid.
- **Browse**: View all active auctions with their phase and bid count.
- **Bid**: Submit a sealed bid (amount + commitment). The secret is saved in your browser for the reveal phase.
- **Reveal**: Reveal your bid after the bidding window closes.
- **Settle**: Trigger settlement (seller) or claim your refund (loser).

## Contract Interface

### Write Functions

| Function | Description |
|----------|-------------|
| `create_auction(item, token, type, bid_dur, reveal_dur, min_bid)` | Create a new auction |
| `place_bid(auction_id, commitment, deposit)` | Submit a sealed bid with deposit |
| `reveal_bid(auction_id, amount, salt)` | Reveal bid amount during reveal phase |
| `settle(auction_id)` | Determine winner, pay seller |
| `claim_refund(auction_id)` | Loser claims deposit refund |
| `cancel_auction(auction_id)` | Seller cancels before bidding ends |
| `privacy_invoke(token, pool, note_id)` | STRK20 pool integration for private bids |

### View Functions

| Function | Description |
|----------|-------------|
| `get_auction(id)` | Full auction state |
| `get_bid(auction_id, bidder)` | Bid state for a specific bidder |
| `get_auction_count()` | Total auctions created |
| `compute_commitment(amount, salt)` | Compute Poseidon commitment hash |

## Security Model

- **Commitment integrity**: Bid amounts are bound by `poseidon(amount, salt)`. Revealing a different amount fails verification.
- **Deposit enforcement**: Bids require a token deposit ≥ the minimum bid. Revealed amounts cannot exceed the deposit.
- **Phase ordering**: Bids only accepted during the bidding window. Reveals only during the reveal window. Settlement only after reveal closes.
- **No front-running**: Since bid amounts are hidden, MEV searchers cannot front-run based on bid values.
- **Refund safety**: Only the original bidder can claim their refund. Winners cannot claim refunds.

## Future Extensions

- **Encrypted note bids**: Replace commit-reveal with STRK20 encrypted notes for stronger privacy (amounts hidden even during deposit).
- **Force-reveal / threshold auditing**: Force-reveal non-cooperative bidders after a timeout.
- **Multi-unit auctions**: Allocate multiple items in a single sealed-bid event.
- **Relayer support**: Gasless bid submission via meta-transactions.
- **Viewing key disclosure**: Scoped proofs for regulators to audit specific bids without revealing the full auction.

## License

MIT
