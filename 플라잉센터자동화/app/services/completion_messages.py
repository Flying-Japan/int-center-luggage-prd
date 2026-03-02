"""Completion message subsystem: constants, normalization, translation, and loading."""
from __future__ import annotations

import json
import re
from typing import Optional
from urllib.parse import urlencode
from urllib.request import Request as URLRequest, urlopen

from app.supabase_client import SupabaseDB


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SUCCESS_PRIMARY_MESSAGE_KEYS = {
    "ko": "customer_success_primary_message_ko",
    "en": "customer_success_primary_message_en",
    "ja": "customer_success_primary_message_ja",
}
SUCCESS_SECONDARY_MESSAGE_KEYS = {
    "ko": "customer_success_secondary_message_ko",
    "en": "customer_success_secondary_message_en",
    "ja": "customer_success_secondary_message_ja",
}
DEFAULT_SUCCESS_PRIMARY_MESSAGES = {
    "ko": (
        "짐보관신청서 작성이 완료 되었습니다.\n"
        "{amount} 금액 준비 해주시면, 순차적으로 성함 불러드리겠습니다."
    ),
    "en": (
        "Your luggage storage form has been completed.\n"
        "Please prepare {amount}. We will call your name in order."
    ),
    "ja": (
        "手荷物保管申込書の作成が完了しました。\n"
        "{amount}をご用意ください。順番にお名前をお呼びします。"
    ),
}
DEFAULT_SUCCESS_SECONDARY_MESSAGES = {
    "ko": (
        "플라잉재팬만의 혜택\n"
        "오사카 맛집 제휴할인되는 플라잉 화이트패스 증정!\n"
        "이건물 드럭스토어 에디온에서 플라잉패스 제시만 해도 최대 17% 할인되고,\n"
        "뒷면 QR코드로 오사카 제휴 맛집 리스트와 혜택도 확인 가능합니다!"
    ),
    "en": (
        "Flying Japan Exclusive Benefits\n"
        "Receive the Flying White Pass with partner discounts at Osaka restaurants!\n"
        "Show the Flying Pass at EDION (drugstore in this building) for up to 17% off,\n"
        "and scan the QR code on the back to check Osaka partner restaurant lists and benefits!"
    ),
    "ja": (
        "フライングジャパン限定特典\n"
        "大阪の提携飲食店で割引が受けられるフライングホワイトパスをプレゼント！\n"
        "この建物内のドラッグストア・エディオンでフライングパスを提示すると最大17%割引、\n"
        "裏面QRコードで大阪の提携飲食店リストと特典も確認できます！"
    ),
}

HANGUL_RE = re.compile(r"[가-힣]")

COMPLETION_LINE_TRANSLATIONS = {
    "짐보관신청서 작성이 완료 되었습니다.": {
        "en": "Your luggage storage form has been completed.",
        "ja": "手荷物保管申込書の作成が完了しました。",
    },
    "{amount} 금액 준비 해주시면, 순차적으로 성함 불러드리겠습니다.": {
        "en": "Please prepare {amount}. We will call your name in order.",
        "ja": "{amount}をご用意ください。順番にお名前をお呼びします。",
    },
    "플라잉재팬만의 혜택": {
        "en": "Flying Japan Exclusive Benefits",
        "ja": "フライングジャパン限定特典",
    },
    "오사카 맛집 제휴할인되는 플라잉 화이트패스 증정!": {
        "en": "Receive the Flying White Pass with partner discounts at Osaka restaurants!",
        "ja": "大阪の提携飲食店で割引が受けられるフライングホワイトパスをプレゼント！",
    },
    "이건물 드럭스토어 에디온에서 플라잉패스 제시만 해도 최대 17% 할인되고,": {
        "en": "Show the Flying Pass at EDION (drugstore in this building) for up to 17% off,",
        "ja": "この建物内のドラッグストア・エディオンでフライングパスを提示すると最大17%割引、",
    },
    "뒷면 QR코드로 오사카 제휴 맛집 리스트와 혜택도 확인 가능합니다!": {
        "en": "and scan the QR code on the back to check Osaka partner restaurant lists and benefits!",
        "ja": "裏面QRコードで大阪の提携飲食店リストと特典も確認できます！",
    },
}

COMPLETION_LINE_PATTERNS = (
    (re.compile(r"작성.*완료"), "짐보관신청서 작성이 완료 되었습니다."),
    (
        re.compile(r"\{amount\}.*(금액|결제|준비).*(불러|호명|호출|이름)"),
        "{amount} 금액 준비 해주시면, 순차적으로 성함 불러드리겠습니다.",
    ),
    (re.compile(r"플라잉재팬.*혜택"), "플라잉재팬만의 혜택"),
    (
        re.compile(r"화이트패스.*증정"),
        "오사카 맛집 제휴할인되는 플라잉 화이트패스 증정!",
    ),
    (
        re.compile(r"(에디온|edion).*(17%|17 %|최대)", flags=re.IGNORECASE),
        "이건물 드럭스토어 에디온에서 플라잉패스 제시만 해도 최대 17% 할인되고,",
    ),
    (
        re.compile(r"(qr|QR).*혜택", flags=re.IGNORECASE),
        "뒷면 QR코드로 오사카 제휴 맛집 리스트와 혜택도 확인 가능합니다!",
    ),
)


# ---------------------------------------------------------------------------
# Functions
# ---------------------------------------------------------------------------

def normalize_completion_message_text(text: str) -> str:
    normalized = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    normalized = normalized.replace("ㅇㅇㅇㅇ", "{amount}")
    normalized = normalized.replace("{ amount }", "{amount}")
    normalized = normalized.replace("{{amount}}", "{amount}")
    normalized = normalized.replace("{amount}금액", "{amount} 금액")
    lines = [line.strip() for line in normalized.split("\n") if line.strip()]
    return "\n".join(lines)


def contains_hangul(text: str) -> bool:
    return bool(HANGUL_RE.search(text or ""))


def canonical_completion_line(source_line: str) -> Optional[str]:
    if source_line in COMPLETION_LINE_TRANSLATIONS:
        return source_line
    for pattern, canonical_line in COMPLETION_LINE_PATTERNS:
        if pattern.search(source_line):
            return canonical_line
    return None


def translate_completion_line_via_api(source_line: str, lang: str) -> str:
    if lang not in ("en", "ja") or not source_line.strip():
        return ""

    placeholder_token = "ZXQAMOUNTTOKENQXZ"
    query_text = source_line.replace("{amount}", placeholder_token)
    translate_url = "https://translate.googleapis.com/translate_a/single?" + urlencode(
        {
            "client": "gtx",
            "sl": "ko",
            "tl": lang,
            "dt": "t",
            "q": query_text,
        }
    )
    try:
        request = URLRequest(translate_url, headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(request, timeout=3) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:
        return ""

    if not isinstance(payload, list) or not payload:
        return ""
    segments = payload[0]
    translated_text = "".join(
        segment[0]
        for segment in segments
        if isinstance(segment, list) and segment and isinstance(segment[0], str)
    ).strip()
    if not translated_text:
        return ""

    translated_text = re.sub(placeholder_token, "{amount}", translated_text, flags=re.IGNORECASE)
    if "{amount}" in source_line and "{amount}" not in translated_text:
        return ""
    return translated_text


def auto_translate_completion_text(ko_text: str, lang: str) -> str:
    if lang == "ko":
        return ko_text

    translated_lines: list[str] = []
    for source_line in [line.strip() for line in ko_text.split("\n") if line.strip()]:
        translated_line = ""
        canonical_line = canonical_completion_line(source_line)
        if canonical_line:
            translated_line = COMPLETION_LINE_TRANSLATIONS.get(canonical_line, {}).get(lang, "")

        if (not translated_line or contains_hangul(translated_line)) and contains_hangul(source_line):
            translated_from_api = translate_completion_line_via_api(source_line, lang)
            if translated_from_api:
                translated_line = translated_from_api

        translated_lines.append(translated_line if translated_line else source_line)
    return "\n".join(translated_lines)


def build_completion_messages_from_ko(
    ko_primary: str,
    ko_secondary: str,
) -> dict[str, dict[str, str]]:
    normalized_primary = normalize_completion_message_text(ko_primary)
    normalized_secondary = normalize_completion_message_text(ko_secondary)
    if not normalized_primary:
        normalized_primary = DEFAULT_SUCCESS_PRIMARY_MESSAGES["ko"]
    if not normalized_secondary:
        normalized_secondary = DEFAULT_SUCCESS_SECONDARY_MESSAGES["ko"]

    return {
        "primary": {
            "ko": normalized_primary,
            "en": auto_translate_completion_text(normalized_primary, "en"),
            "ja": auto_translate_completion_text(normalized_primary, "ja"),
        },
        "secondary": {
            "ko": normalized_secondary,
            "en": auto_translate_completion_text(normalized_secondary, "en"),
            "ja": auto_translate_completion_text(normalized_secondary, "ja"),
        },
    }


def load_completion_messages(db: SupabaseDB) -> dict[str, dict[str, str]]:
    # Import here to avoid circular dependency (get_app_setting lives in main.py for now)
    from app.main import get_app_setting

    ko_primary = get_app_setting(
        db,
        SUCCESS_PRIMARY_MESSAGE_KEYS["ko"],
        DEFAULT_SUCCESS_PRIMARY_MESSAGES["ko"],
    )
    ko_secondary = get_app_setting(
        db,
        SUCCESS_SECONDARY_MESSAGE_KEYS["ko"],
        DEFAULT_SUCCESS_SECONDARY_MESSAGES["ko"],
    )
    auto_messages = build_completion_messages_from_ko(ko_primary, ko_secondary)

    resolved_primary: dict[str, str] = {}
    resolved_secondary: dict[str, str] = {}
    for lang_code in ("ko", "en", "ja"):
        resolved_primary[lang_code] = get_app_setting(
            db,
            SUCCESS_PRIMARY_MESSAGE_KEYS[lang_code],
            auto_messages["primary"][lang_code],
        )
        resolved_secondary[lang_code] = get_app_setting(
            db,
            SUCCESS_SECONDARY_MESSAGE_KEYS[lang_code],
            auto_messages["secondary"][lang_code],
        )
    return {
        "primary": resolved_primary,
        "secondary": resolved_secondary,
    }
