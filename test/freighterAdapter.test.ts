import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FreighterAdapter,
  FreighterNotInstalledError,
  FreighterConnectionError,
} from '../src/wallets/adapters/FreighterAdapter.js';

describe('FreighterAdapter', () => {
  let mockFreighter: Record<string, unknown>;

  beforeEach(() => {
    mockFreighter = {
      isConnected: vi.fn(async () => ({ isConnected: true })),
      getAddress: vi.fn(async () => ({ address: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7' })),
      getNetwork: vi.fn(async () => ({ network: 'TESTNET', networkPassphrase: 'Test SDF Network ; September 2015' })),
      signTransaction: vi.fn(async () => ({ signedTxXdr: 'signed-xdr-payload' })),
    };
    // @ts-ignore
    global.window = { freighter: mockFreighter };
  });

  afterEach(() => {
    // @ts-ignore
    delete global.window;
  });

  it('throws FreighterNotInstalledError when window.freighter is undefined', async () => {
    // @ts-ignore
    global.window = {};
    const adapter = new FreighterAdapter();
    await expect(adapter.connect()).rejects.toBeInstanceOf(FreighterNotInstalledError);
  });

  it('connect() returns the address from Freighter', async () => {
    const adapter = new FreighterAdapter();
    const address = await adapter.connect();
    expect(address).toBe('GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7');
    expect(adapter.isConnected()).toBe(true);
  });

  it('signTransaction() returns signed XDR', async () => {
    const adapter = new FreighterAdapter();
    await adapter.connect();
    const result = await adapter.signTransaction('unsigned-xdr', 'Test SDF Network ; September 2015');
    expect(result).toBe('signed-xdr-payload');
  });

  it('disconnect() resets connection state', async () => {
    const adapter = new FreighterAdapter();
    await adapter.connect();
    adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
  });

  it('onAccountChange callback is invoked on disconnect', async () => {
    const adapter = new FreighterAdapter();
    await adapter.connect();
    const callback = vi.fn();
    adapter.onAccountChange(callback);
    adapter.disconnect();
    expect(callback).toHaveBeenCalledWith(null);
  });
});
