/**
 * Invoice Automation Workflows for StellarSplit SDK.
 *
 * Provides a composable workflow engine for automating invoice lifecycle
 * events: scheduled release, auto-approval, deadline escalation, and
 * chained multi-step workflows.
 */

export type InvoiceWorkflowStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface WorkflowStep<TContext = Record<string, unknown>> {
  name: string;
  execute: (ctx: TContext) => Promise<TContext>;
  /** Optional condition — step is skipped if this returns false */
  condition?: (ctx: TContext) => boolean;
  /** Optional timeout in ms. Defaults to no timeout. */
  timeoutMs?: number;
}

export interface WorkflowRunResult<TContext> {
  status: InvoiceWorkflowStatus;
  context: TContext;
  completedSteps: string[];
  failedStep?: string;
  error?: Error;
  durationMs: number;
}

export interface AutomationTrigger {
  type: 'deadline' | 'payment_received' | 'approval_count' | 'manual';
  /** For deadline triggers: unix timestamp seconds */
  deadlineTs?: number;
  /** For approval_count triggers: required number of approvals */
  requiredApprovals?: number;
}

export interface AutomationRule<TContext = Record<string, unknown>> {
  id: string;
  name: string;
  trigger: AutomationTrigger;
  steps: WorkflowStep<TContext>[];
  /** Whether to continue if a step fails (default: false) */
  continueOnError?: boolean;
}

/**
 * Runs a sequence of workflow steps, threading context through each step.
 * Supports per-step timeouts and conditional execution.
 */
export async function runWorkflow<TContext>(
  steps: WorkflowStep<TContext>[],
  initialContext: TContext,
  options: { continueOnError?: boolean } = {}
): Promise<WorkflowRunResult<TContext>> {
  const startTime = Date.now();
  const completedSteps: string[] = [];
  let ctx = { ...initialContext } as TContext;
  let failedStep: string | undefined;
  let error: Error | undefined;
  let status: InvoiceWorkflowStatus = 'running';

  for (const step of steps) {
    // Evaluate optional condition
    if (step.condition && !step.condition(ctx)) {
      continue;
    }

    try {
      if (step.timeoutMs !== undefined) {
        ctx = await withTimeout(step.execute(ctx), step.timeoutMs, step.name);
      } else {
        ctx = await step.execute(ctx);
      }
      completedSteps.push(step.name);
    } catch (err) {
      failedStep = step.name;
      error = err instanceof Error ? err : new Error(String(err));
      if (!options.continueOnError) {
        status = 'failed';
        return { status, context: ctx, completedSteps, failedStep, error, durationMs: Date.now() - startTime };
      }
    }
  }

  status = failedStep && !options.continueOnError ? 'failed' : 'completed';
  return { status, context: ctx, completedSteps, failedStep, error, durationMs: Date.now() - startTime };
}

function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Step '${name}' timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

export interface InvoiceAutomationEventType {
  type: 'workflow:started' | 'workflow:completed' | 'workflow:failed' | 'workflow:cancelled';
  ruleId: string;
  invoiceId: string;
  timestamp: number;
  detail?: Record<string, unknown>;
}

export type AutomationEventHandler = (event: InvoiceAutomationEventType) => void;

/**
 * InvoiceAutomationEngine manages automation rules and executes them
 * when their triggers are satisfied.
 */
export class InvoiceAutomationEngine<TContext extends Record<string, unknown> = Record<string, unknown>> {
  private readonly rules = new Map<string, AutomationRule<TContext>>();
  private readonly eventHandlers = new Set<AutomationEventHandler>();
  private readonly runningWorkflows = new Map<string, AbortController>();

  /**
   * Register an automation rule.
   */
  registerRule(rule: AutomationRule<TContext>): void {
    this.rules.set(rule.id, rule);
  }

  /**
   * Remove a registered rule.
   */
  removeRule(ruleId: string): boolean {
    return this.rules.delete(ruleId);
  }

  /**
   * Get a registered rule by ID.
   */
  getRule(ruleId: string): AutomationRule<TContext> | undefined {
    return this.rules.get(ruleId);
  }

  /**
   * List all registered rule IDs.
   */
  listRuleIds(): string[] {
    return Array.from(this.rules.keys());
  }

  /**
   * Subscribe to workflow lifecycle events.
   */
  onEvent(handler: AutomationEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  private emit(event: InvoiceAutomationEventType): void {
    for (const handler of this.eventHandlers) {
      try { handler(event); } catch { /* ignore */ }
    }
  }

  /**
   * Manually trigger a rule for a given invoice.
   */
  async trigger(
    ruleId: string,
    invoiceId: string,
    context: TContext
  ): Promise<WorkflowRunResult<TContext>> {
    const rule = this.rules.get(ruleId);
    if (!rule) throw new Error(`Rule '${ruleId}' not found`);

    this.emit({ type: 'workflow:started', ruleId, invoiceId, timestamp: Date.now() });

    const result = await runWorkflow(rule.steps, context, {
      continueOnError: rule.continueOnError,
    });

    if (result.status === 'completed') {
      this.emit({ type: 'workflow:completed', ruleId, invoiceId, timestamp: Date.now(), detail: { completedSteps: result.completedSteps } });
    } else {
      this.emit({ type: 'workflow:failed', ruleId, invoiceId, timestamp: Date.now(), detail: { failedStep: result.failedStep, error: result.error?.message } });
    }

    return result;
  }

  /**
   * Check if a trigger condition is currently satisfied.
   */
  isTriggerSatisfied(trigger: AutomationTrigger, context: Record<string, unknown>): boolean {
    switch (trigger.type) {
      case 'manual':
        return true;
      case 'deadline': {
        const now = Math.floor(Date.now() / 1000);
        return trigger.deadlineTs !== undefined && now >= trigger.deadlineTs;
      }
      case 'approval_count': {
        const approvals = typeof context['approvalCount'] === 'number' ? context['approvalCount'] : 0;
        return trigger.requiredApprovals !== undefined && approvals >= trigger.requiredApprovals;
      }
      case 'payment_received': {
        return context['paymentReceived'] === true;
      }
      default:
        return false;
    }
  }
}
