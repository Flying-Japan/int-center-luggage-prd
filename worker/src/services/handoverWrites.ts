import { normalizeUnifiedWriteActor, type UnifiedWriteActor } from "../lib/internalActorStaff";

// Unified-admin handover writes. The staff HTML routes in operations.tsx keep their behavior;
// these payloads mirror what the staff handover screen lets editors do.

export type HandoverCategory = "HANDOVER" | "NOTICE" | "URGENT" | "EXPERIENCE" | "OTHER";

// The note as the read API exposes it (category folded to OTHER, null text as ""), used as the stale token.
export type HandoverNoteSnapshot = {
  category: string;
  title: string;
  content: string;
  isPinned: boolean;
  authorId: string | null;
};
export type HandoverDeleteSnapshot = HandoverNoteSnapshot & { commentCount: number };

export type HandoverRawNote = {
  noteId: number;
  category: string | null;
  title: string | null;
  content: string | null;
  isPinned: number | null;
  staffId: string | null;
  createdAt: string | null;
};

export type HandoverNoteFields = { category: HandoverCategory; title: string; content: string; isPinned: boolean };
export type HandoverCreatePayload = HandoverNoteFields & { requestId: string; actor: UnifiedWriteActor };
export type HandoverUpdatePayload = HandoverNoteFields & { expected: HandoverNoteSnapshot; actor: UnifiedWriteActor };
export type HandoverDeletePayload = { expected: HandoverDeleteSnapshot; actor: UnifiedWriteActor };
export type HandoverReadPayload = { actor: UnifiedWriteActor };
export type HandoverCommentCreatePayload = { requestId: string; content: string; actor: UnifiedWriteActor };

const CATEGORIES = new Set<string>(["HANDOVER", "NOTICE", "URGENT", "EXPERIENCE", "OTHER"]);
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOTE_FIELD_KEYS = ["category", "title", "content", "isPinned"];
const SNAPSHOT_KEYS = ["category", "title", "content", "isPinned", "authorId"];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, keys: string[], label: string) {
  const allowed = new Set(keys);
  if (!Object.keys(value).every((key) => allowed.has(key))) throw new Error(`${label} contains unsupported fields`);
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
  return normalized;
}

function requestId(value: unknown): string {
  if (typeof value !== "string" || !REQUEST_ID_PATTERN.test(value)) throw new Error("requestId must be a lowercase UUID");
  return value;
}

function noteFields(payload: Record<string, unknown>): HandoverNoteFields {
  if (typeof payload.category !== "string" || !CATEGORIES.has(payload.category)) throw new Error("category is not allowed");
  if (typeof payload.isPinned !== "boolean") throw new Error("isPinned must be a boolean");
  return {
    category: payload.category as HandoverCategory,
    title: requiredText(payload.title, "title", 200),
    content: requiredText(payload.content, "content", 10000),
    isPinned: payload.isPinned,
  };
}

function snapshot(value: unknown, keys: string[]): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error("expected is required");
  assertOnlyKeys(value, keys, "expected");
  for (const key of keys) if (!(key in value)) throw new Error(`expected.${key} is required`);
  if (typeof value.category !== "string" || typeof value.title !== "string" || typeof value.content !== "string") {
    throw new Error("expected note fields must be strings");
  }
  if (typeof value.isPinned !== "boolean") throw new Error("expected.isPinned must be a boolean");
  if (value.authorId !== null && typeof value.authorId !== "string") throw new Error("expected.authorId must be a string or null");
  return value;
}

export function normalizeHandoverCreatePayload(payload: unknown): HandoverCreatePayload {
  if (!isPlainRecord(payload)) throw new Error("Body must be an object");
  assertOnlyKeys(payload, ["requestId", ...NOTE_FIELD_KEYS, "actor"], "Body");
  return { requestId: requestId(payload.requestId), ...noteFields(payload), actor: normalizeUnifiedWriteActor(payload.actor) };
}

export function normalizeHandoverUpdatePayload(payload: unknown): HandoverUpdatePayload {
  if (!isPlainRecord(payload)) throw new Error("Body must be an object");
  assertOnlyKeys(payload, [...NOTE_FIELD_KEYS, "expected", "actor"], "Body");
  const expected = snapshot(payload.expected, SNAPSHOT_KEYS) as HandoverNoteSnapshot;
  return { ...noteFields(payload), expected, actor: normalizeUnifiedWriteActor(payload.actor) };
}

export function normalizeHandoverDeletePayload(payload: unknown): HandoverDeletePayload {
  if (!isPlainRecord(payload)) throw new Error("Body must be an object");
  assertOnlyKeys(payload, ["expected", "actor"], "Body");
  const expected = snapshot(payload.expected, [...SNAPSHOT_KEYS, "commentCount"]);
  if (typeof expected.commentCount !== "number" || !Number.isInteger(expected.commentCount) || expected.commentCount < 0) {
    throw new Error("expected.commentCount must be a non-negative integer");
  }
  return { expected: expected as HandoverDeleteSnapshot, actor: normalizeUnifiedWriteActor(payload.actor) };
}

export function normalizeHandoverReadPayload(payload: unknown): HandoverReadPayload {
  if (!isPlainRecord(payload)) throw new Error("Body must be an object");
  assertOnlyKeys(payload, ["actor"], "Body");
  return { actor: normalizeUnifiedWriteActor(payload.actor) };
}

export function normalizeHandoverCommentCreatePayload(payload: unknown): HandoverCommentCreatePayload {
  if (!isPlainRecord(payload)) throw new Error("Body must be an object");
  assertOnlyKeys(payload, ["requestId", "content", "actor"], "Body");
  return {
    requestId: requestId(payload.requestId),
    content: requiredText(payload.content, "content", 1000),
    actor: normalizeUnifiedWriteActor(payload.actor),
  };
}

export function parseHandoverId(raw: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

// Same folding as GET /internal/luggage-handovers so the client's view can be compared to the raw row.
export function handoverSnapshotOf(row: HandoverRawNote): HandoverNoteSnapshot {
  return {
    category: row.category && CATEGORIES.has(row.category) ? row.category : "OTHER",
    title: row.title ?? "",
    content: row.content ?? "",
    isPinned: Boolean(row.isPinned),
    authorId: row.staffId,
  };
}

export function sameHandoverSnapshot(current: HandoverNoteSnapshot, expected: HandoverNoteSnapshot): boolean {
  return current.category === expected.category
    && current.title === expected.title
    && current.content === expected.content
    && current.isPinned === expected.isPinned
    && current.authorId === expected.authorId;
}

// Raw re-check inside the write statement so a staff-screen edit between our read and write is not overwritten.
export const HANDOVER_RAW_WHERE = "category IS ? AND title IS ? AND content IS ? AND is_pinned IS ? AND staff_id IS ?";

export function handoverRawBinds(row: HandoverRawNote): Array<string | number | null> {
  return [row.category, row.title, row.content, row.isPinned, row.staffId];
}

// Mirrors the staff screen's @mention parsing (operations.tsx extractMentionedStaffIds + buildNameToIdMap).
export function extractMentionedStaffIds(content: string, idToName: Map<string, string>): string[] {
  const nameToId = new Map<string, string>();
  for (const [id, name] of idToName) nameToId.set(name, id);
  const ids: string[] = [];
  for (const match of content.matchAll(/@([^\s,，。！!?？\n]+)/g)) {
    const id = nameToId.get(match[1]);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
