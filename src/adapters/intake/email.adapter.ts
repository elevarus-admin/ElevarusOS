import { IIntakeAdapter } from "./intake.interface";
import { BlogRequest, RawSource } from "../../models/blog-request.model";
import { config } from "../../config";
import { logger } from "../../core/logger";
import { acquireGraphToken, clearGraphTokenCache } from "../../core/graph-auth";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/**
 * Reads blog content requests from an Office 365 shared mailbox via
 * Microsoft Graph API.
 *
 * Auth:      Client credentials flow (see graph-auth.ts)
 * Endpoint:  GET /users/{mailbox}/mailFolders/Inbox/messages
 * Dedup:     Processed emails are marked as read and moved to a
 *            "ElevarusOS-Processed" folder.
 *
 * Required env: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_INTAKE_MAILBOX
 *
 * Email format — senders should use this template in the message body:
 *   Title: <working headline>
 *   Brief: <content goal and angle>
 *   Audience: <target reader>
 *   Keyword: <primary SEO keyword>
 *   CTA: <desired call to action>
 *   Approver: <approver email>
 */
export class EmailIntakeAdapter implements IIntakeAdapter {
  readonly name = "email";

  async fetchPending(): Promise<BlogRequest[]> {
    if (!this.isConfigured()) {
      logger.warn("Email intake adapter is not configured — skipping", {
        adapter: this.name,
      });
      return [];
    }

    logger.info("Polling Office 365 inbox for pending blog requests", {
      mailbox: config.microsoft.intakeMailbox,
    });

    const emails = await this.fetchUnreadEmails();

    if (emails.length === 0) {
      logger.info("No unread intake emails found", { adapter: this.name });
      return [];
    }

    logger.info(`Found ${emails.length} unread intake email(s)`, {
      adapter: this.name,
    });

    const requests = emails.map((e) => this.parseEmail(e));

    // Mark each email as read so it isn't re-processed on the next poll
    await Promise.allSettled(emails.map((e) => this.markAsRead(e.id)));

    return requests;
  }

  // ─── API calls ────────────────────────────────────────────────────────────

  private async fetchUnreadEmails(): Promise<GraphMessage[]> {
    const { intakeMailbox } = config.microsoft;
    const url =
      `${GRAPH_BASE}/users/${encodeURIComponent(intakeMailbox)}` +
      `/mailFolders/Inbox/messages` +
      `?$filter=isRead eq false` +
      `&$select=id,subject,body,from,receivedDateTime` +
      `&$top=20` +
      `&$orderby=receivedDateTime asc`;

    const token = await this.getToken();

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 401) {
      clearGraphTokenCache();
      throw new Error("Graph API returned 401 — token may be invalid");
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Graph messages fetch failed (${res.status}): ${text.slice(0, 300)}`
      );
    }

    const data = (await res.json()) as { value: GraphMessage[] };
    return data.value ?? [];
  }

  private async markAsRead(messageId: string): Promise<void> {
    const { intakeMailbox } = config.microsoft;
    const url =
      `${GRAPH_BASE}/users/${encodeURIComponent(intakeMailbox)}` +
      `/messages/${messageId}`;

    const token = await this.getToken();

    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ isRead: true }),
    });

    if (!res.ok) {
      logger.warn("Could not mark email as read", {
        messageId,
        status: res.status,
      });
    }
  }

  // ─── Parsing ──────────────────────────────────────────────────────────────

  private parseEmail(email: GraphMessage): BlogRequest {
    const raw: RawSource = {
      channel: "email",
      sourceId: email.id,
      receivedAt: email.receivedDateTime ?? new Date().toISOString(),
      payload: email,
    };

    // Strip HTML tags for plain-text extraction
    const bodyText = (email.body?.content ?? "").replace(/<[^>]+>/g, " ").trim();

    const extract = (label: string): string => {
      const match = bodyText.match(new RegExp(`^${label}:\\s*(.+)$`, "im"));
      return match?.[1]?.trim() ?? "";
    };

    const title = extract("Title") || email.subject || "";
    const brief = extract("Brief");
    const audience = extract("Audience");
    const targetKeyword = extract("Keyword");
    const cta = extract("CTA");
    const approver =
      extract("Approver") || email.from?.emailAddress?.address || undefined;

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

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async getToken(): Promise<string> {
    return acquireGraphToken();
  }

  private isConfigured(): boolean {
    const { tenantId, clientId, clientSecret, intakeMailbox } = config.microsoft;
    return (
      !!tenantId &&
      !!clientId &&
      !!clientSecret &&
      !!intakeMailbox &&
      !intakeMailbox.includes("yourdomain.com")
    );
  }

  private detectMissing(
    fields: Record<string, string>
  ): Array<keyof Omit<BlogRequest, "rawSource" | "missingFields" | "workflowType">> {
    return Object.entries(fields)
      .filter(([, v]) => !v)
      .map(([k]) => k as keyof Omit<BlogRequest, "rawSource" | "missingFields" | "workflowType">);
  }
}

// ─── Microsoft Graph shapes ───────────────────────────────────────────────────

interface GraphMessage {
  id: string;
  subject?: string;
  receivedDateTime?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  body?: { contentType?: string; content?: string };
}
