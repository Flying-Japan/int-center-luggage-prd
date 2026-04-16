import type { Env } from "../types";

export type DashboardSyncParams = {
  q: string;
  status: string;
  showAllPickedUp: boolean;
  dateFrom: string;
  dateTo: string;
};

function buildDashboardContextFilters(
  q: string,
  dateFrom: string,
  dateTo: string,
  alias = ""
): { clause: string; params: string[] } {
  const prefix = alias ? `${alias}.` : "";
  let clause = "";
  const params: string[] = [];
  const like = q ? `%${q}%` : "";

  if (q) {
    clause += ` AND (${prefix}name LIKE ? OR ${prefix}order_id LIKE ? OR ${prefix}tag_no LIKE ? OR ${prefix}phone LIKE ?)`;
    params.push(like, like, like, like);
  }

  if (dateFrom) {
    clause += ` AND ${prefix}created_at >= ?`;
    params.push(`${dateFrom} 00:00:00`);
  }

  if (dateTo) {
    clause += ` AND ${prefix}created_at <= ?`;
    params.push(`${dateTo} 23:59:59`);
  }

  return { clause, params };
}

function buildDashboardStatusFilters(
  status: string,
  showAllPickedUp: boolean,
  dateFrom: string,
  dateTo: string
): { clause: string; params: string[] } {
  let clause = "";
  const params: string[] = [];

  if (status === "UNPICKED") {
    clause += " AND o.status IN ('PAYMENT_PENDING', 'PAID')";
  } else if (status === "ALL") {
    if (!showAllPickedUp) {
      clause += " AND o.status != 'CANCELLED'";
    }
  } else {
    clause += " AND o.status = ?";
    params.push(status);
  }

  if (!showAllPickedUp && !dateFrom && !dateTo && (status === "ALL" || status === "PICKED_UP")) {
    clause += " AND (o.status != 'PICKED_UP' OR o.created_at >= datetime('now', '-2 days'))";
  }

  return { clause, params };
}

export async function getDashboardSyncToken(
  db: Env["DB"],
  params: DashboardSyncParams
): Promise<string> {
  const context = buildDashboardContextFilters(params.q, params.dateFrom, params.dateTo, "o");
  const statusFilter = buildDashboardStatusFilters(
    params.status,
    params.showAllPickedUp,
    params.dateFrom,
    params.dateTo
  );

  const [counts, filtered, logs] = await Promise.all([
    db.prepare(
      `SELECT
        SUM(CASE WHEN o.status = 'PAYMENT_PENDING' THEN 1 ELSE 0 END) as pending_count,
        SUM(CASE WHEN o.status = 'PAID' THEN 1 ELSE 0 END) as paid_count,
        SUM(CASE WHEN o.status = 'PICKED_UP' AND o.created_at >= datetime('now', '-2 days') THEN 1 ELSE 0 END) as picked_up_count,
        SUM(CASE WHEN o.status = 'PICKED_UP' THEN 1 ELSE 0 END) as picked_up_all_count,
        SUM(CASE WHEN o.status = 'CANCELLED' THEN 1 ELSE 0 END) as cancelled_count,
        COUNT(*) as total_count
      FROM luggage_orders o
      WHERE 1=1${context.clause}`
    ).bind(...context.params).first<{
      pending_count: number;
      paid_count: number;
      picked_up_count: number;
      picked_up_all_count: number;
      cancelled_count: number;
      total_count: number;
    }>(),
    db.prepare(
      `SELECT COUNT(*) as total
       FROM luggage_orders o
       WHERE 1=1${statusFilter.clause}${context.clause}`
    ).bind(...statusFilter.params, ...context.params).first<{ total: number }>(),
    db.prepare(
      `SELECT COALESCE(MAX(a.log_id), 0) as max_log_id
       FROM luggage_audit_logs a
       JOIN luggage_orders o ON o.order_id = a.order_id
       WHERE (
         a.action IN ('TOGGLE_PAYMENT', 'PICKUP', 'UNDO_PICKUP', 'CANCEL', 'BULK_MARK_PAID', 'BULK_CANCEL')
         OR (a.action = 'INLINE_UPDATE' AND a.details LIKE '%비고%')
       )
       ${context.clause}`
    ).bind(...context.params).first<{ max_log_id: number }>(),
  ]);

  const safeCounts = counts || {
    pending_count: 0,
    paid_count: 0,
    picked_up_count: 0,
    picked_up_all_count: 0,
    cancelled_count: 0,
    total_count: 0,
  };

  return [
    safeCounts.pending_count ?? 0,
    safeCounts.paid_count ?? 0,
    safeCounts.picked_up_count ?? 0,
    safeCounts.picked_up_all_count ?? 0,
    safeCounts.cancelled_count ?? 0,
    safeCounts.total_count ?? 0,
    filtered?.total ?? 0,
    logs?.max_log_id ?? 0,
  ].join(":");
}
