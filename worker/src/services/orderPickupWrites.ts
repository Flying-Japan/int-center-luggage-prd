import { getBillingSummary, pickupBillingError } from './luggageBilling';
import { calculateStorageDays, calculateExtraDays } from './storage';

export class PickupTransitionError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: 404 | 409 | 500 = 409) {
    super(message);
  }
}

type PickupAction = 'mark_picked_up' | 'undo_picked_up';
type PickupRow = {
  order_id: string; parent_order_id: string | null; status: string; updated_at: string;
  created_at: string; expected_pickup_at: string | null; actual_pickup_at: string | null;
  actual_storage_days: number; extra_days: number; extra_amount: number;
  prepaid_amount: number; final_amount: number | null; price_per_day: number;
};
export type PickupResult = {
  orderId: string; status: 'PAID' | 'PICKED_UP'; actualPickupAt: string | null;
  actualStorageDays: number; extraDays: number; extraAmount: number; updatedAt: string;
};
const columns = ['order_id', 'parent_order_id', 'status', 'updated_at', 'created_at', 'expected_pickup_at',
  'actual_pickup_at', 'actual_storage_days', 'extra_days', 'extra_amount', 'prepaid_amount', 'final_amount', 'price_per_day'];
// Check both membership and values: a new child cannot slip between the read and the batch.
const familyMatches = `(SELECT COUNT(*) FROM luggage_orders WHERE order_id = ? OR parent_order_id = ?) = json_array_length(?)
  AND NOT EXISTS (SELECT 1 FROM json_each(?) snapshot LEFT JOIN luggage_orders o
    ON o.order_id = json_extract(snapshot.value, '$.order_id') WHERE ${columns.map(key => `o.${key} IS NOT json_extract(snapshot.value, '$.${key}')`).join(' OR ')})`;

function dto(row: PickupRow): PickupResult {
  if (row.status !== 'PAID' && row.status !== 'PICKED_UP') throw new PickupTransitionError('INVALID_STATUS', 'Pickup status transition is not allowed');
  return { orderId: row.order_id, status: row.status, actualPickupAt: row.actual_pickup_at,
    actualStorageDays: row.actual_storage_days, extraDays: row.extra_days, extraAmount: row.extra_amount, updatedAt: row.updated_at };
}

/** All HTTP pickup writers use one transaction. Money and cancellation records are never changed. */
export async function writePickupTransition(db: D1Database, orderId: string, action: PickupAction, audit: {
  action: string; staffId: string | null; deviceId?: string; actor?: unknown;
}, expectedUpdatedAt?: string): Promise<PickupResult> {
  const family = await db.prepare(`SELECT ${columns.join(', ')} FROM luggage_orders
    WHERE order_id = ? OR parent_order_id = ? ORDER BY order_id`).bind(orderId, orderId).all<PickupRow>();
  const before = family.results;
  const root = before.find(row => row.order_id === orderId);
  if (!root) throw new PickupTransitionError('NOT_FOUND', 'Luggage order not found', 404);
  if (root.parent_order_id) throw new PickupTransitionError('CHILD_ORDER', '원주문에서 수령/취소 처리해주세요');
  if (expectedUpdatedAt !== undefined && root.updated_at !== expectedUpdatedAt) {
    throw new PickupTransitionError('STALE', 'Luggage order was changed by another request');
  }
  const pickup = action === 'mark_picked_up';
  if (root.status !== (pickup ? 'PAID' : 'PICKED_UP')) {
    throw new PickupTransitionError(pickup && root.status !== 'PICKED_UP' ? 'NOT_PAID' : 'INVALID_STATUS', 'Pickup status transition is not allowed');
  }
  const billing = await getBillingSummary(db, orderId);
  const billingError = pickupBillingError(billing);
  if (billingError || (!pickup && billing?.root_review_required)) {
    throw new PickupTransitionError('BILLING_CONFLICT', billingError || '기존 원주문 정산 검토 주문은 수령 취소로 복구할 수 없습니다');
  }
  if ((pickup && (root.actual_pickup_at !== null || root.actual_storage_days !== 0 || root.extra_days !== 0))
    || (!pickup && (!root.actual_pickup_at || !Number.isFinite(Date.parse(root.actual_pickup_at))))) {
    throw new PickupTransitionError('INVALID_FAMILY', '수령 기록이 일치하지 않습니다. 관리자 확인이 필요합니다');
  }
  const active = before.filter(row => row.parent_order_id === orderId && row.status !== 'CANCELLED');
  let restore: PickupRow[] = [];
  if (!pickup && active.length) {
    // Old family pickups lack a before image. Never guess PAID or approve an unpaid child.
    const log = await db.prepare(`SELECT details FROM luggage_audit_logs WHERE order_id = ? AND json_valid(details)
      AND json_extract(details, '$.pickupTransition.action') = 'mark_picked_up'
      AND json_extract(details, '$.after.actualPickupAt') = ? ORDER BY log_id DESC LIMIT 1`)
      .bind(orderId, root.actual_pickup_at).first<{ details: string }>();
    if (!log) throw new PickupTransitionError('INVALID_FAMILY', '연장 주문의 이전 수령 상태를 확인할 수 없습니다. 관리자 확인이 필요합니다');
    const saved = JSON.parse(log.details) as { pickupTransition?: { before?: PickupRow[]; after?: PickupRow[] } };
    const savedBefore = saved.pickupTransition?.before;
    const savedAfter = saved.pickupTransition?.after;
    const complete = (rows: unknown): rows is PickupRow[] => Array.isArray(rows)
      && rows.every(row => row !== null && typeof row === 'object' && columns.every(key => key in row));
    if (!complete(savedBefore) || !complete(savedAfter)) {
      throw new PickupTransitionError('INVALID_FAMILY', '연장 주문의 이전 수령 상태를 확인할 수 없습니다');
    }
    restore = savedBefore;
    if (active.some(row => {
      const old = savedBefore.find(entry => entry.order_id === row.order_id && entry.parent_order_id === orderId);
      const picked = savedAfter.find(entry => entry.order_id === row.order_id && entry.parent_order_id === orderId);
      return !old || !picked || !['PAID', 'PAYMENT_PENDING'].includes(old.status)
        || old.actual_pickup_at !== null || old.actual_storage_days !== 0 || old.extra_days !== 0
        || (old.status === 'PAYMENT_PENDING' && (old.final_amount ?? old.prepaid_amount) + old.extra_amount !== 0)
        || row.status !== 'PICKED_UP' || row.actual_pickup_at !== root.actual_pickup_at
        || picked.status !== row.status || picked.actual_pickup_at !== row.actual_pickup_at
        || picked.actual_storage_days !== row.actual_storage_days || picked.extra_days !== row.extra_days;
    }) || savedAfter.filter(row => row.parent_order_id === orderId && row.status !== 'CANCELLED').length !== active.length) {
      throw new PickupTransitionError('INVALID_FAMILY', '원주문과 연장 주문의 수령 기록이 일치하지 않습니다. 관리자 확인이 필요합니다');
    }
  }
  if (pickup && active.some(row => !['PAID', 'PAYMENT_PENDING'].includes(row.status)
    || row.actual_pickup_at !== null || row.actual_storage_days !== 0 || row.extra_days !== 0
    || (row.status === 'PAYMENT_PENDING' && (row.final_amount ?? row.prepaid_amount) + row.extra_amount !== 0))) {
    throw new PickupTransitionError('INVALID_FAMILY', '원주문과 연장 주문의 수령 기록이 일치하지 않습니다. 관리자 확인이 필요합니다');
  }
  const now = new Date().toISOString();
  const previousRevision = Date.parse(root.updated_at.includes('T') ? root.updated_at : `${root.updated_at.replace(' ', 'T')}Z`);
  if (!Number.isFinite(previousRevision)) throw new PickupTransitionError('INVALID_FAMILY', '주문 수정 시각을 확인해주세요');
  // Millisecond revisions also prevent a same-second pickup/undo/pickup ABA replay.
  const revision = new Date(Math.max(Date.parse(now), previousRevision + 1)).toISOString();
  const after = before.map(row => {
    if (row.order_id !== orderId && row.status === 'CANCELLED') return row;
    const old = restore.find(entry => entry.order_id === row.order_id);
    if (!pickup && row.order_id !== orderId && !old) throw new PickupTransitionError('INVALID_FAMILY', '연장 이전 상태 확인이 필요합니다');
    return { ...row, status: pickup ? 'PICKED_UP' : row.order_id === orderId ? 'PAID' : old?.status ?? row.status,
      actual_pickup_at: pickup ? now : null,
      actual_storage_days: pickup ? calculateStorageDays(row.created_at, now) : 0,
      extra_days: pickup && row.expected_pickup_at ? calculateExtraDays(row.expected_pickup_at, now) : 0,
      updated_at: revision };
  });
  const updatedRoot = after.find(row => row.order_id === orderId)!;
  const details = JSON.stringify({ source: audit.deviceId ?? 'staff', action, actor: audit.actor,
    before: dto(root), after: dto(updatedRoot),
    pickupTransition: { id: crypto.randomUUID(), action, before, after } });
  const beforeJson = JSON.stringify(before);
  const afterJson = JSON.stringify(after);
  try {
    await db.batch([
      // Invalid JSON paths deliberately abort the D1 transaction with a named invariant.
      db.prepare(`SELECT json_extract('{}', CASE WHEN ${familyMatches} THEN '$' ELSE 'PICKUP_STALE' END)`)
        .bind(orderId, orderId, beforeJson, beforeJson),
      db.prepare(`SELECT json_extract('{}', CASE WHEN EXISTS (SELECT 1 FROM luggage_billing_balances
        WHERE root_id = ? AND outstanding_amount = 0 AND invalid_amount = 0 AND review_pickup_blocked = 0 AND pending_refund_count = 0
          AND (? = 1 OR root_review_required = 0)) THEN '$' ELSE 'PICKUP_BILLING_CONFLICT' END)`)
        .bind(orderId, pickup ? 1 : 0),
      db.prepare(`INSERT INTO luggage_audit_logs(order_id, staff_id, device_id, action, details, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)`).bind(orderId, audit.staffId, audit.deviceId ?? null, audit.action, details, now),
      db.prepare(`UPDATE luggage_orders SET status = ?, actual_pickup_at = ?, actual_storage_days = ?,
        extra_days = ?, updated_at = ? WHERE order_id = ? AND status = ? AND updated_at = ?`)
        .bind(updatedRoot.status, updatedRoot.actual_pickup_at, updatedRoot.actual_storage_days, updatedRoot.extra_days,
          revision, orderId, root.status, root.updated_at),
      db.prepare(`UPDATE luggage_orders SET status = json_extract(desired.value, '$.status'),
        actual_pickup_at = json_extract(desired.value, '$.actual_pickup_at'),
        actual_storage_days = json_extract(desired.value, '$.actual_storage_days'),
        extra_days = json_extract(desired.value, '$.extra_days'), updated_at = json_extract(desired.value, '$.updated_at')
        FROM json_each(?) desired WHERE luggage_orders.order_id = json_extract(desired.value, '$.order_id')
          AND luggage_orders.parent_order_id = ? AND luggage_orders.status != 'CANCELLED'`).bind(afterJson, orderId),
      // Check inside the transaction, including silent RAISE(IGNORE) failures. Post-batch checks cannot roll back.
      db.prepare(`SELECT json_extract('{}', CASE WHEN EXISTS (SELECT 1 FROM luggage_audit_logs
        WHERE order_id = ? AND action = ? AND details = ? AND staff_id IS ? AND device_id IS ?)
        AND ${familyMatches} THEN '$' ELSE 'PICKUP_ATOMICITY_FAILED' END)`)
        .bind(orderId, audit.action, details, audit.staffId, audit.deviceId ?? null, orderId, orderId, afterJson, afterJson),
    ]);
    return dto(updatedRoot);
  } catch (error) {
    if (error instanceof PickupTransitionError) throw error;
    const message = [error, error instanceof Error ? error.cause : null].map(String).join(' ');
    if (message.includes('PICKUP_STALE')) throw new PickupTransitionError('STALE', 'Luggage order was changed by another request');
    if (message.includes('PICKUP_BILLING_CONFLICT') || message.includes('Outstanding collection prevents pickup')) {
      throw new PickupTransitionError('BILLING_CONFLICT', '미수납액 또는 정산 상태가 변경되어 수령/취소할 수 없습니다. 새로고침 후 확인해주세요');
    }
    throw new PickupTransitionError('WRITE_FAILED', 'Unable to update pickup status and audit log', 500);
  }
}
