/**
 * Deploy Shade auction contract to Starknet.
 *
 * Usage:
 *   npx tsx scripts/deploy.ts
 *
 * Required env vars (in .env or .env.local):
 *   DEPLOYER_PRIVATE_KEY  - hex private key of the deploying account
 *   DEPLOYER_ADDRESS      - Starknet address of the deploying account
 *   RPC_URL               - Starknet RPC endpoint (Alchemy, Blast, etc.)
 *   NETWORK               - "mainnet" or "sepolia" (default: sepolia)
 */

import { Account, RpcProvider, json, Contract } from "starknet";
import * as fs from "fs";
import * as path from "path";

// Load .env.local manually (scripts excluded from Next.js build).
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
      // Strip surrounding quotes.
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && val) process.env[key] = val;
    }
  } catch { /* file may not exist */ }
}

// Resolve project root (works with tsx, node, and bun).
const PROJECT_ROOT = process.cwd();
loadEnv(path.resolve(PROJECT_ROOT, ".env"));
loadEnv(path.resolve(PROJECT_ROOT, ".env.local")); // .env.local overrides .env

const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const ADDRESS = process.env.DEPLOYER_ADDRESS;
const RPC_URL = process.env.RPC_URL;

if (!PRIVATE_KEY || !ADDRESS || !RPC_URL) {
  console.error("Missing env vars. Set DEPLOYER_PRIVATE_KEY, DEPLOYER_ADDRESS, RPC_URL");
  process.exit(1);
}

async function main() {
  const provider = new RpcProvider({ nodeUrl: RPC_URL });
  const account = new Account({ provider, address: ADDRESS, signer: PRIVATE_KEY });

  console.log("Deploying Shade auction contract…");
  console.log(`  Deployer: ${ADDRESS}`);
  console.log(`  RPC: ${RPC_URL}`);

  // Read compiled contract artifacts.
  const sierraPath = path.resolve(PROJECT_ROOT, "cairo/target/dev/shade_Shade.contract_class.json");
  const casmPath = path.resolve(PROJECT_ROOT, "cairo/target/dev/shade_Shade.compiled_contract_class.json");

  if (!fs.existsSync(sierraPath)) {
    console.error("Sierra artifact not found. Run `cd cairo && scarb build` first.");
    process.exit(1);
  }

  const sierra = json.parse(fs.readFileSync(sierraPath, "utf-8"));
  const casm = json.parse(fs.readFileSync(casmPath, "utf-8"));

  // Declare the contract class.
  console.log("\n1. Declaring contract class…");
  const declareResult = await account.declare({
    contract: sierra,
    casm,
  });
  console.log(`   Class hash: ${declareResult.class_hash}`);
  console.log(`   Declare tx: ${declareResult.transaction_hash}`);

  await provider.waitForTransaction(declareResult.transaction_hash);
  console.log("   ✓ Class declared");

  // Deploy via UDC.
  console.log("\n2. Deploying contract instance via UDC…");
  const deployResult = await account.deployContract({
    classHash: declareResult.class_hash,
    constructorCalldata: [],
  });
  console.log(`   Contract address: ${deployResult.contract_address}`);
  console.log(`   Deploy tx: ${deployResult.transaction_hash}`);

  await provider.waitForTransaction(deployResult.transaction_hash);
  console.log("   ✓ Contract deployed");

  console.log("\n═══════════════════════════════════════════");
  console.log(`  Class hash:   ${declareResult.class_hash}`);
  console.log(`  Contract:     ${deployResult.contract_address}`);
  console.log("═══════════════════════════════════════════");
  console.log("\nAdd to .env.local:");
  console.log(`  NEXT_PUBLIC_SHADE_ADDR=${deployResult.contract_address}`);
  console.log(`  NEXT_PUBLIC_SHADE_CLASS_HASH=${declareResult.class_hash}`);
}

main().catch((err) => {
  console.error("Deploy failed:", err);
  process.exit(1);
});
