/**
 * ApprovalStore — in-process approval gate
 *
 * Replaces MCWorker's approvalCallbacks Map. Keyed on job UUID (string)
 * instead of MC task ID (number), so it works without Mission Control.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 *   // In the approval-notify stage (blocks the workflow):
 *   const approved = await approvalStore.waitForApproval(job.id);
 *
 *   // In the API webhook handler (resolves the Promise):
 *   approvalStore.notifyApproval(jobId, true);   // approved
 *   approvalStore.notifyApproval(jobId, false);  // rejected
 *
 * ─── Restart caveat ──────────────────────────────────────────────────────────
 *
 * Callbacks are held in memory. On daemon restart, any pending approvals lose
 * their callback. To recover, query the job store for jobs with status
 * "awaiting_approval" and call waitForApproval for each at startup — the Slack
 * interactive buttons will then resolve them correctly when the approver acts.
 */
export class ApprovalStore {
  private readonly callbacks = new Map<string, (approved: boolean) => void>();

  /**
   * Block until a human approves or rejects the job, or until timeoutMs elapses.
   *
   * @param jobId     The ElevarusOS job UUID (not an MC task ID)
   * @param timeoutMs Auto-reject after this many ms (default: 24 hours)
   * @returns         true if approved, false if rejected or timed out
   */
  waitForApproval(jobId: string, timeoutMs = 24 * 60 * 60 * 1000): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.callbacks.set(jobId, resolve);

      // Auto-reject on timeout so the workflow doesn't hang forever
      setTimeout(() => {
        if (this.callbacks.has(jobId)) {
          this.callbacks.delete(jobId);
          resolve(false);
        }
      }, timeoutMs);
    });
  }

  /**
   * Resolve a pending waitForApproval. Called by the API webhook handler.
   * No-op if no callback is registered (e.g. daemon was restarted).
   *
   * @returns true if a pending callback was found and resolved; false otherwise
   */
  notifyApproval(jobId: string, approved: boolean): boolean {
    const cb = this.callbacks.get(jobId);
    if (!cb) return false;
    this.callbacks.delete(jobId);
    cb(approved);
    return true;
  }

  /** True if there is a pending approval gate registered for this job. */
  hasPending(jobId: string): boolean {
    return this.callbacks.has(jobId);
  }

  /** All job IDs currently blocked on approval. */
  pendingJobIds(): string[] {
    return [...this.callbacks.keys()];
  }
}

/** Singleton — shared across API server, stages, and the daemon entry point. */
export const approvalStore = new ApprovalStore();
