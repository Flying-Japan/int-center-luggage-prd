export type SalesHolidayFlags = {
  isWeekend: boolean;
  jp: string | null;
  kr: string | null;
};

const JP_HOLIDAYS: Record<string, string> = {
  "01-01": "元日", "01-12": "成人の日", "02-11": "建国記念の日", "02-23": "天皇誕生日",
  "03-20": "春分の日", "04-29": "昭和の日", "05-03": "憲法記念日", "05-04": "みどりの日",
  "05-05": "こどもの日", "05-06": "振替休日", "07-20": "海の日", "08-11": "山の日",
  "09-21": "敬老の日", "09-23": "秋分の日", "10-12": "スポーツの日", "11-03": "文化の日",
  "11-23": "勤労感謝の日",
};

const KR_HOLIDAYS: Record<string, string> = {
  "01-01": "신정", "03-01": "삼일절", "05-05": "어린이날", "06-06": "현충일",
  "08-15": "광복절", "10-03": "개천절", "10-09": "한글날", "12-25": "성탄절",
  "2025-01-28": "설날", "2025-01-29": "설날", "2025-01-30": "설날",
  "2025-05-06": "석가탄신일",
  "2025-10-05": "추석", "2025-10-06": "추석", "2025-10-07": "추석", "2025-10-08": "대체휴일",
  "2026-02-16": "설날", "2026-02-17": "설날", "2026-02-18": "설날",
  "2026-05-24": "석가탄신일",
  "2026-09-24": "추석", "2026-09-25": "추석", "2026-09-26": "추석",
};

export const JST_DOW_JP = ["日", "月", "火", "水", "木", "金", "土"];

export function getSalesHolidayFlags(date: string): SalesHolidayFlags {
  const dayOfWeek = new Date(`${date}T12:00:00Z`).getUTCDay();
  const mmdd = date.slice(5);
  return {
    isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
    jp: JP_HOLIDAYS[mmdd] ?? null,
    kr: KR_HOLIDAYS[date] ?? KR_HOLIDAYS[mmdd] ?? null,
  };
}
