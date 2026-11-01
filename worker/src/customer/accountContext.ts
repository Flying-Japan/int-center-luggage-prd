import type { Env } from '../types';
export type RenewalEnv = Env & { CUSTOMER_RENEWAL_ENABLED?: string; ACCOUNT_CONTEXT_SECRET?: string;
  ACCOUNT_LUGGAGE_LOGIN_READY?: string };
export type VerifiedIntakeCustomer = { personId: string; name: string; phone: string; email: string; provider: string; issuedAt: number; expiresAt: number };
export type IntakeIdentity = { kind: 'anonymous' } | { kind: 'verified'; customer: VerifiedIntakeCustomer } | { kind: 'invalid' };
const fields = ['person_id', 'email', 'provider', 'display_name', 'phone', 'locale', 'timestamp', 'signature'] as const;

/** Exact existing Account handoff format. No email matching, staff session reuse,
 * automatic account creation, profile writes, or cookie issuance occurs here. */
export async function readIntakeIdentity(headers: Headers, secret?: string, now = Date.now()): Promise<IntakeIdentity> {
  const hasHeaders = [...headers.keys()].some(key => key.startsWith('x-flying-account-'));
  const cookie = headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith('fj_account_context='))?.slice('fj_account_context='.length);
  if (!hasHeaders && !cookie) return { kind: 'anonymous' };
  if (!secret) return { kind: 'invalid' };
  try {
    const data: Record<string, unknown> = {};
    if (hasHeaders) for (const field of fields) {
      const key = field.replaceAll('_', '-');
      data[field] = headers.get(`x-flying-account-${key}`) ?? '';
    } else {
      if (!cookie || cookie.length > 4096) return { kind: 'invalid' };
      const value = JSON.parse(new TextDecoder().decode(decode(cookie)));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'invalid' };
      for (const field of fields) data[field] = value[field] ?? '';
    }
    for (const field of fields) if (typeof data[field] !== 'string' || /[\r\n]/.test(data[field] as string)) return { kind: 'invalid' };
    const text = (field: typeof fields[number]) => (data[field] as string).trim();
    const personId = text('person_id'), timestamp = text('timestamp'), signature = text('signature');
    const issuedAt = Date.parse(timestamp), age = now - issuedAt;
    if (!personId || !signature || !Number.isFinite(age) || age < -300000 || age >= 300000) return { kind: 'invalid' };
    const provider = text('provider') || 'account';
    const payload = [timestamp, personId, text('email'), provider, text('display_name'), text('phone'), text('locale')].join('\n');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, decode(signature), new TextEncoder().encode(payload));
    if (!valid) return { kind: 'invalid' };
    return { kind: 'verified', customer: { personId, provider, issuedAt, expiresAt: issuedAt + 300000,
      name: text('display_name').slice(0, 120), phone: text('phone').slice(0, 40), email: text('email').slice(0, 120) } };
  } catch { return { kind: 'invalid' }; }
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[\w-]+$/.test(value)) throw Error('INVALID_ENCODING');
  const raw = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(raw + '='.repeat((4 - raw.length % 4) % 4));
  const result = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) result[i] = binary.charCodeAt(i);
  return result;
}
/** Domain-separated opaque comparison handle. It grants no identity or access;
 * submit still verifies the live Account signature and derives the same handle. */
export async function intakeSubject(personId: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`luggage-intake-subject-v1\n${personId}`)));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export const renewalEnabled = (env: RenewalEnv) => ['development', 'test'].includes(env.APP_ENV) || env.CUSTOMER_RENEWAL_ENABLED === '1';
