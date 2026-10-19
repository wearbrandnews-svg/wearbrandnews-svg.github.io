// Each instance is a file-specific Durable Object. The explicit promise queue
// serializes the whole network operation, including awaits and error paths.
export class SerialQueue {
  tail = Promise.resolve();
  run(operation) {
    const current = this.tail.then(operation);
    this.tail = current.catch(() => {});
    return current;
  }
}
