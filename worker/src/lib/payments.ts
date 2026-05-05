export type PaymentAllocation = {
  cashAmount: number;
  qrAmount: number;
  totalAmount: number;
  paymentMethod: "CASH" | "PAY_QR" | "MIXED";
};

export type PaymentOrderAmounts = {
  prepaid_amount: number;
  final_amount?: number | null;
  extra_amount?: number | null;
};

export function payableAmountFromOrder(order: PaymentOrderAmounts): number {
  const base = order.final_amount && order.final_amount > 0
    ? order.final_amount
    : order.prepaid_amount;
  return (base || 0) + (order.extra_amount || 0);
}

function parseYen(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = Number(String(value).replace(/,/g, "").trim());
  if (!Number.isFinite(parsed)) return NaN;
  return Math.round(parsed);
}

export function normalizePaymentAllocation(
  body: Record<string, unknown>,
  payableAmount: number
): PaymentAllocation | { error: string } {
  const hasAmountPayload = [body.cash_amount, body.qr_amount].some((value) =>
    value !== undefined && value !== null && String(value).trim() !== ""
  );

  if (hasAmountPayload) {
    const cashAmount = parseYen(body.cash_amount);
    const qrAmount = parseYen(body.qr_amount);
    if (!Number.isInteger(cashAmount) || !Number.isInteger(qrAmount) || cashAmount < 0 || qrAmount < 0) {
      return { error: "결제금액은 0 이상의 정수로 입력해주세요" };
    }
    if (cashAmount + qrAmount !== payableAmount) {
      return { error: `현금+QR 합계가 주문금액 ¥${payableAmount.toLocaleString()}와 맞지 않습니다` };
    }
    return {
      cashAmount,
      qrAmount,
      totalAmount: cashAmount + qrAmount,
      paymentMethod: cashAmount > 0 && qrAmount > 0 ? "MIXED" : qrAmount > 0 ? "PAY_QR" : "CASH",
    };
  }

  const paymentMethod = String(body.payment_method || "");
  if (paymentMethod === "CASH") {
    return { cashAmount: payableAmount, qrAmount: 0, totalAmount: payableAmount, paymentMethod: "CASH" };
  }
  if (paymentMethod === "PAY_QR") {
    return { cashAmount: 0, qrAmount: payableAmount, totalAmount: payableAmount, paymentMethod: "PAY_QR" };
  }
  return { error: "결제수단을 선택해주세요" };
}

export function paymentAllocationDetails(allocation: PaymentAllocation): string {
  const parts = [
    allocation.cashAmount > 0 ? `현금 ¥${allocation.cashAmount.toLocaleString()}` : "",
    allocation.qrAmount > 0 ? `QR ¥${allocation.qrAmount.toLocaleString()}` : "",
  ].filter(Boolean);
  return parts.join(" / ") || "결제금액 없음";
}

export function paymentAllocationStatements(
  db: D1Database,
  orderId: string,
  businessDate: string,
  staffId: string | null,
  allocation: PaymentAllocation
): D1PreparedStatement[] {
  const statements = [
    db.prepare("DELETE FROM luggage_order_payments WHERE order_id = ?").bind(orderId),
  ];
  if (allocation.cashAmount > 0) {
    statements.push(
      db.prepare(
        `INSERT INTO luggage_order_payments (order_id, business_date, tender_type, amount, staff_id)
         VALUES (?, ?, 'CASH', ?, ?)`
      ).bind(orderId, businessDate, allocation.cashAmount, staffId)
    );
  }
  if (allocation.qrAmount > 0) {
    statements.push(
      db.prepare(
        `INSERT INTO luggage_order_payments (order_id, business_date, tender_type, amount, staff_id)
         VALUES (?, ?, 'PAY_QR', ?, ?)`
      ).bind(orderId, businessDate, allocation.qrAmount, staffId)
    );
  }
  return statements;
}
