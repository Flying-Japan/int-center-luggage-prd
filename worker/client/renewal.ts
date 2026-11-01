import { createIntakeDraft, reviseIntakeDraft, INTAKE_STEPS, missingIntakeFields,
  mergeMemberContact, confirmAnonymousDraft, draftBoundaryDecision, prepareIntakeAuth, toRenewalIntakeForm, type IntakeDraft } from '../src/customer/intakeDraft';
import { createBrowserDraftStore } from './intakeDraftStore.mjs';
import { inspectPhotoContent } from '../src/lib/imageContent';
import { pickupDateLabel } from '../src/customer/inputControls';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const locale = $('.rd-root').dataset.locale as 'ko' | 'en' | 'ja';
const word = (ko: string, en: string, ja: string) => ({ ko, en, ja })[locale];
const privacyVersion = 'existing-storage-notice-v1';
const draftKey = 'fj-luggage-current-draft-v1';
const store = createBrowserDraftStore();
document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select').forEach(el => { el.disabled = true; });
document.body.setAttribute('aria-busy', 'true');
let draft: IntakeDraft, saving = Promise.resolve(), busy = false, noticeReady = false;
let panel = 'entry', returnPanel = 'entry', provider: 'kakao' | 'google' = locale === 'ko' ? 'kakao' : 'google';
let priceSequence = 0;
let memberVerified = false;
let savesPending = 0;
type Member = { subject: string; profile: { name: string; phone: string; email: string }; expiresAt: number };
let currentMember: Member | null = null, boundaryConfirm: (() => Promise<void>) | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | undefined, boundaryBlocked = true;
let identityGeneration = 0;
const previews: Record<string, string> = {};
const photoGeneration = { identity: 0, luggage: 0 };
const pendingPhotos = new Set<Promise<void>>();
async function waitForPhotos() { while (pendingPhotos.size) await Promise.allSettled([...pendingPhotos]); }
function refreshPickupLabel() { $('#renewal-pickup-label').textContent = pickupDateLabel($<HTMLInputElement>('[data-field="pickupDate"]').value, locale); }
function error(message = '') { $('#renewal-error').textContent = message; $('#renewal-error').hidden = !message; }
function preserveError(cause?: unknown) {
  if (cause instanceof Error && cause.message === 'DRAFT_EXPIRED') { void expireDraft(); return; }
  error(word('초안을 저장하지 못했습니다. 이 화면에서 계속할 수 있습니다. 로그인으로 이동하기 전에 다시 시도해주세요.', 'Your draft could not be saved. Stay on this page and retry before leaving for login.', '下書きを保存できませんでした。この画面で続け、ログイン移動の前に再試行してください。'));
}
function show(next: string) {
  if (next === 'form' && draft.boundary.mode === 'member' && (!currentMember || currentMember.subject !== draft.boundary.subject || Date.now() >= currentMember.expiresAt)) { lockMember(); return; }
  panel = next;
  for (const name of ['entry', 'foreign', 'auth', 'form', 'boundary']) $(`#renewal-${name}`).hidden = name !== next;
  if (next === 'form') render();
}
function mask() {
  photoGeneration.identity++; photoGeneration.luggage++;
  boundaryBlocked = true;
  $('#renewal-form').hidden = true;
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-field]').forEach(el => { el.value = ''; });
  document.querySelectorAll<HTMLInputElement>('[data-photo]').forEach(el => { el.value = ''; });
  for (const field of ['identity','luggage']) {
    if (previews[field]) URL.revokeObjectURL(previews[field]); delete previews[field];
    const img = $<HTMLImageElement>(`[data-photo-preview="${field}"]`); img.removeAttribute('src'); img.hidden = true;
    $(`[data-photo-name="${field}"]`).textContent = '';
  }
  $('#renewal-summary').replaceChildren(); $('#renewal-profile-conflicts').replaceChildren();
  $('#renewal-pickup-label').textContent = '';
  $('#renewal-profile-conflicts').hidden = true; $('#renewal-member').hidden = true;
  $('#renewal-state').textContent = ''; $('#renewal-receipt-link').hidden = true; error();
  $('#renewal-boundary-info').textContent = '';
}
function boundaryScreen(message: string, confirm = false, reauth = false) {
  mask(); show('boundary'); $('#renewal-boundary-info').textContent = message;
  $('#renewal-boundary-confirm').hidden = !confirm; $('#renewal-boundary-cancel').hidden = !confirm;
  $('#renewal-boundary-reauth').hidden = !reauth;
}
function lockMember() {
  memberVerified = false;
  boundaryScreen(word('회원 인증이 없거나 만료되었습니다. 기존 회원으로 다시 인증하면 초안을 이어갈 수 있습니다. 새 비회원 접수는 이전 정보·사진을 사용하지 않습니다.',
    'Member authentication is missing or expired. Reauthenticate as the original member to restore this draft. A new guest reception will not reuse its information or photos.',
    '会員認証がないか期限切れです。元の会員で再認証すると下書きを再開できます。新しい非会員受付には以前の内容・写真を使用しません。'), false, true);
}
async function discardDraft() {
  mask(); boundaryConfirm = null; await saving.catch(() => {});
  await store.discardForNewOwner(draft.id);
  draft.contact = { name:'',phone:'',email:'' }; draft.photos = { identity:null,luggage:null };
  sessionStorage.removeItem(draftKey); sessionStorage.removeItem('fj-luggage-auth-handoff-v1');
  draft = createIntakeDraft(locale, privacyVersion);
  draft.visit.pickupDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
  sessionStorage.setItem(draftKey, draft.id); await save(); scheduleExpiry();
}
async function expireDraft() {
  mask(); boundaryConfirm = null; clearTimeout(expiryTimer);
  await saving.catch(() => {});
  try { await store.discardForNewOwner(draft.id); sessionStorage.removeItem(draftKey); } catch { /* Never restore expired memory. */ }
  draft.contact = { name:'',phone:'',email:'' }; draft.photos = { identity:null,luggage:null };
  boundaryScreen(word('초안의 30분 보관 시간이 끝났습니다. 새 접수를 시작해주세요.', 'This draft’s 30-minute lifetime has ended. Start a new reception.', '下書きの30分の保存期限が切れました。新しく受付を開始してください。'));
}
function scheduleExpiry() {
  clearTimeout(expiryTimer);
  const deadline = draft.boundary.mode === 'member' && currentMember ? Math.min(draft.expiresAt, currentMember.expiresAt) : draft.expiresAt;
  expiryTimer = setTimeout(() => { if (Date.now() >= draft.expiresAt) void expireDraft(); else { currentMember = null; lockMember(); } }, Math.max(0, deadline - Date.now()));
}
async function adopt(providerChoice: 'kakao' | 'google') {
  if (!currentMember || Date.now() >= currentMember.expiresAt) { lockMember(); return; }
  draft = confirmAnonymousDraft(draft, currentMember.subject, providerChoice, true);
  const merged = mergeMemberContact(draft, currentMember.profile, currentMember.subject); draft = merged.draft;
  sessionStorage.removeItem('fj-luggage-auth-handoff-v1');
  await save(); fill(); show('form'); scheduleExpiry();
}
function askAnonymousOwnership(choice: 'kakao' | 'google') {
  const member = currentMember;
  if (!member) { lockMember(); return; }
  boundaryConfirm = async () => {
    // Recheck before taking the user's explicit ownership confirmation.
    await verifyIdentity(); if (!currentMember || currentMember.subject !== member.subject) return;
    await adopt(choice);
  };
  boundaryScreen(word(`현재 확인된 회원은 ${member.profile.name || member.profile.email}입니다. 가입 전 입력한 정보·사진이 본인의 것인지 확인해주세요.`,
    `The verified member is ${member.profile.name || member.profile.email}. Confirm that the pre-login entries and photos are yours.`,
    `確認済みの会員は${member.profile.name || member.profile.email}です。ログイン前の入力内容と写真がご本人のものか確認してください。`), true);
}
async function verifyIdentity() {
  const generation = ++identityGeneration;
  let member: Member | null = null;
  try {
    const response = await fetch('/customer/renewal/account', { credentials: 'same-origin' }); const data = await response.json();
    member = response.ok && data.authenticated && /^[\w-]{43}$/.test(data.subject) && Date.now() < data.expiresAt
      ? { subject:data.subject, profile:data.profile, expiresAt:data.expiresAt } : null;
  } catch { /* Missing verification never grants access to member-bound memory. */ }
  if (generation !== identityGeneration) return false;
  currentMember = member;
  memberVerified = !!currentMember;
  const decision = draftBoundaryDecision(draft, currentMember?.subject ?? null);
  if (decision === 'expired') { await expireDraft(); return false; }
  if (decision === 'different-member') {
    await discardDraft(); boundaryScreen(word('다른 회원이 확인되어 이전 회원의 초안을 사용하지 않았습니다. 새 접수를 시작해주세요.',
      'A different member was verified. The previous member’s draft was discarded. Start a new reception.', '別の会員が確認されたため以前の会員の下書きは使用しません。新しく受付を開始してください。'));
    return false;
  }
  if (decision === 'reauthenticate') { lockMember(); scheduleExpiry(); return false; }
  scheduleExpiry(); return true;
}
function snapshot() { return structuredClone(draft); }
function save() {
  const copy = snapshot();
  // Serialize snapshots; a slow photo encryption cannot overwrite newer input.
  savesPending++;
  $('.rd-root').dataset.savesPending = String(savesPending);
  const next = saving.catch(() => {}).then(() => store.save(copy)).finally(() => {
    savesPending--; $('.rd-root').dataset.savesPending = String(savesPending);
  });
  saving = next; return next;
}
function revise() { draft = reviseIntakeDraft(draft); save().catch(preserveError); }
function sync() {
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-field]').forEach(el => {
    const field = el.dataset.field!;
    if (field in draft.contact) draft.contact[field as keyof typeof draft.contact] = el.value;
    else (draft.visit as Record<string, string>)[field] = el.value;
  });
  draft.visit.paymentMethod = $('input[name="renewal-payment"]:checked').getAttribute('value') as 'CASH' | 'PAY_QR';
  draft.privacy.accepted = $<HTMLInputElement>('#renewal-consent').checked;
  refreshPickupLabel();
}
function fill() {
  if (draft.boundary.mode === 'member' && (!currentMember || currentMember.subject !== draft.boundary.subject || Date.now() >= currentMember.expiresAt)) { lockMember(); return; }
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-field]').forEach(el => {
    const field = el.dataset.field!; el.value = (draft.contact as Record<string, string>)[field] ?? (draft.visit as Record<string, string>)[field];
  });
  $<HTMLInputElement>(`input[name="renewal-payment"][value="${draft.visit.paymentMethod}"]`).checked = true;
  $<HTMLInputElement>('#renewal-consent').checked = draft.privacy.accepted;
  for (const field of ['identity', 'luggage'] as const) {
    const photo = draft.photos[field], img = $<HTMLImageElement>(`[data-photo-preview="${field}"]`);
    if (previews[field]) URL.revokeObjectURL(previews[field]);
    $(`[data-photo-name="${field}"]`).textContent = photo?.name ?? '';
    img.hidden = !photo;
    if (photo) img.src = previews[field] = URL.createObjectURL(photo.blob); else img.removeAttribute('src');
  }
  boundaryBlocked = false;
  refreshPickupLabel();
}
async function readSelectedPhoto(input: HTMLInputElement, file: File) {
  const field = input.dataset.photo as 'identity' | 'luggage';
  const generation = ++photoGeneration[field], draftId = draft.id;
  // Returning from a native camera may resume before visibility revalidation.
  // A different member/expired draft must never receive the pending photo.
  if (boundaryBlocked && !document.hidden) {
    if (!await verifyIdentity() || draft.id !== draftId || photoGeneration[field] !== generation) return;
    fill(); show('form');
  }
  const current = () => draft.id === draftId && photoGeneration[field] === generation
    && input.files?.[0] === file && !boundaryBlocked && !document.hidden
    && (panel === 'form' || panel === 'auth') && Date.now() < draft.expiresAt
    && (draft.boundary.mode === 'guest' || (currentMember?.subject === draft.boundary.subject && Date.now() < currentMember.expiresAt));
  const bytes = file.size <= 10 * 1024 * 1024 ? await file.arrayBuffer() : null;
  if (!current()) return;
  const canonical = bytes ? inspectPhotoContent(bytes, file.type) : null;
  if (!canonical) {
    error(word('지원되는 사진 파일과 용량을 확인해주세요.', 'Check the image type and size.', '画像の形式とサイズをご確認ください。')); input.value = ''; return;
  }
  draft.photos[field] = { blob: new Blob([bytes!], { type: canonical }), name: file.name, lastModified: file.lastModified };
  input.value = ''; error(); revise(); fill();
}
function render() {
  const index = INTAKE_STEPS.indexOf(draft.step);
  const quick = memberVerified && draft.boundary.mode === 'member' && currentMember?.subject === draft.boundary.subject;
  document.querySelectorAll<HTMLElement>('[data-step]').forEach(el => { el.hidden = !quick && el.dataset.step !== draft.step; });
  $('#renewal-progress').textContent = quick ? word('간편접수 · 이번 방문 정보를 확인해주세요', 'Quick reception · Check this visit’s details', 'かんたん受付 · 今回の内容をご確認ください') : `${index + 1} / ${INTAKE_STEPS.length}`;
  $('#renewal-next').hidden = quick || draft.step === 'review'; $('#renewal-submit').hidden = !quick && draft.step !== 'review';
  $('#renewal-back').textContent = index === 0 ? word('접수 방법으로', 'Reception options', '受付方法へ') : word('이전', 'Back', '戻る');
  if (quick || draft.step === 'payment') refreshPrice();
  if (quick || draft.step === 'review') {
    const dl = $('#renewal-summary'); dl.replaceChildren();
    for (const [label, value] of [[word('이름', 'Name', 'お名前'), draft.contact.name], ['Email', draft.contact.email],
      [word('전화번호', 'Phone', '電話番号'), draft.contact.phone],
      [word('짐', 'Luggage', '手荷物'), `${draft.visit.suitcaseQty} / ${draft.visit.backpackQty}`],
      [word('수령 예정', 'Planned pickup', '受取予定'), `${draft.visit.pickupDate} ${draft.visit.pickupTime} JST`],
      [word('현장 결제', 'Onsite payment', '現地支払'), draft.visit.paymentMethod],
      [word('함께 온 인원', 'Group size', '人数'), draft.visit.companionCount]]) {
      const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; dl.append(dt, dd);
    }
  }
}
async function refreshPrice() {
  const sequence = ++priceSequence;
  if (missingIntakeFields(draft, 'pickup').length) {
    $('#renewal-price').textContent = word('수령 날짜와 시간을 선택해주세요.', 'Choose a pickup date and time.', '受取日と時刻を選択してください。'); return;
  }
  $('#renewal-price').textContent = '…';
  const query = new URLSearchParams({ suitcase_qty: draft.visit.suitcaseQty, backpack_qty: draft.visit.backpackQty,
    expected_pickup_at: `${draft.visit.pickupDate}T${draft.visit.pickupTime}` });
  try {
    const response = await fetch(`/api/price-preview?${query}`); if (!response.ok) throw Error('PRICE_UNAVAILABLE');
    const data = await response.json(); if (sequence !== priceSequence) return;
    $('#renewal-price').textContent = `¥${Number(data.final_prepaid).toLocaleString()} · ${data.expected_storage_days} ${word('일', 'day(s)', '日')}`;
  } catch { if (sequence === priceSequence) $('#renewal-price').textContent = word('현장에서 요금을 확인해주세요.', 'Confirm the price at the counter.', '現地で料金をご確認ください。'); }
}
async function openAuth(choice: 'kakao' | 'google') {
  if (pendingPhotos.size) await waitForPhotos();
  if (Date.now() >= draft.expiresAt) { void expireDraft(); return; }
  if (currentMember && Date.now() < currentMember.expiresAt) {
    if (draft.boundary.mode === 'member' && draft.boundary.subject === currentMember.subject) { draft.path = choice; revise(); fill(); show('form'); return; }
    askAnonymousOwnership(choice); return;
  }
  provider = choice; returnPanel = draft.boundary.mode === 'member' ? 'boundary' : panel === 'form' ? 'form' : 'entry';
  $('#renewal-auth-title').textContent = `${choice === 'kakao' ? 'Kakao' : 'Google'} · ${word('간편접수', 'Quick reception', 'かんたん受付')}`;
  $('#renewal-auth-start').textContent = word('로그인·가입 계속', 'Continue to login / sign up', 'ログイン・登録へ');
  $('#renewal-auth-info').textContent = word('입력 내용과 사진을 보존한 뒤 이동합니다. 취소해도 같은 단계로 돌아옵니다.', 'Your entries and photos are saved before leaving. Cancel returns to the same step.', '入力内容と写真を保存して移動します。取消時は同じ手順へ戻ります。');
  error(); show('auth');
}
async function boot() {
  let restored: IntakeDraft | null = null;
  try {
    await store.purgeExpired(); const id = sessionStorage.getItem(draftKey);
    restored = id ? await store.load(id) : null;
    draft = restored ?? createIntakeDraft(locale, privacyVersion);
    draft.locale = locale;
    if (draft.privacy.version !== privacyVersion) draft.privacy = { version: privacyVersion, accepted: false };
    if (!draft.visit.pickupDate) draft.visit.pickupDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
    sessionStorage.setItem(draftKey, draft.id);
  } catch { draft ??= createIntakeDraft(locale, privacyVersion); preserveError(); }
  sessionStorage.setItem(draftKey, draft.id);
  // Verify BEFORE restoring contact, filenames, image URLs or the summary to DOM.
  const safeToRestore = await verifyIdentity();
  if (safeToRestore) {
    const pending = sessionStorage.getItem('fj-luggage-auth-handoff-v1');
    let requested = false, requestedProvider: 'google' | 'kakao' = provider;
    try { const hint = pending ? JSON.parse(pending) : null; requested = hint?.draftId === draft.id && ['google','kakao'].includes(hint.provider); if (requested) requestedProvider = hint.provider; } catch { /* No transfer authority. */ }
    if (draft.boundary.mode === 'member' && currentMember) {
      draft = mergeMemberContact(draft, currentMember.profile, currentMember.subject).draft;
      $('#renewal-member').textContent = word('회원 확인됨', 'Member verified', '会員確認済み'); $('#renewal-member').hidden = false;
    }
    await save();
    if (draft.boundary.mode === 'guest' && currentMember && requested) askAnonymousOwnership(requestedProvider);
    else { fill(); if (restored) { show('form'); $('#renewal-state').textContent = word('저장된 초안을 이어갑니다. 사진도 복원했습니다.', 'Draft restored, including your photos.', '写真を含めて下書きを復元しました。'); } }
  }
  restored = null;
  const date = $<HTMLInputElement>('[data-field="pickupDate"]');
  date.min = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
  date.max = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date(Date.now() + 14 * 86400000));
  try {
    const response = await fetch(`/customer?notice=1&lang=${locale}`); if (!response.ok) throw Error('NOTICE_UNAVAILABLE');
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html'); const notice = doc.querySelector('#consent-notice');
    if (!notice) throw Error('NOTICE_UNAVAILABLE');
    // Existing server-owned legal text, without executing any old form scripts.
    notice.querySelectorAll('script').forEach(el => el.remove()); $('#renewal-notice').append(...Array.from(notice.childNodes)); noticeReady = true;
  } catch { $('#renewal-notice').textContent = word('안내를 불러오지 못했습니다. 새로고침 후 확인해주세요.', 'Notice could not be loaded. Reload before agreeing.', '案内を読み込めません。再読込してご確認ください。'); }
  document.querySelectorAll<HTMLElement>('[data-entry]').forEach(button => button.addEventListener('click', () => {
    const entry = button.dataset.entry; error();
    if (entry === 'foreign') show('foreign'); else if (entry === 'guest') { void startGuest(); }
    else void openAuth(entry as 'kakao' | 'google').catch(preserveError);
  }));
  async function startGuest() {
    if (draft.boundary.mode === 'member') {
      boundaryScreen(word('회원 초안을 비회원 접수로 자동 전환하지 않습니다. 기존 회원으로 계속하거나, 이전 초안을 지우고 새 비회원 접수를 선택해주세요.',
        'A member draft is not automatically converted to a guest reception. Continue as the original member, or explicitly discard it and start a new guest reception.',
        '会員の下書きを自動で非会員受付に変更しません。元の会員で続けるか、下書きを消して新しい非会員受付を選択してください。'), false, true);
      return;
    }
    if (Date.now() >= draft.expiresAt) { await expireDraft(); return; }
    draft.path = 'guest'; sessionStorage.removeItem('fj-luggage-auth-handoff-v1');
    revise(); fill(); show('form');
  }
  $('[data-foreign-guest]').addEventListener('click', () => { void startGuest().catch(preserveError); });
  $('#renewal-boundary-confirm').addEventListener('click', () => { void boundaryConfirm?.().catch(preserveError); });
  $('#renewal-boundary-guest').addEventListener('click', () => { void (async () => { await discardDraft(); fill(); show('form'); })().catch(preserveError); });
  $('#renewal-boundary-cancel').addEventListener('click', () => {
    if (draft.boundary.mode !== 'guest') return;
    boundaryConfirm = null; sessionStorage.removeItem('fj-luggage-auth-handoff-v1'); draft.path = 'guest'; revise(); fill(); show('form');
  });
  $('#renewal-boundary-reauth').addEventListener('click', () => { currentMember = null; memberVerified = false; void openAuth(draft.path === 'google' ? 'google' : 'kakao').catch(preserveError); });
  $('[data-back-entry]').addEventListener('click', () => show('entry'));
  $('[data-existing-booking]').addEventListener('click', () => {
    error(word('기존 예약은 새 현장접수로 만들지 않습니다. 예약 확인 화면을 직원에게 보여주시면 기존 예약을 확인합니다.', 'Existing bookings are separate from new onsite reception. Show your booking confirmation to staff.', '既存予約は新しい現地受付に変更しません。予約確認画面をスタッフに見せてください。'));
  });
  document.querySelectorAll('[data-quick]').forEach(button => button.addEventListener('click', () => { void openAuth(locale === 'ko' ? 'kakao' : 'google').catch(preserveError); }));
  $('#renewal-auth-cancel').addEventListener('click', () => {
    error(); sessionStorage.removeItem('fj-luggage-auth-handoff-v1');
    if (draft.boundary.mode === 'member') lockMember(); else { fill(); show(returnPanel); }
  });
  $('#renewal-auth-start').addEventListener('click', async () => {
    if (busy) return; busy = true; $<HTMLButtonElement>('#renewal-auth-start').disabled = true;
    try {
      await waitForPhotos();
      await saving;
      const handoff = await prepareIntakeAuth(store, snapshot(), provider);
      sessionStorage.setItem('fj-luggage-auth-handoff-v1', JSON.stringify(handoff));
      const response = await fetch(`/customer/renewal/auth?provider=${provider}`, { credentials: 'same-origin' });
      const data = await response.json();
      if (!response.ok) { error(word('간편접수 로그인 연결을 준비 중입니다. 초안은 보존되어 있으며, 취소하면 계속 입력할 수 있습니다.', 'Quick-reception login is being connected. Your draft is saved. Cancel to continue filling it in.', 'かんたん受付のログイン接続を準備中です。下書きは保存済みです。取消して入力を続けられます。')); return; }
      const target = new URL(data.redirectTo); if (target.origin !== 'https://account.flyingjp.com' || target.pathname !== '/login') throw Error('INVALID_LOGIN_DESTINATION');
      location.assign(target.toString());
    } catch { preserveError(); } finally { busy = false; $<HTMLButtonElement>('#renewal-auth-start').disabled = false; }
  });
  $('#renewal-form').addEventListener('input', event => {
    if (busy || boundaryBlocked || panel !== 'form') return; if ((event.target as HTMLInputElement).type === 'file') return;
    sync(); revise(); error(); if (memberVerified && draft.path !== 'guest') render();
  });
  document.querySelectorAll<HTMLInputElement>('[data-photo]').forEach(input => {
    input.addEventListener('click', () => { photoGeneration[input.dataset.photo as 'identity' | 'luggage']++; input.value = ''; });
    input.addEventListener('change', () => {
      if (busy || panel !== 'form') return;
      const file = input.files?.[0]; if (!file) return;
      const task = readSelectedPhoto(input, file).catch(() => { if (!boundaryBlocked) preserveError(); }).finally(() => pendingPhotos.delete(task));
      pendingPhotos.add(task);
    });
  });
  $('#renewal-camera-open').addEventListener('click', () => { if (!busy && !boundaryBlocked && panel === 'form') $<HTMLInputElement>('#renewal-luggage-camera').click(); });
  date.addEventListener('change', () => { if (!busy && !boundaryBlocked && panel === 'form') { sync(); revise(); error(); } });
  date.addEventListener('click', () => { try { date.showPicker?.(); } catch { /* Native keyboard/calendar entry remains available. */ } });
  $('#renewal-next').addEventListener('click', () => {
    sync(); const missing = missingIntakeFields(draft, draft.step);
    if (missing.length) { error(word('현재 단계의 필수 정보를 확인해주세요.', 'Check the required details in this step.', 'この手順の必須項目をご確認ください。')); return; }
    if (draft.step === 'pickup' && (draft.visit.pickupDate < date.min || draft.visit.pickupDate > date.max)) {
      error(word('수령일은 오늘부터 14일 안으로 선택해주세요.', 'Choose pickup within the next 14 days.', '受取日は本日から14日以内を選択してください。')); return;
    }
    draft.step = INTAKE_STEPS[INTAKE_STEPS.indexOf(draft.step) + 1]; revise(); error(); render();
  });
  $('#renewal-back').addEventListener('click', () => { const i = INTAKE_STEPS.indexOf(draft.step); if (!i) return show('entry'); draft.step = INTAKE_STEPS[i - 1]; revise(); error(); render(); });
  $('#renewal-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || boundaryBlocked) return;
    await waitForPhotos(); if (busy || boundaryBlocked) return; sync();
    if (!await verifyIdentity()) return;
    if (!noticeReady) { error(word('안내 내용을 불러온 후 동의해주세요.', 'Load and review the notice before agreeing.', '案内を読み込んでから同意してください。')); return; }
    let form: FormData;
    try { form = toRenewalIntakeForm(draft, privacyVersion); } catch { error(word('필수 정보와 동의를 확인해주세요.', 'Check all required information and consent.', '必須情報と同意をご確認ください。')); return; }
    busy = true; document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('form button, form input, form select, [data-quick]').forEach(el => { el.disabled = true; });
    try {
      $('#renewal-form').dataset.submitStage = 'draft';
      await save(); $('#renewal-form').dataset.submitStage = 'request';
      const response = await fetch('/customer/submit', { method: 'POST', body: form, credentials: 'same-origin' });
      $('#renewal-form').dataset.submitStage = 'response';
      const result = await response.json();
      if (!response.ok) throw Error(result.error || 'INTAKE_UNAVAILABLE');
      const target = new URL(result.receiptUrl, location.origin);
      if (target.origin !== location.origin || !target.pathname.startsWith('/customer/renewal/receipt/')) throw Error('INTAKE_COMMIT_UNCERTAIN');
      const receiptLink = $<HTMLAnchorElement>('#renewal-receipt-link');
      receiptLink.href = target.toString(); receiptLink.hidden = false;
      $('#renewal-state').textContent = word('접수를 저장했습니다. 확인증을 직원에게 보여주세요.', 'Reception saved. Show your receipt to staff.', '受付を保存しました。確認画面をスタッフに見せてください。');
      $('#renewal-form').dataset.submitStage = 'cleanup';
      try { await saving; await store.remove(draft.id); sessionStorage.removeItem(draftKey); sessionStorage.removeItem('fj-luggage-auth-handoff-v1'); } catch { /* Receipt remains available even if local cleanup fails. */ }
      $('#renewal-form').dataset.submitStage = 'receipt';
      location.assign(target.toString());
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : 'INTAKE_UNAVAILABLE';
      error(word('접수 완료를 확인하지 못했습니다. 초안은 유지됩니다. 같은 화면에서 재시도하거나 직원에게 확인해주세요.', 'Reception could not be confirmed. Your draft is preserved. Retry from this page or ask staff to check.', '受付完了を確認できません。下書きは保持されています。この画面で再試行するかスタッフに確認してください。') + ` (${code})`);
      if (/ACCOUNT_CONTEXT|ACCOUNT_BOUNDARY|MEMBER_REAUTHENTICATION/.test(code)) { mask(); await verifyIdentity(); }
      busy = false; document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('form button, form input, form select, [data-quick]').forEach(el => { el.disabled = false; });
    }
  });
  const menu = $<HTMLDialogElement>('#renewal-menu'); $('#renewal-menu-open').addEventListener('click', () => menu.showModal());
  $('#renewal-menu-close').addEventListener('click', () => menu.close());
  document.querySelectorAll<HTMLElement>('[data-language]').forEach(button => button.addEventListener('click', async () => {
    if (busy) return;
    try { await waitForPhotos(); draft.locale = button.dataset.language as typeof locale; revise(); await saving; location.assign(`/customer/renewal?lang=${draft.locale}`); } catch { preserveError(); }
  }));
  // The brand returns to reception choices without losing an in-progress draft.
  $('.fj-customer-brand').addEventListener('click', event => { event.preventDefault(); if (!busy) show('entry'); });
  // Mask BEFORE BFCache/background handoff. Restore only after a fresh verified
  // subject comparison; never flash a previous member's photo on pageshow.
  const restoreVisible = async () => { const previous = panel; mask(); if (await verifyIdentity()) { fill(); show(previous === 'form' ? 'form' : 'entry'); } };
  window.addEventListener('pagehide', () => mask());
  window.addEventListener('pageshow', event => { if (event.persisted) void restoreVisible().catch(preserveError); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) mask(); else if (!busy) void restoreVisible().catch(preserveError); });
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select').forEach(el => { el.disabled = false; });
  document.body.removeAttribute('aria-busy'); $('.rd-root').dataset.ready = 'true';
}
boot().catch(preserveError);
