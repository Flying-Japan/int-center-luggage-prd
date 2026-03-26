/** Brevo (Sendinblue) transactional email client */

const BREVO_API = "https://api.brevo.com/v3/smtp/email";

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
        <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#1e3a8a">${lang === "ja" ? "ご注意事項" : lang === "en" ? "Important Notices" : "주의사항"}</p>
        <ul style="margin:0;padding:0 0 0 16px;font-size:11px;color:#1e3a8a;line-height:1.6">
          <li>${lang === "ja" ? "料金は前払いです" : lang === "en" ? "Payment must be made in advance" : "요금은 선불 결제입니다"}</li>
          <li>${lang === "ja" ? "営業時間(09:00〜21:00)内に受け取りください" : lang === "en" ? "Pickup available during hours: 09:00-21:00" : "영업시간(09:00~21:00) 내 수령 가능"}</li>
          <li>${lang === "ja" ? "受取遅延の場合、追加料金が発生します" : lang === "en" ? "Late pickup incurs additional charges" : "수령 지연 시 추가 요금 발생"}</li>
          <li>${lang === "ja" ? "保管期限が過ぎた物品は2週間保管後に処分されます" : lang === "en" ? "Items past storage period disposed after 2 weeks" : "보관기한이 지난 물품은 2주간 보관 후 폐기"}</li>
          <li>${lang === "ja" ? "写真は本人確認用で、2週間後に自動削除されます" : lang === "en" ? "Photos for ID verification only, auto-deleted after 2 weeks" : "사진은 본인 확인용이며, 2주 후 자동 삭제"}</li>
        </ul>
      </div>
    </div>

    <!-- Rental suggestions -->
    <div style="padding:0 24px 24px">
      <p style="text-align:center;font-size:14px;font-weight:700;margin:0 0 12px">${lang === "ja" ? "センターでレンタルもできます ✈️" : lang === "en" ? "Rentals available at our center ✈️" : "센터에서 대여도 가능해요 ✈️"}</p>
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="padding:4px;text-align:center;width:33%"><a href="https://mkt.shopping.naver.com/link/6980349d41a1733726ec62aa" style="display:block;padding:10px 4px;background:#f5f9ff;border-radius:8px;text-decoration:none;font-size:11px;color:#191f28;font-weight:600">🎮 ${lang === "ja" ? "マリオバンド" : lang === "en" ? "Mario Band" : "마리오밴드"}</a></td>
          <td style="padding:4px;text-align:center;width:33%"><a href="https://mkt.shopping.naver.com/link/68dce579a48a271c2018bb54" style="display:block;padding:10px 4px;background:#f5f9ff;border-radius:8px;text-decoration:none;font-size:11px;color:#191f28;font-weight:600">🪄 ${lang === "ja" ? "HP杖" : lang === "en" ? "HP Wand" : "해리포터 지팡이"}</a></td>
          <td style="padding:4px;text-align:center;width:33%"><a href="https://mkt.shopping.naver.com/link/6980349d92a45c3c29778596" style="display:block;padding:10px 4px;background:#f5f9ff;border-radius:8px;text-decoration:none;font-size:11px;color:#191f28;font-weight:600">💇 ${lang === "ja" ? "エアラップ" : lang === "en" ? "Airwrap" : "다이슨 에어랩"}</a></td>
        </tr>
        <tr>
          <td style="padding:4px;text-align:center;width:33%"><a href="https://mkt.shopping.naver.com/link/6980349d3b9377397d436f46" style="display:block;padding:10px 4px;background:#f5f9ff;border-radius:8px;text-decoration:none;font-size:11px;color:#191f28;font-weight:600">✨ ${lang === "ja" ? "ストレートナー" : lang === "en" ? "Straightener" : "다이슨 고데기"}</a></td>
          <td style="padding:4px;text-align:center;width:33%"><a href="https://mkt.shopping.naver.com/link/68dce520772f4564fe84320a" style="display:block;padding:10px 4px;background:#f5f9ff;border-radius:8px;text-decoration:none;font-size:11px;color:#191f28;font-weight:600">👶 ${lang === "ja" ? "ベビーカー" : lang === "en" ? "Stroller" : "유모차"}</a></td>
          <td style="padding:4px;text-align:center;width:33%"><a href="https://mkt.shopping.naver.com/link/694123cd003f786e5c3c350e" style="display:block;padding:10px 4px;background:#f5f9ff;border-radius:8px;text-decoration:none;font-size:11px;color:#191f28;font-weight:600">🎫 ${lang === "ja" ? "フードパス" : lang === "en" ? "Food Pass" : "먹방패스"}</a></td>
        </tr>
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
