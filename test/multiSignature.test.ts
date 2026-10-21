import { describe, it, expect, vi } from 'vitest';
import {
  MultiSigCoordinator,
  computeAccumulatedWeight,
  isThresholdReached,
  type MultiSigConfig,
  type MultiSigSession,
} from '../src/multiSignature';

const cfg: MultiSigConfig = {
  signers: [
    { publicKey: 'GA1111', weight: 1 },
    { publicKey: 'GA2222', weight: 1 },
    { publicKey: 'GA3333', weight: 2 },
  ],
  threshold: 3,
};

const makeCoordinator = () => new MultiSigCoordinator();

describe('computeAccumulatedWeight / isThresholdReached', () => {
  const session: MultiSigSession = {
    id: 's1',
    txHash: 'hash1',
    txXdr: 'xdr1',
    config: cfg,
    signatures: [],
    status: 'pending',
    createdAt: Date.now(),
  };

  it('returns 0 for no signatures', () => {
    expect(computeAccumulatedWeight(session)).toBe(0);
  });

  it('threshold not reached with insufficient weight', () => {
    const s = { ...session, signatures: [{ publicKey: 'GA1111', signature: 'sig1', timestamp: Date.now(), weight: 1 }] };
    expect(isThresholdReached(s)).toBe(false);
  });

  it('threshold reached at exact weight', () => {
    const s = {
      ...session,
      signatures: [
        { publicKey: 'GA1111', signature: 'sig1', timestamp: Date.now(), weight: 1 },
        { publicKey: 'GA3333', signature: 'sig3', timestamp: Date.now(), weight: 2 },
      ],
    };
    expect(isThresholdReached(s)).toBe(true);
  });
});

describe('MultiSigCoordinator', () => {
  it('creates a session with correct initial state', () => {
    const coord = makeCoordinator();
    const session = coord.createSession('hash1', 'xdr1', cfg);
    expect(session.status).toBe('pending');
    expect(session.signatures).toHaveLength(0);
    expect(session.txHash).toBe('hash1');
  });

  it('throws when config has no signers', () => {
    const coord = makeCoordinator();
    expect(() => coord.createSession('h', 'x', { signers: [], threshold: 1 })).toThrow();
  });

  it('throws when total weight cannot meet threshold', () => {
    const coord = makeCoordinator();
    expect(() =>
      coord.createSession('h', 'x', { signers: [{ publicKey: 'GA1', weight: 1 }], threshold: 5 })
    ).toThrow();
  });

  it('addSignature accepts valid signer', () => {
    const coord = makeCoordinator();
    const session = coord.createSession('hash1', 'xdr1', cfg);
    coord.addSignature(session.id, 'GA1111', 'sig1');
    expect(coord.getSession(session.id)?.signatures).toHaveLength(1);
  });

  it('addSignature returns true when threshold reached', () => {
    const coord = makeCoordinator();
    const session = coord.createSession('hash1', 'xdr1', cfg);
    coord.addSignature(session.id, 'GA1111', 'sig1');
    const reached = coord.addSignature(session.id, 'GA3333', 'sig3');
    expect(reached).toBe(true);
    expect(coord.getSession(session.id)?.status).toBe('authorized');
  });

  it('addSignature throws for unauthorized signer', () => {
    const coord = makeCoordinator();
    const session = coord.createSession('hash1', 'xdr1', cfg);
    expect(() => coord.addSignature(session.id, 'GUNKNOWN', 'sig')).toThrow('not authorized');
  });

  it('addSignature throws on duplicate signature', () => {
    const coord = makeCoordinator();
    const session = coord.createSession('hash1', 'xdr1', cfg);
    coord.addSignature(session.id, 'GA1111', 'sig1');
    expect(() => coord.addSignature(session.id, 'GA1111', 'sig1')).toThrow('already signed');
  });

  it('addSignature throws when session is not pending', () => {
    const coord = makeCoordinator();
    const session = coord.createSession('hash1', 'xdr1', cfg);
    coord.rejectSession(session.id);
    expect(() => coord.addSignature(session.id, 'GA1111', 'sig1')).toThrow('not pending');
  });

  it('rejectSession marks session rejected', () => {
    const coord = makeCoordinator();
    const session = coord.createSession('hash1', 'xdr1', cfg);
    coord.rejectSession(session.id, 'policy violation');
    expect(coord.getSession(session.id)?.status).toBe('rejected');
  });

  it('remainingWeightNeeded decrements correctly', () => {
    const coord = makeCoordinator();
    const session = coord.createSession('hash1', 'xdr1', cfg);
    expect(coord.remainingWeightNeeded(session.id)).toBe(3);
    coord.addSignature(session.id, 'GA1111', 'sig1');
    expect(coord.remainingWeightNeeded(session.id)).toBe(2);
  });

  it('emits signature:added and threshold:reached events', () => {
    const coord = makeCoordinator();
    const session = coord.createSession('hash1', 'xdr1', cfg);
    const events: string[] = [];
    coord.onEvent((e) => events.push(e.type));
    coord.addSignature(session.id, 'GA1111', 'sig1');
    coord.addSignature(session.id, 'GA3333', 'sig3');
    expect(events).toContain('signature:added');
    expect(events).toContain('threshold:reached');
  });

  it('onEvent unsubscribe stops events', () => {
    const coord = makeCoordinator();
    const session = coord.createSession('hash1', 'xdr1', cfg);
    const events: string[] = [];
    const unsub = coord.onEvent((e) => events.push(e.type));
    unsub();
    coord.addSignature(session.id, 'GA1111', 'sig1');
    expect(events).toHaveLength(0);
  });

  it('expired session transitions to expired on addSignature', () => {
    const coord = makeCoordinator();
    const session = coord.createSession('hash1', 'xdr1', cfg, { expiresAt: Date.now() - 1000 });
    expect(() => coord.addSignature(session.id, 'GA1111', 'sig1')).toThrow('expired');
    expect(coord.getSession(session.id)?.status).toBe('expired');
  });

  it('listSessionIds returns all created sessions', () => {
    const coord = makeCoordinator();
    coord.createSession('h1', 'x1', cfg);
    coord.createSession('h2', 'x2', cfg);
    expect(coord.listSessionIds()).toHaveLength(2);
  });
});
