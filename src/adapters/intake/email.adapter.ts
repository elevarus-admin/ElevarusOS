import { IIntakeAdapter } from "./intake.interface";
import { BlogRequest, RawSource } from "../../models/blog-request.model";
import { config } from "../../config";
import { logger } from "../../core/logger";

/**
 * Reads blog content requests from an Office 365 shared mailbox via
 * Microsoft Graph API.
 *
 * Integration points:
 * - Requires MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_INTAKE_MAILBOX
 * - Uses client credentials flow (application permissions):
 *     POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
 * - Reads mail via:
 *     GET https://graph.microsoft.com/v1.0/users/{mailbox}/mailFolders/Inbox/messages
 *
 * TODO: Acquire and cache the Graph access token (expires 3600 s).
 * TODO: Move processed emails to a "Processed" folder to avoid re-reading.
 * TODO: Implement subject/body parsing heuristics or a structured email
 *       template that maps fields to BlogRequest properties.
 */
export class EmailIntakeAdapter implements IIntakeAdapter {
  readonly name = "email";

  async fetchPending(): Promise<BlogRequest[]> {
    if (!config.microsoft.tenantId || !config.microsoft.intakeMailbox) {
      logger.warn("Email intake adapter is not configured — skipping", {
        adapter: this.name,
      });
      return [];
    }

    logger.info("Polling Office 365 inbox for pending blog requests", {
      mailbox: config.microsoft.intakeMailbox,
    });

    const emails = await this.fetchUnreadEmails();
    return emails.map((email) => this.parseEmail(email));
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async fetchUnreadEmails(): Promise<GraphMessage[]> {
    // TODO: Implement Microsoft Graph API call
    // Steps:
    //  1. Acquire token:
    //     POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
    //     body: grant_type=client_credentials&client_id=...&client_secret=...
    //           &scope=https://graph.microsoft.com/.default
    //  2. Read unread messages:
    //     GET https://graph.microsoft.com/v1.0/users/{intakeMailbox}/mailFolders/Inbox/messages
    //     ?$filter=isRead eq false&$select=id,subject,body,from,receivedDateTime
    //     Headers: { Authorization: `Bearer ${token}` }
    //
    // Replace the stub below with the real implementation.
    logger.debug("Graph API call stubbed — returning empty message list", {
      adapter: this.name,
    });
    return [];
  }

  private parseEmail(email: GraphMessage): BlogRequest {
    const raw: RawSource = {
      channel: "email",
      sourceId: email.id,
      receivedAt: email.receivedDateTime ?? new Date().toISOString(),
      payload: email,
    };

    // Simple extraction strategy: look for labeled lines in the email body.
    // Expected format (enforced by a request template):
    //   Title: <value>
    //   Brief: <value>
    //   Audience: <value>
    //   Keyword: <value>
    //   CTA: <value>
    //   Approver: <value>
    const body = email.body?.content ?? "";
    const extract = (label: string): string => {
      const match = body.match(new RegExp(`^${label}:\\s*(.+)$`, "im"));
      return match?.[1]?.trim() ?? "";
    };

    const title = extract("Title") || email.subject || "";
    const brief = extract("Brief");
    const audience = extract("Audience");
    const targetKeyword = extract("Keyword");
    const cta = extract("CTA");
    const approver = extract("Approver") || email.from?.emailAddress?.address;

    const missingFields = this.detectMissing({
      title,
      brief,
      audience,
      targetKeyword,
      cta,
    });

    return {
      title,
      brief,
      audience,
      targetKeyword,
      cta,
      approver,
      rawSource: raw,
      missingFields,
    };
  }

  private detectMissing(
    fields: Record<string, string>
  ): Array<keyof Omit<BlogRequest, "rawSource" | "missingFields">> {
    return Object.entries(fields)
      .filter(([, v]) => !v)
      .map(([k]) => k as keyof Omit<BlogRequest, "rawSource" | "missingFields">);
  }
}

// ─── Microsoft Graph API shapes (minimal) ────────────────────────────────────

interface GraphMessage {
  id: string;
  subject?: string;
  receivedDateTime?: string;
  from?: { emailAddress?: { address?: string } };
  body?: { contentType?: string; content?: string };
}
