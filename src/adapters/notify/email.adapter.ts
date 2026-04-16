import { INotifyAdapter } from "./notify.interface";
import { Job } from "../../models/job.model";
import { EditorialOutput } from "../../models/output.model";
import { config } from "../../config";
import { logger } from "../../core/logger";
import { acquireGraphToken, clearGraphTokenCache } from "../../core/graph-auth";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/**
 * Sends workflow notification emails via Office 365 / Microsoft Graph API.
 *
 * Auth:      Shared client credentials token (see graph-auth.ts)
 * Endpoint:  POST /users/{from}/sendMail
 *
 * Required env: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_NOTIFY_FROM
 */
export class EmailNotifyAdapter implements INotifyAdapter {
  readonly name = "email-notify";

  async sendJobStarted(job: Job): Promise<void> {
    const to = job.request.approver;
    if (!to) {
      logger.info("No approver set — skipping job-started email", {
        jobId: job.id,
      });
      return;
    }
    await this.send({
      to,
      subject: `[ElevarusOS] Blog workflow started: ${job.request.title}`,
      bodyText: [
        `A new blog workflow has started.`,
        ``,
        `Job ID:  ${job.id}`,
        `Title:   ${job.request.title}`,
        `Keyword: ${job.request.targetKeyword}`,
        ``,
        `You will receive a separate email when the draft is ready for your review.`,
      ].join("\n"),
    });
  }

  async sendApprovalRequest(job: Job): Promise<void> {
    const to = job.request.approver;
    if (!to) {
      logger.warn("No approver set — skipping approval email", {
        jobId: job.id,
      });
      return;
    }

    const editorial = this.getStageOutput<EditorialOutput>(job, "editorial");
    const title = editorial?.title ?? job.request.title;
    const body = editorial?.body ?? "_Draft not available_";

    await this.send({
      to,
      subject: `[ElevarusOS] Approval requested: ${title}`,
      bodyText: [
        `A draft is ready for your approval.`,
        ``,
        `Job ID:       ${job.id}`,
        `Title:        ${title}`,
        `Word count:   ${editorial?.wordCount ?? "—"}`,
        `Edit summary: ${editorial?.editSummary ?? "—"}`,
        ``,
        `${"─".repeat(60)}`,
        ``,
        body,
        ``,
        `${"─".repeat(60)}`,
        ``,
        `To approve, reply with "APPROVED" or contact the content ops team.`,
      ].join("\n"),
    });
  }

  async sendFailure(job: Job, error: string): Promise<void> {
    const to = job.request.approver ?? config.microsoft.notifyFrom;
    if (!to || to.includes("yourdomain.com")) return;
    await this.send({
      to,
      subject: `[ElevarusOS] Workflow failed: ${job.request.title}`,
      bodyText: [
        `The blog workflow for job ${job.id} encountered an error.`,
        ``,
        `Error: ${error}`,
        ``,
        `Please review the job logs and retry.`,
      ].join("\n"),
    });
  }

  async sendCompletion(job: Job): Promise<void> {
    const to = job.request.approver;
    if (!to) return;
    await this.send({
      to,
      subject: `[ElevarusOS] Workflow completed: ${job.request.title}`,
      bodyText: [
        `The blog workflow for job ${job.id} has completed successfully.`,
        ``,
        `Title: ${job.request.title}`,
      ].join("\n"),
    });
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async send(message: {
    to: string;
    subject: string;
    bodyText: string;
  }): Promise<void> {
    if (!this.isConfigured()) {
      logger.warn("Email notify adapter is not configured — skipping email", {
        adapter: this.name,
        to: message.to,
      });
      return;
    }

    logger.debug("Sending notification email", {
      adapter: this.name,
      to: message.to,
      subject: message.subject,
    });

    const { notifyFrom } = config.microsoft;
    const url = `${GRAPH_BASE}/users/${encodeURIComponent(notifyFrom)}/sendMail`;

    let token: string;
    try {
      token = await acquireGraphToken();
    } catch (err) {
      logger.error("Failed to acquire Graph token for email send", {
        error: String(err),
      });
      return;
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject: message.subject,
          body: { contentType: "Text", content: message.bodyText },
          toRecipients: [{ emailAddress: { address: message.to } }],
        },
        saveToSentItems: true,
      }),
    });

    if (res.status === 401) {
      clearGraphTokenCache();
      logger.error("Graph sendMail returned 401 — token cleared for retry", {
        adapter: this.name,
      });
      return;
    }

    if (!res.ok) {
      const text = await res.text();
      logger.error("Graph sendMail failed", {
        adapter: this.name,
        status: res.status,
        body: text.slice(0, 300),
      });
      return;
    }

    logger.info("Notification email sent", {
      adapter: this.name,
      to: message.to,
      subject: message.subject,
    });
  }

  private isConfigured(): boolean {
    const { tenantId, clientId, clientSecret, notifyFrom } = config.microsoft;
    if (!tenantId || !clientId || !clientSecret || !notifyFrom) return false;
    if (notifyFrom.includes("yourdomain.com")) return false;
    return true;
  }

  private getStageOutput<T>(job: Job, stageName: string): T | undefined {
    const stage = job.stages.find((s) => s.name === stageName);
    return stage?.output as T | undefined;
  }
}
