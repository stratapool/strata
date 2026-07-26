/**
 * Strict serial execution for the hot wallet.
 *
 * Every relayed withdrawal is a transaction from one address. Two in flight
 * at once means two transactions claiming the same nonce: one of them is
 * dropped or replaced, and the user whose withdrawal vanished has no way to
 * retry — their proof is still valid but they have no idea what happened.
 *
 * Serialising costs throughput we do not need and removes the entire class.
 */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #depth = 0;

  get depth(): number {
    return this.#depth;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.#depth++;
    const result = this.#tail.then(task, task);
    // Track completion order only; swallow outcomes so one failure does not
    // poison the lane or surface as an unhandled rejection.
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    result.then(
      () => this.#depth--,
      () => this.#depth--,
    );
    return result;
  }
}
