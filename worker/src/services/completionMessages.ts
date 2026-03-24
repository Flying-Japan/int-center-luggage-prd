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
  ko: "짐보관신청서 작성이 완료 되었습니다.\n접수 된 순서대로 성함을 불러드리겠습니다.\n{amount} 금액 준비 해주시면 감사하겠습니다.\n(정확한 금액은 변동 될 수 있음)",
  en: "Your luggage storage form has been completed.\nWe will call your name in the order received.\nPlease prepare {amount}.\n(The exact amount may vary.)",
  ja: "手荷物保管申込書の作成が完了しました。\n受付順にお名前をお呼びします。\n{amount}をご用意ください。\n（正確な金額は変動する場合があります。）",
};

export const DEFAULT_SUCCESS_SECONDARY_MESSAGES: Record<string, string> = {
  ko: "플라잉재팬만의 혜택\n오사카 맛집 제휴할인되는 플라잉 화이트패스 증정!\n이건물 드럭스토어 에디온에서 플라잉패스 제시만 해도 최대 17% 할인되고,\n뒷면 QR코드로 오사카 제휴 맛집 리스트와 혜택도 확인 가능합니다!",
  en: "Flying Japan Exclusive Benefits\nReceive the Flying White Pass with partner discounts at Osaka restaurants!\nShow the Flying Pass at EDION (drugstore in this building) for up to 17% off,\nand scan the QR code on the back to check Osaka partner restaurant lists and benefits!",
  ja: "フライングジャパン限定特典\n大阪の提携飲食店で割引が受けられるフライングホワイトパスをプレゼント！\nこの建物内のドラッグストア・エディオンでフライングパスを提示すると最大17%割引、\n裏面QRコードで大阪の提携飲食店リストと特典も確認できます！",
};

// ---------------------------------------------------------------------------
// Canonical line translations (Korean → EN/JA)
// ---------------------------------------------------------------------------

const COMPLETION_LINE_TRANSLATIONS: Record<string, Record<string, string>> = {
  "짐보관신청서 작성이 완료 되었습니다.": {
    en: "Your luggage storage form has been completed.",
    ja: "手荷物保管申込書の作成が完了しました。",
  },
  "{amount} 금액 준비 해주시면, 순차적으로 성함 불러드리겠습니다.": {
    en: "Please prepare {amount}. We will call your name in order.",
    ja: "{amount}をご用意ください。順番にお名前をお呼びします。",
  },
  "플라잉재팬만의 혜택": {
    en: "Flying Japan Exclusive Benefits",
    ja: "フライングジャパン限定特典",
  },
  "오사카 맛집 제휴할인되는 플라잉 화이트패스 증정!": {
    en: "Receive the Flying White Pass with partner discounts at Osaka restaurants!",
    ja: "大阪の提携飲食店で割引が受けられるフライングホワイトパスをプレゼント！",
  },
  "이건물 드럭스토어 에디온에서 플라잉패스 제시만 해도 최대 17% 할인되고,": {
    en: "Show the Flying Pass at EDION (drugstore in this building) for up to 17% off,",
    ja: "この建物内のドラッグストア・エディオンでフライングパスを提示すると最大17%割引、",
  },
  "뒷면 QR코드로 오사카 제휴 맛집 리스트와 혜택도 확인 가능합니다!": {
    en: "and scan the QR code on the back to check Osaka partner restaurant lists and benefits!",
    ja: "裏面QRコードで大阪の提携飲食店リストと特典も確認できます！",
  },
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

// ---------------------------------------------------------------------------
// Auto-translation helpers
// ---------------------------------------------------------------------------

/**
 * Normalize line breaks and fix common {amount} variants.
 */
export function normalizeCompletionText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\{ *amount *\}/gi, "{amount}")
    .trim();
}

/**
 * Translate a single line via Google Translate free API.
 * Preserves {amount} placeholder using a token swap.
 */
async function translateViaApi(text: string, targetLang: string): Promise<string> {
  const placeholder = "ZXQAMOUNTTOKENQXZ";
  const query = text.replace(/\{amount\}/g, placeholder);
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=ko&tl=${targetLang}&dt=t&q=${encodeURIComponent(query)}`;
  try {
    const resp = await fetch(url);
    const data = (await resp.json()) as unknown;
    if (!Array.isArray(data) || !data[0]) return "";
    const translated = (data[0] as unknown[])
      .map((s: unknown) => (Array.isArray(s) ? (s[0] as string) || "" : ""))
      .join("")
      .trim();
    const result = translated.replace(new RegExp(placeholder, "gi"), "{amount}");
    if (text.includes("{amount}") && !result.includes("{amount}")) return "";
    return result;
  } catch {
    return "";
  }
}

/**
 * Translate Korean text to EN or JA, line-by-line.
 * Tries canonical lookup first, falls back to Google Translate API.
 */
export async function autoTranslateCompletionText(
  koText: string,
  lang: "en" | "ja",
): Promise<string> {
  const lines = koText.split("\n");
  const translated: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      translated.push("");
      continue;
    }

    // Canonical lookup
    const canonical = COMPLETION_LINE_TRANSLATIONS[trimmed];
    if (canonical?.[lang]) {
      translated.push(canonical[lang]);
      continue;
    }

    // Fallback to Google Translate API
    const apiResult = await translateViaApi(trimmed, lang);
    translated.push(apiResult || trimmed);
  }

  return translated.join("\n");
}

/**
 * Generate all 6 completion messages (KO/EN/JA x primary/secondary)
 * from Korean input only.
 */
export async function buildCompletionMessagesFromKo(
  koPrimary: string,
  koSecondary: string,
): Promise<CompletionMessages> {
  const normPrimary = normalizeCompletionText(koPrimary);
  const normSecondary = normalizeCompletionText(koSecondary);

  const [enPrimary, jaPrimary, enSecondary, jaSecondary] = await Promise.all([
    autoTranslateCompletionText(normPrimary, "en"),
    autoTranslateCompletionText(normPrimary, "ja"),
    autoTranslateCompletionText(normSecondary, "en"),
    autoTranslateCompletionText(normSecondary, "ja"),
  ]);

  return {
    primary: { ko: normPrimary, en: enPrimary, ja: jaPrimary },
    secondary: { ko: normSecondary, en: enSecondary, ja: jaSecondary },
  };
}
