export const EXPERIENCE_PRODUCT_GROUPS = [
  "에어랩", "에어스트레이트", "트라이크", "싸이벡스", "보조배터리", "밴드",
  "지팡이", "키즈트래블", "머리띠", "폴라로이드 카메라", "풀리오",
] as const;

export type ExperienceRental = {
  product_group: string;
  quantity: number;
  start_date: string;
  end_date: string;
};

export function isISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "0001-01-01") return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Repeated form fields preserve row alignment without interpreting benefit text.
export function parseExperienceRentals(body: Record<string, unknown>): ExperienceRental[] {
  const fields = ["rental_group", "rental_quantity", "rental_start", "rental_end"];
  const columns = fields.map((field) => {
    const value = body[field];
    return value === undefined ? [] : Array.isArray(value) ? value : [value];
  });
  if (columns.some((column) => column.length !== columns[0].length)) {
    throw new Error("렌탈 항목의 상품, 수량, 대여 시작일, 반납일을 모두 입력해 주세요.");
  }
  return columns[0].map((_, index) => {
    const [group, quantity, start, end] = columns.map((column) => column[index]);
    if (typeof group !== "string" || !EXPERIENCE_PRODUCT_GROUPS.some((allowed) => allowed === group)) {
      throw new Error("허용되지 않은 렌탈 상품입니다.");
    }
    if (typeof quantity !== "string" || !/^\d+$/.test(quantity) || !Number.isSafeInteger(Number(quantity)) || Number(quantity) <= 0) {
      throw new Error("렌탈 수량은 1 이상의 정수여야 합니다.");
    }
    if (typeof start !== "string" || typeof end !== "string" || !isISODate(start) || !isISODate(end) || end < start) {
      throw new Error("렌탈 날짜는 YYYY-MM-DD 형식이어야 하며 반납일은 대여 시작일 이후여야 합니다.");
    }
    return { product_group: group, quantity: Number(quantity), start_date: start, end_date: end };
  });
}

export function validateOccupancyRange(start: string, end: string): boolean {
  return isISODate(start) && isISODate(end) && end >= start
    && (Date.parse(end) - Date.parse(start)) / 86_400_000 < 93;
}

// Must run in the same D1 batch (single transaction) right after the parent
// visit INSERT when visitId is omitted.
export function insertExperienceRentals(db: D1Database, rentals: ExperienceRental[], visitId?: string) {
  // last_insert_rowid() changes after every inserted rental row, so capture it
  // once in a MATERIALIZED CTE; otherwise the 2nd+ rentals would reference the
  // previous rental's id instead of the new visit.
  const parent = visitId === undefined ? "last_insert_rowid()" : "CAST(? AS INTEGER)";
  const query = db.prepare(`WITH parent AS MATERIALIZED (SELECT ${parent} AS id)
    INSERT INTO luggage_experience_rentals
    (visit_id, product_group, quantity, start_date, end_date)
    SELECT parent.id, json_extract(value, '$.product_group'), json_extract(value, '$.quantity'),
      json_extract(value, '$.start_date'), json_extract(value, '$.end_date')
    FROM parent, json_each(?)`);
  return visitId === undefined ? query.bind(JSON.stringify(rentals)) : query.bind(visitId, JSON.stringify(rentals));
}

export async function readExperienceOccupancy(db: D1Database, start: string, end: string) {
  // Expand only the bounded requested dates, even for long rentals. Aggregate in
  // D1 and project only stock data; no visitor fields enter this response.
  const result = await db.prepare(`WITH RECURSIVE days(day) AS (
      SELECT ? UNION ALL SELECT date(day, '+1 day') FROM days WHERE day < ?
    )
    SELECT days.day AS date, r.product_group AS "group", SUM(r.quantity) AS quantity
    FROM luggage_experience_rentals r
    JOIN luggage_experience_visits v ON v.visit_id = r.visit_id
    JOIN days ON days.day BETWEEN r.start_date AND r.end_date
    WHERE r.start_date <= ? AND r.end_date >= ?
      AND v.status IN ('SCHEDULED', 'VISITED', 'RECEIVED')
    GROUP BY days.day, r.product_group ORDER BY days.day, r.product_group
  `).bind(start, end, end, start).all<{ date: string; group: string; quantity: number }>();
  return result.results.map(({ date, group, quantity }) => ({ date, group, quantity }));
}
