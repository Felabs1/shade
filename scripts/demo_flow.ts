/**
 * Run a full Shade auction demo flow via CLI.
 *
 * This script:
 *   1. Creates an auction
 *   2. Places 3 sealed bids from different accounts
 *   3. Waits for bidding to end
 *   4. Reveals all bids
 *   5. Settles the auction (pays winner, refunds losers)
 *
 * Usage:
 *   npx tsx scripts/demo_flow.ts
 *
 * Required env vars:
 *   SELLER_PRIVATE_KEY    - seller account private key
 *   SELLER_ADDRESS        - seller account address
 *   BIDDER1_PRIVATE_KEY   - bidder 1 private key
 *   BIDDER1_ADDRESS       - bidder 1 address
 *   BIDDER2_PRIVATE_KEY   - bidder 2 private key
 *   BIDDER2_ADDRESS       - bidder 2 address
 *   BIDDER3_PRIVATE_KEY   - bidder 3 private key
 *   BIDDER3_ADDRESS       - bidder 3 address
 *   SHADE_ADDR              - deployed auction contract address
 *   STRK_TOKEN_ADDR       - STRK token address
 *   RPC_URL               - Starknet RPC endpoint
 */

import { Account, RpcProvider, hash, shortString, num } from "starknet";
import * as fs from "fs";
import * as path from "path";

// Load .env.local manually.
function loadEnv(filePath: string) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) process.env[match[1].trim()] = match[2].trim();
    }
  } catch { /* file may not exist */ }
}

loadEnv(path.resolve(__dirname, "../.env"));
loadEnv(path.resolve(__dirname, "../.env.local")); // .env.local overrides

const SHADE_ADDR = process.env.SHADE_ADDR!;
const STRK_TOKEN = process.env.STRK_TOKEN_ADDR ?? "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const RPC_URL = process.env.RPC_URL!;

if (!SHADE_ADDR || !RPC_URL) {
  console.error("Set SHADE_ADDR and RPC_URL in env");
  process.exit(1);
}

const provider = new RpcProvider({ nodeUrl: RPC_URL });

function makeAccount(keyVar: string, addrVar: string): Account {
  const key = process.env[keyVar];
  const addr = process.env[addrVar];
  if (!key || !addr) {
    console.error(`Missing ${keyVar} or ${addrVar}`);
    process.exit(1);
  }
  return new Account({ provider, address: addr, signer: key });
}

// Compute Poseidon commitment (same as contract).
function computeCommitment(amount: bigint, salt: bigint): string {
  return hash.computePoseidonHashOnElements([amount, salt]);
}

function randomSalt(): bigint {
  return BigInt("0x" + Array.from(crypto.getRandomValues(new Uint8Array(31)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(""));
}

const STRK = (n: number) => BigInt(n) * 10n ** 18n;

async function main() {
  const seller = makeAccount("SELLER_PRIVATE_KEY", "SELLER_ADDRESS");
  const bidder1 = makeAccount("BIDDER1_PRIVATE_KEY", "BIDDER1_ADDRESS");
  const bidder2 = makeAccount("BIDDER2_PRIVATE_KEY", "BIDDER2_ADDRESS");
  const bidder3 = makeAccount("BIDDER3_PRIVATE_KEY", "BIDDER3_ADDRESS");

  console.log("═══════════════════════════════════════════");
  console.log("  Shade Auction — Full Demo Flow");
  console.log("═══════════════════════════════════════════\n");

  // Step 1: Create auction (60s bidding, 60s reveal for demo speed).
  console.log("Step 1: Creating auction…");
  const createTx = await seller.execute([{
    contractAddress: SHADE_ADDR,
    entrypoint: "create_auction",
    calldata: [
      shortString.encodeShortString("Rare NFT Artwork"),
      STRK_TOKEN,
      0,     // FirstPrice
      60,    // 60s bidding
      60,    // 60s reveal
      STRK(1), // min 1 STRK
    ],
  }]);
  await provider.waitForTransaction(createTx.transaction_hash);
  console.log(`  ✓ Auction created — tx: ${createTx.transaction_hash}`);

  // Get auction ID (assumes first auction = 1).
  const auctionId = 1;

  // Step 2: Place bids.
  const bids = [
    { account: bidder1, amount: STRK(5), label: "Bidder 1" },
    { account: bidder2, amount: STRK(8), label: "Bidder 2" },
    { account: bidder3, amount: STRK(3), label: "Bidder 3" },
  ];

  const secrets: { amount: bigint; salt: bigint }[] = [];

  for (const bid of bids) {
    console.log(`\nStep 2: ${bid.label} placing ${num.toHex(bid.amount)} bid…`);
    const salt = randomSalt();
    const commitment = computeCommitment(bid.amount, salt);
    secrets.push({ amount: bid.amount, salt });

    // Approve.
    const approveTx = await bid.account.execute([{
      contractAddress: STRK_TOKEN,
      entrypoint: "approve",
      calldata: [SHADE_ADDR, bid.amount],
    }]);
    await provider.waitForTransaction(approveTx.transaction_hash);

    // Place bid.
    const bidTx = await bid.account.execute([{
      contractAddress: SHADE_ADDR,
      entrypoint: "place_bid",
      calldata: [auctionId, commitment, bid.amount],
    }]);
    await provider.waitForTransaction(bidTx.transaction_hash);
    console.log(`  ✓ Bid placed — tx: ${bidTx.transaction_hash}`);
  }

  // Step 3: Wait for bidding to end.
  console.log("\nStep 3: Waiting 60s for bidding phase to end…");
  for (let i = 60; i > 0; i -= 10) {
    console.log(`  ${i}s remaining…`);
    await new Promise((r) => setTimeout(r, 10000));
  }

  // Step 4: Reveal bids.
  for (let i = 0; i < bids.length; i++) {
    console.log(`\nStep 4: ${bids[i].label} revealing bid…`);
    const revealTx = await bids[i].account.execute([{
      contractAddress: SHADE_ADDR,
      entrypoint: "reveal_bid",
      calldata: [auctionId, secrets[i].amount, secrets[i].salt],
    }]);
    await provider.waitForTransaction(revealTx.transaction_hash);
    console.log(`  ✓ Revealed — tx: ${revealTx.transaction_hash}`);
  }

  // Step 5: Wait for reveal to end.
  console.log("\nStep 5: Waiting 60s for reveal phase to end…");
  for (let i = 60; i > 0; i -= 10) {
    console.log(`  ${i}s remaining…`);
    await new Promise((r) => setTimeout(r, 10000));
  }

  // Step 6: Settle.
  console.log("\nStep 6: Settling auction…");
  const settleTx = await seller.execute([{
    contractAddress: SHADE_ADDR,
    entrypoint: "settle",
    calldata: [auctionId],
  }]);
  await provider.waitForTransaction(settleTx.transaction_hash);
  console.log(`  ✓ Auction settled — tx: ${settleTx.transaction_hash}`);

  // Step 7: Losers claim refunds.
  console.log("\nStep 7: Losers claiming refunds…");
  for (const loser of [bids[0], bids[2]]) { // Bidder 1 and 3 lost
    const refundTx = await loser.account.execute([{
      contractAddress: SHADE_ADDR,
      entrypoint: "claim_refund",
      calldata: [auctionId],
    }]);
    await provider.waitForTransaction(refundTx.transaction_hash);
    console.log(`  ✓ ${loser.label} refunded — tx: ${refundTx.transaction_hash}`);
  }

  console.log("\n═══════════════════════════════════════════");
  console.log("  Demo complete! Winner: Bidder 2 (8 STRK)");
  console.log("  Seller paid: 8 STRK (first-price)");
  console.log("  Losers refunded: 5 + 3 STRK");
  console.log("═══════════════════════════════════════════");
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
