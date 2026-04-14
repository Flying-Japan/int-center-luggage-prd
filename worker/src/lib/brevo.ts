/** Brevo (Sendinblue) transactional email client */

import { RENTAL_PROMO_LINKS } from "./rentalLinks";

const BREVO_API = "https://api.brevo.com/v3/smtp/email";
const STATIC_ASSET_VERSION = "20260401-2";

interface OrderConfirmationData {
  orderId: string;
  name: string;
  email: string;
  phone: string;
  suitcaseQty: number;
  backpackQty: number;
  expectedPickupAt: string;
  expectedStorageDays: number;
  finalAmount: number;
  lang: string;
}

export async function sendOrderConfirmation(
  apiKey: string,
  data: OrderConfirmationData
): Promise<boolean> {
  if (!apiKey) return false;

  const { orderId, name, email, phone, suitcaseQty, backpackQty, expectedPickupAt, expectedStorageDays, finalAmount, lang } = data;

  const pickupDisplay = expectedPickupAt.replace("T", " ");
  const amountFormatted = `¥${finalAmount.toLocaleString()}`;

  const subject = lang === "ja"
    ? `【Flying Japan】荷物預かり受付完了 (${orderId})`
    : lang === "en"
    ? `[Flying Japan] Luggage Storage Confirmed (${orderId})`
    : `[Flying Japan] 짐 보관 접수 완료 (${orderId})`;

  const rentalItems = [
    { img: `https://luggage.flyingjp.com/static/rental-item-mario-band.jpg?v=${STATIC_ASSET_VERSION}`, ko: "마리오 파워업밴드", en: "Mario Power-Up Band", ja: "マリオパワーアップバンド", url: RENTAL_PROMO_LINKS.usj.email },
    { img: `https://luggage.flyingjp.com/static/rental-item-hp-wand.jpg?v=${STATIC_ASSET_VERSION}`, ko: "해리포터 지팡이", en: "Harry Potter Wand", ja: "ハリーポッター杖", url: RENTAL_PROMO_LINKS.usj.email },
    { img: `https://luggage.flyingjp.com/static/rental-item-dyson-straight.jpg?v=${STATIC_ASSET_VERSION}`, ko: "다이슨 에어스트레이트", en: "Dyson Airstraight", ja: "ダイソン ストレートナー", url: RENTAL_PROMO_LINKS.dyson.email },
    { img: `https://luggage.flyingjp.com/static/rental-item-dyson-airwrap.jpg?v=${STATIC_ASSET_VERSION}`, ko: "다이슨 에어랩", en: "Dyson Airwrap", ja: "ダイソン エアラップ", url: RENTAL_PROMO_LINKS.dyson.email },
    { img: `https://luggage.flyingjp.com/static/rental-item-cybex-stroller.jpg?v=${STATIC_ASSET_VERSION}`, ko: "cybex 유모차", en: "Cybex Stroller", ja: "サイベックス ベビーカー", url: RENTAL_PROMO_LINKS.stroller.email },
    { img: `https://luggage.flyingjp.com/static/rental-item-kidstravel-stroller.jpg?v=${STATIC_ASSET_VERSION}`, ko: "키즈트레블 유모차", en: "Kids Travel Stroller", ja: "キッズトラベル ベビーカー", url: RENTAL_PROMO_LINKS.stroller.email },
    { img: `https://luggage.flyingjp.com/static/rental-item-trike-stroller.jpg?v=${STATIC_ASSET_VERSION}`, ko: "트라이크 유모차", en: "Trike Stroller", ja: "トライク ベビーカー", url: RENTAL_PROMO_LINKS.stroller.email },
  ] as const;

  const rentalCardsHtml = rentalItems.map((item, index) => {
    const label = lang === "ja" ? item.ja : lang === "en" ? item.en : item.ko;
    const isRowStart = index % 3 === 0;
    const isRowEnd = index % 3 === 2 || index === rentalItems.length - 1;
    const missingCells = index === rentalItems.length - 1 ? (3 - ((index % 3) + 1)) % 3 : 0;
    return `${isRowStart ? "<tr>" : ""}
          <td style="padding:${index < 3 ? "4px 6px 10px 0" : "10px 6px 0 0"};text-align:center;width:33.33%;vertical-align:top">
            <a href="${item.url}" style="display:block;border:1px solid #dbe4f2;border-radius:10px;overflow:hidden;background:#f8fbff;text-decoration:none">
              <img src="${item.img}" alt="${label}" width="100%" style="display:block;width:100%;height:auto;border:0" />
              <span style="display:block;padding:7px 6px 8px;font-size:10px;line-height:1.3;color:#191f28;font-weight:700">${label}</span>
            </a>
          </td>
          ${isRowEnd ? `${"<td style=\"width:33.33%\"></td>".repeat(missingCells)}</tr>` : ""}`;
  }).join("");

  const html = `
<!DOCTYPE html>
<html lang="${lang}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f2f6ff;font-family:'Pretendard','Noto Sans KR','Noto Sans JP',sans-serif;color:#191f28">
  <div style="max-width:520px;margin:24px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#2f80f8,#1e63da);padding:28px 24px;text-align:center">
      <img src="https://luggage.flyingjp.com/static/logo-horizontal-white.png" alt="Flying Japan" height="32" style="display:block;margin:0 auto 12px" />
      <h1 style="margin:0;color:#fff;font-size:20px;font-weight:800">${lang === "ja" ? "受付完了" : lang === "en" ? "Check-in Complete" : "접수 완료"} ✓</h1>
      <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:13px">${lang === "ja" ? "接収番号" : lang === "en" ? "Order No." : "접수 번호"}: <strong style="color:#fff;font-size:16px">${orderId}</strong></p>
    </div>

    <!-- Order Details -->
    <div style="padding:24px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr style="border-bottom:1px solid #f0f0ee">
          <td style="padding:10px 0;color:#787774;width:40%">${lang === "ja" ? "お名前" : lang === "en" ? "Name" : "이름"}</td>
          <td style="padding:10px 0;font-weight:600;text-align:right">${name}</td>
        </tr>
        <tr style="border-bottom:1px solid #f0f0ee">
          <td style="padding:10px 0;color:#787774">${lang === "ja" ? "連絡先" : lang === "en" ? "Phone" : "연락처"}</td>
          <td style="padding:10px 0;font-weight:600;text-align:right">${phone}</td>
        </tr>
        <tr style="border-bottom:1px solid #f0f0ee">
          <td style="padding:10px 0;color:#787774">${lang === "ja" ? "荷物" : lang === "en" ? "Luggage" : "짐 수량"}</td>
          <td style="padding:10px 0;font-weight:600;text-align:right">${lang === "ja" ? `スーツケース ${suitcaseQty} / バッグ ${backpackQty}` : lang === "en" ? `Suitcase ${suitcaseQty} / Backpack ${backpackQty}` : `캐리어 ${suitcaseQty} / 배낭/백팩 ${backpackQty}`}</td>
        </tr>
        <tr style="border-bottom:1px solid #f0f0ee">
          <td style="padding:10px 0;color:#787774">${lang === "ja" ? "受取予定" : lang === "en" ? "Pickup" : "수령 예정"}</td>
          <td style="padding:10px 0;font-weight:600;text-align:right">${pickupDisplay}</td>
        </tr>
        <tr style="border-bottom:1px solid #f0f0ee">
          <td style="padding:10px 0;color:#787774">${lang === "ja" ? "保管日数" : lang === "en" ? "Storage days" : "보관일수"}</td>
          <td style="padding:10px 0;font-weight:600;text-align:right">${expectedStorageDays}${lang === "ja" ? "日" : lang === "en" ? " days" : "일"}</td>
        </tr>
        <tr>
          <td style="padding:12px 0;color:#787774;font-size:14px">${lang === "ja" ? "お支払い金額" : lang === "en" ? "Amount" : "결제 금액"}</td>
          <td style="padding:12px 0;font-weight:800;text-align:right;font-size:18px;color:#2f80f8">${amountFormatted}</td>
        </tr>
      </table>

      <!-- No-card warning -->
      <div style="margin:16px 0;padding:12px;background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;text-align:center">
        <p style="margin:0;font-size:12px;font-weight:700;color:#dc2626">${lang === "ja" ? "⚠️ クレジットカード・デビットカード不可" : lang === "en" ? "⚠️ Credit/debit cards NOT accepted" : "⚠️ 신용카드/체크카드 결제 불가"}</p>
        <p style="margin:4px 0 0;font-size:11px;font-weight:600;color:#166534">${lang === "ja" ? "✅ 現金 / PayPay / 楽天Pay / d払い / auPay" : lang === "en" ? "✅ Cash / KakaoPay / NaverPay / TossPay / PayPay" : "✅ 현금 / 카카오페이 / 네이버페이 / 토스페이 / PayPay"}</p>
      </div>

      <!-- Pickup note -->
      <p style="margin:12px 0;padding:10px 12px;background:#eaf2ff;border-radius:8px;font-size:12px;color:#1e3a8a;font-weight:600;text-align:center">
        ${lang === "ja" ? "営業時間 09:00〜21:00 内にお受け取りください" : lang === "en" ? "Pickup available during business hours: 09:00-21:00" : "영업시간 09:00~21:00 내 수령 가능합니다"}
      </p>

      <!-- Notices / Cautions -->
      <div style="margin:12px 0;padding:12px 14px;background:#f0f7ff;border:1px solid #bfdbfe;border-radius:8px">
        <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#1e3a8a">${lang === "ja" ? "🧳 荷物預かりご注意事項" : lang === "en" ? "🧳 Luggage Storage Notice" : "🧳 짐 보관 유의사항"}</p>
        <ul style="margin:0;padding:0 0 0 16px;font-size:11px;color:#1e3a8a;line-height:1.6">
          <li>${lang === "ja" ? "料金は前払いです" : lang === "en" ? "Payment must be made in advance" : "요금은 선불 결제입니다"}</li>
          <li>${lang === "ja" ? "お預け荷物の保管前後の状態証明責任はお客様にあります" : lang === "en" ? "Customers are responsible for proving luggage condition before/after storage" : "맡기신 짐의 보관 전·후 상태 증명 책임은 고객님께 있습니다"}</li>
          <li>${lang === "ja" ? "保管中の破損・汚損・紛失については責任を負いかねます" : lang === "en" ? "We are not liable for damage, contamination, or loss during storage" : "보관 중 발생한 파손, 오염, 내용물 분실 등에 대해서는 책임을 지지 않습니다"}</li>
          <li>${lang === "ja" ? "ただし、事業者の故意または重大な過失がない限り責任を負いません" : lang === "en" ? "Unless due to our gross negligence" : "단, 사업자의 고의 또는 중대한 과실이 없는 한 파손이나 분실에 대한 책임을 지지 않습니다"}</li>
          <li>${lang === "ja" ? "高価品・貴重品は必ず別途保管してください" : lang === "en" ? "Please keep valuables and expensive items with you" : "고가품 및 귀중품은 반드시 별도로 보관해 주시기 바랍니다"}</li>
          <li>${lang === "ja" ? "営業時間(09:00〜21:00)内にお受け取りください" : lang === "en" ? "Pickup available during hours: 09:00-21:00" : "맡기신 짐은 영업시간(09:00~21:00) 내에서만 수령하실 수 있습니다"}</li>
          <li>${lang === "ja" ? "21:00以降の受取には出張料8,000円が発生します（1日保管料別途）" : lang === "en" ? "After-hours pickup: ¥8,000 dispatch fee (+ 1 day storage)" : "21:00 이후 수령 시 출동 수수료 8,000엔 부과 (1일 보관료 별도)"}</li>
          <li>${lang === "ja" ? "保管期間超過の場合、1日当たり追加料金が発生します" : lang === "en" ? "Late pickup incurs additional daily charges" : "짐 보관 기간을 초과할 경우, 1일당 추가 요금이 부과됩니다"}</li>
          <li>${lang === "ja" ? "保管期限が過ぎた物品は2週間保管後に処分されます" : lang === "en" ? "Items past storage period disposed after 2 weeks" : "보관기한이 지난 물품 및 분실물은 2주간 보관 후 폐기됩니다"}</li>
          <li>${lang === "ja" ? "紛失荷物の海外配送には1件50,000ウォンの手数料がかかります（送料別）" : lang === "en" ? "Overseas shipping for lost items: ₩50,000 per item (shipping extra)" : "짐 분실 시 해외 배송 1건당 50,000원 수수료 (배송비 별도)"}</li>
          <li>${lang === "ja" ? "紛失荷物は所有者確認後、預けた時点から日額保管料が追加請求されます" : lang === "en" ? "Lost items incur daily storage fees from original deposit date" : "분실된 짐은 소유자 확인 시 맡기신 시점부터 일일 보관요금이 추가 청구됩니다"}</li>
          <li>${lang === "ja" ? "写真は本人確認用で、2週間後に自動削除されます" : lang === "en" ? "Photos for ID verification only, auto-deleted after 2 weeks" : "사진은 본인 확인용이며, 2주 후 자동 삭제"}</li>
        </ul>
        <p style="margin:10px 0 4px;font-size:12px;font-weight:700;color:#1e3a8a">${lang === "ja" ? "🚫 お預かりできないもの" : lang === "en" ? "🚫 Items Not Accepted" : "🚫 보관불가 항목"}</p>
        <ul style="margin:0;padding:0 0 0 16px;font-size:11px;color:#1e3a8a;line-height:1.6">
          <li>${lang === "ja" ? "一辺2m超・35kg超の物品（ゴルフバッグは可）" : lang === "en" ? "Items over 2m or 35kg (golf bags OK)" : "한 변 2m, 무게 35kg 초과 물품 (골프백은 가능)"}</li>
          <li>${lang === "ja" ? "高価品・精密機器（PC・タブレット・カメラ等）" : lang === "en" ? "Valuables, electronics (laptops, tablets, cameras)" : "고가품, 정밀기기 (컴퓨터, 노트북, 태블릿PC, 카메라 등)"}</li>
          <li>${lang === "ja" ? "壊れやすいもの、動物、危険物、冷蔵冷凍・腐りやすいもの" : lang === "en" ? "Fragile items, animals, hazardous materials, perishables" : "깨지기 쉬운 것, 동물, 위험물, 냉장·냉동 또는 부패하기 쉬운 물품"}</li>
          <li>${lang === "ja" ? "液体容器（飲料・ペットボトル等）" : lang === "en" ? "Liquid containers (beverages, bottles)" : "액체가 든 용기 (음료수, 페트병 등)"}</li>
        </ul>
      </div>
    </div>

    <!-- Flying Pass White benefit -->
    <div style="padding:0 24px 24px">
      <img
        src="https://luggage.flyingjp.com/static/flying-pass-white.jpg?v=20260401-2"
        alt="Flying Pass White + EDION Coupon"
        style="display:block;width:100%;max-width:472px;height:auto;margin:0 auto;border:1px solid #e5edf9;border-radius:16px;background:#fff"
      />
    </div>

    <!-- Rental suggestions -->
    <div style="padding:0 24px 24px">
      <p style="text-align:center;font-size:14px;font-weight:700;margin:0 0 12px">${lang === "ja" ? "センターでレンタルもできます ✈️" : lang === "en" ? "Rentals available at our center ✈️" : "센터에서 대여도 가능해요 ✈️"}</p>
      <table style="width:100%;border-collapse:collapse">
        ${rentalCardsHtml}
      </table>
    </div>

    <!-- KakaoTalk -->
    <div style="padding:16px 24px;background:#f7f7f5;text-align:center;border-top:1px solid #f0f0ee">
      <p style="margin:0;font-size:12px;color:#787774">${lang === "ja" ? "お問い合わせ" : lang === "en" ? "Questions?" : "문의사항이 있으시면"}</p>
      <a href="https://pf.kakao.com/_Nrxbcj" style="display:inline-block;margin-top:8px;padding:8px 20px;background:#FEE500;color:#3C1E1E;border-radius:8px;font-size:13px;font-weight:700;text-decoration:none">💬 KakaoTalk</a>
    </div>

    <!-- Footer -->
    <div style="padding:16px 24px;text-align:center;font-size:11px;color:#a5a5a3">
      <p style="margin:0">Flying Inc. · 大阪府大阪市中央区難波3-2-18 1F</p>
      <p style="margin:4px 0 0">JP: +81 090-2254-1865 | KR: +82 070-8287-1455</p>
      <p style="margin:4px 0 0">© 2026 Flying Inc.</p>
    </div>
  </div>
</body>
</html>`;

  try {
    const resp = await fetch(BREVO_API, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        sender: { name: "Flying Japan", email: "noreply@flyingjp.com" },
        to: [{ email, name }],
        subject,
        htmlContent: html,
      }),
    });

    if (!resp.ok) {
      console.error(`Brevo error: ${resp.status} ${resp.statusText}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Failed to send email via Brevo", err);
    return false;
  }
}

/** Send extension notification email to customer */
export async function sendExtensionNotification(
  apiKey: string,
  data: { name: string; email: string; tagNo: string; amount: number }
): Promise<boolean> {
  const { name, email, tagNo, amount } = data;
  const subject = `[Flying Japan] 보관 연장 안내 — 추가 요금 ¥${amount.toLocaleString()}`;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f7f7f5;font-family:'Pretendard',sans-serif">
  <div style="max-width:480px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e5e3">
    <div style="background:linear-gradient(135deg,#1e3a5f,#2563eb);padding:24px;text-align:center">
      <img src="https://luggage.flyingjp.com/static/logo-horizontal-white.png" height="28" alt="Flying Japan" style="display:inline-block"/>
    </div>
    <div style="padding:24px">
      <h2 style="margin:0 0 16px;font-size:18px;color:#1e293b">보관 기한 연장 안내</h2>
      <p style="margin:0 0 12px;font-size:14px;color:#37352f;line-height:1.6">
        안녕하세요 <strong>${name}</strong>님,<br/>
        보관하신 짐(${tagNo})의 수령 예정 시간이 지나 <strong>자동으로 1일 연장</strong> 처리되었습니다.
      </p>
      <div style="margin:16px 0;padding:16px;background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;text-align:center">
        <p style="margin:0;font-size:13px;color:#dc2626;font-weight:700">추가 요금</p>
        <p style="margin:6px 0 0;font-size:24px;font-weight:800;color:#dc2626">¥${amount.toLocaleString()}</p>
      </div>
      <p style="margin:12px 0;font-size:13px;color:#64748b;line-height:1.6">
        수령 시 추가 요금을 결제해주세요.<br/>
        영업시간: 09:00~21:00
      </p>
      <div style="text-align:center;margin-top:16px">
        <a href="https://pf.kakao.com/_Nrxbcj" style="display:inline-block;padding:10px 24px;background:#FEE500;color:#3C1E1E;border-radius:8px;font-size:13px;font-weight:700;text-decoration:none">💬 카카오톡 문의</a>
      </div>
    </div>
    <div style="padding:16px 24px;background:#f7f7f5;text-align:center;font-size:11px;color:#94a3b8;border-top:1px solid #e5e5e3">
      <p style="margin:0">Flying Inc. · 大阪府大阪市中央区難波3-2-18 1F</p>
    </div>
  </div>
</body></html>`;

  try {
    const resp = await fetch(BREVO_API, {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        sender: { name: "Flying Japan", email: "noreply@flyingjp.com" },
        to: [{ email, name }],
        subject,
        htmlContent: html,
      }),
    });
    if (!resp.ok) { console.error(`Brevo extension email error: ${resp.status}`); return false; }
    return true;
  } catch (err) {
    console.error("Failed to send extension email", err);
    return false;
  }
}
