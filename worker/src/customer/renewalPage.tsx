import { luggageCopy, interfaceCopy } from '../../customer-ui/copy';
import type { IntakeLocale } from './intakeDraft';
import { inputControlCopy } from './inputControls';

export function RenewalPage({ locale }: { locale: IntakeLocale }) {
  const c = luggageCopy[locale], ui = interfaceCopy[locale], controls = inputControlCopy[locale];
  const names = { ko: ['연락 정보', '본인 확인', '맡길 짐', '수령 계획', '요금·현장 결제', '확인·동의'],
    en: ['Contact details', 'Identity check', 'Your luggage', 'Pickup plan', 'Price and onsite payment', 'Review and consent'],
    ja: ['連絡先', '本人確認', '手荷物', '受取予定', '料金・現地支払', '確認・同意'] }[locale];
  const next = { ko: '다음', en: 'Continue', ja: '次へ' }[locale];
  const back = { ko: '이전', en: 'Back', ja: '戻る' }[locale];
  const photo = (field: 'identity' | 'luggage', label: string) => <div class="rd-stack"><label class="rd-field" for={`renewal-${field}`}>
    {label}<input id={`renewal-${field}`} type="file" accept="image/*" data-photo={field} /></label>
    {field === 'luggage' && <><input id="renewal-luggage-camera" class="renewal-camera-input" type="file" accept="image/*" capture="environment" data-photo="luggage" tabindex={-1} aria-label={controls.cameraInput} />
      <button id="renewal-camera-open" class="rd-origin-photo-button" type="button" aria-controls="renewal-luggage-camera">{controls.camera}</button></>}
    <p data-photo-name={field} role="status"></p><img data-photo-preview={field} hidden alt={label} style="max-width:100%;max-height:220px;object-fit:contain" /></div>;
  const field = (name: string, label: string, type = 'text') => <label class="rd-field" for={`renewal-${name}`}>{label}
    <input id={`renewal-${name}`} data-field={name} type={type} autocomplete={name === 'name' ? 'name' : name === 'phone' ? 'tel' : name === 'email' ? 'email' : 'off'}
      min={type === 'number' ? name === 'companionCount' ? '1' : '0' : undefined} max={type === 'number' ? '99' : undefined} /></label>;
  return <html lang={locale}><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" /><title>{c.entry} · FLYING JAPAN</title>
    <link rel="stylesheet" href="/customer/renewal/assets/app.css" /><script defer src="/customer/renewal/assets/app.js"></script></head>
    <body style="margin:0"><div class="rd-root" data-locale={locale}>
      <a class="rd-skip" href="#renewal-main">{locale === 'ko' ? '본문으로 이동' : locale === 'ja' ? '本文へ' : 'Skip to content'}</a>
      <header class="fj-customer-header"><a class="fj-customer-brand" href="/customer/renewal"><img src="/customer/renewal/assets/logo.svg" alt="FLYING JAPAN" /></a>
        <div class="fj-customer-actions"><span id="renewal-member" hidden></span><button class="fj-customer-auth" type="button" data-quick>{locale === 'ko' ? '로그인·가입' : locale === 'ja' ? 'ログイン・登録' : 'Log in / Sign up'}</button>
          <button class="fj-customer-icon" id="renewal-menu-open" type="button" aria-label={locale === 'ko' ? '메뉴 열기' : locale === 'ja' ? 'メニューを開く' : 'Open menu'} aria-controls="renewal-menu">☰</button></div></header>
      <dialog class="fj-customer-menu" id="renewal-menu"><div class="fj-customer-menu-panel"><div class="fj-customer-menu-top"><h2>{locale === 'ko' ? '메뉴' : locale === 'ja' ? 'メニュー' : 'Menu'}</h2><button class="fj-customer-icon" id="renewal-menu-close" type="button" aria-label={locale === 'ko' ? '메뉴 닫기' : locale === 'ja' ? 'メニューを閉じる' : 'Close menu'}>×</button></div>
        <div class="fj-customer-language-options">{(['ko', 'en', 'ja'] as const).map(lang => <button type="button" data-language={lang} aria-pressed={locale === lang}>{lang === 'ko' ? '한국어' : lang === 'en' ? 'English' : '日本語'}</button>)}</div></div></dialog>
      <main class="rd-main rd-stack rd-luggage-origin" id="renewal-main" tabindex={-1}>
        <section class="rd-title"><h1 id="renewal-heading" tabindex={-1}>{c.entry}</h1><p class="rd-muted">{c.centerCompact}</p></section>
        <p role="status" id="renewal-state" class="rd-muted"></p><p role="alert" id="renewal-error" class="rd-alert" hidden></p>
        <a id="renewal-receipt-link" class="rd-primary" hidden>{locale === 'ko' ? '저장된 접수 확인증 보기' : locale === 'ja' ? '保存した受付を確認' : 'View saved reception receipt'}</a>
        <section id="renewal-boundary" class="rd-card rd-stack" hidden aria-live="polite"><h2>{locale === 'ko' ? '접수 초안 확인' : locale === 'ja' ? '下書きの確認' : 'Check your reception draft'}</h2>
          <p id="renewal-boundary-info"></p>
          <button id="renewal-boundary-confirm" class="rd-primary" type="button" hidden>{locale === 'ko' ? '제가 입력한 정보·사진입니다. 이 회원으로 이어가기' : locale === 'ja' ? '私が入力した内容・写真です。この会員で続ける' : 'These are my entries and photos. Continue with this member'}</button>
          <button id="renewal-boundary-reauth" class="rd-secondary" type="button" hidden>{locale === 'ko' ? '기존 회원으로 다시 인증' : locale === 'ja' ? '元の会員で再認証' : 'Reauthenticate as the original member'}</button>
          <button id="renewal-boundary-guest" class="rd-secondary" type="button">{locale === 'ko' ? '이전 초안을 지우고 새 비회원 접수' : locale === 'ja' ? '以前の下書きを消して新しく会員登録せず受付' : 'Discard the previous draft and start a new guest reception'}</button>
          <button id="renewal-boundary-cancel" class="rd-secondary" type="button" hidden>{locale === 'ko' ? '가입 전 초안으로 돌아가기' : locale === 'ja' ? '登録前の下書きに戻る' : 'Return to the pre-login guest draft'}</button></section>
        <section id="renewal-entry" class="rd-origin-entry-choices" aria-label={ui.method}>
          <button class="rd-origin-choice rd-origin-kakao" type="button" data-entry="kakao"><span class="rd-origin-choice-title"><strong>{ui.quick}</strong><span>{ui.kakao}</span></span></button>
          <button class="rd-origin-choice" type="button" data-entry="guest"><span class="rd-origin-choice-title"><strong>{ui.general}</strong><span>{ui.manual}</span></span></button>
          <button class="rd-origin-choice" type="button" data-entry="foreign"><strong>{ui.foreign}</strong><small>{ui.languages}</small></button>
          <button class="rd-origin-choice" type="button" data-existing-booking><strong>{locale === 'ko' ? '이미 예약하셨나요?' : locale === 'ja' ? '予約済みの方' : 'Already have a booking?'}</strong><small>{locale === 'ko' ? '기존 예약 확인' : locale === 'ja' ? '既存予約の確認' : 'Continue an existing booking'}</small></button>
        </section>
        <section id="renewal-foreign" class="rd-card rd-stack" hidden><h2>English · 日本語</h2>
          <button class="rd-primary" type="button" data-entry="google">Continue with Google</button>
          <button class="rd-secondary" type="button" data-foreign-guest>Continue as guest / 会員登録せずに続ける</button>
          <button class="rd-secondary" type="button" data-back-entry>{back}</button></section>
        <section id="renewal-auth" class="rd-card rd-stack" hidden><h2 id="renewal-auth-title">{ui.kakaoTitle}</h2>
          <p id="renewal-auth-info"></p><button class="rd-primary" id="renewal-auth-start" type="button">{ui.kakaoTitle}</button>
          <button class="rd-secondary" id="renewal-auth-cancel" type="button">{ui.cancel}</button></section>
        <form id="renewal-form" class="rd-stack" hidden novalidate>
          <aside class="rd-origin-kakao-switch"><span>{ui.switchTitle}</span><button class="rd-secondary" type="button" data-quick>{ui.switchAction}</button></aside>
          <p class="rd-muted" id="renewal-progress"></p>
          <fieldset data-step="contact" class="rd-card rd-stack"><legend>{names[0]}</legend>
            {field('name', locale === 'ko' ? '이름' : locale === 'ja' ? 'お名前（フリガナ）' : 'Name')}
            {field('phone', locale === 'ko' ? '전화번호' : locale === 'ja' ? '電話番号' : 'Phone', 'tel')}{field('email', locale === 'ko' ? '이메일' : 'Email', 'email')}
            <div id="renewal-profile-conflicts" class="rd-stack" hidden></div></fieldset>
          <fieldset data-step="identity" class="rd-card rd-stack" hidden><legend>{names[1]}</legend>{photo('identity', c.identity)}
            <p class="rd-muted">{locale === 'ko' ? '얼굴과 이름만 보이게 촬영해주세요. 번호·주소는 가려도 괜찮습니다. 사진은 14일 이내 자동 삭제됩니다.' : locale === 'ja' ? '顔と氏名が見える写真を選んでください。番号・住所は隠せます。写真は14日以内に削除されます。' : 'Show your face and name. You may cover the number and address. Photos are deleted within 14 days.'}</p></fieldset>
          <fieldset data-step="luggage" class="rd-card rd-stack" hidden><legend>{names[2]}</legend>{photo('luggage', c.bagPhoto)}<div class="rd-row">{field('suitcaseQty', c.suitcase, 'number')}{field('backpackQty', c.backpack, 'number')}</div></fieldset>
          <fieldset data-step="pickup" class="rd-card rd-stack" hidden><legend>{names[3]}</legend><label class="rd-field" for="renewal-pickupDate">{c.date}
            <span class="rd-origin-date-picker"><span id="renewal-pickup-label" class="rd-origin-date-label" aria-hidden="true"></span><span aria-hidden="true">▦</span>
              <input id="renewal-pickupDate" data-field="pickupDate" type="date" required aria-describedby="renewal-date-help" /></span></label><p id="renewal-date-help" class="rd-muted">{controls.dateHelp}</p>
            <label class="rd-field" for="renewal-pickupTime">{c.time}<select id="renewal-pickupTime" data-field="pickupTime" required><option value="">{controls.choose}</option>{Array.from({ length: 25 }, (_, i) => `${String(9 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`).map(time => <option>{time}</option>)}</select></label>
            <p class="rd-origin-deadline">{locale === 'ko' ? '21:00까지 찾아주세요. 대략적인 시간이어도 괜찮아요.' : locale === 'ja' ? '21:00までにお受け取りください。おおよその時刻で構いません。' : 'Collect by 21:00. An approximate time is fine.'}</p></fieldset>
          <fieldset data-step="payment" class="rd-card rd-stack" hidden><legend>{names[4]}</legend>
            <div class="rd-price-info"><strong>{locale === 'ko' ? '예상 요금' : locale === 'ja' ? '予定料金' : 'Estimated price'}</strong><p id="renewal-price"></p><p>{locale === 'ko' ? '현장에서 금액과 결제를 확인합니다. 접수 제출만으로 결제되지 않습니다.' : locale === 'ja' ? '現地で金額と支払を確認します。受付送信だけでは決済されません。' : 'Confirm the amount and payment at the counter. Submitting does not take payment.'}</p></div>
            <fieldset class="rd-origin-payments"><legend>{c.payment}</legend><label><input type="radio" name="renewal-payment" value="CASH" checked /><span><strong>{c.cash}</strong></span></label><label><input type="radio" name="renewal-payment" value="PAY_QR" /><span><strong>{c.qr}</strong></span></label></fieldset>
            {field('companionCount', c.companions, 'number')}<p class="rd-muted">{c.companionsHelp}</p></fieldset>
          <fieldset data-step="review" class="rd-card rd-stack" hidden><legend>{names[5]}</legend><dl id="renewal-summary" class="rd-summary"></dl>
            <details><summary>{locale === 'ko' ? '보관 유의사항·개인정보 수집 안내' : locale === 'ja' ? '注意事項・個人情報の取扱い' : 'Storage and privacy notice'}</summary><div id="renewal-notice"></div></details>
            <label class="rd-row"><input type="checkbox" id="renewal-consent" />{c.consent}</label></fieldset>
          <div class="rd-form-action rd-stack"><button class="rd-primary" id="renewal-next" type="button">{next}</button><button class="rd-primary" id="renewal-submit" type="submit" hidden>{c.submit}</button><button class="rd-secondary" id="renewal-back" type="button">{back}</button></div>
        </form>
      </main></div></body></html>;
}
