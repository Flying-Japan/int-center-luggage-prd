/** Customer-intake state only. Nothing in this module authenticates a customer,
 * submits an order, sends a message, or changes the financial/warehouse SOT. */
export const INTAKE_STEPS = ["contact", "identity", "luggage", "pickup", "payment", "review"] as const;
export type IntakeStep = typeof INTAKE_STEPS[number];
export type IntakeLocale = "ko" | "en" | "ja";
export type ReceptionPath = "guest" | "kakao" | "google";
export type Contact = { name: string; phone: string; email: string };
export type DraftPhoto = { blob: Blob; name: string; lastModified: number };
export const INTAKE_DRAFT_TTL = 30 * 60 * 1000;
export type DraftBoundary = { mode: 'guest' } | { mode: 'member'; subject: string };
export type IntakeDraft = {
  version: 2;
  id: string;
  requestKey: string;
  revision: number;
  updatedAt: number;
  createdAt: number;
  expiresAt: number;
  boundary: DraftBoundary;
  step: IntakeStep;
  locale: IntakeLocale;
  path: ReceptionPath;
  contact: Contact;
  // Strings deliberately preserve partially typed/invalid input during auth.
  visit: { suitcaseQty: string; backpackQty: string; pickupDate: string; pickupTime: string;
    paymentMethod: "CASH" | "PAY_QR"; companionCount: string };
  photos: { identity: DraftPhoto | null; luggage: DraftPhoto | null };
  privacy: { version: string; accepted: boolean };
};

export function createIntakeDraft(locale: IntakeLocale, privacyVersion: string, now = Date.now()): IntakeDraft {
  const requestKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return { version: 2, id: crypto.randomUUID(), requestKey, revision: 0, updatedAt: now,
    createdAt: now, expiresAt: now + INTAKE_DRAFT_TTL, boundary: { mode: 'guest' },
    step: "contact", locale, path: "guest", contact: { name: "", phone: "", email: "" },
    visit: { suitcaseQty: "0", backpackQty: "0", pickupDate: "", pickupTime: "",
      paymentMethod: "CASH", companionCount: "1" }, photos: { identity: null, luggage: null },
    privacy: { version: privacyVersion, accepted: false } };
}

export function reviseIntakeDraft(draft: IntakeDraft, now = Date.now()): IntakeDraft {
  return { ...draft, revision: draft.revision + 1, updatedAt: now };
}

/** Adapter input must come from verified Account context, never an email match,
 * client-submitted person id, staff cookie, or user-editable authorization claim.
 * This function fills display fields only; it makes no ownership decision. */
export function mergeMemberContact(draft: IntakeDraft, profile: Partial<Contact>, subject: string, now = Date.now()) {
  if (draft.boundary.mode !== 'member' || draft.boundary.subject !== subject) throw Error('ACCOUNT_BOUNDARY_CHANGED');
  const contact = { ...draft.contact };
  const conflicts: Partial<Contact> = {};
  for (const field of ["name", "phone", "email"] as const) {
    const value = typeof profile[field] === "string" ? profile[field]!.trim() : "";
    if (!value) continue;
    if (!contact[field].trim()) contact[field] = value;
    else if (contact[field].trim() !== value) conflicts[field] = value;
  }
  return { draft: reviseIntakeDraft({ ...draft, contact }, now), conflicts };
}

/** A verified subject is a comparison value, never an authorization credential.
 * Only an explicit user action may adopt an anonymous draft. A member draft
 * cannot be re-attributed to a different account, even through this function. */
export function confirmAnonymousDraft(draft: IntakeDraft, subject: string, provider: 'kakao' | 'google', confirmed: boolean) {
  if (!confirmed || !/^[A-Za-z0-9_-]{43}$/.test(subject)) throw Error('ANONYMOUS_OWNERSHIP_CONFIRMATION_REQUIRED');
  if (draft.boundary.mode === 'member' && draft.boundary.subject !== subject) throw Error('ACCOUNT_BOUNDARY_CHANGED');
  return reviseIntakeDraft({ ...draft, boundary: { mode: 'member', subject }, path: provider });
}
export function draftBoundaryDecision(draft: IntakeDraft, subject: string | null, now = Date.now()) {
  if (!Number.isFinite(draft.createdAt) || draft.expiresAt !== draft.createdAt + INTAKE_DRAFT_TTL || now >= draft.expiresAt) return 'expired' as const;
  if (draft.boundary.mode === 'member') return !subject ? 'reauthenticate' as const
    : subject === draft.boundary.subject ? 'same-member' as const : 'different-member' as const;
  return subject ? 'confirm-anonymous' as const : 'guest' as const;
}

export type AuthHandoff = { draftId: string; revision: number; step: IntakeStep;
  provider: "kakao" | "google"; nonce: string };

export function beginIntakeAuth(draft: IntakeDraft, provider: "kakao" | "google"): AuthHandoff {
  // No validation gate: incomplete inputs and both photos must survive switching.
  return { draftId: draft.id, revision: draft.revision, step: draft.step, provider, nonce: crypto.randomUUID() };
}

export function resumeIntakeAuth(draft: IntakeDraft, handoff: AuthHandoff,
  outcome: "success" | "cancel" | "failure", profile: Partial<Contact> = {}, subject?: string, now = Date.now()) {
  if (draft.id !== handoff.draftId) throw new Error("AUTH_DRAFT_MISMATCH");
  if (draft.revision < handoff.revision) throw new Error("AUTH_DRAFT_STALE");
  // Keep the latest draft if another input was made while login was pending.
  if (outcome !== "success") return { draft, conflicts: {} as Partial<Contact> };
  // A local nonce hint alone never proves that an anonymous photo is this member's.
  if (draft.boundary.mode === 'guest') return { draft, conflicts: {} as Partial<Contact>, requiresConfirmation: true };
  if (!subject) throw Error('MEMBER_REAUTHENTICATION_REQUIRED');
  return mergeMemberContact({ ...draft, path: handoff.provider }, profile, subject, now);
}

function positiveInt(value: string, allowZero = false) {
  return /^\d+$/.test(value) && Number(value) <= 99 && Number(value) >= (allowZero ? 0 : 1);
}
export function missingIntakeFields(draft: IntakeDraft, step: IntakeStep): string[] {
  const { contact, visit, photos, privacy } = draft;
  switch (step) {
    case "contact": return [!contact.name.trim() && "name",
      !/^[\d\s\-+()]{6,20}$/.test(contact.phone.trim()) && "phone",
      !/^[^\s@]+@[^\s@]+$/.test(contact.email.trim()) && "email"].filter((v): v is string => !!v);
    case "identity": return photos.identity?.blob.size ? [] : ["id_image"];
    case "luggage": return [(!positiveInt(visit.suitcaseQty, true) || !positiveInt(visit.backpackQty, true)
      || Number(visit.suitcaseQty) + Number(visit.backpackQty) === 0) && "bag_quantities",
      !photos.luggage?.blob.size && "luggage_image"].filter((v): v is string => !!v);
    case "pickup": {
      const date = new Date(`${visit.pickupDate}T${visit.pickupTime}:00+09:00`);
      const validDate = /^\d{4}-\d{2}-\d{2}$/.test(visit.pickupDate)
        && Number.isFinite(date.getTime())
        && new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 10) === visit.pickupDate;
      const validTime = /^(?:09|1\d|20):(?:00|30)$|^21:00$/.test(visit.pickupTime);
      return validDate && validTime ? [] : ["expected_pickup_at"];
    }
    case "payment": return positiveInt(visit.companionCount) ? [] : ["companion_count"];
    case "review": return privacy.accepted && privacy.version ? [] : ["consent_checked"];
  }
}

/** Existing order/price/tag creation remains server-authoritative. */
export function toLegacyIntakeForm(draft: IntakeDraft, privacyVersion: string): FormData {
  const missing = INTAKE_STEPS.flatMap(step => missingIntakeFields(draft, step));
  if (draft.privacy.version !== privacyVersion) missing.push("privacy_version");
  if (missing.length) throw new Error(`INTAKE_INCOMPLETE:${missing.join(",")}`);
  const form = new FormData();
  for (const field of ["name", "phone", "email"] as const) form.set(field, draft.contact[field].trim());
  form.set("lang", draft.locale);
  form.set("suitcase_qty", draft.visit.suitcaseQty);
  form.set("backpack_qty", draft.visit.backpackQty);
  form.set("expected_pickup_at", `${draft.visit.pickupDate}T${draft.visit.pickupTime}`);
  form.set("payment_method", draft.visit.paymentMethod);
  form.set("companion_count", draft.visit.companionCount);
  form.set("consent_checked", "1");
  form.set("id_image", draft.photos.identity!.blob, draft.photos.identity!.name);
  form.set("luggage_image", draft.photos.luggage!.blob, draft.photos.luggage!.name);
  // No client-supplied person id, prices, paid/intake flags, point balance or benefits.
  return form;
}

export interface IntakeDraftStore {
  save(draft: IntakeDraft): Promise<void>;
  load(id: string): Promise<IntakeDraft | null>;
}

/** Use only with the renewed, server-idempotent submit route once it is mounted. */
export function toRenewalIntakeForm(draft: IntakeDraft, privacyVersion: string): FormData {
  if (!Number.isFinite(draft.createdAt) || draft.expiresAt !== draft.createdAt + INTAKE_DRAFT_TTL || Date.now() < draft.createdAt || Date.now() >= draft.expiresAt)
    throw Error('INTAKE_DRAFT_EXPIRED');
  if (draft.boundary.mode === 'guest' && draft.path !== 'guest') throw Error('ANONYMOUS_OWNERSHIP_CONFIRMATION_REQUIRED');
  const form = toLegacyIntakeForm(draft, privacyVersion);
  form.set("intake_request_key", draft.requestKey);
  form.set('intake_mode', draft.boundary.mode);
  if (draft.boundary.mode === 'member') form.set('intake_member_subject', draft.boundary.subject);
  return form;
}

/** Navigate only after durable storage confirms a complete photo-bearing snapshot.
 * Quota/private-mode failures must leave the user on the current form. */
export async function prepareIntakeAuth(store: IntakeDraftStore, draft: IntakeDraft, provider: "kakao" | "google") {
  await store.save(draft);
  return beginIntakeAuth(draft, provider);
}
