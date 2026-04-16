import { INotifyAdapter } from "./notify.interface";
import { Job } from "../../models/job.model";
import { EditorialOutput } from "../../models/output.model";
import { config } from "../../config";
import { logger } from "../../core/logger";

/**
 * Sends workflow notifications via Office 365 / Microsoft Graph API.
 *
 * Integration points:
 * - Requires MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_NOTIFY_FROM
 * - Uses the same credentials as the email intake adapter
 * - Sends mail via:
 *     POST https://graph.microsoft.com/v1.0/users/{from}/sendMail
 *
 * TODO: Acquire and cache Graph access token (shared with email intake adapter
 *       — extract token logic into a shared GraphAuthClient utility).
 * TODO: Use HTML email templates for richer approval requests.
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
      body: `A new blog workflow has started.\n\nJob ID: ${job.id}\nTitle: ${job.request.title}\nKeyword: ${job.request.targetKeyword}\n\nYou will receive a separate email when the draft is ready for your review.`,
    });
  }

  async sendApprovalRequest(job: Job): Promise<void> {
    const to = job.request.approver;
    if (!to) {
      logger.warn("No approver set — skipping approval email", { jobId: job.id });
      return;
    }

    const editorial = this.getStageOutput<EditorialOutput>(job, "editorial");
    const title = editorial?.title ?? job.request.title;
    const body = editorial?.body ?? "_Draft not available_";

    await this.send({
      to,
      subject: `[ElevarusOS] Approval requested: ${title}`,
      body: [
        `A draft is ready for your approval.`,
        ``,
        `Job ID: ${job.id}`,
        `Title: ${title}`,
        `Word count: ${editorial?.wordCount ?? "—"}`,
        `Edit summary: ${editorial?.editSummary ?? "—"}`,
        ``,
        `─── Draft ───────────────────────────────────────────────────`,
        ``,
        body,
        ``,
        `─────────────────────────────────────────────────────────────`,
        ``,
        `To approve, reply to this email with "APPROVED" or contact the content ops team.`,
      ].join("\n"),
    });
  }

  async sendFailure(job: Job, error: string): Promise<void> {
    const to = job.request.approver ?? config.microsoft.notifyFrom;
    if (!to) return;
    await this.send({
      to,
      subject: `[ElevarusOS] Workflow failed: ${job.request.title}`,
      body: `The blog workflow for job ${job.id} encountered an error.\n\nError: ${error}\n\nPlease review the job logs and retry.`,
    });
  }

  async sendCompletion(job: Job): Promise<void> {
    const to = job.request.approver;
    if (!to) return;
    await this.send({
      to,
      subject: `[ElevarusOS] Workflow completed: ${job.request.title}`,
      body: `The blog workflow for job ${job.id} has completed successfully.\n\nTitle: ${job.request.title}`,
    });
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async send(message: {
    to: string;
    subject: string;
    body: string;
  }): Promise<void> {
    if (!config.microsoft.tenantId || !config.microsoft.notifyFrom) {
      logger.warn("Email notify adapter is not configured — skipping email", {
        adapter: this.name,
        to: message.to,
      });
      return;
    }

    logger.debug("Sending email notification", {
      adapter: this.name,
      to: message.to,
      subject: message.subject,
    });

    // TODO: Implement real Graph API sendMail call
    // const token = await acquireGraphToken();
    // fetch(`https://graph.microsoft.com/v1.0/users/${config.microsoft.notifyFrom}/sendMail`, {
    //   method: "POST",
    //   headers: {
    //     "Content-Type": "application/json",
    //     Authorization: `Bearer ${token}`,
    //   },
    //   body: JSON.stringify({
    //     message: {
    //       subject: message.subject,
    //       body: { contentType: "Text", content: message.body },
    //       toRecipients: [{ emailAddress: { address: message.to } }],
    //     },
    //     saveToSentItems: true,
    //   }),
    // });

    logger.info("Email notification stubbed", {
      adapter: this.name,
      to: message.to,
      subject: message.subject,
    });
  }

  private getStageOutput<T>(job: Job, stageName: string): T | undefined {
    const stage = job.stages.find((s) => s.name === stageName);
    return stage?.output as T | undefined;
  }
}
