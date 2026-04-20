import { Hono } from "hono";
import type { AppType } from "../types";
import { internalAuth } from "../middleware/internalAuth";

const internalApi = new Hono<AppType>();
internalApi.use("/*", internalAuth);

const EXPERIENCE_STATUSES = new Set(["SCHEDULED", "VISITED", "RECEIVED", "CANCELLED"]);
const EXPERIENCE_VISITOR_TYPES = new Set(["BLOGGER", "INFLUENCER", "YOUTUBER", "OTHER"]);
const EXPERIENCE_BENEFIT_TYPES = new Set(["GIFT_CARD", "CASH", "PRODUCT", "OTHER", "REVIEWER_EXPERIENCE"]);

type ExperienceUpsertPayload = {
  benefitAmount?: unknown;
  benefitLabel?: unknown;
  benefitType?: unknown;
  createdByStaffId?: unknown;
  externalId?: unknown;
  note?: unknown;
  piiMaskedAt?: unknown;
  scheduledDate?: unknown;
  scheduledTime?: unknown;
  visitorName?: unknown;
  visitorType?: unknown;
};

function asOptionalText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > maxLength) {
    throw new Error(`Text field exceeds ${maxLength} characters`);
  }
  return text;
}

function asRequiredText(value: unknown, field: string, maxLength: number): string {
  const text = asOptionalText(value, maxLength);
  if (!text) {
    throw new Error(`${field} is required`);
  }
  return text;
}

function asDate(value: unknown, field: string): string {
  const text = asRequiredText(value, field, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`${field} must be YYYY-MM-DD`);
  }
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} is not a valid date`);
  }
  return text;
}

function asOptionalEnum(
  value: unknown,
  allowedValues: Set<string>,
  field: string,
): string | null {
  const text = asOptionalText(value, 100);
  if (!text) return null;
  if (!allowedValues.has(text)) {
    throw new Error(`${field} is invalid`);
  }
  return text;
}

function normalizeUpsertPayload(payload: ExperienceUpsertPayload) {
  return {
    benefitAmount: asOptionalText(payload.benefitAmount, 100),
    benefitLabel: asOptionalText(payload.benefitLabel, 200),
    benefitType:
      asOptionalEnum(payload.benefitType, EXPERIENCE_BENEFIT_TYPES, "benefitType") ?? "REVIEWER_EXPERIENCE",
    createdByStaffId: asOptionalText(payload.createdByStaffId, 100) ?? "system:reviewer",
    externalId: asRequiredText(payload.externalId, "externalId", 120),
    note: asOptionalText(payload.note, 500),
    piiMaskedAt: asOptionalText(payload.piiMaskedAt, 50),
    scheduledDate: asDate(payload.scheduledDate, "scheduledDate"),
    scheduledTime: asOptionalText(payload.scheduledTime, 50),
    visitorName: asRequiredText(payload.visitorName, "visitorName", 100),
    visitorType:
      asOptionalEnum(payload.visitorType, EXPERIENCE_VISITOR_TYPES, "visitorType") ?? "OTHER",
  };
}

internalApi.get("/internal/experience/:externalId", async (c) => {
  const externalId = c.req.param("externalId");
  const visit = await c.env.DB.prepare(
    "SELECT * FROM luggage_experience_visits WHERE external_id = ?",
  ).bind(externalId).first<Record<string, unknown>>();

  if (!visit) {
    return c.json({ error: "Experience visit not found" }, 404);
  }

  return c.json({ visit });
});

internalApi.post("/internal/experience", async (c) => {
  let payload: ExperienceUpsertPayload;
  try {
    payload = await c.req.json<ExperienceUpsertPayload>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  let normalized: ReturnType<typeof normalizeUpsertPayload>;
  try {
    normalized = normalizeUpsertPayload(payload);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO luggage_experience_visits (
       visitor_name, visitor_type, scheduled_date, scheduled_time,
       benefit_type, benefit_label, benefit_amount, external_id,
       status, note, created_by_staff_id, pii_masked_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SCHEDULED', ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(external_id) WHERE external_id IS NOT NULL DO UPDATE SET
       visitor_name = excluded.visitor_name,
       visitor_type = excluded.visitor_type,
       scheduled_date = excluded.scheduled_date,
       scheduled_time = excluded.scheduled_time,
       benefit_type = COALESCE(excluded.benefit_type, luggage_experience_visits.benefit_type),
       benefit_label = COALESCE(excluded.benefit_label, luggage_experience_visits.benefit_label),
       benefit_amount = COALESCE(excluded.benefit_amount, luggage_experience_visits.benefit_amount),
       note = COALESCE(excluded.note, luggage_experience_visits.note),
       pii_masked_at = COALESCE(excluded.pii_masked_at, luggage_experience_visits.pii_masked_at),
       updated_at = datetime('now')`,
  ).bind(
    normalized.visitorName,
    normalized.visitorType,
    normalized.scheduledDate,
    normalized.scheduledTime,
    normalized.benefitType,
    normalized.benefitLabel,
    normalized.benefitAmount,
    normalized.externalId,
    normalized.note,
    normalized.createdByStaffId,
    normalized.piiMaskedAt,
  ).run();

  const visit = await c.env.DB.prepare(
    "SELECT * FROM luggage_experience_visits WHERE external_id = ?",
  ).bind(normalized.externalId).first<Record<string, unknown>>();

  return c.json({ visit }, 201);
});

internalApi.post("/internal/experience/batch", async (c) => {
  let payload: ExperienceUpsertPayload[];
  try {
    payload = await c.req.json<ExperienceUpsertPayload[]>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!Array.isArray(payload) || payload.length === 0) {
    return c.json({ error: "Batch payload must be a non-empty array" }, 400);
  }
  if (payload.length > 50) {
    return c.json({ error: "Batch payload cannot exceed 50 items" }, 400);
  }

  const results: Array<{ error?: string; externalId?: string; ok: boolean }> = [];

  for (const entry of payload) {
    try {
      const normalized = normalizeUpsertPayload(entry);
      await c.env.DB.prepare(
        `INSERT INTO luggage_experience_visits (
           visitor_name, visitor_type, scheduled_date, scheduled_time,
           benefit_type, benefit_label, benefit_amount, external_id,
           status, note, created_by_staff_id, pii_masked_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SCHEDULED', ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(external_id) WHERE external_id IS NOT NULL DO UPDATE SET
           visitor_name = excluded.visitor_name,
           visitor_type = excluded.visitor_type,
           scheduled_date = excluded.scheduled_date,
           scheduled_time = excluded.scheduled_time,
           benefit_type = COALESCE(excluded.benefit_type, luggage_experience_visits.benefit_type),
           benefit_label = COALESCE(excluded.benefit_label, luggage_experience_visits.benefit_label),
           benefit_amount = COALESCE(excluded.benefit_amount, luggage_experience_visits.benefit_amount),
           note = COALESCE(excluded.note, luggage_experience_visits.note),
           pii_masked_at = COALESCE(excluded.pii_masked_at, luggage_experience_visits.pii_masked_at),
           updated_at = datetime('now')`,
      ).bind(
        normalized.visitorName,
        normalized.visitorType,
        normalized.scheduledDate,
        normalized.scheduledTime,
        normalized.benefitType,
        normalized.benefitLabel,
        normalized.benefitAmount,
        normalized.externalId,
        normalized.note,
        normalized.createdByStaffId,
        normalized.piiMaskedAt,
      ).run();
      results.push({ externalId: normalized.externalId, ok: true });
    } catch (error) {
      results.push({
        error: error instanceof Error ? error.message : String(error),
        externalId: typeof entry.externalId === "string" ? entry.externalId : undefined,
        ok: false,
      });
    }
  }

  const failed = results.filter((result) => !result.ok).length;
  return c.json(
    {
      failed,
      results,
      succeeded: results.length - failed,
    },
    failed > 0 ? 207 : 200,
  );
});

internalApi.patch("/internal/experience/:externalId", async (c) => {
  const externalId = c.req.param("externalId");

  let payload: Record<string, unknown>;
  try {
    payload = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const updates: string[] = [];
  const values: Array<string | null> = [];

  try {
    if ("visitorName" in payload) {
      updates.push("visitor_name = ?");
      values.push(asRequiredText(payload.visitorName, "visitorName", 100));
    }
    if ("visitorType" in payload) {
      updates.push("visitor_type = ?");
      values.push(asOptionalEnum(payload.visitorType, EXPERIENCE_VISITOR_TYPES, "visitorType") ?? "OTHER");
    }
    if ("scheduledDate" in payload) {
      updates.push("scheduled_date = ?");
      values.push(asDate(payload.scheduledDate, "scheduledDate"));
    }
    if ("scheduledTime" in payload) {
      updates.push("scheduled_time = ?");
      values.push(asOptionalText(payload.scheduledTime, 50));
    }
    if ("benefitType" in payload) {
      updates.push("benefit_type = ?");
      values.push(asOptionalEnum(payload.benefitType, EXPERIENCE_BENEFIT_TYPES, "benefitType"));
    }
    if ("benefitLabel" in payload) {
      updates.push("benefit_label = ?");
      values.push(asOptionalText(payload.benefitLabel, 200));
    }
    if ("benefitAmount" in payload) {
      updates.push("benefit_amount = ?");
      values.push(asOptionalText(payload.benefitAmount, 100));
    }
    if ("note" in payload) {
      updates.push("note = ?");
      values.push(asOptionalText(payload.note, 500));
    }
    if ("piiMaskedAt" in payload) {
      updates.push("pii_masked_at = ?");
      values.push(asOptionalText(payload.piiMaskedAt, 50));
    }
    if ("status" in payload) {
      const status = asRequiredText(payload.status, "status", 20);
      if (!EXPERIENCE_STATUSES.has(status)) {
        throw new Error("status is invalid");
      }
      updates.push("status = ?");
      values.push(status);
    }
    if ("receivedBy" in payload) {
      updates.push("received_by = ?");
      values.push(asOptionalText(payload.receivedBy, 100));
    }
    if ("receivedAt" in payload) {
      updates.push("received_at = ?");
      values.push(asOptionalText(payload.receivedAt, 50));
    }
    if ("processedByStaffId" in payload) {
      updates.push("processed_by_staff_id = ?");
      values.push(asOptionalText(payload.processedByStaffId, 100));
    }
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }

  if (updates.length === 0) {
    return c.json({ error: "No valid fields to update" }, 400);
  }

  updates.push("updated_at = datetime('now')");
  values.push(externalId);

  const result = await c.env.DB.prepare(
    `UPDATE luggage_experience_visits
     SET ${updates.join(", ")}
     WHERE external_id = ?`,
  ).bind(...values).run();

  if (!result.meta.changes) {
    return c.json({ error: "Experience visit not found" }, 404);
  }

  const visit = await c.env.DB.prepare(
    "SELECT * FROM luggage_experience_visits WHERE external_id = ?",
  ).bind(externalId).first<Record<string, unknown>>();

  return c.json({ visit });
});

export default internalApi;
