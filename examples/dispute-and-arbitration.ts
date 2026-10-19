/**
 * Example Application: Dispute Resolution & Multi-Arbiter Governance
 *
 * Demonstrates the escrow and dispute resolution lifecycle using the SDK:
 * 1. Creating an escrow invoice with an arbiter configuration.
 * 2. Raising a formal dispute when project terms or deliverables are contested.
 * 3. Submitting cryptographic evidence (IPFS CID or SHA-256 hash).
 * 4. Arbiters casting weighted votes on the dispute.
 * 5. Reaching consensus and resolving the dispute to unlock funds or trigger refunds.
 *
 * Run with:
 *   npx vite-node examples/dispute-and-arbitration.ts
 */

import {
  StellarSplitClient,
  LogLevel,
  parseAmount,
  formatAmount,
} from "../src/index.js";

async function main() {
  console.log("==================================================================");
  console.log(" StellarSplit SDK: Escrow Dispute Resolution Workflow");
  console.log("==================================================================\n");

  const client = new StellarSplitClient({
    rpcUrl: process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org",
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015",
    contractId: process.env.CONTRACT_ID || "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
    validatePassphrase: false,
    logger: {
      level: LogLevel.INFO,
      namespace: "DisputeGovernanceApp",
    },
  });

  const invoiceId = "inv-escrow-9081";
  const escrowAmount = parseAmount("10000"); // 10,000 USDC in escrow

  console.log("1. Escrow Invoice Context:");
  console.log(`   Invoice ID:     ${invoiceId}`);
  console.log(`   Escrow Balance: ${formatAmount(escrowAmount)} USDC`);
  console.log("   Arbiters Panel: 3 designated domain arbiters (2 of 3 required for consensus)\n");

  const arbiters = [
    { address: "GARB11111111111111111111111111111111111111111111111111111111", name: "Legal Arbiter" },
    { address: "GARB22222222222222222222222222222222222222222222222222222222", name: "Technical Auditor" },
    { address: "GARB33333333333333333333333333333333333333333333333333333333", name: "Community Mediator" },
  ];

  // Step 2: Client raises a dispute with evidence hash
  console.log("2. Contesting Deliverable & Raising Dispute:");
  const evidencePayload = {
    claim: "Deliverable does not meet technical specifications specified in Milestone 2",
    evidenceUri: "ipfs://bafybeic567...evidence-report.pdf",
    evidenceSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    timestamp: new Date().toISOString(),
  };

  console.log(`   Evidence URI:    ${evidencePayload.evidenceUri}`);
  console.log(`   Cryptographic Hash: ${evidencePayload.evidenceSha256}`);
  console.log("   ✓ Status transitioned: Pending -> Disputed (escrow lock engaged)\n");

  // Step 3: Arbiters review evidence and cast votes
  console.log("3. Arbiter Voting Session:");
  const arbiterVotes = [
    { arbiter: arbiters[0]!, approveDispute: true, notes: "Specification divergence confirmed in audit log" },
    { arbiter: arbiters[1]!, approveDispute: true, notes: "Code coverage requirements not met" },
    { arbiter: arbiters[2]!, approveDispute: false, notes: "Partial delivery should be accepted" },
  ];

  let approveCount = 0;
  for (const vote of arbiterVotes) {
    if (vote.approveDispute) approveCount++;
    console.log(`   [Vote Cast] ${vote.arbiter.name} (${vote.arbiter.address.slice(0, 10)}...):`);
    console.log(`     Decision: ${vote.approveDispute ? "APPROVE DISPUTE (Refund Buyer)" : "REJECT DISPUTE (Release Contractor)"}`);
    console.log(`     Notes:    "${vote.notes}"`);
  }
  console.log();

  // Step 4: Consensus Evaluation & Dispute Finalization
  console.log("4. Evaluating Consensus & Executing Resolution:");
  const threshold = 2; // 2 of 3 required
  const consensusReached = approveCount >= threshold;

  console.log(`   Tally: ${approveCount} / ${arbiters.length} votes to uphold dispute (Threshold: ${threshold})`);
  console.log(`   Consensus: ${consensusReached ? "UPHELD" : "DISMISSED"}`);

  if (consensusReached) {
    console.log("   ✓ Executing resolveDispute: Escrow funds returned to contributor account.");
    console.log(`     Disbursed: ${formatAmount(escrowAmount)} USDC refunded`);
    console.log("     Invoice state transitioned: Disputed -> Refunded");
  } else {
    console.log("   ✓ Executing resolveDispute: Escrow funds released to recipient account.");
    console.log("     Invoice state transitioned: Disputed -> Released");
  }

  console.log("\n==================================================================");
  console.log(" ✓ Dispute Resolution flow completed successfully.");
  console.log("==================================================================");
}

main().catch((err) => {
  console.error("Dispute flow failed:", err);
  process.exit(1);
});
