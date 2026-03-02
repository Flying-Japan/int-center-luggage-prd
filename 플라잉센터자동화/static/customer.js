(function () {
  const suitcaseEl = document.getElementById("suitcase_qty");
  const backpackEl = document.getElementById("backpack_qty");
  const suitcaseSelectEl = document.getElementById("suitcase_qty_select");
  const suitcaseCustomEl = document.getElementById("suitcase_qty_custom");
  const backpackSelectEl = document.getElementById("backpack_qty_select");
  const backpackCustomEl = document.getElementById("backpack_qty_custom");
  const pickupDateEl = document.getElementById("expected_pickup_date");
  const pickupTimeEl = document.getElementById("expected_pickup_time");
  const pickupHiddenEl = document.getElementById("expected_pickup_at");
  const priceValueEl = document.getElementById("price-value");
  const priceMetaEl = document.getElementById("price-meta");
  const companionSelectEl = document.getElementById("companion_count_select");
  const companionCustomEl = document.getElementById("companion_count_custom");
  const companionHiddenEl = document.getElementById("companion_count");
  const formEl = document.getElementById("customer-form");
  const nameInputEl = formEl ? formEl.querySelector('input[name="name"]') : null;
  const phoneInputEl = formEl ? formEl.querySelector('input[name="phone"]') : null;
  const paymentMethodEls = formEl ? Array.from(formEl.querySelectorAll('input[name="payment_method"]')) : [];
  const submitBtnEl = document.getElementById("customer-submit-btn");
  const uploadStatusEl = document.getElementById("upload-status");
  const idImageInputEl = document.getElementById("id_image");
  const luggageImageInputEl = document.getElementById("luggage_image");

  if (
    !suitcaseEl ||
    !backpackEl ||
    !suitcaseSelectEl ||
    !suitcaseCustomEl ||
    !backpackSelectEl ||
    !backpackCustomEl ||
    !pickupDateEl ||
    !pickupTimeEl ||
    !pickupHiddenEl ||
    !priceValueEl ||
    !formEl
  ) {
    return;
  }

  var formatYen = FJ.formatYen;
  var normalizeAmount = FJ.normalizeAmount;
  var isLatePickupTime = FJ.isLatePickupTime;
  var safeStorageSet = FJ.safeStorageSet;
  var safeStorageGet = FJ.safeStorageGet;
  var safeStorageRemove = FJ.safeStorageRemove;
  var jpy = FJ.yenFormatter;
  const messages = {
    metaEmpty: formEl.dataset.previewMetaEmpty || "",
    invalidTitle: formEl.dataset.previewInvalidTitle || "Check input",
    invalidMeta: formEl.dataset.previewInvalidMeta || "Please review your input values.",
    errorTitle: formEl.dataset.previewErrorTitle || "Calc error",
    errorMeta: formEl.dataset.previewErrorMeta || "Please check your network and try again.",
    latePickupWarning:
      formEl.dataset.pickupLateWarning ||
      "Business hours end at 9:00 PM. Please collect your luggage before 9:00 PM.",
    resultMeta:
      formEl.dataset.previewResultMeta || "¥ {price_per_day}/day · {days} days · discount {discount}%",
    uploadOptimizing: formEl.dataset.uploadOptimizing || "Optimizing photos for upload...",
    uploadSubmitting: formEl.dataset.uploadSubmitting || "Submitting... please wait.",
    uploadError: formEl.dataset.uploadError || "Upload failed. Please try again.",
    fileOptimized: formEl.dataset.fileOptimized || "Optimized",
  };
  const optimizedFilesByField = new Map();
  const MAX_IMAGE_DIMENSION = 1800;
  const OPTIMIZE_SIZE_THRESHOLD = 450 * 1024;
  const TARGET_IMAGE_BYTES = 1000 * 1024;
  const DRAFT_STORAGE_KEY = "fj_customer_form_draft_v2";
  let latePickupWarned = false;
  let isSubmitting = false;

  const tokyoFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });



  function setUploadStatus(message, kind) {
    if (!uploadStatusEl) {
      return;
    }
    if (!message) {
      uploadStatusEl.textContent = "";
      uploadStatusEl.className = "upload-status";
      return;
    }
    uploadStatusEl.textContent = message;
    uploadStatusEl.className = `upload-status is-visible is-${kind || "busy"}`;
  }

  function clearUploadStatus() {
    setUploadStatus("");
  }

  function setSubmitBusy(busy) {
    if (!submitBtnEl) {
      return;
    }
    submitBtnEl.disabled = !!busy;
    submitBtnEl.classList.toggle("is-disabled", !!busy);
  }

  function getSelectedPaymentMethod() {
    for (const radio of paymentMethodEls) {
      if (radio.checked) {
        return radio.value;
      }
    }
    return "PAY_QR";
  }



  function saveDraft() {
    const payload = {
      name: nameInputEl ? nameInputEl.value.trim() : "",
      phone: phoneInputEl ? phoneInputEl.value.trim() : "",
      suitcase_select: suitcaseSelectEl.value || "0",
      suitcase_custom: suitcaseCustomEl.value || "",
      backpack_select: backpackSelectEl.value || "0",
      backpack_custom: backpackCustomEl.value || "",
      companion_select: companionSelectEl ? companionSelectEl.value : "1",
      companion_custom: companionCustomEl ? companionCustomEl.value : "",
      pickup_date: pickupDateEl.value || "",
      pickup_time: pickupTimeEl.value || "",
      payment_method: getSelectedPaymentMethod(),
      saved_at: Date.now(),
    };
    safeStorageSet(DRAFT_STORAGE_KEY, JSON.stringify(payload));
  }

  function applyRadioValue(radios, targetValue) {
    if (!targetValue) {
      return;
    }
    for (const radio of radios) {
      radio.checked = radio.value === targetValue;
    }
  }

  function loadDraft() {
    const raw = safeStorageGet(DRAFT_STORAGE_KEY);
    if (!raw) {
      return;
    }
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch (_error) {
      safeStorageRemove(DRAFT_STORAGE_KEY);
      return;
    }
    if (!payload || typeof payload !== "object") {
      safeStorageRemove(DRAFT_STORAGE_KEY);
      return;
    }

    if (nameInputEl && payload.name && !nameInputEl.value) {
      nameInputEl.value = payload.name;
    }
    if (phoneInputEl && payload.phone && !phoneInputEl.value) {
      phoneInputEl.value = payload.phone;
    }

    if (typeof payload.suitcase_select === "string") {
      suitcaseSelectEl.value = payload.suitcase_select;
      suitcaseCustomEl.value = typeof payload.suitcase_custom === "string" ? payload.suitcase_custom : "";
    }
    if (typeof payload.backpack_select === "string") {
      backpackSelectEl.value = payload.backpack_select;
      backpackCustomEl.value = typeof payload.backpack_custom === "string" ? payload.backpack_custom : "";
    }
    if (companionSelectEl && typeof payload.companion_select === "string") {
      companionSelectEl.value = payload.companion_select;
      companionCustomEl.value = typeof payload.companion_custom === "string" ? payload.companion_custom : "";
    }

    if (typeof payload.pickup_date === "string" && payload.pickup_date) {
      pickupDateEl.value = payload.pickup_date;
    }
    if (typeof payload.pickup_time === "string" && payload.pickup_time) {
      pickupTimeEl.value = payload.pickup_time;
    }

    applyRadioValue(paymentMethodEls, payload.payment_method);
  }

  function parseDateParts(dateValue) {
    const match = String(dateValue || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      return null;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
      return null;
    }
    return { year, month, day };
  }

  function parseTimeParts(timeValue) {
    const match = String(timeValue || "").match(/^(\d{2}):(\d{2})$/);
    if (!match) {
      return null;
    }
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
      return null;
    }
    return { hour, minute };
  }

  function hasPickupTimeOption(timeValue) {
    return Array.from(pickupTimeEl.options).some((option) => option.value === timeValue);
  }

  function toTokyoPseudoUTC(dateValue, timeValue) {
    const dateParts = parseDateParts(dateValue);
    const timeParts = parseTimeParts(timeValue);
    if (!dateParts || !timeParts) {
      return null;
    }
    return new Date(
      Date.UTC(
        dateParts.year,
        dateParts.month - 1,
        dateParts.day,
        timeParts.hour,
        timeParts.minute,
        0,
        0
      )
    );
  }

  function ensureValidPickupDefaults() {
    const currentDate = String(pickupDateEl.value || "");
    const currentTime = String(pickupTimeEl.value || "");
    if (!currentDate || !currentTime || !hasPickupTimeOption(currentTime)) {
      setDefaultPickupByTokyoTime();
      return;
    }

    const pickup = toTokyoPseudoUTC(currentDate, currentTime);
    if (!pickup) {
      setDefaultPickupByTokyoTime();
      return;
    }

    const nowTokyo = getTokyoNow();
    if (pickup.getTime() < nowTokyo.getTime()) {
      setDefaultPickupByTokyoTime();
      return;
    }

    const minDate = String(pickupDateEl.min || "");
    if (minDate && currentDate < minDate) {
      setDefaultPickupByTokyoTime();
    }
  }

  function clearDraft() {
    safeStorageRemove(DRAFT_STORAGE_KEY);
  }

  function beforeUnloadWhileSubmitting(event) {
    if (!isSubmitting) {
      return;
    }
    event.preventDefault();
    event.returnValue = "";
  }

  function bindDraftEvents() {
    const targets = [
      nameInputEl,
      phoneInputEl,
      suitcaseSelectEl,
      suitcaseCustomEl,
      backpackSelectEl,
      backpackCustomEl,
      companionSelectEl,
      companionCustomEl,
      pickupDateEl,
      pickupTimeEl,
      ...paymentMethodEls,
    ].filter(Boolean);

    targets.forEach((target) => {
      target.addEventListener("change", saveDraft);
      target.addEventListener("input", saveDraft);
    });
  }

  function getTokyoNow() {
    const parts = tokyoFormatter.formatToParts(new Date());
    const byType = {};
    parts.forEach((part) => {
      if (part.type !== "literal") {
        byType[part.type] = part.value;
      }
    });

    return new Date(
      Date.UTC(
        Number(byType.year),
        Number(byType.month) - 1,
        Number(byType.day),
        Number(byType.hour),
        Number(byType.minute),
        0,
        0
      )
    );
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function formatDateUTC(date) {
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }

  function formatTimeUTC(date) {
    return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  }

  function roundToHalfHourUTC(date) {
    const cloned = new Date(date.getTime());
    const minute = cloned.getUTCMinutes();

    cloned.setUTCSeconds(0, 0);
    if (minute === 0 || minute === 30) {
      return cloned;
    }

    if (minute < 30) {
      cloned.setUTCMinutes(30, 0, 0);
      return cloned;
    }

    cloned.setUTCHours(cloned.getUTCHours() + 1, 0, 0, 0);
    return cloned;
  }

  function buildPickupTimeOptions() {
    pickupTimeEl.innerHTML = "";
    for (let hour = 9; hour <= 21; hour += 1) {
      [0, 30].forEach((minute) => {
        if (hour === 21 && minute > 0) {
          return;
        }
        const value = `${pad(hour)}:${pad(minute)}`;
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        pickupTimeEl.appendChild(option);
      });
    }
  }

  function setDefaultPickupByTokyoTime() {
    const nowTokyo = getTokyoNow();
    let pickup = roundToHalfHourUTC(nowTokyo);

    const hour = pickup.getUTCHours();
    const minute = pickup.getUTCMinutes();

    if (hour < 9) {
      pickup.setUTCHours(9, 0, 0, 0);
    } else if (hour > 21 || (hour === 21 && minute > 0)) {
      pickup.setUTCDate(pickup.getUTCDate() + 1);
      pickup.setUTCHours(9, 0, 0, 0);
    }

    pickupDateEl.value = formatDateUTC(pickup);
    pickupTimeEl.value = formatTimeUTC(pickup);
  }

  function syncPickupHiddenValue() {
    if (!pickupDateEl.value || !pickupTimeEl.value) {
      pickupHiddenEl.value = "";
      return;
    }
    pickupHiddenEl.value = `${pickupDateEl.value}T${pickupTimeEl.value}`;
  }


  function maybeWarnLatePickup(force) {
    const shouldWarn = isLatePickupTime(pickupTimeEl.value);
    pickupTimeEl.classList.toggle("late-pickup", shouldWarn);
    if (!shouldWarn) {
      latePickupWarned = false;
      return;
    }

    if (force || !latePickupWarned) {
      window.alert(messages.latePickupWarning);
      latePickupWarned = true;
    }
  }

  function setMeta(message) {
    if (priceMetaEl) {
      priceMetaEl.textContent = message;
    }
  }

  function formatMessage(template, values) {
    return template.replace(/\{(\w+)\}/g, (_match, key) => {
      return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : "";
    });
  }

  function syncCompanionCount() {
    if (!companionSelectEl || !companionCustomEl || !companionHiddenEl) {
      return true;
    }

    if (companionSelectEl.value === "custom") {
      companionCustomEl.classList.remove("is-hidden");
      companionCustomEl.required = true;

      const min = Number(companionCustomEl.min || 11);
      const max = Number(companionCustomEl.max || 99);
      const value = Number(companionCustomEl.value || 0);

      if (!Number.isInteger(value) || value < min || value > max) {
        companionHiddenEl.value = "";
        return false;
      }

      companionHiddenEl.value = String(value);
      return true;
    }

    companionCustomEl.classList.add("is-hidden");
    companionCustomEl.required = false;
    companionCustomEl.value = "";
    companionHiddenEl.value = companionSelectEl.value;
    return true;
  }

  function initCompanionPicker() {
    if (!companionSelectEl || !companionCustomEl || !companionHiddenEl) {
      return;
    }

    companionSelectEl.addEventListener("change", syncCompanionCount);
    companionCustomEl.addEventListener("input", syncCompanionCount);
    companionCustomEl.addEventListener("change", syncCompanionCount);
    syncCompanionCount();
  }

  function syncBagPicker(selectEl, customEl, hiddenEl) {
    if (selectEl.value === "custom") {
      customEl.classList.remove("is-hidden");
      customEl.required = true;

      const min = Number(customEl.min || 11);
      const max = Number(customEl.max || 99);
      const value = Number(customEl.value || 0);
      if (!Number.isInteger(value) || value < min || value > max) {
        hiddenEl.value = "";
        return false;
      }
      hiddenEl.value = String(value);
      return true;
    }

    customEl.classList.add("is-hidden");
    customEl.required = false;
    customEl.value = "";
    hiddenEl.value = selectEl.value;
    return true;
  }

  function syncBagQuantities() {
    const suitcaseValid = syncBagPicker(suitcaseSelectEl, suitcaseCustomEl, suitcaseEl);
    const backpackValid = syncBagPicker(backpackSelectEl, backpackCustomEl, backpackEl);
    return suitcaseValid && backpackValid;
  }

  function initBagQuantityPickers() {
    const onPickerChanged = () => {
      syncBagQuantities();
      refreshPreview();
    };

    suitcaseSelectEl.addEventListener("change", onPickerChanged);
    backpackSelectEl.addEventListener("change", onPickerChanged);
    suitcaseCustomEl.addEventListener("input", onPickerChanged);
    suitcaseCustomEl.addEventListener("change", onPickerChanged);
    backpackCustomEl.addEventListener("input", onPickerChanged);
    backpackCustomEl.addEventListener("change", onPickerChanged);

    syncBagQuantities();
  }

  function shouldOptimizeImage(file, forceOptimize) {
    if (!file || !file.type || !file.type.startsWith("image/")) {
      return false;
    }
    if (forceOptimize) {
      return true;
    }
    const contentType = file.type.toLowerCase();
    const isHeavyType = contentType.includes("heic") || contentType.includes("heif");
    return isHeavyType || file.size >= OPTIMIZE_SIZE_THRESHOLD;
  }

  function formatFileSize(bytes) {
    const value = Number(bytes || 0);
    if (value >= 1024 * 1024) {
      return `${(value / (1024 * 1024)).toFixed(1)}MB`;
    }
    return `${Math.max(Math.round(value / 1024), 1)}KB`;
  }

  function baseName(fileName) {
    const raw = String(fileName || "photo");
    return raw.replace(/\.[^.]+$/, "").slice(0, 40);
  }

  function loadImageElement(file) {
    return new Promise((resolve, reject) => {
      const blobUrl = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(blobUrl);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(blobUrl);
        reject(new Error("Image load failed"));
      };
      image.src = blobUrl;
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    });
  }

  async function optimizeImageFile(file) {
    if (!file || !file.type || !file.type.startsWith("image/")) {
      return file;
    }

    let image;
    try {
      image = await loadImageElement(file);
    } catch (_error) {
      return file;
    }

    const width = Number(image.naturalWidth || image.width || 0);
    const height = Number(image.naturalHeight || image.height || 0);
    if (width < 1 || height < 1) {
      return file;
    }

    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(width, height));
    const targetWidth = Math.max(Math.round(width * scale), 1);
    const targetHeight = Math.max(Math.round(height * scale), 1);

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return file;
    }
    ctx.drawImage(image, 0, 0, targetWidth, targetHeight);

    const qualities = [0.86, 0.76, 0.66, 0.56];
    let selectedBlob = null;

    for (const quality of qualities) {
      const blob = await canvasToBlob(canvas, "image/jpeg", quality);
      if (!blob) {
        continue;
      }
      if (!selectedBlob || blob.size < selectedBlob.size) {
        selectedBlob = blob;
      }
      if (blob.size <= TARGET_IMAGE_BYTES) {
        selectedBlob = blob;
        break;
      }
    }

    if (!selectedBlob) {
      return file;
    }

    if (selectedBlob.size >= file.size * 0.96 && file.size <= TARGET_IMAGE_BYTES) {
      return file;
    }

    const optimizedName = `${baseName(file.name)}-opt.jpg`;
    return new File([selectedBlob], optimizedName, {
      type: "image/jpeg",
      lastModified: Date.now(),
    });
  }

  async function optimizeInputIfNeeded(inputEl, textEl, emptyText, forceOptimize) {
    if (!inputEl || !textEl) {
      return;
    }

    const sourceFile = inputEl.files && inputEl.files[0];
    if (!sourceFile) {
      optimizedFilesByField.delete(inputEl.name);
      textEl.textContent = emptyText || "";
      return;
    }

    textEl.textContent = sourceFile.name;
    if (!shouldOptimizeImage(sourceFile, forceOptimize)) {
      optimizedFilesByField.set(inputEl.name, sourceFile);
      return;
    }

    const optimizedFile = await optimizeImageFile(sourceFile);
    optimizedFilesByField.set(inputEl.name, optimizedFile);
    if (optimizedFile !== sourceFile) {
      textEl.textContent = `${sourceFile.name} · ${messages.fileOptimized} (${formatFileSize(
        optimizedFile.size
      )})`;
    }
  }

  async function prepareUploadFiles(forceOptimize) {
    const fileTargets = [
      {
        inputEl: idImageInputEl,
        textEl: document.getElementById("id_image_name"),
      },
      {
        inputEl: luggageImageInputEl,
        textEl: document.getElementById("luggage_image_name"),
      },
    ];

    setUploadStatus(messages.uploadOptimizing, "busy");
    try {
      await Promise.all(
        fileTargets.map(({ inputEl, textEl }) => {
          if (!inputEl || !textEl) {
            return Promise.resolve();
          }
          const emptyText = textEl.getAttribute("data-file-empty") || "";
          return optimizeInputIfNeeded(inputEl, textEl, emptyText, forceOptimize);
        })
      );
    } finally {
      clearUploadStatus();
    }
  }

  function initFilePickers() {
    const triggers = Array.from(document.querySelectorAll("[data-file-trigger]"));
    triggers.forEach((trigger) => {
      const inputId = trigger.getAttribute("data-file-trigger");
      const inputEl = document.getElementById(inputId);
      const textEl = document.getElementById(`${inputId}_name`);
      if (!inputEl || !textEl) {
        return;
      }

      const emptyText = textEl.getAttribute("data-file-empty") || "";
      trigger.addEventListener("click", () => {
        inputEl.click();
      });

      inputEl.addEventListener("change", async () => {
        if (!inputEl.files || inputEl.files.length === 0) {
          optimizedFilesByField.delete(inputEl.name);
          textEl.textContent = emptyText;
          return;
        }
        try {
          setUploadStatus(messages.uploadOptimizing, "busy");
          await optimizeInputIfNeeded(inputEl, textEl, emptyText, false);
          clearUploadStatus();
        } catch (_error) {
          optimizedFilesByField.set(inputEl.name, inputEl.files[0]);
          textEl.textContent = inputEl.files[0].name;
          setUploadStatus(messages.uploadError, "error");
        }
      });
    });
  }

  async function refreshPreview() {
    syncPickupHiddenValue();

    const suitcaseQty = Number(suitcaseEl.value || 0);
    const backpackQty = Number(backpackEl.value || 0);
    const expectedPickupAt = pickupHiddenEl.value;

    if (!expectedPickupAt || (suitcaseQty === 0 && backpackQty === 0)) {
      priceValueEl.textContent = "-";
      setMeta(messages.metaEmpty);
      return;
    }

    try {
      const params = new URLSearchParams({
        suitcase_qty: String(suitcaseQty),
        backpack_qty: String(backpackQty),
        expected_pickup_at: expectedPickupAt,
      });
      const response = await fetch(`/api/price-preview?${params.toString()}`);
      const data = await response.json();

      if (!response.ok) {
        priceValueEl.textContent = messages.invalidTitle;
        setMeta(data.detail || messages.invalidMeta);
        return;
      }

      const ratePct = Math.round(data.discount_rate * 100);
      priceValueEl.textContent = formatYen(data.prepaid_amount);
      setMeta(
        formatMessage(messages.resultMeta, {
          price_per_day: jpy.format(Math.abs(normalizeAmount(data.price_per_day))),
          days: data.expected_storage_days,
          set_qty: Math.max(normalizeAmount(data.set_qty), 0),
          discount: ratePct,
        })
      );
    } catch (_error) {
      priceValueEl.textContent = messages.errorTitle;
      setMeta(messages.errorMeta);
    }
  }

  buildPickupTimeOptions();

  const todayTokyo = getTokyoNow();
  pickupDateEl.min = formatDateUTC(todayTokyo);
  setDefaultPickupByTokyoTime();
  loadDraft();
  ensureValidPickupDefaults();
  syncPickupHiddenValue();

  [pickupDateEl, pickupTimeEl].forEach((el) => {
    el.addEventListener("change", refreshPreview);
    el.addEventListener("input", refreshPreview);
  });
  pickupTimeEl.addEventListener("change", () => {
    maybeWarnLatePickup(false);
  });

  initCompanionPicker();
  initBagQuantityPickers();
  initFilePickers();
  bindDraftEvents();
  saveDraft();

  formEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (isSubmitting) {
      return;
    }

    syncPickupHiddenValue();
    const isBagValid = syncBagQuantities();
    if (!isBagValid) {
      if (suitcaseSelectEl.value === "custom" && !suitcaseEl.value) {
        suitcaseCustomEl.focus();
        return;
      }
      if (backpackSelectEl.value === "custom" && !backpackEl.value) {
        backpackCustomEl.focus();
        return;
      }
      return;
    }

    const isCompanionValid = syncCompanionCount();
    if (!isCompanionValid && companionCustomEl) {
      companionCustomEl.focus();
      return;
    }

    maybeWarnLatePickup(false);

    isSubmitting = true;
    setSubmitBusy(true);
    window.addEventListener("beforeunload", beforeUnloadWhileSubmitting);
    try {
      await prepareUploadFiles(true);
      setUploadStatus(messages.uploadSubmitting, "busy");

      var idImage = optimizedFilesByField.get("id_image");
      var luggageImage = optimizedFilesByField.get("luggage_image");
      var hasDataTransfer = typeof DataTransfer === "function";
      if (idImage && idImageInputEl && hasDataTransfer) {
        var dt1 = new DataTransfer();
        dt1.items.add(idImage);
        idImageInputEl.files = dt1.files;
      }
      if (luggageImage && luggageImageInputEl && hasDataTransfer) {
        var dt2 = new DataTransfer();
        dt2.items.add(luggageImage);
        luggageImageInputEl.files = dt2.files;
      }

      clearDraft();
      window.removeEventListener("beforeunload", beforeUnloadWhileSubmitting);
      formEl.submit();
    } catch (_error) {
      setUploadStatus(messages.uploadError, "error");
      window.alert(messages.uploadError);
      isSubmitting = false;
      setSubmitBusy(false);
      window.removeEventListener("beforeunload", beforeUnloadWhileSubmitting);
    }
  });

  refreshPreview();
})();
