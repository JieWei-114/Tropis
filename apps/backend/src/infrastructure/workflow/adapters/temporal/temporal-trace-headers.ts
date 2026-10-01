import { SpanKind, type Attributes } from '@opentelemetry/api';
import {
  defaultPayloadConverter,
  type WorkflowClientInterceptor,
  type WorkflowStartInput,
} from '@temporalio/client';
import {
  ApplicationFailure,
  type Context as ActivityContext,
} from '@temporalio/activity';
import { isPermanentFailure } from '../../../capability/permanent-failure';
import type {
  ActivityInboundCallsInterceptor,
  ActivityInterceptors,
} from '@temporalio/worker';
import {
  injectTraceContext,
  runInExtractedSpan,
} from '../../../../common/observability/propagation';
import {
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
} from '../../../../common/observability/trace-context';
import { isTenantId } from '../../../../common/keyspace';

/**
 * The tenant an execution belongs to, from its engine id (`t.<tenant>:…`,
 * see tenantWorkflowPrefix); undefined for an id without the prefix.
 */
export function tenantOfWorkflowId(workflowId: string | undefined) {
  const match = /^t\.([^:]+):/.exec(workflowId ?? '');
  return match && isTenantId(match[1]) ? match[1] : undefined;
}

/**
 * W3C Trace Context across Temporal. The client writes `traceparent` and
 * `tracestate` into the workflow start headers; the workflow interceptors
 * (temporal-interceptors.ts, inside the sandbox) copy them onto every
 * activity and child workflow it schedules; the activity interceptor below
 * continues the trace around each activity attempt.
 */
export const TRACE_HEADER_KEYS = [TRACEPARENT_HEADER, TRACESTATE_HEADER];

type Payloads = WorkflowStartInput['headers'];

export function traceHeaders(): Payloads {
  const headers: Payloads = {};
  const carrier = injectTraceContext({});
  for (const key of TRACE_HEADER_KEYS) {
    const value = carrier[key];
    if (value) headers[key] = defaultPayloadConverter.toPayload(value);
  }
  return headers;
}

export function carrierFromHeaders(
  headers: Readonly<Payloads>,
): Record<string, string | undefined> {
  const carrier: Record<string, string | undefined> = {};
  for (const key of TRACE_HEADER_KEYS) {
    const payload = headers[key];
    if (!payload) continue;
    try {
      const value: unknown = defaultPayloadConverter.fromPayload(payload);
      if (typeof value === 'string') carrier[key] = value;
    } catch {
      continue;
    }
  }
  return carrier;
}

export const traceClientInterceptor: WorkflowClientInterceptor = {
  startWithDetails(input, next) {
    return next({ ...input, headers: { ...input.headers, ...traceHeaders() } });
  },
  signalWithStart(input, next) {
    return next({ ...input, headers: { ...input.headers, ...traceHeaders() } });
  },
};

export function traceActivityInterceptors(
  ctx: ActivityContext,
): ActivityInterceptors {
  const inbound: ActivityInboundCallsInterceptor = {
    execute(input, next) {
      const { info } = ctx;
      const attributes: Attributes = {
        'temporal.activity.type': info.activityType,
        'temporal.activity.attempt': info.attempt,
      };
      if (info.workflowType) {
        attributes['temporal.workflow.type'] = info.workflowType;
      }
      if (info.workflowExecution) {
        attributes['temporal.workflow.id'] = info.workflowExecution.workflowId;
      }
      const tenantId = tenantOfWorkflowId(info.workflowExecution?.workflowId);
      return runInExtractedSpan(
        carrierFromHeaders(input.headers),
        `RunActivity:${info.activityType}`,
        { kind: SpanKind.CONSUMER, attributes, tenantId },
        () =>
          next(input).catch((err: unknown) => {
            // Retrying cannot fix a permanent failure: fail the activity now.
            if (isPermanentFailure(err)) {
              throw ApplicationFailure.nonRetryable(
                (err as Error).message,
                (err as { code?: string }).code,
              );
            }
            throw err;
          }),
      );
    },
  };
  return { inbound };
}
