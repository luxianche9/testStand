/** Serializes async read-modify-write operations while keeping failures from poisoning the queue. */
export class SerializedWriter {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async flush(): Promise<void> {
    await this.tail;
  }
}
