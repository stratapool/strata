/**
 * blake-hash ships no types. Only the engine table the shim needs is declared.
 * The `lib` subpath is the dependency-free hashing core; the package's own
 * entry points wrap it in a Node stream, which is the thing being avoided.
 */
declare module 'blake-hash/lib' {
  interface BlakeEngine {
    update(data: Uint8Array): void;
    digest(): Uint8Array;
  }
  const engines: {
    Blake224: new () => BlakeEngine;
    Blake256: new () => BlakeEngine;
    Blake384: new () => BlakeEngine;
    Blake512: new () => BlakeEngine;
  };
  export default engines;
}
