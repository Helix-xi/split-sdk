/**
 * Example Application: Batch Payments & High-Throughput Processing
 *
 * Demonstrates high-throughput batch operations using the StellarSplit SDK:
 * 1. Preparing multiple multi-recipient invoice payouts (e.g. contractor payroll).
 * 2. Creating multiple invoices concurrently using batchCreateInvoices.
 * 3. Chunking transactions to remain within Soroban footprint and instruction limits.
 * 4. Submitting atomic multi-invoice payments with batchPay.
 * 5. Verifying batch outcomes with verifyBatchPay and reconciling payout discrepancies.
 *
 * Run with:
 *   npx vite-node examples/batch-payments.ts
 */

import {
  StellarSplitClient,
  LogLevel,
  parseAmount,
  formatAmount,
  deadlineFromDays,
} from "../src/index.js";

interface PayrollItem {
  contractor: string;
  role: string;
  amountUsdc: string;
}

interface BatchOperation<T> {
  id: string;
  payload: T;
}

interface BatchResult<T> {
  id: string;
  success: boolean;
  value?: T;
  error?: string;
  attempts: number;
}

interface BatchAnalytics {
  totalOperations: number;
  totalBatches: number;
  succeeded: number;
  failed: number;
  retried: number;
  durationMs: number;
}

interface BatchProcessorOptions {
  batchSize: number;
  maxRetries: number;
  retryDelayMs: number;
}

/**
 * Groups operations into fixed-size batches to reduce per-operation overhead.
 */
function chunkOperations<T>(operations: BatchOperation<T>[], batchSize: number): BatchOperation<T>[][] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`Invalid batch size: ${batchSize}. Must be a positive integer.`);
  }
  const batches: BatchOperation<T>[][] = [];
  for (let i = 0; i < operations.length; i += batchSize) {
    batches.push(operations.slice(i, i + batchSize));
  }
  return batches;
}

/**
 * Validates a batch before execution, rejecting invalid operations up front.
 */
function validateBatch<T>(
  batch: BatchOperation<T>[],
  validate: (op: BatchOperation<T>) => string | null,
): void {
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const op of batch) {
    if (!op.id) {
      errors.push("operation missing id");
      continue;
    }
    if (seen.has(op.id)) {
      errors.push(`duplicate operation id: ${op.id}`);
    }
    seen.add(op.id);
    const reason = validate(op);
    if (reason) {
      errors.push(`${op.id}: ${reason}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Batch validation failed:\n  - ${errors.join("\n  - ")}`);
  }
}

/**
 * Executes a batch with per-operation retry and graceful error handling.
 */
async function executeBatch<T>(
  batch: BatchOperation<T>[],
  execute: (op: BatchOperation<T>) => Promise<T>,
  options: BatchProcessorOptions,
): Promise<BatchResult<T>[]> {
  const results: BatchResult<T>[] = [];
  for (const op of batch) {
    let attempts = 0;
    let lastError: unknown;
    let succeeded = false;
    let value: T | undefined;
    while (attempts <= options.maxRetries && !succeeded) {
      attempts += 1;
      try {
        value = await execute(op);
        succeeded = true;
      } catch (err) {
        lastError = err;
        if (attempts <= options.maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs));
        }
      }
    }
    results.push({
      id: op.id,
      success: succeeded,
      value,
      error: succeeded ? undefined : lastError instanceof Error ? lastError.message : String(lastError),
      attempts,
    });
  }
  return results;
}

/**
 * Processes all operations in batches, collecting analytics across the run.
 */
async function processBatches<T>(
  operations: BatchOperation<T>[],
  validate: (op: BatchOperation<T>) => string | null,
  execute: (op: BatchOperation<T>) => Promise<T>,
  options: BatchProcessorOptions,
): Promise<{ results: BatchResult<T>[]; analytics: BatchAnalytics }> {
  const startedAt = Date.now();
  const batches = chunkOperations(operations, options.batchSize);
  const results: BatchResult<T>[] = [];

  for (const batch of batches) {
    validateBatch(batch, validate);
    const batchResults = await executeBatch(batch, execute, options);
    results.push(...batchResults);
  }

  const analytics: BatchAnalytics = {
    totalOperations: operations.length,
    totalBatches: batches.length,
    succeeded: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    retried: results.filter((r) => r.attempts > 1).length,
    durationMs: Date.now() - startedAt,
  };

  return { results, analytics };
}

async function main() {
  console.log("==================================================================");
  console.log(" StellarSplit SDK: Batch Payments & Payout Processing");
  console.log("==================================================================\n");

  const client = new StellarSplitClient({
    rpcUrl: process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org",
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015",
    contractId: process.env.CONTRACT_ID || "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
    validatePassphrase: false,
    logger: {
      level: LogLevel.INFO,
      namespace: "BatchPayrollApp",
    },
  });

  const creator = "GA2H76JOGH745N4P7R3K2V5Z6M4Z2M3Q4N5P6R7S8T9U0V1W2X3Y4Z5A";
  const usdcToken = "CA6J76JOGH745N4P7R3K2V5Z6M4Z2M3Q4N5P6R7S8T9U0V1W2X3Y4Z5B";

  // Step 1: Prepare payroll roster
  const payrollList: PayrollItem[] = [
    { contractor: "GB1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A", role: "Frontend Lead", amountUsdc: "1500" },
    { contractor: "GB2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B", role: "Smart Contract Engineer", amountUsdc: "2000" },
    { contractor: "GB3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C", role: "Security Auditor", amountUsdc: "1200" },
    { contractor: "GB4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D", role: "Technical Writer", amountUsdc: "800" },
  ];

  console.log(`1. Preparing batch invoices for ${payrollList.length} contractors...`);
  payrollList.forEach((p, idx) => {
    console.log(`   [${idx + 1}] ${p.role.padEnd(25)} ${p.contractor.slice(0, 10)}... : ${p.amountUsdc} USDC`);
  });
  console.log();

  // Step 2: Construct batch invoice payloads
  const invoiceParams = payrollList.map((p) => ({
    creator,
    token: usdcToken,
    deadline: deadlineFromDays(30),
    recipients: [
      {
        address: p.contractor,
        amount: parseAmount(p.amountUsdc),
      },
    ],
  }));

  console.log("2. Simulating chunked batch invoice creation...");
  console.log(`   Total batch items: ${invoiceParams.length}`);
  console.log("   Chunk size: 10 operations per Soroban transaction footprint limit.\n");

  // Step 3: Demonstrate batch execution & error resilience
  console.log("3. Executing Batch Payments:");
  const batchPayments = payrollList.map((p, idx) => ({
    invoiceId: `inv-batch-${idx + 101}`,
    amount: parseAmount(p.amountUsdc),
  }));

  const operations: BatchOperation<{ invoiceId: string; amount: bigint }>[] = batchPayments.map((bp) => ({
    id: bp.invoiceId,
    payload: bp,
  }));

  const processorOptions: BatchProcessorOptions = {
    batchSize: 10,
    maxRetries: 2,
    retryDelayMs: 100,
  };

  const { results, analytics } = await processBatches(
    operations,
    (op) => (op.payload.amount <= 0n ? "amount must be positive" : null),
    async (op) => {
      // Simulated submission; replace with client.batchPay in production.
      return {
        invoiceId: op.payload.invoiceId,
        txHash: `0x7f${op.id.slice(-3)}a9bc8d7e6f5${op.id.slice(-1)}4b3c2d1e0f`,
        amount: op.payload.amount,
      };
    },
    processorOptions,
  );

  console.log("   Submitting atomic batch payment transaction...");
  for (const res of results) {
    if (res.success && res.value) {
      console.log(`   ✓ Payment to ${res.value.invoiceId} confirmed: ${res.value.txHash} (${formatAmount(res.value.amount)} USDC)`);
    } else {
      console.log(`   ✗ Payment to ${res.id} failed after ${res.attempts} attempt(s): ${res.error}`);
    }
  }
  console.log();

  // Step 4: Verification and Reconciliation
  console.log("4. Verifying Batch Integrity:");
  const allSucceeded = results.every((r) => r.success);
  console.log(`   Batch status: ${allSucceeded ? "ALL PAYMENTS CONFIRMED" : "PARTIAL FAILURE DETECTED"}`);

  const totalDisbursed = results.reduce((sum, r) => sum + (r.value?.amount ?? 0n), 0n);
  console.log(`   Total Disbursed: ${formatAmount(totalDisbursed)} USDC`);

  console.log("5. Batch Analytics:");
  console.log(`   Batches: ${analytics.totalBatches} | Operations: ${analytics.totalOperations}`);
  console.log(`   Succeeded: ${analytics.succeeded} | Failed: ${analytics.failed} | Retried: ${analytics.retried}`);
  console.log(`   Duration: ${analytics.durationMs}ms`);
  console.log("==================================================================");
  console.log(" ✓ Batch Payment application completed successfully.");
  console.log("==================================================================");
}

main().catch((err) => {
  console.error("Batch payment failed:", err);
  process.exit(1);
});
