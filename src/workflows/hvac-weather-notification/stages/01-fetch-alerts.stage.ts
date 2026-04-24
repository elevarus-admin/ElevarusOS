import { IStage } from "../../../core/stage.interface";
import { Job } from "../../../models/job.model";
import { logger } from "../../../core/logger";

const NWS_ALERTS_URL =
  "https://api.weather.gov/alerts/active?status=actual";

const HEAT_EVENTS = new Set<string>([
  "Excessive Heat Warning",
  "Excessive Heat Watch",
  "Heat Advisory",
]);

const COLD_EVENTS = new Set<string>([
  "Extreme Cold Warning",
  "Extreme Cold Watch",
  "Cold Weather Advisory",
  "Wind Chill Warning",
  "Wind Chill Advisory",
  "Winter Storm Warning",
  "Winter Storm Watch",
  "Winter Weather Advisory",
  "Freeze Warning",
]);

const US_STATE_CODES = new Set<string>([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
  "DC",
]);

interface NwsAlertFeature {
  properties: {
    event:     string;
    areaDesc:  string;
    ends:      string | null;
    expires:   string | null;
    geocode?:  { UGC?: string[]; SAME?: string[] };
  };
}

interface NwsAlertsResponse {
  features: NwsAlertFeature[];
}

export interface BucketSummary {
  states:      string[];
  stateCount:  number;
  alertCount:  number;
  events:      string[];
}

export interface FetchAlertsOutput {
  fetchedAt:     string;
  totalAlerts:   number;
  relevant:      number;
  heat:          BucketSummary;
  cold:          BucketSummary;
  hasAny:        boolean;
}

export class FetchAlertsStage implements IStage {
  readonly stageName = "fetch-alerts";

  async run(job: Job): Promise<FetchAlertsOutput> {
    logger.info("Running fetch-alerts stage", { jobId: job.id });

    const res = await fetch(NWS_ALERTS_URL, {
      headers: {
        "User-Agent": "ElevarusOS-HVAC-Weather-Notification/1.0 (shane@elevarus.com)",
        Accept:       "application/geo+json",
      },
    });

    if (!res.ok) {
      throw new Error(`NWS API ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as NwsAlertsResponse;
    const features = data.features ?? [];

    const heatStates = new Map<string, number>();
    const coldStates = new Map<string, number>();
    const heatEventSet = new Set<string>();
    const coldEventSet = new Set<string>();

    for (const f of features) {
      const event = f.properties.event;
      const isHeat = HEAT_EVENTS.has(event);
      const isCold = COLD_EVENTS.has(event);
      if (!isHeat && !isCold) continue;

      const ugcs = f.properties.geocode?.UGC ?? [];
      const states = new Set<string>();
      for (const u of ugcs) {
        const s = u.slice(0, 2);
        if (US_STATE_CODES.has(s)) states.add(s);
      }

      const bucket = isHeat ? heatStates : coldStates;
      const eventSet = isHeat ? heatEventSet : coldEventSet;
      eventSet.add(event);
      for (const s of states) {
        bucket.set(s, (bucket.get(s) ?? 0) + 1);
      }
    }

    const heat: BucketSummary = {
      states:     [...heatStates.keys()].sort(),
      stateCount: heatStates.size,
      alertCount: [...heatStates.values()].reduce((a, b) => a + b, 0),
      events:     [...heatEventSet].sort(),
    };
    const cold: BucketSummary = {
      states:     [...coldStates.keys()].sort(),
      stateCount: coldStates.size,
      alertCount: [...coldStates.values()].reduce((a, b) => a + b, 0),
      events:     [...coldEventSet].sort(),
    };

    const hasAny = heat.stateCount > 0 || cold.stateCount > 0;

    logger.info("fetch-alerts: done", {
      jobId:        job.id,
      totalAlerts:  features.length,
      heatStates:   heat.stateCount,
      coldStates:   cold.stateCount,
      hasAny,
    });

    return {
      fetchedAt:   new Date().toISOString(),
      totalAlerts: features.length,
      relevant:    heat.alertCount + cold.alertCount,
      heat,
      cold,
      hasAny,
    };
  }
}
