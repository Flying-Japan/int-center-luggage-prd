/**
 * Completion message subsystem.
 * Ported from Python: app/services/completion_messages.py
 *
 * Provides default KO/EN/JA primary and secondary success messages
 * and loads per-language overrides from luggage_app_settings.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUCCESS_PRIMARY_MESSAGE_KEYS: Record<string, string> = {
  ko: "customer_success_primary_message_ko",
  en: "customer_success_primary_message_en",
  ja: "customer_success_primary_message_ja",
};

const SUCCESS_SECONDARY_MESSAGE_KEYS: Record<string, string> = {
  ko: "customer_success_secondary_message_ko",
  en: "customer_success_secondary_message_en",
  ja: "customer_success_secondary_message_ja",
};

export const DEFAULT_SUCCESS_PRIMARY_MESSAGES: Record<string, string> = {
  ko: "짐보관신청서 작성이 완료 되었습니다.\n{amount} 금액 준비 해주시면, 순차적으로 성함 불러드리겠습니다.",
  en: "Your luggage storage form has been completed.\nPlease prepare {amount}. We will call your name in order.",
  ja: "手荷物保管申込書の作成が完了しました。\n{amount}をご用意ください。順番にお名前をお呼びします。",
};

export const DEFAULT_SUCCESS_SECONDARY_MESSAGES: Record<string, string> = {
  ko: "플라잉재팬만의 혜택\n오사카 맛집 제휴할인되는 플라잉 화이트패스 증정!\n이건물 드럭스토어 에디온에서 플라잉패스 제시만 해도 최대 17% 할인되고,\n뒷면 QR코드로 오사카 제휴 맛집 리스트와 혜택도 확인 가능합니다!",
  en: "Flying Japan Exclusive Benefits\nReceive the Flying White Pass with partner discounts at Osaka restaurants!\nShow the Flying Pass at EDION (drugstore in this building) for up to 17% off,\nand scan the QR code on the back to check Osaka partner restaurant lists and benefits!",
  ja: "フライングジャパン限定特典\n大阪の提携飲食店で割引が受けられるフライングホワイトパスをプレゼント！\nこの建物内のドラッグストア・エディオンでフライングパスを提示すると最大17%割引、\n裏面QRコードで大阪の提携飲食店リストと特典も確認できます！",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompletionMessages {
  primary: Record<string, string>;
  secondary: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Replace {amount} placeholder with the provided amount string.
 */
export function applyAmountTemplate(text: string, amount: string): string {
  return text.replace(/\{amount\}/g, amount);
}

/**
 * Load completion messages from luggage_app_settings.
 * Falls back to defaults for any missing keys.
 */
export async function loadCompletionMessages(db: D1Database): Promise<CompletionMessages> {
  // Collect all setting keys we need
  const allKeys = [
    ...Object.values(SUCCESS_PRIMARY_MESSAGE_KEYS),
    ...Object.values(SUCCESS_SECONDARY_MESSAGE_KEYS),
  ];

  // Fetch all relevant settings in one query
  const placeholders = allKeys.map(() => "?").join(", ");
  const rows = await db
    .prepare(`SELECT setting_key, setting_value FROM luggage_app_settings WHERE setting_key IN (${placeholders})`)
    .bind(...allKeys)
    .all<{ setting_key: string; setting_value: string | null }>();

  const settingsMap = new Map<string, string>();
  for (const row of rows.results) {
    if (row.setting_value !== null && row.setting_value.trim() !== "") {
      settingsMap.set(row.setting_key, row.setting_value);
    }
  }

  const primary: Record<string, string> = {};
  const secondary: Record<string, string> = {};

  for (const lang of ["ko", "en", "ja"]) {
    primary[lang] = settingsMap.get(SUCCESS_PRIMARY_MESSAGE_KEYS[lang]) ?? DEFAULT_SUCCESS_PRIMARY_MESSAGES[lang];
    secondary[lang] = settingsMap.get(SUCCESS_SECONDARY_MESSAGE_KEYS[lang]) ?? DEFAULT_SUCCESS_SECONDARY_MESSAGES[lang];
  }

  return { primary, secondary };
}
