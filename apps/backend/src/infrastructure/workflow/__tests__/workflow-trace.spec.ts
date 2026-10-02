import { AppError } from '../../../common/errors/app-error';
import { currentRequestContext } from '../../../common/observability/request-context';
import { SpanKind, trace } from '@opentelemetry/api';
import { defaultPayloadConverter } from '@temporalio/client';
import type { Context as ActivityContext } from '@temporalio/activity';
import {
  installTracing,
  TRACE_ID,
  TRACEPARENT,
} from '../../../common/observability/__tests__/harness';
import { runInExtractedSpan } from '../../../common/observability/propagation';
import {
  carrierFromHeaders,
  tenantOfWorkflowId,
  traceActivityInterceptors,
  traceClientInterceptor,
} from '../adapters/temporal/temporal-trace-headers';
import { interceptors } from '../adapters/temporal/temporal-interceptors';

const otel = installTracing();
afterAll(() => otel.shutdown());
beforeEach(() => otel.reset());

const toPayload = (v: string) => defaultPayloadConverter.toPayload(v);

describe('workflow trace propagation', () => {
  it('writes the active trace into the workflow start headers', async () => {
    const next = jest.fn().mockResolvedValue({ runId: 'r' });
    await runInExtractedSpan(
      { traceparent: TRACEPARENT },
      'user.created',
      { kind: SpanKind.CONSUMER },
      async () => {
        await traceClientInterceptor.startWithDetails!(
          {
            workflowType: 'userOnboardingWorkflow',
            headers: {},
            options: {} as never,
          },
          next,
        );
      },
    );
    const [[{ headers }]] = next.mock.calls as [[{ headers: never }]];
    const carrier = carrierFromHeaders(headers);
    expect(carrier.traceparent).toMatch(new RegExp(`^00-${TRACE_ID}-`));
  });

  it('copies the start trace headers onto scheduled activities and child workflows', async () => {
    const { inbound, outbound } = interceptors();
    const traceparent = toPayload(TRACEPARENT);
    await inbound![0].execute!(
      { args: [], headers: { traceparent, other: toPayload('x') } },
      () => Promise.resolve(undefined),
    );

    const next = jest.fn().mockResolvedValue(undefined);
    const childNext = jest
      .fn()
      .mockResolvedValue([Promise.resolve(), Promise.resolve()]);
    const own = { mine: toPayload('y') };
    await outbound![0].scheduleActivity!(
      { activityType: 'a', args: [], options: {}, headers: own, seq: 1 },
      next,
    );
    const [started, handle] = await outbound![0].startChildWorkflowExecution!(
      {
        workflowType: 'w',
        options: {} as never,
        headers: {},
        seq: 2,
      },
      childNext,
    );
    await Promise.all([started, handle]);
    const [[activity]] = next.mock.calls as [[{ headers: unknown }]];
    const [[child]] = childNext.mock.calls as [[{ headers: unknown }]];
    expect(activity.headers).toEqual({
      mine: own.mine,
      traceparent,
    });
    expect(child.headers).toEqual({ traceparent });
  });

  it('runs an activity in a span continuing the workflow starter trace', async () => {
    const ctx = {
      info: {
        activityType: 'sendFollowUpEmail',
        attempt: 1,
        workflowType: 'userOnboardingWorkflow',
        workflowExecution: { workflowId: 'onboarding-u1', runId: 'r' },
      },
    } as unknown as ActivityContext;
    const { inbound } = traceActivityInterceptors(ctx);
    let traceId: string | undefined;
    await inbound!.execute!(
      { args: [], headers: { traceparent: toPayload(TRACEPARENT) } },
      () => {
        traceId = trace.getActiveSpan()?.spanContext().traceId;
        return Promise.resolve(undefined);
      },
    );
    expect(traceId).toBe(TRACE_ID);
    const span = otel.spans()[0];
    expect(span.name).toBe('RunActivity:sendFollowUpEmail');
    expect(span.parentSpanContext?.spanId).toBe('00f067aa0ba902b7');
    expect(span.attributes['temporal.workflow.id']).toBe('onboarding-u1');
  });

  it('starts a new trace for an activity whose workflow carried none', async () => {
    const ctx = {
      info: { activityType: 'a', attempt: 1 },
    } as unknown as ActivityContext;
    const { inbound } = traceActivityInterceptors(ctx);
    await inbound!.execute!({ args: [], headers: {} }, () =>
      Promise.resolve(undefined),
    );
    expect(otel.spans()[0].parentSpanContext).toBeUndefined();
  });

  it('binds the execution tenant for the activity logs and span', async () => {
    const ctx = {
      info: {
        activityType: 'sendFollowUpEmail',
        attempt: 1,
        workflowExecution: { workflowId: 't.acme:onboarding-u1', runId: 'r' },
      },
    } as unknown as ActivityContext;
    const { inbound } = traceActivityInterceptors(ctx);
    let tenant: string | undefined;
    await inbound!.execute!({ args: [], headers: {} }, () => {
      tenant = currentRequestContext()?.tenantId;
      return Promise.resolve(undefined);
    });
    expect(tenant).toBe('acme');
    expect(otel.spans()[0].attributes['tenant.id']).toBe('acme');
    expect(tenantOfWorkflowId('onboarding-u1')).toBeUndefined();
  });

  it('fails an activity whose input is invalid without retries', async () => {
    const ctx = {
      info: { activityType: 'a', attempt: 1 },
    } as unknown as ActivityContext;
    const { inbound } = traceActivityInterceptors(ctx);
    await expect(
      inbound!.execute!({ args: [], headers: {} }, () =>
        Promise.reject(
          AppError.validation([{ field: 'to', description: 'x' }]),
        ),
      ),
    ).rejects.toMatchObject({ nonRetryable: true });
  });
});
