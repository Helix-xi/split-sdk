/**
 * Invoice Versioning Module (#1056)
 *
 * Provides invoice versioning with change tracking, rollback support,
 * and immutable history auditing.
 */

export {
  InvoiceVersionTracker,
  InvoiceVersionManager,
  InMemoryVersionStore,
  computeChecksum,
  detectVersionConflict,
  ConflictError,
} from "./invoiceVersionTracker.js";

export type {
  InvoiceVersion,
  InvoiceVersionDiff,
  VersionStore,
  InvoiceVersionTrackerOptions,
  RollbackOptions,
  InvoiceRollbackResult,
  ChangeLogEntry,
  VersionVector,
} from "./invoiceVersionTracker.js";
