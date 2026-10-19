import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MetaMaskAdapter,
  MetaMaskNotInstalledError,
  MetaMaskConnectionError,
  UserRejectedError,
  MetaMaskConnector,
  WalletConnectConnector,
  LedgerConnector,
  MultiWalletManager,
  WalletFallbackExhaustedError,
  WalletNotAvailableError,
  type MultiWalletEvent,
} from "../src/multiWallet.js";

// Mock ledger hardware modules
vi.mock("@ledgerhq/hw-transport-webhid", () => ({
  default: {
    create: vi.fn(async () => ({
      send: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 0, 0])),
      close: vi.fn().mockResolvedValue(undefined),
    })),
  },
}));

vi.mock("@ledgerhq/hw-app-str", () => ({
  default: class {
    async getPublicKey() {
      return { publicKey: "GLEDGERPUBLICKEY1234567890" };
    }
    async signTransaction() {
      return { signature: Uint8Array.from([1, 2, 3]) };
    }
  },
}));

describe("Multi-Wallet Support", () => {
  const ETH_ADDRESS = "0x1234567890123456789012345678901234567890";
  const STELLAR_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

  let mockProvider: any;

  beforeEach(() => {
    mockProvider = {
      isMetaMask: true,
      request: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("MetaMask Connector / Adapter", () => {
    it("reports available when provider is present", () => {
      const adapter = new MetaMaskAdapter({ provider: mockProvider });
      expect(adapter.isAvailable()).toBe(true);
      expect(adapter.name).toBe("MetaMask");
    });

    it("throws MetaMaskNotInstalledError when no provider exists", async () => {
      const adapter = new MetaMaskAdapter({ provider: undefined });
      // In node environment without global window.ethereum
      await expect(adapter.connect()).rejects.toBeInstanceOf(MetaMaskNotInstalledError);
      await expect(adapter.getAddress()).rejects.toBeInstanceOf(MetaMaskNotInstalledError);
    });

    it("connects and returns active account address", async () => {
      mockProvider.request.mockResolvedValue([ETH_ADDRESS]);
      const adapter = new MetaMaskAdapter({ provider: mockProvider });

      const address = await adapter.connect();
      expect(mockProvider.request).toHaveBeenCalledWith({ method: "eth_requestAccounts" });
      expect(address).toBe(ETH_ADDRESS);
      expect(await adapter.getAddress()).toBe(ETH_ADDRESS);
    });

    it("handles user rejection during connect", async () => {
      mockProvider.request.mockRejectedValue({ code: 4001, message: "User rejected" });
      const adapter = new MetaMaskAdapter({ provider: mockProvider });

      await expect(adapter.connect()).rejects.toBeInstanceOf(UserRejectedError);
    });

    it("signs transaction XDR using personal_sign", async () => {
      mockProvider.request.mockImplementation((args: any) => {
        if (args.method === "eth_requestAccounts") return Promise.resolve([ETH_ADDRESS]);
        if (args.method === "personal_sign") return Promise.resolve("0xsignature123");
        return Promise.resolve(null);
      });

      const adapter = new MetaMaskAdapter({ provider: mockProvider });
      await adapter.connect();

      const sig = await adapter.signTransaction("AAAABBB...", "testnet");
      expect(mockProvider.request).toHaveBeenCalledWith({
        method: "personal_sign",
        params: ["AAAABBB...", ETH_ADDRESS],
      });
      expect(sig).toBe("0xsignature123");
    });

    it("subscribes to accountsChanged and updates address", async () => {
      let changeHandler: any;
      mockProvider.on.mockImplementation((event: string, handler: any) => {
        if (event === "accountsChanged") changeHandler = handler;
      });

      mockProvider.request.mockResolvedValue([ETH_ADDRESS]);
      const adapter = new MetaMaskAdapter({ provider: mockProvider });
      await adapter.connect();

      const onAccountChanged = vi.fn();
      adapter.onAccountChange(onAccountChanged);

      expect(changeHandler).toBeDefined();
      changeHandler(["0x9999999999999999999999999999999999999999"]);

      expect(onAccountChanged).toHaveBeenCalledWith("0x9999999999999999999999999999999999999999");
      expect(await adapter.getAddress()).toBe("0x9999999999999999999999999999999999999999");
    });

    it("MetaMaskConnector conforms to unified WalletAdapter interface", async () => {
      mockProvider.request.mockResolvedValue([ETH_ADDRESS]);
      const connector = new MetaMaskConnector({ provider: mockProvider });

      expect(connector.name).toBe("MetaMask");
      expect(connector.isAvailable()).toBe(true);

      const addr = await connector.connect();
      expect(addr).toBe(ETH_ADDRESS);

      connector.disconnect();
    });
  });

  describe("WalletConnect Connector", () => {
    it("connects and returns address from options", async () => {
      const mockClient = { request: vi.fn().mockResolvedValue("signed-xdr-result") };
      const connector = new WalletConnectConnector({
        client: mockClient,
        topic: "topic-1",
        chainId: "stellar:testnet",
        address: STELLAR_ADDRESS,
      });

      expect(connector.name).toBe("WalletConnect");
      expect(await connector.connect()).toBe(STELLAR_ADDRESS);
      expect(await connector.getAddress()).toBe(STELLAR_ADDRESS);

      const signed = await connector.signTransaction("unsigned-xdr", "testnet");
      expect(signed).toBe("signed-xdr-result");
      expect(mockClient.request).toHaveBeenCalledWith({
        topic: "topic-1",
        chainId: "stellar:testnet",
        request: {
          method: "stellar_signXDR",
          params: { xdr: "unsigned-xdr", network: "testnet" },
        },
      });

      connector.disconnect();
    });

    it("throws error when attempting to sign without connection", async () => {
      const connector = new WalletConnectConnector();
      await expect(connector.signTransaction("xdr", "testnet")).rejects.toThrow();
    });
  });

  describe("Ledger Connector", () => {
    it("connects and returns hardware public key", async () => {
      const connector = new LedgerConnector("44'/148'/0'", { skipFirmwareCheck: true });
      expect(connector.name).toBe("Ledger");

      const address = await connector.connect();
      expect(address).toBe("GLEDGERPUBLICKEY1234567890");
      expect(await connector.getAddress()).toBe("GLEDGERPUBLICKEY1234567890");

      const signed = await connector.signTransaction("AQID", "testnet");
      expect(signed).toBeTruthy();

      connector.disconnect();
    });
  });

  describe("MultiWalletManager & Safe Fallback Handling", () => {
    let mmAdapter: any;
    let wcAdapter: any;
    let ledgerAdapter: any;

    beforeEach(() => {
      mmAdapter = {
        name: "MetaMask",
        isAvailable: vi.fn().mockReturnValue(true),
        connect: vi.fn(),
        getAddress: vi.fn(),
        signTransaction: vi.fn(),
        disconnect: vi.fn(),
        onAccountChange: vi.fn(() => () => {}),
      };

      wcAdapter = {
        name: "WalletConnect",
        isAvailable: vi.fn().mockReturnValue(true),
        connect: vi.fn(),
        getAddress: vi.fn(),
        signTransaction: vi.fn(),
        disconnect: vi.fn(),
        onAccountChange: vi.fn(() => () => {}),
      };

      ledgerAdapter = {
        name: "Ledger",
        isAvailable: vi.fn().mockReturnValue(true),
        connect: vi.fn(),
        getAddress: vi.fn(),
        signTransaction: vi.fn(),
        disconnect: vi.fn(),
        onAccountChange: vi.fn(() => () => {}),
      };
    });

    it("registers and detects available adapters", async () => {
      const manager = new MultiWalletManager({
        adapters: [mmAdapter, wcAdapter, ledgerAdapter],
      });

      expect(manager.getAdapters()).toHaveLength(3);
      expect(manager.getAdapter("metamask")).toBe(mmAdapter);
      expect(manager.getAdapter("WALLETCONNECT")).toBe(wcAdapter);

      const available = await manager.detectAvailable();
      expect(available).toHaveLength(3);
    });

    it("connects directly to primary wallet when available", async () => {
      mmAdapter.connect.mockResolvedValue(ETH_ADDRESS);
      const manager = new MultiWalletManager({
        adapters: [mmAdapter, wcAdapter],
      });

      const { adapter, address } = await manager.connectWithFallback();

      expect(adapter.name).toBe("MetaMask");
      expect(address).toBe(ETH_ADDRESS);
      expect(manager.isConnected()).toBe(true);
      expect(manager.getActiveAdapter()?.name).toBe("MetaMask");
      expect(manager.getConnectedAccount()).toBe(ETH_ADDRESS);
      expect(wcAdapter.connect).not.toHaveBeenCalled();
    });

    it("safely falls back to secondary wallet when primary fails", async () => {
      mmAdapter.connect.mockRejectedValue(new MetaMaskNotInstalledError());
      wcAdapter.connect.mockResolvedValue(STELLAR_ADDRESS);

      const manager = new MultiWalletManager({
        adapters: [mmAdapter, wcAdapter, ledgerAdapter],
      });

      const events: MultiWalletEvent[] = [];
      manager.onEvent((e) => events.push(e));

      const { adapter, address } = await manager.connectWithFallback(["MetaMask", "WalletConnect"]);

      expect(adapter.name).toBe("WalletConnect");
      expect(address).toBe(STELLAR_ADDRESS);
      expect(mmAdapter.connect).toHaveBeenCalledTimes(1);
      expect(wcAdapter.connect).toHaveBeenCalledTimes(1);
      expect(ledgerAdapter.connect).not.toHaveBeenCalled();

      // Check emitted events
      const attempted = events.find((e) => e.type === "fallback:attempted");
      expect(attempted).toBeDefined();
      expect(attempted?.walletName).toBe("MetaMask");

      const succeeded = events.find((e) => e.type === "fallback:succeeded");
      expect(succeeded).toBeDefined();
      expect(succeeded?.walletName).toBe("WalletConnect");
    });

    it("falls back across multiple providers until one succeeds", async () => {
      mmAdapter.connect.mockRejectedValue(new Error("User rejected"));
      wcAdapter.connect.mockRejectedValue(new Error("Relay timeout"));
      ledgerAdapter.connect.mockResolvedValue("GLEDGERPUBLICKEY");

      const manager = new MultiWalletManager({
        adapters: [mmAdapter, wcAdapter, ledgerAdapter],
      });

      const { adapter, address } = await manager.connectWithFallback();

      expect(adapter.name).toBe("Ledger");
      expect(address).toBe("GLEDGERPUBLICKEY");
      expect(mmAdapter.connect).toHaveBeenCalled();
      expect(wcAdapter.connect).toHaveBeenCalled();
      expect(ledgerAdapter.connect).toHaveBeenCalled();
    });

    it("throws WalletFallbackExhaustedError when all fallback providers fail", async () => {
      mmAdapter.connect.mockRejectedValue(new Error("MetaMask not found"));
      wcAdapter.connect.mockRejectedValue(new Error("Session pairing rejected"));
      ledgerAdapter.connect.mockRejectedValue(new Error("Ledger device not connected"));

      const manager = new MultiWalletManager({
        adapters: [mmAdapter, wcAdapter, ledgerAdapter],
      });

      try {
        await manager.connectWithFallback();
        throw new Error("Expected fallback to fail");
      } catch (err: any) {
        expect(err).toBeInstanceOf(WalletFallbackExhaustedError);
        expect(err.attempts).toHaveLength(3);
        expect(err.attempts[0].walletName).toBe("MetaMask");
        expect(err.attempts[1].walletName).toBe("WalletConnect");
        expect(err.attempts[2].walletName).toBe("Ledger");
        expect(err.message).toContain("All wallet providers in fallback chain failed");
      }
    });

    it("throws WalletNotAvailableError when connecting directly to unregistered wallet", async () => {
      const manager = new MultiWalletManager();
      await expect(manager.connect("Phantom")).rejects.toBeInstanceOf(WalletNotAvailableError);
    });

    it("disconnect() clears active adapter and account", async () => {
      mmAdapter.connect.mockResolvedValue(ETH_ADDRESS);
      const manager = new MultiWalletManager({ adapters: [mmAdapter] });

      await manager.connect("MetaMask");
      expect(manager.isConnected()).toBe(true);

      manager.disconnect();
      expect(manager.isConnected()).toBe(false);
      expect(manager.getActiveAdapter()).toBeNull();
      expect(manager.getConnectedAccount()).toBeNull();
      expect(mmAdapter.disconnect).toHaveBeenCalled();
    });

    it("routes signTransaction to the active wallet", async () => {
      mmAdapter.connect.mockResolvedValue(ETH_ADDRESS);
      mmAdapter.signTransaction.mockResolvedValue("signed-by-metamask");

      const manager = new MultiWalletManager({ adapters: [mmAdapter] });
      await manager.connect("MetaMask");

      const result = await manager.signTransaction("test-xdr", "testnet");
      expect(result).toBe("signed-by-metamask");
      expect(mmAdapter.signTransaction).toHaveBeenCalledWith("test-xdr", "testnet");
    });
  });
});
