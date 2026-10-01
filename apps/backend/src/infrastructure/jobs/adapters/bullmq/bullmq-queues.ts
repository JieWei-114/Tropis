import { Queue, type ConnectionOptions } from 'bullmq';

/** BullMQ Queue handles, created on first use and closed together. */
export class BullmqQueues {
  private readonly queues = new Map<string, Queue>();

  constructor(private readonly connection: ConnectionOptions) {}

  get(name: string): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.connection });
      this.queues.set(name, queue);
    }
    return queue;
  }

  async close(): Promise<void> {
    const all = [...this.queues.values()];
    this.queues.clear();
    await Promise.all(all.map((q) => q.close().catch(() => undefined)));
  }
}
