/**
 * Issue #1139: Implement streaming for large datasets
 *
 * Supports cursor-based pagination and prefetching for large invoice
 * or transaction datasets to bound memory consumption.
 */

export interface PageResult<T> {
  items: T[];
  nextCursor?: string;
  prevCursor?: string;
  hasMore: boolean;
}

export interface StreamingDatasetOptions<T> {
  chunkSize?: number;
  fetchPage: (cursor?: string, limit?: number) => Promise<PageResult<T>>;
}

export class StreamingDatasetIterator<T> {
  private chunkSize: number;
  private currentCursor?: string;
  private cursorHistory: Array<string | undefined> = [];
  private prefetchedNext?: Promise<PageResult<T>>;

  constructor(private readonly options: StreamingDatasetOptions<T>) {
    this.chunkSize = options.chunkSize ?? 50;
  }

  public async nextPage(): Promise<PageResult<T>> {
    let result: PageResult<T>;
    if (this.prefetchedNext) {
      result = await this.prefetchedNext;
      this.prefetchedNext = undefined;
    } else {
      result = await this.options.fetchPage(this.currentCursor, this.chunkSize);
    }

    this.cursorHistory.push(this.currentCursor);
    this.currentCursor = result.nextCursor;

    if (result.hasMore && result.nextCursor) {
      this.prefetch(result.nextCursor);
    }

    return result;
  }

  public async prevPage(): Promise<PageResult<T>> {
    if (this.cursorHistory.length <= 1) {
      this.currentCursor = undefined;
      return this.nextPage();
    }

    this.cursorHistory.pop(); // current
    const prev = this.cursorHistory.pop(); // previous
    this.currentCursor = prev;
    this.prefetchedNext = undefined;

    return this.nextPage();
  }

  private prefetch(cursor: string): void {
    this.prefetchedNext = this.options.fetchPage(cursor, this.chunkSize);
  }

  public async *stream(): AsyncGenerator<T, void, unknown> {
    let hasMore = true;
    while (hasMore) {
      const page = await this.nextPage();
      for (const item of page.items) {
        yield item;
      }
      hasMore = page.hasMore;
    }
  }
}
