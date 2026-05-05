/**
 * Korean label helpers for enum values displayed in UI.
 */

export function displayPaymentMethod(method: string | null): string {
  if (method === null) return "-";
  switch (method) {
    case "PAY_QR": return "QR결제";
    case "CASH": return "현금";
    case "MIXED": return "분할결제";
    default: return method;
  }
}

export function displayFlyingPassTier(tier: string): string {
  switch (tier) {
    case "NONE": return "미적용";
    case "BLUE": return "블루";
    case "SILVER": return "실버";
    case "GOLD": return "골드";
    case "PLATINUM": return "플래티넘";
    case "BLACK": return "블랙";
    default: return tier;
  }
}

export function displayOrderStatus(status: string): string {
  switch (status) {
    case "PAYMENT_PENDING": return "결제대기";
    case "PAID": return "결제완료";
    case "PICKED_UP": return "수령완료";
    case "CANCELLED": return "취소";
    default: return status;
  }
}

export function displayLostFoundStatus(status: string): string {
  switch (status) {
    case "UNCLAIMED": return "보관중";
    case "CLAIMED": return "인계완료";
    case "DISPOSED": return "폐기";
    default: return status;
  }
}

export function displayNoteCategory(category: string): string {
  switch (category) {
    case "NOTICE": return "안내사항";
    case "HANDOVER": return "인수인계";
    default: return category;
  }
}

export function displayCashClosingType(type: string): string {
  switch (type) {
    case "MORNING_HANDOVER": return "오전 인수인계";
    case "FINAL_CLOSE": return "최종 마감";
    default: return type;
  }
}

export function displayCashClosingStatus(status: string): string {
  switch (status) {
    case "DRAFT": return "작성중";
    case "SUBMITTED": return "제출됨";
    case "LOCKED": return "확인완료(잠금)";
    default: return status;
  }
}
