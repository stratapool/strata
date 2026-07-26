/**
 * Local store for notes that did NOT come from this wallet's signature.
 *
 * Notes derived from the wallet seed are recoverable anywhere with the same
 * wallet. A note handed to you by someone else is not: its secrets came from
 * their seed, so nothing can regenerate it. If this store is lost and the
 * original string was not kept, the funds are gone.
 *
 * That asymmetry has to be surfaced in the UI, not buried here.
 */
const KEY = 'strata.imported-notes.v1';

export interface ImportedNote {
  nullifier: string;
  secret: string;
  /** The serialised form, kept so the user can always re-export it. */
  encoded: string;
  importedAt: number;
}

function read(): ImportedNote[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A corrupt store must not take the whole app down; the wallet-derived
    // balance is unaffected and still spendable.
    return [];
  }
}

function write(notes: ImportedNote[]): void {
  localStorage.setItem(KEY, JSON.stringify(notes));
}

export const noteVault = {
  all(): ImportedNote[] {
    return read();
  },

  /** Idempotent: importing the same note twice must not double-count it. */
  add(note: Omit<ImportedNote, 'importedAt'>): { added: boolean } {
    const notes = read();
    if (notes.some((n) => n.nullifier === note.nullifier)) return { added: false };
    notes.push({ ...note, importedAt: Date.now() });
    write(notes);
    return { added: true };
  },

  remove(nullifier: string): void {
    write(read().filter((n) => n.nullifier !== nullifier));
  },

  clear(): void {
    localStorage.removeItem(KEY);
  },
};
