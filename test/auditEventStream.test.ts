import { describe, it, expect, vi } from 'vitest';
import { AuditEventStream } from '../src/audit/AuditEventStream';
import type { AuditEvent } from '../src/types/audit';

const makeEvent = (action: string, id = 'inv-1'): AuditEvent => ({
  invoiceId: id,
  actorId: 'actor-1',
  action,
  payload: { value: 42 },
  timestamp: Date.now(),
});

describe('AuditEventStream', () => {
  it('delivers published events to subscribers', () => {
    const stream = new AuditEventStream();
    const received: AuditEvent[] = [];
    stream.subscribe((e) => received.push(e));

    const evt = makeEvent('CREATE');
    stream.publish(evt);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(evt);
  });

  it('supports multiple subscribers', () => {
    const stream = new AuditEventStream();
    const a: AuditEvent[] = [];
    const b: AuditEvent[] = [];
    stream.subscribe((e) => a.push(e));
    stream.subscribe((e) => b.push(e));

    stream.publish(makeEvent('UPDATE_STATUS'));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('unsubscribe stops delivery', () => {
    const stream = new AuditEventStream();
    const received: AuditEvent[] = [];
    const unsub = stream.subscribe((e) => received.push(e));

    stream.publish(makeEvent('CREATE'));
    unsub();
    stream.publish(makeEvent('REFUND'));

    expect(received).toHaveLength(1);
  });

  it('buffers events and replays to new subscribers', () => {
    const stream = new AuditEventStream({ bufferSize: 5 });
    stream.publish(makeEvent('CREATE'));
    stream.publish(makeEvent('UPDATE_STATUS'));

    const replayed: AuditEvent[] = [];
    stream.subscribe((e) => replayed.push(e));

    expect(replayed).toHaveLength(2);
  });

  it('respects bufferSize cap - oldest events are evicted', () => {
    const stream = new AuditEventStream({ bufferSize: 2 });
    stream.publish(makeEvent('A'));
    stream.publish(makeEvent('B'));
    stream.publish(makeEvent('C'));

    expect(stream.getBuffer()).toHaveLength(2);
    expect(stream.getBuffer()[0]?.action).toBe('B');
    expect(stream.getBuffer()[1]?.action).toBe('C');
  });

  it('filter option prevents non-matching events', () => {
    const stream = new AuditEventStream({
      filter: (e) => e.action === 'CREATE',
    });
    const received: AuditEvent[] = [];
    stream.subscribe((e) => received.push(e));

    stream.publish(makeEvent('CREATE'));
    stream.publish(makeEvent('REFUND'));

    expect(received).toHaveLength(1);
    expect(received[0]?.action).toBe('CREATE');
  });

  it('closed stream drops events', () => {
    const stream = new AuditEventStream();
    const received: AuditEvent[] = [];
    stream.subscribe((e) => received.push(e));

    stream.close();
    stream.publish(makeEvent('CREATE'));

    expect(received).toHaveLength(0);
    expect(stream.isClosed).toBe(true);
  });

  it('subscriber count tracks correctly', () => {
    const stream = new AuditEventStream();
    expect(stream.subscriberCount).toBe(0);

    const unsub1 = stream.subscribe(vi.fn());
    const unsub2 = stream.subscribe(vi.fn());
    expect(stream.subscriberCount).toBe(2);

    unsub1();
    expect(stream.subscriberCount).toBe(1);

    unsub2();
    expect(stream.subscriberCount).toBe(0);
  });

  it('clearBuffer empties the replay buffer', () => {
    const stream = new AuditEventStream({ bufferSize: 10 });
    stream.publish(makeEvent('CREATE'));
    expect(stream.getBuffer()).toHaveLength(1);

    stream.clearBuffer();
    expect(stream.getBuffer()).toHaveLength(0);
  });

  it('subscriber errors do not crash the stream', () => {
    const stream = new AuditEventStream();
    const good: AuditEvent[] = [];
    stream.subscribe(() => { throw new Error('boom'); });
    stream.subscribe((e) => good.push(e));

    stream.publish(makeEvent('CREATE'));
    expect(good).toHaveLength(1);
  });
});
