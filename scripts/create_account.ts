/**
 * Create a fresh Starknet account (OpenZeppelin 0.15.1) for deployments.
 *
 * Usage:
 *   # Step 1: Generate keys (no network needed)
 *   npx tsx scripts/create_account.ts
 *
 *   # Step 2: Fund the printed address with ETH (faucet or bridge)
 *
 *   # Step 3: Deploy the account contract on-chain
 *   RPC_URL=https://... npx tsx scripts/create_account.ts --deploy
 *
 * Optional env vars (for --deploy step):
 *   RPC_URL  — Starknet RPC endpoint
 */

import { ec, hash, stark, RpcProvider, Account } from "starknet";
import * as fs from "fs";
import * as path from "path";

// ── Env loading (same pattern as deploy.ts) ────────────────────────────────

function loadEnv(filePath: string) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && val) process.env[key] = val;
    }
  } catch { /* file may not exist */ }
}

const PROJECT_ROOT = process.cwd();
loadEnv(path.resolve(PROJECT_ROOT, ".env"));
loadEnv(path.resolve(PROJECT_ROOT, ".env.local"));

// ── Constants ──────────────────────────────────────────────────────────────

// OpenZeppelin Account 0.15.1 — pre-declared on both Sepolia and Mainnet.
const OZ_ACCOUNT_CLASS_HASH = "0x061dac032f228abef9c6626f995015233097ae253a7f72d68552db02f2971b8f";

// Check if we should deploy.
const shouldDeploy = process.argv.includes("--deploy");

// ── Key generation file ────────────────────────────────────────────────────

const KEYS_FILE = path.resolve(PROJECT_ROOT, ".account_keys.json");

async function main() {
  if (shouldDeploy) {
    await deployAccount();
  } else {
    generateKeys();
  }
}

function generateKeys() {
  // Generate a random private key.
  const privateKey = stark.randomAddress();
  const publicKey = ec.starkCurve.getStarkKey(privateKey);

  // Compute the account address (OZ account constructor takes public key).
  const address = hash.calculateContractAddressFromHash(
    publicKey,             // salt
    OZ_ACCOUNT_CLASS_HASH, // class hash
    [publicKey],           // constructor calldata (OZ takes public key)
    0                      // deployer address (0 for UDC)
  );

  // Save to file so --deploy can pick it up.
  fs.writeFileSync(KEYS_FILE, JSON.stringify({ privateKey, publicKey, address }, null, 2));

  console.log("\n═══════════════════════════════════════════");
  console.log("  New Starknet Account (OZ 0.15.1)");
  console.log("═══════════════════════════════════════════");
  console.log(`  Private key: ${privateKey}`);
  console.log(`  Public key:  ${publicKey}`);
  console.log(`  Address:     ${address}`);
  console.log("═══════════════════════════════════════════");
  console.log("\n⚠️  SAVE YOUR PRIVATE KEY — it cannot be recovered.\n");
  console.log("Keys saved to .account_keys.json (add to .gitignore!)");
  console.log("\nNext steps:");
  console.log("  1. Send ETH to the address above (Sepolia faucet or mainnet bridge)");
  console.log("  2. Deploy the account:");
  console.log("     RPC_URL=https://your-rpc npx tsx scripts/create_account.ts --deploy");
  console.log("\nAdd to .env.local:");
  console.log(`  DEPLOYER_PRIVATE_KEY=${privateKey}`);
  console.log(`  DEPLOYER_ADDRESS=${address}`);
}

async function deployAccount() {
  const RPC_URL = process.env.RPC_URL;
  if (!RPC_URL) {
    console.error("Set RPC_URL in env or pass it inline:");
    console.error("  RPC_URL=https://... npx tsx scripts/create_account.ts --deploy");
    process.exit(1);
  }

  // Load keys from file.
  if (!fs.existsSync(KEYS_FILE)) {
    console.error("No .account_keys.json found. Run without --deploy first to generate keys.");
    process.exit(1);
  }

  const keys = JSON.parse(fs.readFileSync(KEYS_FILE, "utf-8"));
  const { privateKey, publicKey, address } = keys;

  console.log("Deploying account…");
  console.log(`  Address: ${address}`);
  console.log(`  RPC:     ${RPC_URL}`);

  const provider = new RpcProvider({ nodeUrl: RPC_URL });

  // Check balance.
  const STRK_TOKEN = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
  try {
    const { Contract } = await import("starknet");
    const strk = new Contract([{
      type: "function", name: "balance_of",
      inputs: [{ name: "account", type: "core::starknet::contract_address::ContractAddress" }],
      outputs: [{ type: "core::integer::u256" }],
      state_mutability: "view",
    }], STRK_TOKEN, provider);
    const bal = await strk.balance_of(address);
    console.log(`  STRK balance: ${bal.toString()}`);
  } catch { /* non-fatal */ }

  // Deploy the account via deploy_account transaction.
  const account = new Account({ provider, address, signer: privateKey });

  console.log("\n  Sending deploy_account transaction…");
  try {
    const result = await account.deployAccount({
      classHash: OZ_ACCOUNT_CLASS_HASH,
      constructorCalldata: [publicKey],
      addressSalt: publicKey,
    });
    console.log(`  Deploy tx: ${result.transaction_hash}`);

    await provider.waitForTransaction(result.transaction_hash);
    console.log("  ✓ Account deployed!\n");

    console.log("═══════════════════════════════════════════");
    console.log("  Account ready to use");
    console.log("═══════════════════════════════════════════");
    console.log(`  Address: ${address}`);
    console.log("═══════════════════════════════════════════");
    console.log("\nAdd to .env.local:");
    console.log(`  DEPLOYER_PRIVATE_KEY=${privateKey}`);
    console.log(`  DEPLOYER_ADDRESS=${address}`);
  } catch (err: any) {
    if (err?.message?.includes("INSUFFICIENT") || err?.message?.includes("insufficient")) {
      console.error("\n❌ Insufficient funds. Send ETH/STRK to the address first:");
      console.error(`   ${address}`);
      console.error("\n   Sepolia faucet: https://starknet-faucet.vercel.app/");
    } else {
      console.error("\nDeploy failed:", err?.message ?? err);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
