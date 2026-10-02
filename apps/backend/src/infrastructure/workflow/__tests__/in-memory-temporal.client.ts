import { WorkflowNotFoundError, type Client } from '@temporalio/client';

interface Execution {
  workflowId: string;
  workflowType: string;
  status: { name: string };
  startTime: Date;
}

const CLAUSE = /^(\w+) (=|STARTS_WITH) '([^']*)'$/;
const STATUS_NAMES: Record<string, string> = {
  Running: 'RUNNING',
  Completed: 'COMPLETED',
};

/**
 * A Temporal client over an in-memory execution table, enough of the real
 * client for the WorkflowPort conformance suite: start (rejecting a running
 * id), describe (WorkflowNotFoundError for an unknown id), and count/list
 * over the AND-joined visibility clauses the adapter emits. No worker runs,
 * so executions stay RUNNING.
 */
export class InMemoryTemporalClient {
  private readonly executions = new Map<string, Execution>();
  private clock = Date.now();

  readonly connection = {
    ensureConnected: (): Promise<void> => Promise.resolve(),
    close: (): Promise<void> => Promise.resolve(),
  };

  readonly workflow = {
    start: (
      workflowType: string,
      options: { workflowId: string; taskQueue: string },
    ): Promise<{ workflowId: string }> => {
      const existing = this.executions.get(options.workflowId);
      if (existing?.status.name === 'RUNNING') {
        return Promise.reject(
          new Error(
            `Workflow execution already started: ${options.workflowId}`,
          ),
        );
      }
      this.executions.set(options.workflowId, {
        workflowId: options.workflowId,
        workflowType,
        status: { name: 'RUNNING' },
        startTime: new Date(++this.clock),
      });
      return Promise.resolve({ workflowId: options.workflowId });
    },
    getHandle: (workflowId: string) => ({
      describe: (): Promise<Execution> => {
        const execution = this.executions.get(workflowId);
        return execution
          ? Promise.resolve(execution)
          : Promise.reject(
              new WorkflowNotFoundError('not found', workflowId, undefined),
            );
      },
    }),
    count: (query: string): Promise<{ count: number }> =>
      Promise.resolve({ count: this.matching(query).length }),
    list: ({ query }: { query: string }): AsyncIterable<Execution> => {
      const rows = this.matching(query);
      return {
        [Symbol.asyncIterator]: () => {
          let next = 0;
          return {
            next: (): Promise<IteratorResult<Execution>> =>
              Promise.resolve(
                next < rows.length
                  ? { value: rows[next++], done: false }
                  : { value: undefined, done: true },
              ),
          };
        },
      };
    },
  };

  asClient(): Client {
    return this as unknown as Client;
  }

  private matching(query: string): Execution[] {
    const predicates = query.split(' AND ').map((clause) => {
      const match = CLAUSE.exec(clause.trim());
      if (!match) throw new Error(`Unsupported visibility clause: ${clause}`);
      const [, field, op, value] = match;
      return (e: Execution): boolean => {
        if (field === 'WorkflowType') return e.workflowType === value;
        if (field === 'ExecutionStatus')
          return e.status.name === STATUS_NAMES[value];
        if (field === 'WorkflowId') {
          return op === '='
            ? e.workflowId === value
            : e.workflowId.startsWith(value);
        }
        throw new Error(`Unsupported visibility field: ${field}`);
      };
    });
    return [...this.executions.values()].filter((e) =>
      predicates.every((p) => p(e)),
    );
  }
}
