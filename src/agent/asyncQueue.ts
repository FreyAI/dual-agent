/** A pull-based queue the SDK reads user messages from (streaming input mode). */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T) {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true } as IteratorResult<T>);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) {
          return Promise.resolve({ value: this.items.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true } as IteratorResult<T>);
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
