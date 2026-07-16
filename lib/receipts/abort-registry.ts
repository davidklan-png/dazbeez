// Client-safe registry of in-flight AbortControllers for capture uploads.
// Extracted from useReceiptUpload so the cancel/reset lifecycle is testable
// without a React harness. Uses only the AbortController global.

/**
 * Tracks AbortControllers for in-flight uploads so cancel()/reset() can abort
 * every one at once. register/unregister are paired around each upload;
 * abortAll() aborts every registered controller and clears the registry.
 *
 * Invariants:
 *   - abortAll() clears the registry, so a later unregister() is a harmless
 *     no-op (Set.delete on a missing key).
 *   - unregister() never throws, even after abortAll().
 */
export class AbortRegistry {
  private readonly controllers = new Set<AbortController>();

  register(controller: AbortController): void {
    this.controllers.add(controller);
  }

  unregister(controller: AbortController): void {
    this.controllers.delete(controller);
  }

  /** Abort every registered controller, then clear the registry. */
  abortAll(): void {
    for (const controller of this.controllers) {
      controller.abort();
    }
    this.controllers.clear();
  }

  /** Number of currently registered controllers. */
  get size(): number {
    return this.controllers.size;
  }
}
