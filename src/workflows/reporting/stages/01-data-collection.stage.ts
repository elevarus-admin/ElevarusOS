import { IStage } from "../../../core/stage.interface";
import { Job } from "../../../models/job.model";
import { logger } from "../../../core/logger";

export interface DataCollectionOutput {
  rawData: Record<string, unknown>;
  dataSource: string;
  collectedAt: string;
}

/**
 * Stage 1 — Data Collection
 *
 * Collects raw campaign metric data for analysis.
 *
 * Currently accepts a manual JSON payload passed in the job request brief.
 * Future: wire up Google Ads API, Meta API, or CRM adapters here.
 *
 * To add a real data source:
 *   1. Create an adapter in src/adapters/datasource/
 *   2. Configure it per-instance in instance.md
 *   3. Call it here based on the instance's data source config
 */
export class DataCollectionStage implements IStage {
  readonly stageName = "data-collection";

  async run(job: Job): Promise<DataCollectionOutput> {
    logger.info("Running data-collection stage", { jobId: job.id });

    // TODO: Replace this with real data source integrations.
    // For now, parse a JSON payload from the job brief field.
    let rawData: Record<string, unknown> = {};
    let dataSource = "manual";

    try {
      const parsed = JSON.parse(job.request.brief);
      if (typeof parsed === "object" && parsed !== null) {
        rawData = parsed as Record<string, unknown>;
        dataSource = "brief-json";
      }
    } catch {
      // Brief is not JSON — treat it as a text description
      rawData = { description: job.request.brief };
      dataSource = "brief-text";
    }

    logger.info("Data collection complete", {
      jobId: job.id,
      dataSource,
      fieldCount: Object.keys(rawData).length,
    });

    return {
      rawData,
      dataSource,
      collectedAt: new Date().toISOString(),
    };
  }
}
