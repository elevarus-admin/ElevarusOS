import { BlogRequest } from "../../models/blog-request.model";

/**
 * Every intake source must implement this interface so the orchestrator can
 * poll for new requests without knowing the underlying system.
 */
export interface IIntakeAdapter {
  readonly name: string;

  /**
   * Fetch zero or more pending blog requests from the source system.
   * Implementations are responsible for deduplication (e.g. marking tasks as
   * read, tracking processed message IDs).
   */
  fetchPending(): Promise<BlogRequest[]>;
}
