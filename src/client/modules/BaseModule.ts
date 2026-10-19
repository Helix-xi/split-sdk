import type { StellarSplitClient } from "../../client.js";

/**
 * Base client module holding a reference to the main StellarSplitClient instance.
 */
export abstract class BaseClientModule {
  constructor(protected readonly client: StellarSplitClient) {}
}
