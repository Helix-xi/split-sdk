import { describe, it, expect, vi } from 'vitest';
import {
  InvoiceAutomationEngine,
  runWorkflow,
  type WorkflowStep,
  type AutomationRule,
} from '../src/invoiceAutomation';

type Ctx = { value: number; log: string[] };

const makeStep = (name: string, increment = 1): WorkflowStep<Ctx> => ({
  name,
  execute: async (ctx) => ({ ...ctx, value: ctx.value + increment, log: [...ctx.log, name] }),
});

describe('runWorkflow', () => {
  it('runs all steps in order and threads context', async () => {
    const result = await runWorkflow(
      [makeStep('step1'), makeStep('step2'), makeStep('step3')],
      { value: 0, log: [] }
    );
    expect(result.status).toBe('completed');
    expect(result.context.value).toBe(3);
    expect(result.completedSteps).toEqual(['step1', 'step2', 'step3']);
  });

  it('stops on failed step by default', async () => {
    const failStep: WorkflowStep<Ctx> = {
      name: 'failStep',
      execute: async () => { throw new Error('fail!'); },
    };
    const result = await runWorkflow(
      [makeStep('step1'), failStep, makeStep('step3')],
      { value: 0, log: [] }
    );
    expect(result.status).toBe('failed');
    expect(result.failedStep).toBe('failStep');
    expect(result.completedSteps).toContain('step1');
    expect(result.completedSteps).not.toContain('step3');
  });

  it('continueOnError skips failed step but completes', async () => {
    const failStep: WorkflowStep<Ctx> = {
      name: 'failStep',
      execute: async () => { throw new Error('oops'); },
    };
    const result = await runWorkflow(
      [makeStep('step1'), failStep, makeStep('step3')],
      { value: 0, log: [] },
      { continueOnError: true }
    );
    expect(result.status).toBe('completed');
    expect(result.completedSteps).toContain('step1');
    expect(result.completedSteps).toContain('step3');
  });

  it('conditional step is skipped when condition is false', async () => {
    const conditionalStep: WorkflowStep<Ctx> = {
      name: 'conditional',
      condition: (ctx) => ctx.value > 100,
      execute: async (ctx) => ({ ...ctx, value: ctx.value + 1000 }),
    };
    const result = await runWorkflow(
      [makeStep('step1'), conditionalStep],
      { value: 0, log: [] }
    );
    expect(result.status).toBe('completed');
    expect(result.completedSteps).not.toContain('conditional');
    expect(result.context.value).toBe(1);
  });

  it('timeout causes step to fail', async () => {
    const slowStep: WorkflowStep<Ctx> = {
      name: 'slowStep',
      timeoutMs: 10,
      execute: (ctx) => new Promise((resolve) => setTimeout(() => resolve(ctx), 500)),
    };
    const result = await runWorkflow([slowStep], { value: 0, log: [] });
    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('timed out');
  }, 1000);

  it('reports durationMs', async () => {
    const result = await runWorkflow([makeStep('s1')], { value: 0, log: [] });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('InvoiceAutomationEngine', () => {
  const makeRule = (id: string): AutomationRule<Ctx> => ({
    id,
    name: `Rule ${id}`,
    trigger: { type: 'manual' },
    steps: [makeStep('step1'), makeStep('step2')],
  });

  it('registers and retrieves rules', () => {
    const engine = new InvoiceAutomationEngine<Ctx>();
    engine.registerRule(makeRule('r1'));
    expect(engine.getRule('r1')).toBeDefined();
    expect(engine.listRuleIds()).toContain('r1');
  });

  it('removes a rule', () => {
    const engine = new InvoiceAutomationEngine<Ctx>();
    engine.registerRule(makeRule('r1'));
    engine.removeRule('r1');
    expect(engine.getRule('r1')).toBeUndefined();
  });

  it('trigger runs workflow and returns result', async () => {
    const engine = new InvoiceAutomationEngine<Ctx>();
    engine.registerRule(makeRule('r1'));
    const result = await engine.trigger('r1', 'inv-1', { value: 0, log: [] });
    expect(result.status).toBe('completed');
    expect(result.context.value).toBe(2);
  });

  it('trigger emits workflow:started and workflow:completed events', async () => {
    const engine = new InvoiceAutomationEngine<Ctx>();
    engine.registerRule(makeRule('r1'));
    const events: string[] = [];
    engine.onEvent((e) => events.push(e.type));
    await engine.trigger('r1', 'inv-1', { value: 0, log: [] });
    expect(events).toContain('workflow:started');
    expect(events).toContain('workflow:completed');
  });

  it('trigger emits workflow:failed on error', async () => {
    const engine = new InvoiceAutomationEngine<Ctx>();
    engine.registerRule({
      id: 'fail-rule',
      name: 'Fail',
      trigger: { type: 'manual' },
      steps: [{ name: 'bad', execute: async () => { throw new Error('boom'); } }],
    });
    const events: string[] = [];
    engine.onEvent((e) => events.push(e.type));
    await engine.trigger('fail-rule', 'inv-1', { value: 0, log: [] });
    expect(events).toContain('workflow:failed');
  });

  it('trigger throws for unknown rule', async () => {
    const engine = new InvoiceAutomationEngine<Ctx>();
    await expect(engine.trigger('no-rule', 'inv-1', { value: 0, log: [] })).rejects.toThrow('not found');
  });

  it('onEvent returns unsubscribe function', async () => {
    const engine = new InvoiceAutomationEngine<Ctx>();
    engine.registerRule(makeRule('r1'));
    const events: string[] = [];
    const unsub = engine.onEvent((e) => events.push(e.type));
    unsub();
    await engine.trigger('r1', 'inv-1', { value: 0, log: [] });
    expect(events).toHaveLength(0);
  });

  describe('isTriggerSatisfied', () => {
    const engine = new InvoiceAutomationEngine<Ctx>();

    it('manual trigger always satisfied', () => {
      expect(engine.isTriggerSatisfied({ type: 'manual' }, {})).toBe(true);
    });

    it('deadline trigger satisfied when past deadline', () => {
      const past = Math.floor(Date.now() / 1000) - 100;
      expect(engine.isTriggerSatisfied({ type: 'deadline', deadlineTs: past }, {})).toBe(true);
    });

    it('deadline trigger not satisfied when future deadline', () => {
      const future = Math.floor(Date.now() / 1000) + 10000;
      expect(engine.isTriggerSatisfied({ type: 'deadline', deadlineTs: future }, {})).toBe(false);
    });

    it('approval_count trigger satisfied with enough approvals', () => {
      expect(engine.isTriggerSatisfied({ type: 'approval_count', requiredApprovals: 3 }, { approvalCount: 3 })).toBe(true);
    });

    it('payment_received trigger satisfied when flag set', () => {
      expect(engine.isTriggerSatisfied({ type: 'payment_received' }, { paymentReceived: true })).toBe(true);
    });
  });
});
