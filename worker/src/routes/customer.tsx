import { Hono } from "hono";
import type { AppType } from "../types";
import { t, normalizeLang } from "../lib/i18n";
import { FLYING_PASS_TIERS, type FlyingPassTier } from "../services/pricing";
import { loadCompletionMessages, applyAmountTemplate } from "../services/completionMessages";
import { uploadImage, buildImageKey, extFromContentType, validateImageUpload } from "../lib/r2";
import {
  calculatePricePerDay,
  calculatePrepaidAmount,
  normalizeFlyingPassTier,
  flyingPassDiscountAmount,
} from "../services/pricing";
import { calculateStorageDays } from "../services/storage";
import { buildOrderId, buildTagNo } from "../services/orderNumber";

const customer = new Hono<AppType>();

// ---------------------------------------------------------------------------
// GET /customer — Intake form (faithful port of original FastAPI template)
// ---------------------------------------------------------------------------
customer.get("/customer", (c) => {
  const lang = normalizeLang(c.req.query("lang"));
  const error = c.req.query("error") || "";

  const MAX_BAG_QTY = 99;
  const MAX_COMPANION_COUNT = 99;

  /* ---- per-language labels not in i18n.ts ---- */
  const receiptLabel: Record<string, string> = {
    ko: "영수증 발급", en: "Receipt", ja: "領収書発行",
  };
  const customerTitle: Record<string, string> = {
    ko: "짐 보관 접수", en: "Luggage Storage Check-in", ja: "荷物預かり受付",
  };
  const receptionTitle: Record<string, string> = {
    ko: "보관 접수", en: "Storage Check-in", ja: "預かり受付",
  };
  const receptionDesc: Record<string, string> = {
    ko: "아래 양식을 작성해 주세요.", en: "Please fill in the form below.", ja: "以下のフォームにご記入ください。",
  };
  const idImageHint: Record<string, string> = {
    ko: "(여권 등 — 얼굴과 이름만 보이면 OK)", en: "(passport etc. — face & name visible is enough)", ja: "(パスポート等 — 顔と名前が見えればOK)",
  };
  const suitcaseHint: Record<string, string> = {
    ko: "기내용 포함 모든 캐리어", en: "All suitcases incl. carry-on", ja: "機内持込を含む全スーツケース",
  };
  const backpackHint: Record<string, string> = {
    ko: "배낭·에코백·보스턴백 등", en: "Backpacks, totes, boston bags, etc.", ja: "リュック・エコバッグ・ボストンバッグ等",
  };
  const bagCustomOption: Record<string, string> = {
    ko: "직접입력", en: "Custom", ja: "直接入力",
  };
  const bagCustomPlaceholder: Record<string, string> = {
    ko: "11 이상 입력", en: "Enter 11+", ja: "11以上入力",
  };
  const pickupDateLabel: Record<string, string> = {
    ko: "수령 예정 날짜", en: "Expected Pickup Date", ja: "受取予定日",
  };
  const pickupTimeLabel: Record<string, string> = {
    ko: "수령 예정 시간", en: "Expected Pickup Time", ja: "受取予定時間",
  };
  const pickupFlexNote: Record<string, string> = {
    ko: "수령 시간은 변경될 수 있으며, 영업시간(09:00~21:00) 내 수령 가능합니다.",
    en: "Pickup time may change. Collection is available during business hours (09:00-21:00).",
    ja: "受取時間は変更可能です。営業時間（09:00〜21:00）内に受け取りいただけます。",
  };
  const previewMetaDefault: Record<string, string> = {
    ko: "짐 수량과 수령일을 입력하면 예상 요금이 표시됩니다.",
    en: "Enter luggage quantity and pickup date to see estimated price.",
    ja: "荷物数量と受取日を入力すると見積もりが表示されます。",
  };
  const payQrNote: Record<string, string> = {
    ko: "카카오페이 · 네이버페이 · 토스페이 · PayPay · LINE Pay", en: "KakaoPay · NaverPay · TossPay · PayPay · LINE Pay", ja: "KakaoPay・NaverPay・TossPay・PayPay・LINE Pay",
  };
  const noCardWarning: Record<string, string> = {
    ko: "⚠️ 신용카드/체크카드 결제 불가", en: "⚠️ Credit/debit cards NOT accepted", ja: "⚠️ クレジットカード・デビットカード不可",
  };
  const companionCustomOption: Record<string, string> = {
    ko: "직접입력", en: "Custom", ja: "直接入力",
  };
  const companionCustomPlaceholder: Record<string, string> = {
    ko: "11 이상 입력", en: "Enter 11+", ja: "11以上入力",
  };
  const companionHint: Record<string, string> = {
    ko: "본인 포함", en: "Including yourself", ja: "ご本人を含む",
  };
  const noticeTitle: Record<string, string> = {
    ko: "유의사항 안내", en: "Important Notice", ja: "ご注意事項",
  };
  const fileNone: Record<string, string> = {
    ko: "선택된 파일 없음", en: "No file selected", ja: "ファイル未選択",
  };
  const photoRetention: Record<string, string> = {
    ko: "🔒 사진은 본인 확인용이며, 2주 후 자동 삭제됩니다.",
    en: "🔒 Photos are for ID verification only and auto-deleted after 2 weeks.",
    ja: "🔒 写真は本人確認用で、2週間後に自動削除されます。",
  };
  const mobileSubmitHint: Record<string, string> = {
    ko: "접수 후 직원이 안내해 드립니다.",
    en: "Staff will assist you after check-in.",
    ja: "受付後、スタッフがご案内いたします。",
  };
  const discountTableExpand: Record<string, string> = {
    ko: "장기 보관 할인표 보기", en: "View Long-stay Discount Table", ja: "長期保管割引表を見る",
  };
  const discountDays: Record<string, string> = {
    ko: "보관일수", en: "Storage Days", ja: "保管日数",
  };
  const discountRate: Record<string, string> = {
    ko: "할인율", en: "Discount", ja: "割引率",
  };
  const footerHours: Record<string, string> = {
    ko: "영업시간: 09:00~21:00", en: "Hours: 09:00-21:00", ja: "営業時間: 09:00〜21:00",
  };
  const footerCopyright: Record<string, string> = {
    ko: "© 2026 Flying Inc. All rights reserved.",
    en: "© 2026 Flying Inc. All rights reserved.",
    ja: "© 2026 Flying Inc. All rights reserved.",
  };
  const previewMetaEmpty: Record<string, string> = {
    ko: "짐 수량과 수령일을 입력해 주세요.",
    en: "Please enter luggage quantity and pickup date.",
    ja: "荷物数量と受取日を入力してください。",
  };
  const previewInvalidTitle: Record<string, string> = {
    ko: "입력 확인", en: "Check input", ja: "入力確認",
  };
  const previewInvalidMeta: Record<string, string> = {
    ko: "입력 값을 확인해 주세요.", en: "Please review your input values.", ja: "入力値をご確認ください。",
  };
  const previewErrorTitle: Record<string, string> = {
    ko: "계산 오류", en: "Calc error", ja: "計算エラー",
  };
  const previewErrorMeta: Record<string, string> = {
    ko: "네트워크를 확인 후 다시 시도해 주세요.", en: "Please check your network and try again.", ja: "ネットワークを確認して再試行してください。",
  };
  const pickupLateWarn: Record<string, string> = {
    ko: "21시 이후에는 추가 출동 수수료(¥8,000)가 발생합니다.", en: "After 9 PM, a dispatch fee (¥8,000) applies.", ja: "21時以降は出動手数料（¥8,000）が発生します。",
  };
  const previewResultMeta: Record<string, string> = {
    ko: "¥ {price_per_day}/일 · {days}일 · 할인 {discount}%",
    en: "¥ {price_per_day}/day · {days} days · discount {discount}%",
    ja: "¥ {price_per_day}/日 · {days}日 · 割引 {discount}%",
  };
  const uploadOptimizing: Record<string, string> = {
    ko: "사진 최적화 중...", en: "Optimizing photos for upload...", ja: "写真を最適化中...",
  };
  const uploadSubmitting: Record<string, string> = {
    ko: "접수 중... 잠시 기다려 주세요.", en: "Submitting... please wait.", ja: "送信中... しばらくお待ちください。",
  };
  const uploadErrorMsg: Record<string, string> = {
    ko: "업로드에 실패했습니다. 다시 시도해 주세요.", en: "Upload failed. Please try again.", ja: "アップロードに失敗しました。再試行してください。",
  };

  const qtyOptions = Array.from({ length: 11 }, (_, i) => i);
  const companionOptions = Array.from({ length: 10 }, (_, i) => i + 1);

  const discountTable = [
    { days: "7 ~ 13", rate: "5%" },
    { days: "14 ~ 29", rate: "10%" },
    { days: "30 ~ 59", rate: "15%" },
    { days: "60+", rate: "20%" },
  ];

  // Rental banners — shuffled randomly on each render
  const bannerDefs = [
    { emoji: "🎮", bg: "linear-gradient(135deg,#4285F4 0%,#1b6ec2 100%)", color: "#fff", tag: "USJ", url: "https://mkt.shopping.naver.com/link/6980349d41a1733726ec62aa",
      title: { ko: "유니버셜 스튜디오 가시나요?", en: "Going to Universal Studios?", ja: "USJに行きますか？" },
      sub: { ko: "마리오밴드 · 해리포터 지팡이 대여", en: "Mario Band & Wand rentals", ja: "マリオバンド・杖レンタル" },
      cta: { ko: "대여하기", en: "Rent now", ja: "レンタル" } },
    { emoji: "✨", bg: "linear-gradient(135deg,#ec4899 0%,#be185d 100%)", color: "#fff", tag: "HOT", url: "https://mkt.shopping.naver.com/link/6980349d92a45c3c29778596",
      title: { ko: "다이슨 에어랩 · 고데기", en: "Dyson Airwrap & Straightener", ja: "ダイソン エアラップ" },
      sub: { ko: "센터에서 바로 대여 가능!", en: "Available right at our center!", ja: "センターですぐレンタル！" },
      cta: { ko: "대여하기", en: "Rent now", ja: "レンタル" } },
    { emoji: "👶", bg: "linear-gradient(135deg,#22c55e 0%,#15803d 100%)", color: "#fff", tag: "NEW", url: "https://mkt.shopping.naver.com/link/68dce520772f4564fe84320a",
      title: { ko: "유모차 대여 가능!", en: "Stroller rentals!", ja: "ベビーカーレンタル！" },
      sub: { ko: "싸이벡스 · 트라이크 바로 대여", en: "Cybex & Trike at our center", ja: "サイベックス・トライク" },
      cta: { ko: "대여하기", en: "Rent now", ja: "レンタル" } },
  ];
  // Fisher-Yates shuffle
  for (let i = bannerDefs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bannerDefs[i], bannerDefs[j]] = [bannerDefs[j], bannerDefs[i]];
  }
  const rentalBanners = bannerDefs.map(b => (
    <a href={b.url} target="_blank" rel="noopener" style={`background:${b.bg};border:none;border-radius:var(--radius-md);padding:14px 16px;display:flex;align-items:center;gap:14px;margin:6px 0;text-decoration:none;color:${b.color};transition:transform .15s,box-shadow .15s;box-shadow:0 4px 14px rgba(0,0,0,0.12)`}>
      <span style="font-size:32px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.2))">{b.emoji}</span>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
          <span style="font-size:9px;font-weight:800;background:rgba(255,255,255,0.25);padding:2px 6px;border-radius:4px;letter-spacing:0.05em">{b.tag}</span>
          <p style="font-size:14px;font-weight:700;margin:0;line-height:1.2">{b.title[lang] || b.title.ko}</p>
        </div>
        <p style="font-size:11px;opacity:0.85;margin:0">{b.sub[lang] || b.sub.ko}</p>
      </div>
      <span style="font-size:12px;font-weight:700;background:rgba(255,255,255,0.2);padding:6px 12px;border-radius:999px;white-space:nowrap;border:1px solid rgba(255,255,255,0.3)">{b.cta[lang] || b.cta.ko} →</span>
    </a>
  ));

  return c.html(
    <html lang={lang}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{customerTitle[lang] || customerTitle.ko} — {t("brand_name", lang)}</title>
        <link rel="preconnect" href="https://cdn.jsdelivr.net" />
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css" />
        <style dangerouslySetInnerHTML={{__html: `
:root {
  --bg: #eef3fb;
  --bg-deep: #e7f0ff;
  --surface: #ffffff;
  --surface-soft: #f5f9ff;
  --line: #dbe4f2;
  --line-strong: #cedaee;
  --text: #191f28;
  --subtext: #4a5668;
  --muted: #7d8794;
  --primary: #2f80f8;
  --primary-strong: #1e63da;
  --primary-soft: #eaf2ff;
  --positive: #12b886;
  --warning: #ef7d22;
  --radius-xl: 26px;
  --radius-lg: 20px;
  --radius-md: 12px;
  --shadow-sm: 0 10px 30px rgba(16, 31, 60, 0.07);
  --shadow-md: 0 14px 36px rgba(16, 31, 60, 0.11);
  --shadow-lg: 0 22px 52px rgba(39, 103, 209, 0.2);
}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; width: 100%; overflow-x: hidden; }
body {
  position: relative;
  font-family: "Pretendard", "Noto Sans KR", "Noto Sans JP", sans-serif;
  color: var(--text);
  background:
    radial-gradient(1200px 560px at -10% -8%, rgba(141,190,255,0.42) 0%, rgba(141,190,255,0) 68%),
    radial-gradient(980px 520px at 106% -14%, rgba(138,220,255,0.34) 0%, rgba(138,220,255,0) 70%),
    linear-gradient(180deg, #f2f6ff 0%, #edf3fc 100%);
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  overflow-x: hidden;
}
body::before {
  content: "";
  position: fixed; inset: 0; z-index: -2;
  pointer-events: none;
  background-image: radial-gradient(circle at 1px 1px, rgba(87,111,150,0.08) 1px, transparent 0);
  background-size: 28px 28px;
  mask-image: linear-gradient(180deg, rgba(0,0,0,0.22), transparent 68%);
}
a { color: inherit; text-decoration: none; }
.bg-orb { position: fixed; z-index: -1; width: 560px; height: 560px; border-radius: 50%; filter: blur(72px); opacity: 0.48; pointer-events: none; }
.bg-orb-left { left: -200px; top: -190px; background: #95bdff; }
.bg-orb-right { right: -220px; top: -70px; background: #8fdfff; }
.topbar {
  position: sticky; top: 0; z-index: 30;
  backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  border-bottom: 1px solid rgba(136,158,195,0.22);
  background: linear-gradient(180deg, rgba(246,250,255,0.93) 0%, rgba(241,247,255,0.84) 100%);
  box-shadow: 0 8px 24px rgba(17,34,68,0.08);
}
.topbar-inner {
  width: 100%; max-width: 1120px; margin-inline: auto;
  padding: 13px 18px; display: flex; align-items: center;
  justify-content: space-between; gap: 12px;
}
.brand {
  display: inline-flex; align-items: center; gap: 10px;
  font-size: 18px; font-weight: 800; letter-spacing: -0.02em;
}
.topbar-actions { display: flex; align-items: center; gap: 10px; }
.lang-switcher {
  display: inline-flex; background: rgba(231,240,252,0.88);
  border-radius: 999px; padding: 3px; border: 1px solid #d4dfef;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.75);
}
.lang-btn {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 6px 14px; font-size: 12px; font-weight: 700; color: #3d4d66;
  border-radius: 999px; text-decoration: none;
  transition: background 0.2s ease, color 0.2s ease, box-shadow 0.2s ease; line-height: 1;
}
.lang-btn:hover { background: rgba(220,232,251,0.8); }
.lang-btn-active { background: var(--primary); color: #fff; box-shadow: 0 2px 8px rgba(47,128,248,0.3); }
.lang-btn-active:hover { background: var(--primary-strong); color: #fff; }
.receipt-link {
  display: inline-flex; align-items: center; padding: 6px 14px;
  font-size: 12px; font-weight: 600; color: var(--subtext);
  border: 1.5px solid var(--line-strong); border-radius: 999px;
  text-decoration: none; white-space: nowrap;
  transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease; line-height: 1;
}
.receipt-link:hover { background: var(--primary); color: #fff; border-color: var(--primary); }
.container {
  width: 100%; max-width: 1080px; margin: 24px auto 44px;
  padding: 0 16px; display: grid; gap: 18px;
}
.hero { padding: 4px 2px; animation: riseIn 0.45s ease both; }
.hero-title {
  margin: 6px 0 0; font-size: clamp(26px, 5vw, 34px);
  font-weight: 800; letter-spacing: -0.03em;
}
.hero-desc { margin: 10px 0 0; color: var(--subtext); font-size: 15px; }
.card {
  background: linear-gradient(180deg, rgba(255,255,255,0.94) 0%, rgba(252,254,255,0.98) 100%);
  border: 1px solid var(--line); border-radius: var(--radius-xl);
  box-shadow: var(--shadow-sm), inset 0 1px 0 rgba(255,255,255,0.78);
  padding: 22px; animation: riseIn 0.42s ease both;
}
.card-primary { border-color: #cddffb; box-shadow: var(--shadow-lg); }
.card-title { margin: 0; font-size: 21px; font-weight: 700; letter-spacing: -0.02em; }
.card-desc { margin: 8px 0 0; color: var(--subtext); font-size: 14px; }
form { margin-top: 16px; }
.field { display: grid; gap: 8px; margin-bottom: 14px; }
.field-label { font-size: 13px; color: var(--subtext); font-weight: 600; }
.inline-note { color: #1b64da; font-style: normal; font-size: 12px; font-weight: 700; }
.control {
  width: 100%; min-height: 44px; border: 1px solid #cfdcf0;
  background: linear-gradient(180deg, #ffffff 0%, #fdfefe 100%);
  color: var(--text); border-radius: var(--radius-md);
  padding: 12px 14px; font-size: 16px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.85);
  transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
  font-family: inherit;
}
.control:focus {
  outline: none; border-color: #87b1f6; background: #fff;
  box-shadow: 0 0 0 4px rgba(46,123,244,0.14);
}
.field-hint { color: #3f5e88; font-size: 12px; }
.file-picker {
  display: grid; grid-template-columns: auto minmax(0, 1fr);
  gap: 10px; padding: 10px 12px; border-radius: var(--radius-md);
  border: 1px solid #cfdcf0;
  background: linear-gradient(180deg, #ffffff 0%, #f8fbff 100%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.84);
}
.file-input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.file-btn {
  border: 0; border-radius: 10px; padding: 9px 13px;
  font-size: 12px; font-weight: 700; color: #fff;
  background: linear-gradient(160deg, #4091ff 0%, #1e63da 100%);
  box-shadow: 0 8px 18px rgba(31,102,221,0.26);
  cursor: pointer; white-space: nowrap; font-family: inherit;
}
.file-name {
  color: var(--subtext); font-size: 13px; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.pickup-time-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; min-width: 0; }
.pickup-time-grid .field { min-width: 0; }
.pickup-time-grid .control { min-width: 0; max-width: 100%; }
.pickup-guide {
  margin-top: 4px; margin-bottom: 12px;
  border-left: 4px solid #2f80ed; background: #f2f7ff;
  border-radius: 12px; padding: 12px;
}
.pickup-guide p { margin: 0; color: #1e3a8a; font-weight: 700; line-height: 1.5; font-size: 13px; }
.companion-picker { display: grid; gap: 8px; }
.companion-picker .control-compact { max-width: 100%; }
.bag-qty-picker { max-width: 100%; }
.control-compact { max-width: 140px; padding: 10px 12px; }
.is-hidden { display: none !important; }
.preview {
  margin: 16px 0 18px; border: 1px solid #d9e7ff;
  border-radius: var(--radius-lg);
  background: linear-gradient(160deg, #f4f8ff 0%, #edf4ff 100%);
  padding: 16px;
}
.preview-head { color: var(--subtext); font-size: 13px; font-weight: 600; }
.preview-value {
  margin-top: 6px; font-size: 30px; font-weight: 800;
  letter-spacing: -0.02em; color: #174ea6;
}
.preview-meta { margin: 6px 0 0; font-size: 13px; color: #4b638d; }
.preview-with-options {
  display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
  gap: 14px; align-items: start;
}
.preview-side { display: grid; gap: 10px; }
.field-compact { margin-bottom: 0; }
.payment-toggle { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.payment-chip { display: block; cursor: pointer; }
.payment-chip input { position: absolute; opacity: 0; pointer-events: none; }
.payment-chip span {
  display: inline-flex; width: 100%; justify-content: center; align-items: center;
  padding: 10px 8px; border-radius: 10px; border: 1px solid #d4e1f7;
  background: #eff5ff; color: #32537b; font-size: 12px; font-weight: 700;
}
.payment-chip input:checked + span {
  background: linear-gradient(160deg, #4b91fa 0%, #1f68e8 100%);
  border-color: #1f68e8; color: #fff;
  box-shadow: 0 8px 18px rgba(31,104,232,0.24);
}
.notice-card {
  margin-top: 16px; padding: 0; background: transparent; border: none;
}
.notice-panel {
  display: block; margin-top: 10px; border-radius: 14px;
  background: #f7faff; border: 1px solid #dce8ff; padding: 14px 16px;
}
.notice-panel h4 { margin: 4px 0 8px; font-size: 14px; }
.notice-list {
  margin: 0 0 12px; padding-left: 18px; color: #2f3947;
  font-size: 13px; line-height: 1.52;
}
.notice-list li { margin-bottom: 5px; }
.check-row {
  display: flex; align-items: center; gap: 10px;
  margin: 14px 0 16px; color: var(--subtext); font-size: 13px;
}
.check-row input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--primary); }
.check-row-strong {
  border-radius: 12px; background: #eef4ff;
  border: 1px solid #d8e4fb; padding: 10px 12px;
}
.upload-status { display: none; margin: 10px 0 0; border-radius: 12px; padding: 10px 12px; font-size: 13px; font-weight: 700; }
.upload-status.is-visible { display: block; }
.upload-status.is-busy { background: #edf4ff; border: 1px solid #d3e4ff; color: #1b58c0; }
.upload-status.is-error { background: #fff2f2; border: 1px solid #ffd4d4; color: #bd3030; }
.submit-dock { margin-top: 12px; }
.submit-dock-hint { margin: 8px 2px 0; color: #617086; font-size: 12px; text-align: center; }
.btn, button {
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid transparent; border-radius: 14px; min-height: 42px;
  padding: 10px 16px; font-size: 14px; font-weight: 700; cursor: pointer;
  letter-spacing: -0.01em; font-family: inherit;
  transition: transform 0.16s ease, box-shadow 0.16s ease, background 0.16s ease;
}
.btn-primary, .btn-primary:hover {
  background: linear-gradient(160deg, var(--primary) 0%, var(--primary-strong) 100%);
  color: #fff; border-color: rgba(15,73,166,0.18);
  box-shadow: 0 10px 24px rgba(47,128,248,0.26);
}
.btn:hover, button:hover { transform: translateY(-1px); filter: saturate(1.04); }
.btn:active, button:active { transform: translateY(0); }
.btn-lg { width: 100%; padding: 14px 18px; font-size: 15px; }
.is-disabled { opacity: 0.45; cursor: not-allowed; }
.discount-details summary {
  cursor: pointer; font-size: 14px; font-weight: 600; color: var(--subtext);
  list-style: none; padding: 2px 0;
}
.discount-details summary::-webkit-details-marker { display: none; }
.table-wrap { margin-top: 12px; }
.table-wrap table { width: 100%; border-collapse: collapse; }
.table-wrap th {
  background: var(--surface-soft); padding: 10px 14px; font-size: 12px;
  font-weight: 700; color: var(--muted); text-align: left; border-bottom: 1px solid var(--line);
}
.table-wrap td {
  padding: 10px 14px; font-size: 14px; color: var(--subtext);
  font-weight: 500; border-bottom: 1px solid var(--line);
}
.table-wrap tr:last-child td { border-bottom: none; }
.site-footer {
  padding: 36px 16px 28px; text-align: center;
}
.footer-inner { max-width: 400px; margin: 0 auto; }
.footer-logo { display: block; margin: 0 auto 14px; }
.footer-info { display: grid; gap: 3px; font-size: 12px; color: var(--muted); line-height: 1.6; }
.footer-copy { margin-top: 12px; font-size: 11px; color: var(--muted); }
.error-banner {
  padding: 12px 16px; border-radius: var(--radius-md);
  background: #fff2f2; border: 1px solid #ffd4d4;
  color: #bd3030; font-size: 14px; font-weight: 600;
}
.late-pickup { border-color: #f7c3c3 !important; background: #fff4f4 !important; }
@keyframes riseIn {
  from { opacity: 0; transform: translateY(18px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (max-width: 640px) {
  .topbar-inner { padding: 10px 12px; gap: 6px; }
  .brand img { height: 28px !important; }
  .topbar-actions { gap: 6px; }
  .lang-switcher { gap: 2px; }
  .lang-btn { padding: 7px 11px; font-size: 11px; }
  .receipt-link { padding: 7px 11px; font-size: 11px; }
  .container { padding: 0 10px; gap: 12px; margin: 12px auto 28px; }
  .hero-title { font-size: 22px; }
  .hero-desc { font-size: 13px; }
  .card { padding: 14px 12px; border-radius: 16px; }
  .card-primary { padding: 16px 14px; }
  .card-title { font-size: 17px; }
  .card-desc { font-size: 13px; }
  .field-label { font-size: 12px; }
  .control { font-size: 16px; padding: 10px 12px; min-height: 44px; }
  .file-btn { min-height: 44px; padding: 12px 16px; }
  .payment-chip span { min-height: 44px; display: flex; align-items: center; justify-content: center; }
  .check-row { min-height: 44px; align-items: center; }
  .check-row input[type="checkbox"] { width: 22px; height: 22px; }
  .notice-card .card-title { font-size: 16px; }
  .notice-panel { padding: 10px 12px; border-radius: 10px; }
  .notice-panel h4 { font-size: 13px; }
  .notice-list { padding-left: 14px; font-size: 13px; line-height: 1.55; }
  .notice-list li { margin-bottom: 6px; }
  .grid2 { grid-template-columns: 1fr; }
  .pickup-time-grid { grid-template-columns: 1fr 1fr; }
  .preview-with-options { grid-template-columns: 1fr; }
  .preview-head { font-size: 12px; }
  .preview-value { font-size: 28px; }
  .submit-dock { padding: 12px; }
  .table-wrap { overflow-x: auto; }
  .btn, button, a, label, select { touch-action: manipulation; }
}
        `}} />
      </head>
      <body class="customer-site">
        <div class="bg-orb bg-orb-left" aria-hidden="true"></div>
        <div class="bg-orb bg-orb-right" aria-hidden="true"></div>

        <header class="topbar">
          <div class="topbar-inner">
            <a class="brand" href="/customer">
              <img class="brand-logo-horizontal" src="/static/logo-horizontal.png?v=2" alt="Flying Japan" height="36" style="mix-blend-mode:multiply" />
            </a>
            <div class="topbar-actions">
              <div class="lang-switcher" role="group" aria-label="Language">
                <a href="/customer?lang=ko" class={`lang-btn${lang === "ko" ? " lang-btn-active" : ""}`}>KO</a>
                <a href="/customer?lang=en" class={`lang-btn${lang === "en" ? " lang-btn-active" : ""}`}>EN</a>
                <a href="/customer?lang=ja" class={`lang-btn${lang === "ja" ? " lang-btn-active" : ""}`}>JA</a>
              </div>
              <a class="receipt-link" href="https://script.google.com/macros/s/AKfycbztXz0FhN90_Zs04h-f2AedkqHD4Koi-jtAnT0OE-HbzhMnShmMeWoYL-J8l9_07qlI/exec" target="_blank" rel="noopener">{receiptLabel[lang] || receiptLabel.ko}</a>
            </div>
          </div>
        </header>

        <main class="container">
          <section class="hero">
            <h2 class="hero-title">{customerTitle[lang] || customerTitle.ko}</h2>
            <p class="hero-desc">{t("pickup_note", lang)}</p>
          </section>

          {error && (
            <div class="error-banner">{decodeURIComponent(error)}</div>
          )}

          <section class="card card-primary">
            <form
              id="customer-form"
              action="/customer/submit"
              method="post"
              enctype="multipart/form-data"
              autocomplete="off"
              data-preview-meta-empty={previewMetaEmpty[lang] || previewMetaEmpty.ko}
              data-preview-invalid-title={previewInvalidTitle[lang] || previewInvalidTitle.ko}
              data-preview-invalid-meta={previewInvalidMeta[lang] || previewInvalidMeta.ko}
              data-preview-error-title={previewErrorTitle[lang] || previewErrorTitle.ko}
              data-preview-error-meta={previewErrorMeta[lang] || previewErrorMeta.ko}
              data-pickup-late-warning={pickupLateWarn[lang] || pickupLateWarn.ko}
              data-preview-result-meta={previewResultMeta[lang] || previewResultMeta.ko}
              data-upload-optimizing={uploadOptimizing[lang] || uploadOptimizing.ko}
              data-upload-submitting={uploadSubmitting[lang] || uploadSubmitting.ko}
              data-upload-error={uploadErrorMsg[lang] || uploadErrorMsg.ko}
              data-file-optimized={t("file_optimized", lang)}
            >
              <input type="hidden" name="lang" value={lang} />
              <input id="expected_pickup_at" type="hidden" name="expected_pickup_at" required />

              {/* name */}
              <label class="field">
                <span class="field-label">{t("name", lang)}</span>
                <input class="control" type="text" name="name" required maxlength={120} autocomplete="off" />
              </label>

              {/* phone */}
              <label class="field">
                <span class="field-label">{t("phone", lang)}</span>
                <input class="control" type="text" name="phone" required maxlength={40} autocomplete="off" />
              </label>

              {/* images */}
              <div class="grid2">
                <label class="field">
                  <span class="field-label">{t("id_image", lang)} <em class="inline-note">{idImageHint[lang] || idImageHint.ko}</em></span>
                  <div class="file-picker">
                    <input id="id_image" class="file-input" type="file" name="id_image" accept="image/*" required />
                    <button class="file-btn" type="button" data-file-trigger="id_image">{t("file_select", lang)}</button>
                    <span id="id_image_name" class="file-name" data-file-empty={fileNone[lang] || fileNone.ko}>{fileNone[lang] || fileNone.ko}</span>
                  </div>
                  <span class="field-hint">{photoRetention[lang] || photoRetention.ko}</span>
                </label>

                <label class="field">
                  <span class="field-label">{t("luggage_image", lang)}</span>
                  <div class="file-picker">
                    <input id="luggage_image" class="file-input" type="file" name="luggage_image" accept="image/*" required />
                    <button class="file-btn" type="button" data-file-trigger="luggage_image">{t("file_select", lang)}</button>
                    <span id="luggage_image_name" class="file-name" data-file-empty={fileNone[lang] || fileNone.ko}>{fileNone[lang] || fileNone.ko}</span>
                  </div>
                  <span class="field-hint">{photoRetention[lang] || photoRetention.ko}</span>
                </label>
              </div>

              {/* Rental banner — randomized */}
              {rentalBanners[0]}

              {/* bag quantities */}
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                <label class="field">
                  <span class="field-label">{t("suitcase_qty", lang)}</span>
                  <div class="companion-picker bag-qty-picker">
                    <select id="suitcase_qty_select" class="control control-compact" required>
                      {qtyOptions.map((n) => (
                        <option value={String(n)} selected={n === 0}>{n}</option>
                      ))}
                      <option value="custom">{bagCustomOption[lang] || bagCustomOption.ko}</option>
                    </select>
                    <input
                      id="suitcase_qty_custom"
                      class="control control-compact is-hidden"
                      type="number"
                      min={11}
                      max={MAX_BAG_QTY}
                      placeholder={bagCustomPlaceholder[lang] || bagCustomPlaceholder.ko}
                      inputmode="numeric"
                    />
                    <input id="suitcase_qty" type="hidden" name="suitcase_qty" value="0" />
                  </div>
                  <span class="field-hint">{suitcaseHint[lang] || suitcaseHint.ko}</span>
                </label>

                <label class="field">
                  <span class="field-label">{t("backpack_qty", lang)}</span>
                  <div class="companion-picker bag-qty-picker">
                    <select id="backpack_qty_select" class="control control-compact" required>
                      {qtyOptions.map((n) => (
                        <option value={String(n)} selected={n === 0}>{n}</option>
                      ))}
                      <option value="custom">{bagCustomOption[lang] || bagCustomOption.ko}</option>
                    </select>
                    <input
                      id="backpack_qty_custom"
                      class="control control-compact is-hidden"
                      type="number"
                      min={11}
                      max={MAX_BAG_QTY}
                      placeholder={bagCustomPlaceholder[lang] || bagCustomPlaceholder.ko}
                      inputmode="numeric"
                    />
                    <input id="backpack_qty" type="hidden" name="backpack_qty" value="0" />
                  </div>
                  <span class="field-hint">{backpackHint[lang] || backpackHint.ko}</span>
                </label>
              </div>

              {/* pickup date + time */}
              {(() => {
                const DOW_SHORT: Record<string, string[]> = {
                  ko: ["일", "월", "화", "수", "목", "금", "토"],
                  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
                  ja: ["日", "月", "火", "水", "木", "金", "土"],
                };
                const dow = DOW_SHORT[lang] || DOW_SHORT.ko;
                const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
                const dates: { value: string; label: string }[] = [];
                for (let i = 0; i < 14; i++) {
                  const d = new Date(now.getTime() + i * 86400000);
                  const y = d.getUTCFullYear();
                  const m = d.getUTCMonth() + 1;
                  const day = d.getUTCDate();
                  const value = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                  const dayOfWeek = dow[d.getUTCDay()];
                  const todayLabel = i === 0 ? (lang === "en" ? " (Today)" : lang === "ja" ? " (今日)" : " (오늘)") : "";
                  dates.push({ value, label: `${m}/${day} (${dayOfWeek})${todayLabel}` });
                }
                return (
                  <div class="pickup-time-grid">
                    <label class="field">
                      <span class="field-label">{pickupDateLabel[lang] || pickupDateLabel.ko}</span>
                      <select id="expected_pickup_date" class="control" required>
                        {dates.map(d => <option value={d.value}>{d.label}</option>)}
                      </select>
                    </label>
                    <label class="field">
                      <span class="field-label">{pickupTimeLabel[lang] || pickupTimeLabel.ko}</span>
                      <select id="expected_pickup_time" class="control" required></select>
                    </label>
                  </div>
                );
              })()}

              <div class="pickup-guide">
                <p>{pickupFlexNote[lang] || pickupFlexNote.ko}</p>
              </div>

              {rentalBanners[1]}

              {/* price preview */}
              <div class="preview preview-with-options" id="price-preview" aria-live="polite">
                <div class="preview-main">
                  <div class="preview-head">{t("price_preview", lang)}</div>
                  <div id="price-value" class="preview-value">-</div>
                  <p id="price-meta" class="preview-meta">{previewMetaDefault[lang] || previewMetaDefault.ko}</p>
                </div>

                <div class="preview-side">
                  <label class="field field-compact">
                    <span class="field-label">{t("payment_method_label", lang)}</span>
                    <div class="payment-toggle">
                      <label class="payment-chip">
                        <input type="radio" name="payment_method" value="PAY_QR" checked />
                        <span>{t("payment_method_pay_qr", lang)}</span>
                      </label>
                      <label class="payment-chip">
                        <input type="radio" name="payment_method" value="CASH" />
                        <span>{t("payment_method_cash", lang)}</span>
                      </label>
                    </div>
                    <span class="field-hint">{payQrNote[lang] || payQrNote.ko}</span>
                    <span style="display:block;margin-top:4px;font-size:12px;font-weight:700;color:#dc2626">{noCardWarning[lang] || noCardWarning.ko}</span>
                  </label>

                  <label class="field field-compact">
                    <span class="field-label">{t("companion_count", lang)}</span>
                    <div class="companion-picker">
                      <select id="companion_count_select" class="control control-compact" required>
                        {companionOptions.map((n) => (
                          <option value={String(n)} selected={n === 1}>{n}</option>
                        ))}
                        <option value="custom">{companionCustomOption[lang] || companionCustomOption.ko}</option>
                      </select>
                      <input
                        id="companion_count_custom"
                        class="control control-compact is-hidden"
                        type="number"
                        min={11}
                        max={MAX_COMPANION_COUNT}
                        placeholder={companionCustomPlaceholder[lang] || companionCustomPlaceholder.ko}
                        inputmode="numeric"
                      />
                      <input id="companion_count" type="hidden" name="companion_count" value="1" />
                    </div>
                    <span class="field-hint">{companionHint[lang] || companionHint.ko}</span>
                  </label>
                </div>
              </div>

              {rentalBanners[2]}

              {/* notice */}
              <div id="consent-notice" style="margin-top:8px">
                <h3 style="font-size:15px;font-weight:700;margin:0 0 8px;color:var(--text)">{noticeTitle[lang] || noticeTitle.ko}</h3>
                {lang === "en" ? (
                  <article class="notice-panel notice-panel-static">
                    <h4>&#x1F9F3; Baggage Storage Guidelines</h4>
                    <ul class="notice-list">
                      <li>Payment must be made in advance.</li>
                      <li>Customers are responsible for proving the condition of their baggage before and after storage.</li>
                      <li>We are not responsible for any damage, contamination, or loss of contents during storage.</li>
                      <li>The operator is not liable for damage or loss unless caused by willful misconduct or gross negligence.</li>
                      <li>Please store valuables and expensive items separately.</li>
                      <li>Stored baggage can be collected only during business hours (09:00-21:00).</li>
                      <li>In unavoidable circumstances requiring luggage pickup after 21:00, dispatch service may be provided only if staff can be reached. A dispatch fee of &#165;8,000 will apply. (An additional one-day storage fee will also be charged if pickup occurs after business hours.)</li>
                      <li>An additional daily fee will be charged if the storage period is exceeded.</li>
                      <li>Unclaimed or overdue items will be kept for 2 weeks and then disposed of.</li>
                      <li>If loss or unavoidable circumstances require international delivery, a handling fee of 50,000 KRW per item will apply (shipping fee not included).</li>
                      <li>For international delivery, customers must make a reservation directly with a local Japanese delivery company.</li>
                      <li>If lost baggage is identified, daily storage fees will be charged retroactively from the original deposit date.</li>
                      <li>Storage fees are charged separately based on the total number of storage days.</li>
                    </ul>
                    <h4>&#x1F6AB; Non-Storable Items</h4>
                    <ul class="notice-list">
                      <li>Items exceeding 2 meters in any dimension or weighing over 35 kg (golf bags are accepted)</li>
                      <li>Valuables, high-priced items, or precision equipment (computers, laptops, tablets, cameras, etc.)</li>
                      <li>Fragile items, animals, hazardous materials, or perishable goods requiring refrigeration or freezing</li>
                      <li>Liquids in containers such as beverages or PET bottles</li>
                      <li>Any other items deemed unsuitable for storage by staff</li>
                    </ul>
                    <h4>&#x1F512; Personal Information Notice</h4>
                    <ul class="notice-list">
                      <li>Collected Information: Name, contact number</li>
                      <li>Purpose of Use: Identity verification for baggage storage service</li>
                      <li>ID/luggage photos are automatically deleted within 14 days.</li>
                    </ul>
                  </article>
                ) : lang === "ja" ? (
                  <article class="notice-panel notice-panel-static">
                    <h4>&#x1F9F3; 手荷物預かりに関する注意事項</h4>
                    <ul class="notice-list">
                      <li>料金は前払い制です。</li>
                      <li>お預けになる手荷物の保管前後の状態証明はお客様の責任となります。</li>
                      <li>保管中の破損・汚損・内容物の紛失等については一切の責任を負いません。</li>
                      <li>ただし、事業者に故意または重大な過失がない場合、破損や紛失についての責任は負いません。</li>
                      <li>高価品・貴重品は必ず別途保管してください。</li>
                      <li>お預かりした手荷物は営業時間（09:00〜21:00）のみ受け取り可能です。</li>
                      <li>やむを得ない事情により21:00以降の荷物のお引き取りが必要な場合、スタッフと連絡が取れる場合に限り出動対応が可能です。その際、出動手数料として8,000円を申し受けます。（営業時間を過ぎた場合は、別途1日分の保管料金が発生いたします。）</li>
                      <li>保管期間を超過した場合、1日ごとに追加料金が発生します。</li>
                      <li>保管期限を過ぎた荷物や遺失物は2週間保管後、処分いたします。</li>
                      <li>紛失またはやむを得ない事情により海外配送が必要な場合、1件につき5万ウォンの手数料が発生します（送料別途）。</li>
                      <li>海外配送をご希望の場合は、お客様ご自身で日本現地の配送業者へ直接予約を行ってください。</li>
                      <li>紛失した荷物が確認された場合、預け入れ日から日数分の保管料金が遡って請求されます。</li>
                      <li>保管料金は保管日数に応じて別途請求されます。</li>
                    </ul>
                    <h4>&#x1F6AB; 保管できない物</h4>
                    <ul class="notice-list">
                      <li>一辺の長さが2mを超えるもの、または重量が35kgを超えるもの（ゴルフバッグは可）</li>
                      <li>高価な物品、貴重品、精密機器（パソコン、ノートPC、タブレット、カメラ等）</li>
                      <li>壊れやすい物、動物、危険物、冷蔵・冷凍または腐敗しやすい物</li>
                      <li>飲料やペットボトルなどの液体が入った容器</li>
                      <li>その他、スタッフが取り扱い困難と判断した物品</li>
                    </ul>
                    <h4>&#x1F512; 個人情報の取扱いについて</h4>
                    <ul class="notice-list">
                      <li>収集項目： 氏名、連絡先</li>
                      <li>利用目的： 手荷物預かりサービスにおける本人確認のため</li>
                      <li>本人確認書類・荷物写真は14日以内に自動削除されます。</li>
                    </ul>
                  </article>
                ) : (
                  <article class="notice-panel notice-panel-static">
                    <h4>&#x1F9F3; 짐 보관 유의사항</h4>
                    <ul class="notice-list">
                      <li>요금은 선불 결제입니다.</li>
                      <li>맡기신 짐의 보관 전·후 상태 증명 책임은 고객님께 있습니다.</li>
                      <li>보관 중 발생한 파손, 오염, 내용물 분실 등에 대해서는 책임을 지지 않습니다.</li>
                      <li>단, 사업자의 고의 또는 중대한 과실이 없는 한 파손이나 분실에 대한 책임을 지지 않습니다.</li>
                      <li>고가품 및 귀중품은 반드시 별도로 보관해 주시기 바랍니다.</li>
                      <li>맡기신 짐은 영업시간(09:00~21:00) 내에서만 수령하실 수 있습니다.</li>
                      <li>불가피한 사유로 21:00 이후 수령이 필요한 경우, 직원과 연락이 닿는 상황에 한해 출동이 가능하며 8,000엔의 출동 수수료가 부과됩니다. (영업시간이 지난 경우 1일 보관료 별도 발생)</li>
                      <li>짐 보관 기간을 초과할 경우, 1일당 추가 요금이 부과됩니다.</li>
                      <li>보관기한이 지난 물품 및 분실물은 2주간 보관 후 폐기됩니다.</li>
                      <li>짐 분실 또는 부득이한 사유로 해외 배송이 필요한 경우, 1건당 50,000원의 수수료가 발생합니다. (배송비 별도)</li>
                      <li>해외 배송이 필요한 경우, 고객님이 직접 일본 현지 배송업체에 예약을 진행해야 합니다.</li>
                      <li>분실된 짐은 소유자 확인이 되면 맡기신 시점부터 일일 보관요금이 추가로 청구됩니다.</li>
                      <li>짐 보관료는 보관 일수에 따라 별도 청구됩니다.</li>
                    </ul>
                    <h4>&#x1F6AB; 보관불가 항목</h4>
                    <ul class="notice-list">
                      <li>한 변의 길이가 2m, 무게가 35kg을 초과하는 물품 (단, 골프백은 가능)</li>
                      <li>고가의 물건, 귀중품, 정밀기기(컴퓨터, 노트북, 태블릿PC, 카메라 등)</li>
                      <li>깨지기 쉬운 것, 동물, 위험물, 냉장·냉동 또는 부패하기 쉬운 물품</li>
                      <li>액체가 든 용기(음료수, 페트병 등)</li>
                      <li>그 외 직원이 취급에 문제가 있다고 판단한 물품</li>
                    </ul>
                    <h4>&#x1F512; 개인정보 수집 안내</h4>
                    <ul class="notice-list">
                      <li>수집 항목: 이름, 연락처</li>
                      <li>수집 및 이용 목적: 짐 보관 신원 확인용</li>
                      <li>신분증/짐 사진은 14일 이내 자동 삭제됩니다.</li>
                    </ul>
                  </article>
                )}
              </div>

              {/* consent */}
              <label class="check-row check-row-strong">
                <input type="checkbox" name="consent_checked" value="1" required />
                <span>{t("consent_label", lang)}</span>
              </label>

              <p id="upload-status" class="upload-status" aria-live="polite"></p>

              {/* submit */}
              <div class="submit-dock">
                <button id="customer-submit-btn" class="btn btn-primary btn-lg" type="submit">{t("submit", lang)}</button>
                <p class="submit-dock-hint">{mobileSubmitHint[lang] || mobileSubmitHint.ko}</p>
              </div>
            </form>
          </section>

          {/* discount table */}
          <section class="card">
            <details class="discount-details">
              <summary>{discountTableExpand[lang] || discountTableExpand.ko}</summary>
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr><th>{discountDays[lang] || discountDays.ko}</th><th>{discountRate[lang] || discountRate.ko}</th></tr>
                  </thead>
                  <tbody>
                    {discountTable.map((row) => (
                      <tr><td>{row.days}</td><td>{row.rate}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </section>
        </main>

        <footer class="site-footer">
          <div class="footer-inner">
            <img class="footer-logo" src="/static/logo-horizontal.png?v=2" alt="Flying Japan" height="28" style="mix-blend-mode:multiply" />
            <div class="footer-info">
              <span>{t("footer_company", lang)}</span>
              <span>{t("footer_address", lang)}</span>
              <span>{footerHours[lang] || footerHours.ko}</span>
              <span>{t("footer_phone", lang)}</span>
            </div>
            <p class="footer-copy">{footerCopyright[lang] || footerCopyright.ko}</p>
          </div>
        </footer>

        <script dangerouslySetInnerHTML={{__html: `
(function(){
  var suitcaseEl = document.getElementById("suitcase_qty");
  var backpackEl = document.getElementById("backpack_qty");
  var suitcaseSelectEl = document.getElementById("suitcase_qty_select");
  var suitcaseCustomEl = document.getElementById("suitcase_qty_custom");
  var backpackSelectEl = document.getElementById("backpack_qty_select");
  var backpackCustomEl = document.getElementById("backpack_qty_custom");
  var pickupDateEl = document.getElementById("expected_pickup_date");
  var pickupTimeEl = document.getElementById("expected_pickup_time");
  var pickupHiddenEl = document.getElementById("expected_pickup_at");
  var priceValueEl = document.getElementById("price-value");
  var priceMetaEl = document.getElementById("price-meta");
  var companionSelectEl = document.getElementById("companion_count_select");
  var companionCustomEl = document.getElementById("companion_count_custom");
  var companionHiddenEl = document.getElementById("companion_count");
  var formEl = document.getElementById("customer-form");
  var submitBtnEl = document.getElementById("customer-submit-btn");
  var uploadStatusEl = document.getElementById("upload-status");
  var idImageInputEl = document.getElementById("id_image");
  var luggageImageInputEl = document.getElementById("luggage_image");
  var paymentMethodEls = formEl ? Array.from(formEl.querySelectorAll('input[name="payment_method"]')) : [];
  if (!suitcaseEl || !backpackEl || !pickupDateEl || !pickupTimeEl || !pickupHiddenEl || !priceValueEl || !formEl) return;

  var messages = {
    metaEmpty: formEl.dataset.previewMetaEmpty || "",
    invalidTitle: formEl.dataset.previewInvalidTitle || "Check input",
    invalidMeta: formEl.dataset.previewInvalidMeta || "",
    errorTitle: formEl.dataset.previewErrorTitle || "Calc error",
    errorMeta: formEl.dataset.previewErrorMeta || "",
    latePickupWarning: formEl.dataset.pickupLateWarning || "",
    resultMeta: formEl.dataset.previewResultMeta || "",
    uploadOptimizing: formEl.dataset.uploadOptimizing || "",
    uploadSubmitting: formEl.dataset.uploadSubmitting || "",
    uploadError: formEl.dataset.uploadError || "",
    fileOptimized: formEl.dataset.fileOptimized || ""
  };
  var optimizedFilesByField = new Map();
  var MAX_IMAGE_DIMENSION = 1800;
  var OPTIMIZE_SIZE_THRESHOLD = 450 * 1024;
  var TARGET_IMAGE_BYTES = 1000 * 1024;
  var latePickupWarned = false;
  var isSubmitting = false;

  var tokyoFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });

  function setUploadStatus(message, kind) {
    if (!uploadStatusEl) return;
    if (!message) { uploadStatusEl.textContent = ""; uploadStatusEl.className = "upload-status"; return; }
    uploadStatusEl.textContent = message;
    uploadStatusEl.className = "upload-status is-visible is-" + (kind || "busy");
  }
  function clearUploadStatus() { setUploadStatus(""); }
  function setSubmitBusy(busy) {
    if (!submitBtnEl) return;
    submitBtnEl.disabled = !!busy;
    submitBtnEl.classList.toggle("is-disabled", !!busy);
  }

  function pad(v) { return String(v).padStart(2, "0"); }
  function formatDateUTC(d) { return d.getUTCFullYear() + "-" + pad(d.getUTCMonth()+1) + "-" + pad(d.getUTCDate()); }
  function formatTimeUTC(d) { return pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()); }
  function getTokyoNow() {
    var parts = tokyoFormatter.formatToParts(new Date());
    var b = {};
    parts.forEach(function(p){ if(p.type!=="literal") b[p.type]=p.value; });
    return new Date(Date.UTC(Number(b.year), Number(b.month)-1, Number(b.day), Number(b.hour), Number(b.minute), 0, 0));
  }
  function roundToHalfHourUTC(d) {
    var c = new Date(d.getTime()); var m = c.getUTCMinutes(); c.setUTCSeconds(0,0);
    if (m===0||m===30) return c;
    if (m<30) { c.setUTCMinutes(30,0,0); return c; }
    c.setUTCHours(c.getUTCHours()+1,0,0,0); return c;
  }

  function buildPickupTimeOptions() {
    pickupTimeEl.innerHTML = "";
    for (var h = 9; h <= 21; h++) {
      [0, 30].forEach(function(m) {
        if (h === 21 && m > 0) return;
        var v = pad(h) + ":" + pad(m);
        var opt = document.createElement("option");
        opt.value = v; opt.textContent = v;
        pickupTimeEl.appendChild(opt);
      });
    }
  }
  function setDefaultPickupByTokyoTime() {
    var now = getTokyoNow(); var p = roundToHalfHourUTC(now);
    var h = p.getUTCHours(), m = p.getUTCMinutes();
    if (h < 9) { p.setUTCHours(9,0,0,0); }
    else if (h > 21 || (h===21 && m>0)) { p.setUTCDate(p.getUTCDate()+1); p.setUTCHours(9,0,0,0); }
    pickupDateEl.value = formatDateUTC(p);
    pickupTimeEl.value = formatTimeUTC(p);
  }
  function syncPickupHiddenValue() {
    if (!pickupDateEl.value || !pickupTimeEl.value) { pickupHiddenEl.value = ""; return; }
    pickupHiddenEl.value = pickupDateEl.value + "T" + pickupTimeEl.value;
  }
  function isLatePickupTime(tv) {
    var match = String(tv||"").match(/^(\\d{2}):(\\d{2})$/);
    if (!match) return false;
    var h = Number(match[1]);
    return h >= 21;
  }
  function maybeWarnLatePickup(force) {
    var shouldWarn = isLatePickupTime(pickupTimeEl.value);
    pickupTimeEl.classList.toggle("late-pickup", shouldWarn);
    if (!shouldWarn) { latePickupWarned = false; return; }
    if (force || !latePickupWarned) { window.alert(messages.latePickupWarning); latePickupWarned = true; }
  }
  function setMeta(msg) { if (priceMetaEl) priceMetaEl.textContent = msg; }
  function formatMessage(tpl, vals) {
    return tpl.replace(/\\{(\\w+)\\}/g, function(_,k){ return vals.hasOwnProperty(k) ? String(vals[k]) : ""; });
  }

  /* bag qty pickers */
  function syncBagPicker(sel, cust, hid) {
    if (sel.value === "custom") {
      cust.classList.remove("is-hidden"); cust.required = true;
      var min = Number(cust.min||11), max = Number(cust.max||99), v = Number(cust.value||0);
      if (!Number.isInteger(v)||v<min||v>max) { hid.value = ""; return false; }
      hid.value = String(v); return true;
    }
    cust.classList.add("is-hidden"); cust.required = false; cust.value = "";
    hid.value = sel.value; return true;
  }
  function syncBagQuantities() {
    var a = syncBagPicker(suitcaseSelectEl, suitcaseCustomEl, suitcaseEl);
    var b = syncBagPicker(backpackSelectEl, backpackCustomEl, backpackEl);
    return a && b;
  }
  function initBagQuantityPickers() {
    var onChanged = function(){ syncBagQuantities(); refreshPreview(); };
    suitcaseSelectEl.addEventListener("change", onChanged);
    backpackSelectEl.addEventListener("change", onChanged);
    suitcaseCustomEl.addEventListener("input", onChanged);
    suitcaseCustomEl.addEventListener("change", onChanged);
    backpackCustomEl.addEventListener("input", onChanged);
    backpackCustomEl.addEventListener("change", onChanged);
    syncBagQuantities();
  }

  /* companion picker */
  function syncCompanionCount() {
    if (!companionSelectEl || !companionCustomEl || !companionHiddenEl) return true;
    if (companionSelectEl.value === "custom") {
      companionCustomEl.classList.remove("is-hidden"); companionCustomEl.required = true;
      var min = Number(companionCustomEl.min||11), max = Number(companionCustomEl.max||99), v = Number(companionCustomEl.value||0);
      if (!Number.isInteger(v)||v<min||v>max) { companionHiddenEl.value = ""; return false; }
      companionHiddenEl.value = String(v); return true;
    }
    companionCustomEl.classList.add("is-hidden"); companionCustomEl.required = false; companionCustomEl.value = "";
    companionHiddenEl.value = companionSelectEl.value; return true;
  }
  function initCompanionPicker() {
    if (!companionSelectEl || !companionCustomEl || !companionHiddenEl) return;
    companionSelectEl.addEventListener("change", syncCompanionCount);
    companionCustomEl.addEventListener("input", syncCompanionCount);
    companionCustomEl.addEventListener("change", syncCompanionCount);
    syncCompanionCount();
  }

  /* file pickers */
  function loadImageElement(file) {
    return new Promise(function(resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function(){ URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function(){ URL.revokeObjectURL(url); reject(new Error("Image load failed")); };
      img.src = url;
    });
  }
  function canvasToBlob(canvas, type, quality) {
    return new Promise(function(resolve){ canvas.toBlob(function(blob){ resolve(blob); }, type, quality); });
  }
  function shouldOptimizeImage(file) {
    if (!file||!file.type||!file.type.startsWith("image/")) return false;
    var ct = file.type.toLowerCase();
    return ct.includes("heic")||ct.includes("heif")||file.size>=OPTIMIZE_SIZE_THRESHOLD;
  }
  function baseName(fn) { return String(fn||"photo").replace(/\\.[^.]+$/,"").slice(0,40); }
  function formatFileSize(bytes) {
    var v = Number(bytes||0);
    if (v>=1024*1024) return (v/(1024*1024)).toFixed(1)+"MB";
    return Math.max(Math.round(v/1024),1)+"KB";
  }
  async function optimizeImageFile(file) {
    if (!file||!file.type||!file.type.startsWith("image/")) return file;
    var img; try { img = await loadImageElement(file); } catch(e) { return file; }
    var w = Number(img.naturalWidth||img.width||0), h = Number(img.naturalHeight||img.height||0);
    if (w<1||h<1) return file;
    var scale = Math.min(1, MAX_IMAGE_DIMENSION/Math.max(w,h));
    var tw = Math.max(Math.round(w*scale),1), th = Math.max(Math.round(h*scale),1);
    var canvas = document.createElement("canvas"); canvas.width = tw; canvas.height = th;
    var ctx = canvas.getContext("2d"); if (!ctx) return file;
    ctx.drawImage(img, 0, 0, tw, th);
    var qualities = [0.86,0.76,0.66,0.56]; var best = null;
    for (var i=0;i<qualities.length;i++) {
      var blob = await canvasToBlob(canvas,"image/jpeg",qualities[i]);
      if (!blob) continue;
      if (!best||blob.size<best.size) best=blob;
      if (blob.size<=TARGET_IMAGE_BYTES) { best=blob; break; }
    }
    if (!best) return file;
    if (best.size>=file.size*0.96&&file.size<=TARGET_IMAGE_BYTES) return file;
    return new File([best], baseName(file.name)+"-opt.jpg", {type:"image/jpeg",lastModified:Date.now()});
  }
  async function optimizeInputIfNeeded(inputEl, textEl, emptyText) {
    if (!inputEl||!textEl) return;
    var src = inputEl.files&&inputEl.files[0];
    if (!src) { optimizedFilesByField.delete(inputEl.name); textEl.textContent=emptyText||""; return; }
    textEl.textContent = src.name;
    if (!shouldOptimizeImage(src)) { optimizedFilesByField.set(inputEl.name,src); return; }
    var opt = await optimizeImageFile(src);
    optimizedFilesByField.set(inputEl.name, opt);
    if (opt!==src) textEl.textContent = src.name+" · "+messages.fileOptimized+" ("+formatFileSize(opt.size)+")";
  }
  function initFilePickers() {
    var triggers = Array.from(document.querySelectorAll("[data-file-trigger]"));
    triggers.forEach(function(trigger){
      var inputId = trigger.getAttribute("data-file-trigger");
      var inputEl = document.getElementById(inputId);
      var textEl = document.getElementById(inputId+"_name");
      if (!inputEl||!textEl) return;
      var emptyText = textEl.getAttribute("data-file-empty")||"";
      trigger.addEventListener("click", function(){ inputEl.click(); });
      inputEl.addEventListener("change", async function(){
        if (!inputEl.files||inputEl.files.length===0) {
          optimizedFilesByField.delete(inputEl.name); textEl.textContent=emptyText; return;
        }
        try {
          setUploadStatus(messages.uploadOptimizing,"busy");
          await optimizeInputIfNeeded(inputEl, textEl, emptyText);
          clearUploadStatus();
        } catch(e) {
          optimizedFilesByField.set(inputEl.name, inputEl.files[0]);
          textEl.textContent = inputEl.files[0].name;
          setUploadStatus(messages.uploadError,"error");
        }
      });
    });
  }

  /* price preview */
  async function refreshPreview() {
    syncPickupHiddenValue();
    var sq = Number(suitcaseEl.value||0), bq = Number(backpackEl.value||0);
    var ep = pickupHiddenEl.value;
    if (!ep||(sq===0&&bq===0)) { priceValueEl.textContent="-"; setMeta(messages.metaEmpty); return; }
    try {
      var params = new URLSearchParams({suitcase_qty:String(sq),backpack_qty:String(bq),expected_pickup_at:ep});
      var resp = await fetch("/api/price-preview?"+params.toString());
      var data = await resp.json();
      if (!resp.ok) { priceValueEl.textContent=messages.invalidTitle; setMeta(data.detail||messages.invalidMeta); return; }
      var ratePct = Math.round(data.discount_rate*100);
      priceValueEl.textContent = "\\u00A5"+data.prepaid_amount.toLocaleString();
      setMeta(formatMessage(messages.resultMeta,{price_per_day:"\\u00A5"+data.price_per_day.toLocaleString(),days:data.expected_storage_days,discount:ratePct}));
    } catch(e) { priceValueEl.textContent=messages.errorTitle; setMeta(messages.errorMeta); }
  }

  /* init */
  buildPickupTimeOptions();
  var todayTokyo = getTokyoNow();
  pickupDateEl.min = formatDateUTC(todayTokyo);
  setDefaultPickupByTokyoTime();
  syncPickupHiddenValue();

  [pickupDateEl, pickupTimeEl].forEach(function(el){
    el.addEventListener("change", refreshPreview);
    el.addEventListener("input", refreshPreview);
  });
  pickupTimeEl.addEventListener("change", function(){ maybeWarnLatePickup(false); });

  initCompanionPicker();
  initBagQuantityPickers();
  initFilePickers();

  /* submit */
  formEl.addEventListener("submit", async function(event){
    event.preventDefault();
    if (isSubmitting) return;
    syncPickupHiddenValue();
    var bagValid = syncBagQuantities();
    if (!bagValid) {
      if (suitcaseSelectEl.value==="custom"&&!suitcaseEl.value) { suitcaseCustomEl.focus(); return; }
      if (backpackSelectEl.value==="custom"&&!backpackEl.value) { backpackCustomEl.focus(); return; }
      return;
    }
    var compValid = syncCompanionCount();
    if (!compValid && companionCustomEl) { companionCustomEl.focus(); return; }
    maybeWarnLatePickup(false);
    isSubmitting = true;
    setSubmitBusy(true);
    try {
      /* optimize images */
      var fileTargets = [
        {inputEl:idImageInputEl,textEl:document.getElementById("id_image_name")},
        {inputEl:luggageImageInputEl,textEl:document.getElementById("luggage_image_name")}
      ];
      setUploadStatus(messages.uploadOptimizing,"busy");
      await Promise.all(fileTargets.map(function(t){
        if(!t.inputEl||!t.textEl) return Promise.resolve();
        var empty = t.textEl.getAttribute("data-file-empty")||"";
        return optimizeInputIfNeeded(t.inputEl,t.textEl,empty);
      }));
      clearUploadStatus();
      setUploadStatus(messages.uploadSubmitting,"busy");
      var hasDataTransfer = typeof DataTransfer === "function";
      var idImg = optimizedFilesByField.get("id_image");
      var lugImg = optimizedFilesByField.get("luggage_image");
      if (idImg && idImageInputEl && hasDataTransfer) { var dt1=new DataTransfer(); dt1.items.add(idImg); idImageInputEl.files=dt1.files; }
      if (lugImg && luggageImageInputEl && hasDataTransfer) { var dt2=new DataTransfer(); dt2.items.add(lugImg); luggageImageInputEl.files=dt2.files; }
      formEl.submit();
    } catch(e) {
      setUploadStatus(messages.uploadError,"error");
      window.alert(messages.uploadError);
      isSubmitting = false;
      setSubmitBusy(false);
    }
  });

  refreshPreview();
})();
        `}} />
      </body>
    </html>
  );
});

// ---------------------------------------------------------------------------
// POST /customer/submit — Process form
// ---------------------------------------------------------------------------
customer.post("/customer/submit", async (c) => {
  const body = await c.req.parseBody();
  const lang = normalizeLang(String(body.lang || ""));

  const redirect = (msg: string) =>
    c.redirect(`/customer?error=${encodeURIComponent(msg)}&lang=${lang}`);

  // --- Field extraction ---
  const name = String(body.name || "").trim();
  const phone = String(body.phone || "").trim();
  const companionCount = parseInt(String(body.companion_count || "0"), 10) || 0;
  const suitcaseQty = Math.min(99, parseInt(String(body.suitcase_qty || "0"), 10) || 0);
  const backpackQty = Math.min(99, parseInt(String(body.backpack_qty || "0"), 10) || 0);
  const expectedPickupAt = String(body.expected_pickup_at || "").trim();
  const flyingPassTier = normalizeFlyingPassTier(String(body.flying_pass_tier || ""));
  const consentChecked = String(body.consent_checked || "") === "1";

  // --- Validation ---
  if (!name) return redirect(t("required", lang) + ": " + t("name", lang));
  if (!phone || !/^[\d\s\-+()]{6,20}$/.test(phone)) return redirect(t("required", lang) + ": " + t("phone", lang));
  if (suitcaseQty <= 0 && backpackQty <= 0) {
    return redirect(t("required", lang) + ": " + t("suitcase_qty", lang) + "/" + t("backpack_qty", lang));
  }
  if (!expectedPickupAt) return redirect(t("required", lang) + ": " + t("expected_pickup", lang));
  if (!consentChecked) return redirect(t("consent_label", lang));

  const pickupDate = new Date(expectedPickupAt);
  if (isNaN(pickupDate.getTime())) {
    return redirect(t("error", lang));
  }

  // Validate business hours using the raw form value (already in JST)
  // Extract hour from "YYYY-MM-DDTHH:MM" string directly
  const pickupTimeMatch = String(expectedPickupAt).match(/T(\d{2}):(\d{2})/);
  const pickupHour = pickupTimeMatch ? parseInt(pickupTimeMatch[1], 10) : -1;
  const pickupMin = pickupTimeMatch ? parseInt(pickupTimeMatch[2], 10) : 0;
  if (pickupHour < 9 || pickupHour > 21 || (pickupHour === 21 && pickupMin > 0)) {
    return redirect(t("pickup_note", lang));
  }

  // --- Generate order ID and tag number (parallel) ---
  const [orderId, tagNo] = await Promise.all([
    buildOrderId(c.env.DB),
    buildTagNo(c.env.DB),
  ]);

  // --- Upload images ---
  let idImageUrl: string | null = null;
  let luggageImageUrl: string | null = null;

  try {
    const idImageFile = body.id_image;
    if (idImageFile && idImageFile instanceof File && idImageFile.size > 0) {
      const validation = validateImageUpload(idImageFile.size, idImageFile.type);
      if (!validation.valid) return redirect(validation.error || t("upload_error", lang));
      const ext = extFromContentType(idImageFile.type);
      const key = buildImageKey("id", orderId, ext);
      const buffer = await idImageFile.arrayBuffer();
      await uploadImage(c.env.IMAGES, key, buffer, idImageFile.type);
      idImageUrl = key;
    }

    const luggageImageFile = body.luggage_image;
    if (luggageImageFile && luggageImageFile instanceof File && luggageImageFile.size > 0) {
      const validation = validateImageUpload(luggageImageFile.size, luggageImageFile.type);
      if (!validation.valid) return redirect(validation.error || t("upload_error", lang));
      const ext = extFromContentType(luggageImageFile.type);
      const key = buildImageKey("luggage", orderId, ext);
      const buffer = await luggageImageFile.arrayBuffer();
      await uploadImage(c.env.IMAGES, key, buffer, luggageImageFile.type);
      luggageImageUrl = key;
    }
  } catch (e) {
    console.error("Image upload failed:", e);
    return redirect(t("upload_error", lang));
  }

  // --- Pricing ---
  const now = new Date();
  const storageDays = calculateStorageDays(now, pickupDate);
  const { setQty, pricePerDay } = calculatePricePerDay(suitcaseQty, backpackQty);
  const { discountRate, prepaidAmount } = calculatePrepaidAmount(pricePerDay, storageDays);
  const passDiscount = flyingPassDiscountAmount(prepaidAmount, flyingPassTier);
  const finalPrepaid = Math.max(0, prepaidAmount - passDiscount);

  // --- Insert order (clean up R2 on failure) ---
  try {
    await c.env.DB.prepare(
      `INSERT INTO luggage_orders (
        order_id, tag_no, name, phone, companion_count,
        suitcase_qty, backpack_qty, set_qty,
        expected_pickup_at, expected_storage_days,
        price_per_day, discount_rate, prepaid_amount,
        flying_pass_tier, flying_pass_discount_amount, final_amount,
        id_image_url, luggage_image_url,
        consent_checked, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAYMENT_PENDING')`
    )
      .bind(
        orderId,
        tagNo,
        name,
        phone,
        companionCount,
        suitcaseQty,
        backpackQty,
        setQty,
        pickupDate.toISOString(),
        storageDays,
        pricePerDay,
        discountRate,
        prepaidAmount,
        flyingPassTier,
        passDiscount,
        finalPrepaid,
        idImageUrl,
        luggageImageUrl,
        1
      )
      .run();
  } catch (e) {
    // Clean up orphaned R2 objects
    if (idImageUrl) try { await c.env.IMAGES.delete(idImageUrl); } catch { /* best-effort */ }
    if (luggageImageUrl) try { await c.env.IMAGES.delete(luggageImageUrl); } catch { /* best-effort */ }
    console.error("Order insert failed:", e);
    return redirect(t("upload_error", lang));
  }

  return c.redirect(`/customer/orders/${orderId}?lang=${lang}`);
});

// ---------------------------------------------------------------------------
// GET /customer/orders/:id — Success / order summary page
// ---------------------------------------------------------------------------
customer.get("/customer/orders/:id", async (c) => {
  const orderId = c.req.param("id");
  const lang = normalizeLang(c.req.query("lang"));

  const order = await c.env.DB.prepare(
    `SELECT order_id, name, suitcase_qty, backpack_qty, set_qty,
            expected_pickup_at, expected_storage_days,
            price_per_day, discount_rate, prepaid_amount,
            flying_pass_tier, flying_pass_discount_amount, final_amount,
            status, created_at
     FROM luggage_orders WHERE order_id = ?`
  )
    .bind(orderId)
    .first<{
      order_id: string;
      name: string;
      suitcase_qty: number;
      backpack_qty: number;
      set_qty: number;
      expected_pickup_at: string;
      expected_storage_days: number;
      price_per_day: number;
      discount_rate: number;
      prepaid_amount: number;
      flying_pass_tier: string;
      flying_pass_discount_amount: number;
      final_amount: number;
      status: string;
      created_at: string;
    }>();

  if (!order) {
    return c.html(
      <html>
        <head><meta charset="UTF-8" /><title>Not Found</title></head>
        <body><h1>Order not found</h1></body>
      </html>,
      404
    );
  }

  const completionMsgs = await loadCompletionMessages(c.env.DB);
  const finalAmountFormatted = `¥${order.final_amount.toLocaleString()}`;
  const primaryMsg = applyAmountTemplate(completionMsgs.primary[lang] ?? completionMsgs.primary["ko"], finalAmountFormatted);
  const secondaryMsg = completionMsgs.secondary[lang] ?? completionMsgs.secondary["ko"];

  const pickupAtDisplay = order.expected_pickup_at
    ? new Date(order.expected_pickup_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
    : "-";

  const footerHours: Record<string, string> = {
    ko: "영업시간: 09:00~21:00", en: "Hours: 09:00-21:00", ja: "営業時間: 09:00〜21:00",
  };
  const footerCopyright = "© 2026 Flying Inc. All rights reserved.";

  const summaryLabel: Record<string, string> = {
    ko: "접수 정보", en: "Order Summary", ja: "受付情報",
  };
  const finalAmountLabel: Record<string, string> = {
    ko: "최종금액", en: "Final Amount", ja: "最終金額",
  };
  const fpDiscountLabel: Record<string, string> = {
    ko: "플라잉패스 할인", en: "Flying Pass Discount", ja: "フライングパス割引",
  };

  return c.html(
    <html lang={lang}>
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{t("success_title", lang)} — {t("brand_name", lang)}</title>
        <link rel="preconnect" href="https://cdn.jsdelivr.net" />
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css" />
        <style dangerouslySetInnerHTML={{__html: `
:root {
  --bg: #eef3fb;
  --surface: #ffffff;
  --line: #dbe4f2;
  --line-strong: #cedaee;
  --text: #191f28;
  --subtext: #4a5668;
  --muted: #7d8794;
  --primary: #2f80f8;
  --primary-strong: #1e63da;
  --positive: #12b886;
  --warning: #ef7d22;
  --radius-xl: 26px;
  --radius-lg: 20px;
  --radius-md: 12px;
  --shadow-sm: 0 10px 30px rgba(16,31,60,0.07);
  --shadow-lg: 0 22px 52px rgba(39,103,209,0.18);
}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; width: 100%; overflow-x: hidden; }
body {
  position: relative;
  font-family: "Pretendard", "Noto Sans KR", "Noto Sans JP", sans-serif;
  color: var(--text);
  background:
    radial-gradient(1200px 560px at -10% -8%, rgba(141,190,255,0.42) 0%, rgba(141,190,255,0) 68%),
    radial-gradient(980px 520px at 106% -14%, rgba(138,220,255,0.34) 0%, rgba(138,220,255,0) 70%),
    linear-gradient(180deg, #f2f6ff 0%, #edf3fc 100%);
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  overflow-x: hidden;
}
body::before {
  content: "";
  position: fixed; inset: 0; z-index: -2;
  pointer-events: none;
  background-image: radial-gradient(circle at 1px 1px, rgba(87,111,150,0.08) 1px, transparent 0);
  background-size: 28px 28px;
  mask-image: linear-gradient(180deg, rgba(0,0,0,0.22), transparent 68%);
}
a { color: inherit; text-decoration: none; }
.bg-orb { position: fixed; z-index: -1; width: 560px; height: 560px; border-radius: 50%; filter: blur(72px); opacity: 0.48; pointer-events: none; }
.bg-orb-left { left: -200px; top: -190px; background: #95bdff; }
.bg-orb-right { right: -220px; top: -70px; background: #8fdfff; }
.topbar {
  position: sticky; top: 0; z-index: 30;
  backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  border-bottom: 1px solid rgba(136,158,195,0.22);
  background: linear-gradient(180deg, rgba(246,250,255,0.93) 0%, rgba(241,247,255,0.84) 100%);
  box-shadow: 0 8px 24px rgba(17,34,68,0.08);
}
.topbar-inner {
  width: 100%; max-width: 560px; margin-inline: auto;
  padding: 13px 18px; display: flex; align-items: center;
  justify-content: space-between; gap: 12px;
}
.brand {
  display: inline-flex; align-items: center; gap: 10px;
  font-size: 18px; font-weight: 800; letter-spacing: -0.02em;
}
.lang-switcher {
  display: inline-flex; background: rgba(231,240,252,0.88);
  border-radius: 999px; padding: 3px; border: 1px solid #d4dfef;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.75);
}
.lang-btn {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 6px 12px; font-size: 12px; font-weight: 700; color: #3d4d66;
  border-radius: 999px; text-decoration: none;
  transition: background 0.2s ease, color 0.2s ease; line-height: 1;
}
.lang-btn:hover { background: rgba(220,232,251,0.8); }
.lang-btn-active { background: var(--primary); color: #fff; box-shadow: 0 2px 8px rgba(47,128,248,0.3); }
.lang-btn-active:hover { background: var(--primary-strong); color: #fff; }
.page-wrap {
  width: 100%; max-width: 520px; margin: 28px auto 48px;
  padding: 0 16px; display: grid; gap: 16px;
}
.card {
  background: linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(252,254,255,0.99) 100%);
  border: 1px solid var(--line); border-radius: var(--radius-xl);
  box-shadow: var(--shadow-sm), inset 0 1px 0 rgba(255,255,255,0.78);
  padding: 24px;
  animation: riseIn 0.42s ease both;
}
@keyframes riseIn {
  from { opacity: 0; transform: translateY(14px); }
  to   { opacity: 1; transform: translateY(0); }
}
.success-header {
  display: flex; flex-direction: column; align-items: center;
  text-align: center; gap: 14px; padding-bottom: 20px;
  border-bottom: 1px solid var(--line);
}
.check-badge {
  width: 64px; height: 64px; border-radius: 50%;
  background: linear-gradient(135deg, #22c87a 0%, #0fa966 100%);
  box-shadow: 0 8px 24px rgba(18,184,134,0.36);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.success-title {
  margin: 0; font-size: 22px; font-weight: 800; letter-spacing: -0.03em; color: var(--text);
}
.order-id-chip {
  display: inline-flex; align-items: center; gap: 8px;
  background: #eaf2ff; border: 1px solid #c5d9f8;
  border-radius: 999px; padding: 6px 16px;
}
.order-id-label { font-size: 12px; font-weight: 600; color: var(--subtext); }
.order-id-value { font-size: 18px; font-weight: 900; color: var(--primary); letter-spacing: 0.02em; }
.summary-title {
  margin: 0 0 14px; font-size: 14px; font-weight: 700; color: var(--subtext);
  text-transform: uppercase; letter-spacing: 0.04em;
}
.summary-list { display: grid; gap: 0; }
.summary-row {
  display: flex; justify-content: space-between; align-items: baseline;
  padding: 11px 0; border-bottom: 1px solid var(--line); gap: 12px;
}
.summary-row:last-child { border-bottom: none; }
.summary-key { font-size: 13px; color: var(--muted); font-weight: 500; flex-shrink: 0; }
.summary-val { font-size: 14px; font-weight: 700; color: var(--text); text-align: right; }
.summary-val-final { font-size: 18px; font-weight: 900; color: var(--primary); }
.notice-row { display: flex; align-items: flex-start; gap: 8px; }
.notice-muted { font-size: 13px; color: var(--muted); margin: 0; line-height: 1.5; }
.notice-warning { font-size: 13px; color: var(--warning); margin: 0; font-weight: 600; line-height: 1.5; }
.notice-icon { font-size: 15px; flex-shrink: 0; line-height: 1.5; }
.qr-wrap {
  display: flex; flex-direction: column; align-items: center; gap: 12px;
}
.qr-img-wrap {
  border: 2px solid var(--line); border-radius: 16px; padding: 12px;
  background: #fff; box-shadow: var(--shadow-sm);
}
.qr-order-id { font-size: 13px; color: var(--subtext); font-weight: 600; letter-spacing: 0.04em; }
.completion-msg {
  font-size: 14px; line-height: 1.7; color: var(--text);
  white-space: pre-line; text-align: center;
}
.secondary-msg {
  font-size: 13px; line-height: 1.7; color: var(--subtext);
  white-space: pre-line; text-align: center;
}
.site-footer {
  padding: 28px 16px 24px; text-align: center;
}
.footer-inner { max-width: 400px; margin: 0 auto; }
.footer-logo { display: block; margin: 0 auto 12px; }
.footer-info { display: grid; gap: 3px; font-size: 12px; color: var(--muted); line-height: 1.6; }
.footer-copy { margin-top: 10px; font-size: 11px; color: var(--muted); }
        `}} />
      </head>
      <body>
        <div class="bg-orb bg-orb-left" />
        <div class="bg-orb bg-orb-right" />

        <header class="topbar">
          <div class="topbar-inner">
            <a href={`/customer?lang=${lang}`} class="brand">
              <img src="/static/logo-horizontal.png?v=2" alt={t("brand_name", lang)} height="26" style="mix-blend-mode:multiply" />
            </a>
            <nav class="lang-switcher">
              <a href={`/customer/orders/${orderId}?lang=ko`} class={`lang-btn${lang === "ko" ? " lang-btn-active" : ""}`}>한국어</a>
              <a href={`/customer/orders/${orderId}?lang=en`} class={`lang-btn${lang === "en" ? " lang-btn-active" : ""}`}>EN</a>
              <a href={`/customer/orders/${orderId}?lang=ja`} class={`lang-btn${lang === "ja" ? " lang-btn-active" : ""}`}>日本語</a>
            </nav>
          </div>
        </header>

        <main class="page-wrap">

          {/* Success header card */}
          <div class="card">
            <div class="success-header">
              <div class="check-badge">
                <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M7 16.5L13 22.5L25 10" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </div>
              <h1 class="success-title">{t("success_title", lang)}</h1>
              <div class="order-id-chip">
                <span class="order-id-label">{t("order_id_label", lang)}</span>
                <span class="order-id-value">{order.order_id}</span>
              </div>
            </div>
            <div style="text-align:center;display:grid;gap:14px;padding-top:16px">
              <div class="completion-msg" dangerouslySetInnerHTML={{__html: primaryMsg
                .replace(/\n/g, "<br/>")
                .replace(/(접수 된 순서대로 성함을 불러드리겠습니다|We will call your name in the order received|受付順にお名前をお呼びします)/g, '<strong style="font-size:15px;color:var(--text)">$1</strong>')
                .replace(/(¥[\d,]+)/g, '<strong style="color:var(--primary);font-size:115%">$1</strong>')
                .replace(/(정확한 금액은 변동 될 수 있음|The exact amount may vary\.|正確な金額は変動する場合があります。)/g, '<span style="font-size:11px;color:var(--muted)">$1</span>')
              }} />
              <p style="margin:0;padding:8px 12px;background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;font-size:12px;font-weight:700;color:#dc2626;text-align:center">{lang === "ja" ? "⚠️ クレジットカード・デビットカード不可（現金またはQR決済のみ）" : lang === "en" ? "⚠️ Credit/debit cards NOT accepted (cash or QR pay only)" : "⚠️ 신용카드/체크카드 결제 불가 (현금 또는 QR결제만 가능)"}</p>
            </div>
          </div>

          {/* Benefits card — separate */}
          {(() => {
            const lines = secondaryMsg.split("\n");
            const title = lines[0] || "";
            const body = lines.slice(1).join("\n");
            return (
              <div class="card" style="text-align:center;padding:16px 20px;display:grid;gap:8px">
                <p style="font-size:20px;font-weight:800;color:var(--text);margin:0;letter-spacing:-0.02em" dangerouslySetInnerHTML={{__html: title }} />
                <p class="secondary-msg" style="margin:0;font-size:13px;line-height:1.6" dangerouslySetInnerHTML={{__html: body
                  .replace(/\n/g, "<br/>")
                  .replace(/(최대 17% 할인!|up to 17% off|最大17%割引)/g, '<strong style="color:var(--primary)">$1</strong>')
                  .replace(/(플라잉 화이트패스|Flying White Pass|フライングホワイトパス)/g, '<strong>$1</strong>')
                }} />
                <img src="/static/flying-pass-white.jpg" alt="Flying Pass White + EDION Coupon" style="width:100%;max-width:260px;margin:2px auto 0;display:block" />
              </div>
            );
          })()}

          {/* Rental suggestion */}
          {(() => {
            const rentalTitle: Record<string, string> = {
              ko: "편리한 여행을 위해 준비했어요 ✈️",
              en: "We've prepared these for your trip ✈️",
              ja: "快適な旅のためにご用意しました ✈️",
            };
            const rentalSub: Record<string, string> = {
              ko: "센터에서 바로 대여 가능한 렌탈 서비스",
              en: "Rental services available right at our center",
              ja: "センターですぐレンタルできるサービス",
            };
            const rentalItems = [
              { emoji: "🎮", ko: "마리오 파워업밴드", en: "Mario Power-Up Band", ja: "マリオパワーアップバンド", url: "https://mkt.shopping.naver.com/link/6980349d41a1733726ec62aa" },
              { emoji: "🪄", ko: "해리포터 지팡이", en: "Harry Potter Wand", ja: "ハリーポッター杖", url: "https://mkt.shopping.naver.com/link/68dce579a48a271c2018bb54" },
              { emoji: "💇", ko: "다이슨 에어랩", en: "Dyson Airwrap", ja: "ダイソン エアラップ", url: "https://mkt.shopping.naver.com/link/6980349d92a45c3c29778596" },
              { emoji: "✨", ko: "다이슨 고데기", en: "Dyson Airstraight", ja: "ダイソン ストレートナー", url: "https://mkt.shopping.naver.com/link/6980349d3b9377397d436f46" },
              { emoji: "👶", ko: "유모차 대여", en: "Stroller Rental", ja: "ベビーカーレンタル", url: "https://mkt.shopping.naver.com/link/68dce520772f4564fe84320a" },
              { emoji: "🎫", ko: "플라잉패스 먹방패스", en: "Flying Food Pass", ja: "フライングフードパス", url: "https://mkt.shopping.naver.com/link/694123cd003f786e5c3c350e" },
            ];
            return (
              <div class="card" style="padding:20px;background:linear-gradient(135deg,rgba(234,242,255,0.9) 0%,rgba(255,255,255,0.95) 50%,rgba(234,242,255,0.9) 100%);border:1px solid rgba(47,128,248,0.15)">
                <h3 style="text-align:center;font-size:17px;font-weight:800;margin:0 0 4px;color:var(--text)">{rentalTitle[lang] || rentalTitle.ko}</h3>
                <p style="text-align:center;font-size:12px;color:var(--primary);margin:0 0 16px;font-weight:500">✨ {rentalSub[lang] || rentalSub.ko} ✨</p>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px">
                  {rentalItems.map(item => (
                    <a href={item.url} target="_blank" rel="noopener" style="display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 8px;border-radius:var(--radius-md);border:1px solid var(--line);text-decoration:none;color:var(--text);transition:border-color .2s,box-shadow .2s;background:var(--surface)">
                      <span style="font-size:28px">{item.emoji}</span>
                      <span style="font-size:12px;font-weight:600;text-align:center;line-height:1.3">{lang === "en" ? item.en : lang === "ja" ? item.ja : item.ko}</span>
                    </a>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Order summary card */}
          <div class="card">
            <p class="summary-title">{summaryLabel[lang] || summaryLabel.ko}</p>
            <div class="summary-list">
              <div class="summary-row">
                <span class="summary-key">{t("order_id_label", lang)}</span>
                <span class="summary-val">{order.order_id}</span>
              </div>
              <div class="summary-row">
                <span class="summary-key">{t("name", lang)}</span>
                <span class="summary-val">{order.name}</span>
              </div>
              <div class="summary-row">
                <span class="summary-key">{t("suitcase_qty", lang)}</span>
                <span class="summary-val">{order.suitcase_qty}</span>
              </div>
              <div class="summary-row">
                <span class="summary-key">{t("backpack_qty", lang)}</span>
                <span class="summary-val">{order.backpack_qty}</span>
              </div>
              <div class="summary-row">
                <span class="summary-key">{t("expected_pickup", lang)}</span>
                <span class="summary-val">{pickupAtDisplay}</span>
              </div>
              <div class="summary-row">
                <span class="summary-key">{t("expected_storage_days", lang)}</span>
                <span class="summary-val">{order.expected_storage_days}</span>
              </div>
              <div class="summary-row">
                <span class="summary-key">{t("price_per_day", lang)}</span>
                <span class="summary-val">¥{order.price_per_day.toLocaleString()}</span>
              </div>
              <div class="summary-row">
                <span class="summary-key">{t("discount_rate", lang)}</span>
                <span class="summary-val">{(order.discount_rate * 100).toFixed(0)}%</span>
              </div>
              <div class="summary-row">
                <span class="summary-key">{t("prepaid_amount", lang)}</span>
                <span class="summary-val">¥{order.prepaid_amount.toLocaleString()}</span>
              </div>
              <div class="summary-row">
                <span class="summary-key">{t("flying_pass_label", lang)}</span>
                <span class="summary-val">{order.flying_pass_tier || t("flying_pass_none", lang)}</span>
              </div>
              <div class="summary-row">
                <span class="summary-key">{fpDiscountLabel[lang] || fpDiscountLabel.ko}</span>
                <span class="summary-val">¥{order.flying_pass_discount_amount.toLocaleString()}</span>
              </div>
              <div class="summary-row">
                <span class="summary-key">{finalAmountLabel[lang] || finalAmountLabel.ko}</span>
                <span class="summary-val summary-val-final">{finalAmountFormatted}</span>
              </div>
            </div>
          </div>

          {/* Notices */}
          <div class="card" style="padding: 16px 20px; display: grid; gap: 10px;">
            <div class="notice-row">
              <span class="notice-icon">🕐</span>
              <p class="notice-muted" dangerouslySetInnerHTML={{__html: t("pickup_note", lang)
                .replace(/(09:00~21:00|09:00-21:00|09:00〜21:00)/g, '<strong style="color:var(--text)">$1</strong>')
              }} />
            </div>
            <div class="notice-row" style="background:rgba(239,125,34,0.06);border-radius:8px;padding:10px 12px">
              <span class="notice-icon">⚠️</span>
              <p class="notice-warning" dangerouslySetInnerHTML={{__html: t("pickup_late_warning", lang)
                .replace(/(추가 요금|additional charges|追加料金)/g, '<strong style="color:#dc2626">$1</strong>')
              }} />
            </div>
          </div>



        </main>

        <footer class="site-footer">
          <div class="footer-inner">
            <img class="footer-logo" src="/static/logo-horizontal.png?v=2" alt={t("brand_name", lang)} height="28" style="mix-blend-mode:multiply" />
            <div class="footer-info">
              <span>{t("footer_company", lang)}</span>
              <span>{t("footer_address", lang)}</span>
              <span>{footerHours[lang] || footerHours.ko}</span>
              <span>{t("footer_phone", lang)}</span>
            </div>
            <p class="footer-copy">{footerCopyright}</p>
          </div>
        </footer>
      </body>
    </html>
  );
});

// ---------------------------------------------------------------------------
// GET /api/price-preview — Public JSON pricing API
// ---------------------------------------------------------------------------
customer.get("/api/price-preview", (c) => {
  const suitcaseQty = parseInt(c.req.query("suitcase_qty") || "0", 10) || 0;
  const backpackQty = parseInt(c.req.query("backpack_qty") || "0", 10) || 0;
  const expectedPickupAtRaw = c.req.query("expected_pickup_at") || "";
  const flyingPassTier = normalizeFlyingPassTier(c.req.query("flying_pass_tier"));

  const pickupDate = new Date(expectedPickupAtRaw);
  if (isNaN(pickupDate.getTime())) {
    return c.json({ error: "invalid expected_pickup_at" }, 400);
  }

  const now = new Date();
  const expectedStorageDays = calculateStorageDays(now, pickupDate);
  const { setQty, pricePerDay } = calculatePricePerDay(suitcaseQty, backpackQty);
  const { discountRate, prepaidAmount } = calculatePrepaidAmount(pricePerDay, expectedStorageDays);
  const passDiscount = flyingPassDiscountAmount(prepaidAmount, flyingPassTier);
  const finalPrepaid = Math.max(0, prepaidAmount - passDiscount);

  return c.json({
    set_qty: setQty,
    price_per_day: pricePerDay,
    expected_storage_days: expectedStorageDays,
    discount_rate: discountRate,
    prepaid_amount: prepaidAmount,
    flying_pass_discount_amount: passDiscount,
    final_prepaid: finalPrepaid,
  });
});

// Catch-all for /customer/* — return customer-friendly 404
customer.all("/customer/*", (c) => {
  const lang = normalizeLang(c.req.query("lang"));
  const titles: Record<string, string> = { ko: "페이지를 찾을 수 없습니다", en: "Page not found", ja: "ページが見つかりません" };
  const msgs: Record<string, string> = { ko: "요청하신 페이지가 존재하지 않습니다.", en: "The page you requested does not exist.", ja: "リクエストされたページは存在しません。" };
  return c.html(
    <html lang={lang}>
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>{titles[lang] || titles.ko}</title></head>
      <body>
        <div class="bg-orb bg-orb-left" /><div class="bg-orb bg-orb-right" />
        <header class="topbar"><div class="topbar-inner"><a class="brand" href="/customer"><img class="brand-logo-horizontal" src="/static/logo-horizontal.png" alt="Flying Japan" height="36" /></a></div></header>
        <main class="container" style="text-align:center;padding:60px 16px">
          <h2 style="font-size:22px;margin-bottom:8px">{titles[lang] || titles.ko}</h2>
          <p style="color:var(--muted);margin-bottom:24px">{msgs[lang] || msgs.ko}</p>
          <a class="btn btn-primary" href="/customer">{lang === "ja" ? "受付フォームへ" : lang === "en" ? "Go to check-in form" : "접수 화면으로 이동"}</a>
        </main>
      </body>
    </html>,
    404
  );
});

export default customer;
