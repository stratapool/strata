import { Buffer } from 'buffer';

/**
 * ffjavascript's *browser* build still reaches for `Buffer`, and circomlibjs
 * depends on it — so every note derivation and merkle hash in the client dies
 * with "Buffer is not defined" without this.
 *
 * It failed loudly rather than silently: the pool read threw, the error
 * surfaced in the UI, and the figures were marked as not live. Worth keeping
 * that behaviour — a privacy pool quietly rendering zeros because its crypto
 * library never loaded is far worse than one that says it is broken.
 *
 * Imported for its side effect, first thing in main.tsx, because the modules
 * that need it are pulled in lazily later.
 */
if (typeof globalThis.Buffer === 'undefined') {
  (globalThis as { Buffer?: unknown }).Buffer = Buffer;
}
