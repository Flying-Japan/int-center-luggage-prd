export const inputControlCopy = {
  ko: { camera: '짐 사진 촬영', cameraInput: '촬영한 짐 사진', today: '오늘', choose: '선택', dateHelp: '오늘 수령이 기본값입니다. 다른 날 수령할 때만 변경해주세요.' },
  en: { camera: 'Take luggage photo', cameraInput: 'Captured luggage photo', today: 'Today', choose: 'Select', dateHelp: 'Today is selected by default. Change it only if you will pick up on another day.' },
  ja: { camera: '手荷物を撮影', cameraInput: '撮影した手荷物写真', today: '今日', choose: '選択', dateHelp: '本日受取が初期設定です。別日に受け取る場合のみ変更してください。' },
} as const;
export type ControlLocale = keyof typeof inputControlCopy;
export const tokyoDay = (now = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(now);
export function pickupDateLabel(value: string, locale: ControlLocale, now = new Date()) {
  const copy = inputControlCopy[locale];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return copy.choose;
  const date = new Date(`${value}T12:00:00+09:00`);
  if (!Number.isFinite(date.getTime()) || tokyoDay(date) !== value) return copy.choose;
  if (value === tokyoDay(now)) return copy.today;
  return new Intl.DateTimeFormat({ ko: 'ko-KR', en: 'en-US', ja: 'ja-JP' }[locale], { month: 'long', day: 'numeric', timeZone: 'Asia/Tokyo' }).format(date);
}
