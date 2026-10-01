/**
 * Workflow interceptors, loaded into Temporal's deterministic sandbox through
 * WorkerOptions.interceptors.workflowModules. They copy the trace headers the
 * workflow was started with (trace-headers.ts) onto every activity and child
 * workflow it schedules, so those continue the starter's trace. Pure header
 * copying: no I/O, nothing non-deterministic.
 */
import type {
  Next,
  WorkflowInboundCallsInterceptor,
  WorkflowInterceptorsFactory,
  WorkflowOutboundCallsInterceptor,
} from '@temporalio/workflow';

const TRACE_HEADER_KEYS = ['traceparent', 'tracestate'];

type Headers = Parameters<
  Next<WorkflowInboundCallsInterceptor, 'execute'>
>[0]['headers'];

export const interceptors: WorkflowInterceptorsFactory = () => {
  let trace: Headers = {};
  const withTrace = (headers: Headers): Headers => ({ ...headers, ...trace });

  const inbound: WorkflowInboundCallsInterceptor = {
    execute(input, next) {
      const picked: Headers = {};
      for (const key of TRACE_HEADER_KEYS) {
        const value = input.headers[key];
        if (value) picked[key] = value;
      }
      trace = picked;
      return next(input);
    },
  };

  const outbound: WorkflowOutboundCallsInterceptor = {
    scheduleActivity(input, next) {
      return next({ ...input, headers: withTrace(input.headers) });
    },
    scheduleLocalActivity(input, next) {
      return next({ ...input, headers: withTrace(input.headers) });
    },
    startChildWorkflowExecution(input, next) {
      return next({ ...input, headers: withTrace(input.headers) });
    },
  };

  return { inbound: [inbound], outbound: [outbound] };
};
