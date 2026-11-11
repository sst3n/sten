// Plumbing between "a leader signature was seen" and "we act on the trade".
//
// Fetching a transaction is slow and independent per signature, so fetches
// start at once and run in parallel. Acting on trades must stay ordered (a
// leader's buy before their sell, or we end up holding a bag they already
// dumped) and one at a time (so position and spend limits are never raced).

export interface FeedMeta {
  signature: string;
  /** Where the signature came from: 'push' or 'poll'. */
  via: string;
  seenAt: number;
  fetchedAt: number;
}

export class LeaderFeed<T> {
  private readonly seen = new Set<string>();
  private order: Promise<void> = Promise.resolve();
  private readonly fetchItem: (signature: string) => Promise<T | null>;
  private readonly emit: (item: T, meta: FeedMeta) => void;
  private readonly onError: (signature: string, error: Error) => void;

  constructor(
    fetchItem: (signature: string) => Promise<T | null>,
    emit: (item: T, meta: FeedMeta) => void,
    onError: (signature: string, error: Error) => void,
  ) {
    this.fetchItem = fetchItem;
    this.emit = emit;
    this.onError = onError;
  }

  /**
   * Starts fetching now, hands the result to `emit` in the order signatures
   * arrived. Returns false for a signature already seen (push and poll overlap).
   */
  ingest(signature: string, via: string): boolean {
    if (this.seen.has(signature)) return false;
    this.seen.add(signature);
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value!);

    const seenAt = Date.now();
    const pending = this.fetchItem(signature);
    pending.catch(() => {}); // reported below, in order; this only avoids an unhandled-rejection warning
    this.order = this.order.then(async () => {
      try {
        const item = await pending;
        if (item !== null) this.emit(item, { signature, via, seenAt, fetchedAt: Date.now() });
      } catch (e) {
        this.onError(signature, e as Error);
      }
    });
    return true;
  }
}

/** Runs tasks one at a time, first in first out. A failing task does not stop the ones behind it. */
export function makeQueue(onError: (e: Error) => void) {
  let chain: Promise<void> = Promise.resolve();
  return (task: () => Promise<void>) => {
    chain = chain.then(task).catch(onError);
  };
}
