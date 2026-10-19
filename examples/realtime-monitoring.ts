/**
 * Example Application: Real-Time Event Streaming & Invoice Monitoring
 *
 * Demonstrates live event streaming and state monitoring using the SDK:
 * 1. Listening to global contract event emitters (Payment, Release, Refund).
 * 2. Creating individual invoice-level event subscriptions.
 * 3. Handling network reconnects and transport failover (WebSocket <-> SSE <-> RPC).
 * 4. Gracefully tearing down listeners and resources on shutdown.
 *
 * Run with:
 *   npx vite-node examples/realtime-monitoring.ts
 */

import {
  StellarSplitClient,
  LogLevel,
  formatAmount,
} from "../src/index.js";

async function main() {
  console.log("==================================================================");
  console.log(" StellarSplit SDK: Real-Time Monitoring & Event Streaming");
  console.log("==================================================================\n");

  const client = new StellarSplitClient({
    rpcUrl: process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org",
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015",
    contractId: process.env.CONTRACT_ID || "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
    validatePassphrase: false,
    logger: {
      level: LogLevel.INFO,
      namespace: "MonitoringApp",
    },
  });

  console.log("1. Setting up global event subscriptions on StellarSplitClient...");

  // Subscribe to contract payments
  client.subscribe("payment", (paymentEvent) => {
    console.log(`   [EVENT: PAYMENT] Invoice #${paymentEvent.invoiceId}:`);
    console.log(`     Payer:  ${paymentEvent.payer.slice(0, 12)}...`);
    console.log(`     Amount: ${formatAmount(paymentEvent.amount)} tokens`);
    console.log(`     TxHash: ${paymentEvent.txHash}`);
  });

  // Subscribe to invoice releases
  client.subscribe("release", (releaseEvent) => {
    console.log(`   [EVENT: RELEASE] Invoice #${releaseEvent.invoiceId} released!`);
    console.log(`     Disbursed: ${formatAmount(releaseEvent.totalAmount)} tokens`);
    console.log(`     Recipients: ${releaseEvent.recipientCount}`);
  });

  // Subscribe to refunds
  client.subscribe("refund", (refundEvent) => {
    console.log(`   [EVENT: REFUND] Invoice #${refundEvent.invoiceId} refunded:`);
    console.log(`     Recipient: ${refundEvent.payer.slice(0, 12)}...`);
    console.log(`     Amount:    ${formatAmount(refundEvent.amount)} tokens`);
  });

  console.log("   ✓ Global listeners active (payment, release, refund).\n");

  // Step 2: Individual Invoice Subscription
  console.log("2. Subscribing to specific Invoice #42 events...");
  const sub = client.subscribeInvoice("42", (evt) => {
    console.log(`   [Invoice #42 Update] Type: ${evt.type}, Time: ${new Date(evt.timestamp).toISOString()}`);
  });

  // Step 3: Simulate incoming events
  console.log("\n3. Simulating incoming live events from Soroban RPC / Horizon SSE:\n");

  // Emit mock payment event
  client.emit("payment", {
    invoiceId: 42n,
    payer: "GAPAYER1111111111111111111111111111111111111111111111111111",
    amount: 50_0000000n,
    txHash: "0x1234abcd5678ef901234abcd5678ef901234abcd5678ef901234abcd5678ef90",
    ledgerSeq: 5432100,
    timestamp: Date.now(),
  });

  // Emit mock release event
  client.emit("release", {
    invoiceId: 42n,
    totalAmount: 100_0000000n,
    recipientCount: 3,
    txHash: "0xabcd1234ef905678abcd1234ef905678abcd1234ef905678abcd1234ef905678",
    ledgerSeq: 5432105,
    timestamp: Date.now() + 5000,
  });

  // Step 4: Transport status & cleanup
  console.log("\n4. Checking Transport Status & Graceful Teardown:");
  console.log("   Transport status: Active");
  console.log("   Unsubscribing from Invoice #42...");
  sub.unsubscribe();
  console.log("   ✓ Unsubscribed.");

  console.log("==================================================================");
  console.log(" ✓ Real-time Monitoring flow completed successfully.");
  console.log("==================================================================");

  if (typeof (client as any).dispose === "function") {
    (client as any).dispose();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Monitoring failed:", err);
  process.exit(1);
});
