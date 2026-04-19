/**
 * Slack file attachment → Claude image content blocks.
 *
 * When a Slack event carries a `files` array, this module downloads each
 * file from its `url_private` (private URL requires bot-token auth),
 * validates mimetype + size, and returns Anthropic-shaped image content
 * blocks ready to inject into the Claude Messages API request.
 *
 * Required Slack scope: `files:read` (Bot Token).
 *
 * Claude Messages API image limits (2025):
 *   - Supported mimetypes: image/png, image/jpeg, image/gif, image/webp
 *   - Per-image max: 5 MB (base64'd size slightly larger; we cap raw bytes)
 *   - Per-request max: 20 MB total base64 payload
 *   - Recommended: no more than ~5 images per turn for latency/cost
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config";
import { logger } from "../../core/logger";

const SUPPORTED_MIMETYPES = new Set<Anthropic.Base64ImageSource["media_type"]>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const MAX_IMAGE_BYTES   = 5  * 1024 * 1024;   // 5 MB per image
const MAX_TOTAL_BYTES   = 20 * 1024 * 1024;   // 20 MB combined (base64 approximately 33% larger, still safe)
const MAX_IMAGES        = 5;                  // per message
const DOWNLOAD_TIMEOUT_MS = 10_000;

/** Shape of the `files[]` entries we care about on Slack events. */
export interface SlackEventFile {
  id?:                 string;
  name?:               string;
  title?:              string;
  mimetype?:           string;
  url_private?:        string;
  url_private_download?: string;
  size?:               number;
  /** Slack sometimes marks files that haven't uploaded yet. */
  is_external?:        boolean;
  filetype?:           string;
}

export interface IngestedImages {
  /** Content blocks to concatenate after the user text block. */
  blocks:         Anthropic.ImageBlockParam[];
  /** Summary diagnostics for logging / audit. */
  stats: {
    total:           number;    // total files in the event
    accepted:        number;    // successfully attached as image blocks
    skipped:         number;    // filtered out (non-image, too big, etc.)
    skippedReasons:  Record<string, number>;
    totalBytes:      number;
  };
}

/**
 * Download every image file in the event's `files` array and return Claude
 * image content blocks. Non-image, oversized, or failed downloads are
 * skipped and logged — the caller still gets a coherent content array.
 *
 * Returns { blocks: [], stats: {...} } when files is missing/empty.
 */
export async function ingestSlackImages(
  files:   readonly SlackEventFile[] | undefined,
  traceId: string,
): Promise<IngestedImages> {
  const stats = {
    total:          files?.length ?? 0,
    accepted:       0,
    skipped:        0,
    skippedReasons: {} as Record<string, number>,
    totalBytes:     0,
  };
  const blocks: Anthropic.ImageBlockParam[] = [];

  if (!files || files.length === 0) return { blocks, stats };

  const token = config.slack.botToken;
  if (!token) {
    logger.warn("image-ingest: SLACK_BOT_TOKEN missing — cannot download files", {
      traceId,
      fileCount: files.length,
    });
    stats.skipped = stats.total;
    stats.skippedReasons.no_bot_token = stats.total;
    return { blocks, stats };
  }

  const recordSkip = (reason: string) => {
    stats.skipped += 1;
    stats.skippedReasons[reason] = (stats.skippedReasons[reason] ?? 0) + 1;
  };

  let imagesAccepted = 0;

  for (const file of files) {
    if (imagesAccepted >= MAX_IMAGES) { recordSkip("max_images_per_message"); continue; }

    const mimetype = (file.mimetype ?? "").toLowerCase();
    if (!mimetype.startsWith("image/")) { recordSkip("not_an_image"); continue; }
    if (!SUPPORTED_MIMETYPES.has(mimetype as Anthropic.Base64ImageSource["media_type"])) {
      recordSkip(`mimetype_${mimetype}`);
      continue;
    }

    if (typeof file.size === "number" && file.size > MAX_IMAGE_BYTES) {
      recordSkip("file_too_large");
      continue;
    }

    const url = file.url_private_download ?? file.url_private;
    if (!url) { recordSkip("missing_url_private"); continue; }

    try {
      const bytes = await downloadWithTimeout(url, token, traceId);
      if (!bytes) { recordSkip("download_failed"); continue; }
      if (bytes.byteLength > MAX_IMAGE_BYTES) { recordSkip("file_too_large_post_download"); continue; }
      if (stats.totalBytes + bytes.byteLength > MAX_TOTAL_BYTES) {
        recordSkip("total_bytes_exceeded");
        continue;
      }

      const base64 = Buffer.from(bytes).toString("base64");
      blocks.push({
        type:   "image",
        source: {
          type:       "base64",
          media_type: mimetype as Anthropic.Base64ImageSource["media_type"],
          data:       base64,
        },
      });

      stats.accepted   += 1;
      stats.totalBytes += bytes.byteLength;
      imagesAccepted   += 1;
    } catch (err) {
      logger.warn("image-ingest: download error", {
        traceId,
        fileId: file.id,
        error:  String(err),
      });
      recordSkip("exception");
    }
  }

  logger.info("image-ingest: done", {
    traceId,
    ...stats,
  });

  return { blocks, stats };
}

async function downloadWithTimeout(
  url:     string,
  token:   string,
  traceId: string,
): Promise<ArrayBuffer | null> {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal:  controller.signal,
    });
    if (!res.ok) {
      logger.warn("image-ingest: HTTP error", { traceId, status: res.status, url: safeUrl(url) });
      return null;
    }
    return await res.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

/** Strip query-string params from a Slack url_private for log safety. */
function safeUrl(u: string): string {
  const q = u.indexOf("?");
  return q > 0 ? u.slice(0, q) + "?…" : u;
}
