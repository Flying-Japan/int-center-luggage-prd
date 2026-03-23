/**
 * Internationalization system supporting Korean (default), English, Japanese.
 * Ported from Python: app/i18n.py
 */

export const SUPPORTED_LANGS = ["ko", "en", "ja"] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];
export const DEFAULT_LANG: Lang = "ko";

type TranslationKeys = {
  // Form labels
  name: string;
  phone: string;
  companion_count: string;
  suitcase_qty: string;
  backpack_qty: string;
  expected_pickup: string;
  consent_label: string;
  submit: string;

  // Images
  id_image: string;
  luggage_image: string;
  file_select: string;
  file_optimized: string;

  // Payment
  payment_method_label: string;
  payment_method_pay_qr: string;
  payment_method_cash: string;

  // Pricing
  price_preview: string;
  expected_storage_days: string;
  price_per_day: string;
  discount_rate: string;
  prepaid_amount: string;
  set_discount_note: string;

  // Status
  reception_complete_badge: string;
  order_id_label: string;
  pickup_note: string;
  upload_error: string;
  pickup_late_warning: string;

  // Page titles
  page_title: string;
  success_title: string;

  // Footer
  brand_name: string;
  footer_company: string;
  footer_address: string;
  footer_phone: string;
  copyright: string;

  // Flying Pass
  flying_pass_label: string;
  flying_pass_none: string;

  // Misc
  loading: string;
  error: string;
  required: string;
};

const TRANSLATIONS: Record<Lang, TranslationKeys> = {
  ko: {
    name: "이름",
    phone: "연락처",
    companion_count: "동행 인원",
    suitcase_qty: "캐리어 수량",
    backpack_qty: "배낭/가방 수량",
    expected_pickup: "수령 예정 일시",
    consent_label: "개인정보 수집 및 이용에 동의합니다",
    submit: "접수하기",
    id_image: "신분증 사진",
    luggage_image: "짐 사진",
    file_select: "파일 선택",
    file_optimized: "최적화됨",
    payment_method_label: "결제 방법",
    payment_method_pay_qr: "QR결제",
    payment_method_cash: "현금",
    price_preview: "예상 요금",
    expected_storage_days: "예상 보관일",
    price_per_day: "1일 요금",
    discount_rate: "장기 할인",
    prepaid_amount: "선결제 금액",
    set_discount_note: "캐리어+배낭 세트 할인 자동 적용",
    reception_complete_badge: "접수 완료",
    order_id_label: "접수 번호",
    pickup_note: "영업시간: 09:00~21:00 (JST)",
    upload_error: "업로드 실패",
    pickup_late_warning: "수령 지연 시 추가 요금이 발생합니다",
    page_title: "짐보관 접수",
    success_title: "접수가 완료되었습니다",
    brand_name: "플라잉재팬",
    footer_company: "주식회사 플라잉",
    footer_address: "大阪府大阪市中央区難波3-2-18 1F",
    footer_phone: "JP: +81 090-2254-1865 | KR: +82 070-8287-1455",
    copyright: "© Flying Inc.",
    flying_pass_label: "플라잉패스",
    flying_pass_none: "없음",
    loading: "로딩 중...",
    error: "오류가 발생했습니다",
    required: "필수 항목입니다",
  },
  en: {
    name: "Name",
    phone: "Phone",
    companion_count: "Companions",
    suitcase_qty: "Suitcases",
    backpack_qty: "Backpacks/Bags",
    expected_pickup: "Expected Pickup",
    consent_label: "I agree to the collection and use of personal information",
    submit: "Submit",
    id_image: "ID Photo",
    luggage_image: "Luggage Photo",
    file_select: "Choose File",
    file_optimized: "Optimized",
    payment_method_label: "Payment Method",
    payment_method_pay_qr: "QR Payment",
    payment_method_cash: "Cash",
    price_preview: "Estimated Price",
    expected_storage_days: "Storage Days",
    price_per_day: "Daily Rate",
    discount_rate: "Long-stay Discount",
    prepaid_amount: "Prepaid Amount",
    set_discount_note: "Suitcase + Backpack set discount auto-applied",
    reception_complete_badge: "Check-in Complete",
    order_id_label: "Order Number",
    pickup_note: "Business hours: 09:00-21:00 (JST)",
    upload_error: "Upload failed",
    pickup_late_warning: "Late pickup will incur additional charges",
    page_title: "Luggage Storage",
    success_title: "Check-in Complete",
    brand_name: "Flying Japan",
    footer_company: "Flying Inc.",
    footer_address: "1F, 3-2-18 Namba, Chuo-ku, Osaka 542-0076",
    footer_phone: "JP: +81 090-2254-1865 | KR: +82 070-8287-1455",
    copyright: "© Flying Inc.",
    flying_pass_label: "Flying Pass",
    flying_pass_none: "None",
    loading: "Loading...",
    error: "An error occurred",
    required: "Required",
  },
  ja: {
    name: "お名前",
    phone: "電話番号",
    companion_count: "同行人数",
    suitcase_qty: "スーツケース数",
    backpack_qty: "リュック・バッグ数",
    expected_pickup: "受取予定日時",
    consent_label: "個人情報の収集・利用に同意します",
    submit: "申し込む",
    id_image: "身分証写真",
    luggage_image: "荷物写真",
    file_select: "ファイル選択",
    file_optimized: "最適化済み",
    payment_method_label: "お支払い方法",
    payment_method_pay_qr: "QR決済",
    payment_method_cash: "現金",
    price_preview: "見積もり",
    expected_storage_days: "保管日数",
    price_per_day: "1日料金",
    discount_rate: "長期割引",
    prepaid_amount: "前払い金額",
    set_discount_note: "スーツケース＋リュックのセット割引自動適用",
    reception_complete_badge: "受付完了",
    order_id_label: "受付番号",
    pickup_note: "営業時間: 09:00〜21:00 (JST)",
    upload_error: "アップロード失敗",
    pickup_late_warning: "受取遅延の場合、追加料金が発生します",
    page_title: "荷物預かり",
    success_title: "受付が完了しました",
    brand_name: "フライングジャパン",
    footer_company: "株式会社フライング",
    footer_address: "大阪府大阪市中央区難波3-2-18 1F",
    footer_phone: "JP: +81 090-2254-1865 | KR: +82 070-8287-1455",
    copyright: "© Flying Inc.",
    flying_pass_label: "フライングパス",
    flying_pass_none: "なし",
    loading: "読み込み中...",
    error: "エラーが発生しました",
    required: "必須項目です",
  },
};

/**
 * Get a translation for a given key and language.
 */
export function t(key: keyof TranslationKeys, lang: Lang = DEFAULT_LANG): string {
  return TRANSLATIONS[lang]?.[key] ?? TRANSLATIONS[DEFAULT_LANG][key] ?? key;
}

/**
 * Get all translations for a language.
 */
export function getTranslations(lang: Lang = DEFAULT_LANG): TranslationKeys {
  return TRANSLATIONS[lang] ?? TRANSLATIONS[DEFAULT_LANG];
}

/**
 * Normalize and validate language from query param or fallback.
 */
export function normalizeLang(raw: string | null | undefined): Lang {
  if (!raw) return DEFAULT_LANG;
  const lower = raw.trim().toLowerCase();
  if (SUPPORTED_LANGS.includes(lower as Lang)) return lower as Lang;
  return DEFAULT_LANG;
}
