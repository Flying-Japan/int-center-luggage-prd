import type { Env } from "../types";
import { createBugTask } from "../lib/asana";
import { createTimestampHeader, signInternalRequest } from "../lib/hmac";

const SYNC_BACKOFF_MINUTES = [1, 10, 60] as const;
const SYNC_BATCH_LIMIT = 8;

type SyncJobStatus = "PENDING" | "FAILED" | "COMPLETED" | "DEAD_LETTER";

type SyncJobRow = {
  attempt_count: number;
  created_at: string;
  dead_letter_reason: string | null;
  external_id: string;
  job_id: number;
  job_type: string;
  last_error: string | null;
  max_attempts: number;
  next_attempt_at: string;
  request_body: string | null;
  request_headers: string | null;
  request_method: string;
  request_url: string;
  requires_hmac: number;
  status: SyncJobStatus;
  target_system: string;
  updated_at: string;
};

export type SyncJobInput = {
  externalId: string;
  jobType?: string;
  requestBody?: string | null;
  requestHeaders?: Record<string, string> | null;
  requestMethod: string;
  requestUrl: string;
  requiresHmac?: boolean;
  targetSystem: string;
};

function compactErrorMessage(value: string): string {
  return value.length > 500 ? `${value.slice(0, 497)}...` : value;
}

function getNextAttemptTimestamp(attemptCount: number, now = new Date()): string {
  const minutes = SYNC_BACKOFF_MINUTES[Math.min(attemptCount - 1, SYNC_BACKOFF_MINUTES.length - 1)];
  const next = new Date(now.getTime() + minutes * 60_000);
  return next.toISOString();
}

async function deadLetterJob(env: Env, job: SyncJobRow, errorMessage: string) {
  await env.DB.prepare(
    `UPDATE sync_jobs
     SET status = 'DEAD_LETTER',
         attempt_count = ?,
         dead_letter_reason = ?,
         dead_lettered_at = datetime('now'),
         last_error = ?,
         updated_at = datetime('now')
     WHERE job_id = ?`,
  ).bind(job.attempt_count, errorMessage, errorMessage, job.job_id).run();

  const notes = [
    `target_system: ${job.target_system}`,
    `job_type: ${job.job_type}`,
    `external_id: ${job.external_id}`,
    `request_url: ${job.request_url}`,
    `attempt_count: ${job.attempt_count}/${job.max_attempts}`,
    "",
    "last_error:",
    errorMessage,
  ].join("\n");

  await createBugTask(
    env.ASANA_PAT,
    env.ASANA_BUG_PROJECT_GID,
    `[sync_jobs] ${job.target_system} ${job.external_id}`,
    notes,
    "system",
    "medium",
  );
}

async function markJobRetry(env: Env, job: SyncJobRow, attemptCount: number, errorMessage: string) {
  await env.DB.prepare(
    `UPDATE sync_jobs
     SET status = 'FAILED',
         attempt_count = ?,
         next_attempt_at = ?,
         last_error = ?,
         updated_at = datetime('now')
     WHERE job_id = ?`,
  ).bind(attemptCount, getNextAttemptTimestamp(attemptCount), errorMessage, job.job_id).run();
}

async function processSyncJob(env: Env, job: SyncJobRow): Promise<"completed" | "failed" | "dead-letter"> {
  try {
    const body = job.request_body ?? undefined;
    const headers = new Headers(
      job.request_headers ? (JSON.parse(job.request_headers) as Record<string, string>) : undefined,
    );

    if (body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    if (job.requires_hmac) {
      const timestamp = createTimestampHeader();
      const { signature } = await signInternalRequest({
        body,
        method: job.request_method,
        secret: env.INTERNAL_API_SECRET,
        timestamp,
        url: job.request_url,
      });
      headers.set("x-internal-timestamp", timestamp);
      headers.set("x-internal-signature", signature);
    }

    const response = await fetch(job.request_url, {
      body,
      headers,
      method: job.request_method,
    });

    if (!response.ok) {
      const errorBody = compactErrorMessage(await response.text());
      const errorMessage = `HTTP ${response.status}: ${errorBody || response.statusText}`;
      const attemptCount = job.attempt_count + 1;

      if (attemptCount >= job.max_attempts) {
        await deadLetterJob(env, { ...job, attempt_count: attemptCount }, errorMessage);
        return "dead-letter";
      }

      await markJobRetry(env, job, attemptCount, errorMessage);
      return "failed";
    }

    await env.DB.prepare(
      `UPDATE sync_jobs
       SET status = 'COMPLETED',
           attempt_count = ?,
           last_error = NULL,
           updated_at = datetime('now')
       WHERE job_id = ?`,
    ).bind(job.attempt_count + 1, job.job_id).run();
    return "completed";
  } catch (error) {
    const message = compactErrorMessage(error instanceof Error ? error.message : String(error));
    const attemptCount = job.attempt_count + 1;

    if (attemptCount >= job.max_attempts) {
      await deadLetterJob(env, { ...job, attempt_count: attemptCount }, message);
      return "dead-letter";
    }

    await markJobRetry(env, job, attemptCount, message);
    return "failed";
  }
}

export async function enqueueSyncJob(env: Env, job: SyncJobInput) {
  await env.DB.prepare(
    `INSERT INTO sync_jobs (
       target_system, job_type, external_id,
       request_method, request_url, request_headers, request_body, requires_hmac,
       status, attempt_count, max_attempts, next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, 3, datetime('now'), datetime('now'), datetime('now'))
     ON CONFLICT(external_id) DO UPDATE SET
       target_system = excluded.target_system,
       job_type = excluded.job_type,
       request_method = excluded.request_method,
       request_url = excluded.request_url,
       request_headers = excluded.request_headers,
       request_body = excluded.request_body,
       requires_hmac = excluded.requires_hmac,
       status = 'PENDING',
       attempt_count = 0,
       max_attempts = 3,
       next_attempt_at = datetime('now'),
       last_error = NULL,
       dead_letter_reason = NULL,
       dead_lettered_at = NULL,
       updated_at = datetime('now')`,
  ).bind(
    job.targetSystem,
    job.jobType ?? "HTTP_REQUEST",
    job.externalId,
    job.requestMethod.trim().toUpperCase(),
    job.requestUrl,
    job.requestHeaders ? JSON.stringify(job.requestHeaders) : null,
    job.requestBody ?? null,
    job.requiresHmac === false ? 0 : 1,
  ).run();
}

export async function runSyncJobs(env: Env) {
  const jobs = await env.DB.prepare(
    `SELECT *
     FROM sync_jobs
     WHERE status IN ('PENDING', 'FAILED')
       AND next_attempt_at <= datetime('now')
     ORDER BY next_attempt_at ASC, job_id ASC
     LIMIT ?`,
  ).bind(SYNC_BATCH_LIMIT).all<SyncJobRow>();

  let completed = 0;
  let failed = 0;
  let deadLettered = 0;
  let crashed = 0;

  for (const job of jobs.results) {
    // Guard each job independently — a DB write failure inside processSyncJob's
    // retry/dead-letter branches would otherwise bubble out and abort the
    // remaining jobs in the batch, stranding them until the next cron tick.
    try {
      const outcome = await processSyncJob(env, job);
      if (outcome === "completed") completed += 1;
      if (outcome === "failed") failed += 1;
      if (outcome === "dead-letter") deadLettered += 1;
    } catch (error) {
      crashed += 1;
      const message = compactErrorMessage(error instanceof Error ? error.message : String(error));
      console.error(`sync_jobs: job_id=${job.job_id} crashed outside handler:`, message);
    }
  }

  return {
    completed,
    crashed,
    deadLettered,
    failed,
    scanned: jobs.results.length,
  };
}
