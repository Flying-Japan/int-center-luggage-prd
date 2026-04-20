export type CashClosingStatusInput = {
  closingType?: string | null;
  finalCount?: number | null;
  morningCount?: number | null;
};

export function hasMissingFinalClose(status: CashClosingStatusInput): boolean {
  return (status.finalCount ?? 0) === 0 && (status.morningCount ?? 0) > 0;
}

export function shouldIncludeClosingInStats(status: CashClosingStatusInput): boolean {
  return status.closingType === "FINAL_CLOSE";
}
