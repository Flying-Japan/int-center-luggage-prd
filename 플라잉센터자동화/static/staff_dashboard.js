(function () {
  const formEl = document.getElementById("staff-search-form");
  const qEl = document.getElementById("search-q");
  const statusButtonsEl = document.getElementById("status-filter-buttons");
  const statusAllButtonEl = document.getElementById("status-filter-all");
  const statusInputEls = Array.from(document.querySelectorAll(".status-filter-input"));
  const showAllPickedUpEl = document.getElementById("show-all-picked-up");
  const tbodyEl = document.getElementById("staff-orders-tbody");
  const tableEl = document.getElementById("staff-orders-table");
  const tableWrapEl = tableEl ? tableEl.closest(".table-wrap") : null;
  const statusValues = ["PAYMENT_PENDING", "PAID", "PICKED_UP"];
  const COL_WIDTH_STORAGE_KEY = "flying-japan-staff-col-widths-v9";
  ["v2","v3","v4","v5","v6","v7","v8"].forEach(function (v) {
    FJ.safeStorageRemove("flying-japan-staff-col-widths-" + v);
  });
  const columnSchema = [
    { key: "name", min: 120, weight: 1.5 },
    { key: "tag_no", min: 62, weight: 0 },
    { key: "created_time", min: 105, weight: 0 },
    { key: "price", min: 200, weight: 0 },
    { key: "pickup_time", min: 100, weight: 0 },
    { key: "luggage_image", min: 66, weight: 0 },
    { key: "pickup_action", min: 148, weight: 0 },
    { key: "note", min: 140, weight: 4.5 },
    { key: "detail", min: 58, weight: 0 },
  ];
  var _rawTiers = [];
  try { _rawTiers = JSON.parse(tbodyEl.dataset.flyingPassTiers || "[]"); } catch (_) {}
  var FLYING_PASS_TIERS = _rawTiers.length ? _rawTiers : [
    { value: "NONE", label: "미적용", discount: 0 },
    { value: "BLUE", label: "블루", discount: 100 },
    { value: "SILVER", label: "실버", discount: 200 },
    { value: "GOLD", label: "골드", discount: 300 },
    { value: "PLATINUM", label: "플래티넘", discount: 400 },
    { value: "BLACK", label: "블랙", discount: 0 },
  ];
  var FLYING_PASS_TIER_OPTIONS = FLYING_PASS_TIERS.map(function (t) {
    if (t.value === "BLACK") return { value: t.value, label: t.label + " (무료)" };
    if (t.discount > 0) return { value: t.value, label: t.label + " (-¥ " + t.discount.toLocaleString() + ")" };
    return { value: t.value, label: t.label };
  });

  if (!formEl || !qEl || !statusButtonsEl || !tbodyEl || !tableEl || !statusInputEls.length) {
    return;
  }

  var formatYen = FJ.formatYen;
  var isLatePickupTime = FJ.isLatePickupTime;
  const confirmSaveText = tbodyEl.dataset.confirmSaveText || "입력한 내용으로 수정하시겠습니까?";
  const confirmPickupText = tbodyEl.dataset.confirmPickupText || "수령완료 처리하시겠습니까?";
  const confirmUndoPickupText = tbodyEl.dataset.confirmUndoPickupText || "수령완료를 취소하시겠습니까?";



  function toSafeInt(value, fallback = 0) {
    const amount = Math.trunc(Number(value));
    if (!Number.isFinite(amount)) {
      return fallback;
    }
    return amount;
  }

  function toNonNegativeInt(value) {
    return Math.max(0, toSafeInt(value, 0));
  }

  var _tierLabelMap = {};
  FLYING_PASS_TIERS.forEach(function (t) { _tierLabelMap[t.value] = t.label; });

  function tierLabel(tierValue) {
    var normalizedTier = String(tierValue || "").toUpperCase();
    return _tierLabelMap[normalizedTier] || _tierLabelMap["NONE"] || "미적용";
  }

  var _tierDiscountMap = {};
  FLYING_PASS_TIERS.forEach(function (t) { _tierDiscountMap[t.value] = t.discount; });

  function memberDiscountByTier(basePrepaid, tierValue) {
    var normalizedTier = String(tierValue || "").toUpperCase();
    var safeBase = toNonNegativeInt(basePrepaid);
    if (normalizedTier === "BLACK") {
      return safeBase;
    }
    return Math.min(safeBase, toNonNegativeInt(_tierDiscountMap[normalizedTier] || 0));
  }

  function autoPrepaidByTier(basePrepaid, tierValue) {
    const safeBase = toNonNegativeInt(basePrepaid);
    return Math.max(0, safeBase - memberDiscountByTier(safeBase, tierValue));
  }

  var lastRenderedOrders = new Map();

  let debounceTimer = null;
  let activeController = null;
  let viewportResizeTimer = null;
  let customColumnWidths = loadSavedColumnWidths();

  function loadSavedColumnWidths() {
    try {
      const raw = FJ.safeStorageGet(COL_WIDTH_STORAGE_KEY);
      if (!raw) {
        return {};
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return {};
      }
      const normalized = {};
      columnSchema.forEach((column) => {
        const value = Number(parsed[column.key]);
        if (Number.isFinite(value) && value >= column.min) {
          normalized[column.key] = Math.round(value);
        }
      });
      return normalized;
    } catch (_error) {
      return {};
    }
  }

  function saveColumnWidths(widths) {
    try {
      FJ.safeStorageSet(COL_WIDTH_STORAGE_KEY, JSON.stringify(widths));
    } catch (_error) {
      // Ignore storage quota/private mode issues.
    }
  }

  function minWidthForKey(key) {
    const column = columnSchema.find((item) => item.key === key);
    return column ? column.min : 80;
  }

  function availableTableWidth() {
    const minTotal = columnSchema.reduce((total, column) => total + column.min, 0);
    const wrapWidth = tableWrapEl ? tableWrapEl.clientWidth : tableEl.clientWidth;
    return Math.max(minTotal, wrapWidth - 4);
  }

  function computeAutoWidths() {
    const target = availableTableWidth();
    const minTotal = columnSchema.reduce((total, column) => total + column.min, 0);
    const extra = Math.max(0, target - minTotal);
    const totalWeight = columnSchema.reduce((total, column) => total + column.weight, 0);

    const widths = {};
    columnSchema.forEach((column) => {
      const distributed = totalWeight > 0 ? (extra * column.weight) / totalWeight : 0;
      widths[column.key] = Math.max(column.min, Math.round(column.min + distributed));
    });
    return widths;
  }

  function fitWidthsToViewport(widths) {
    const target = availableTableWidth();
    const normalized = {};
    let total = 0;
    columnSchema.forEach((column) => {
      const value = Math.max(column.min, Number(widths[column.key] || column.min));
      normalized[column.key] = value;
      total += value;
    });

    if (total <= 0) {
      return computeAutoWidths();
    }

    const ratio = target / total;
    const scaled = {};
    columnSchema.forEach((column) => {
      scaled[column.key] = Math.max(column.min, Math.round(normalized[column.key] * ratio));
    });
    return scaled;
  }

  function applyColumnWidths(widths) {
    columnSchema.forEach((column) => {
      const colEl = tableEl.querySelector(`col[data-col-key="${column.key}"]`);
      if (!colEl) {
        return;
      }
      const widthValue = Math.max(column.min, Math.round(Number(widths[column.key] || column.min)));
      colEl.style.width = `${widthValue}px`;
    });
  }

  function readCurrentColumnWidths() {
    const widths = {};
    columnSchema.forEach((column) => {
      const colEl = tableEl.querySelector(`col[data-col-key="${column.key}"]`);
      if (!colEl) {
        return;
      }
      const width = Number.parseFloat(colEl.style.width || "");
      if (Number.isFinite(width) && width > 0) {
        widths[column.key] = width;
      }
    });
    return widths;
  }

  function refreshColumnWidths() {
    const autoWidths = computeAutoWidths();
    const merged = { ...autoWidths, ...customColumnWidths };
    applyColumnWidths(fitWidthsToViewport(merged));
  }

  function setupColumnResizeHandles() {
    const headerCells = Array.from(tableEl.querySelectorAll("thead th[data-col-key]"));
    headerCells.forEach((headerCell) => {
      const key = String(headerCell.dataset.colKey || "").trim();
      if (!key || headerCell.querySelector(".col-resize-handle")) {
        return;
      }

      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "col-resize-handle";
      handle.setAttribute("aria-label", "열 너비 조절");
      headerCell.appendChild(handle);

      handle.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();

        const currentWidths = readCurrentColumnWidths();
        const startWidth = Math.max(minWidthForKey(key), Number(currentWidths[key] || headerCell.getBoundingClientRect().width));
        const startX = event.clientX;

        handle.setPointerCapture(event.pointerId);
        document.body.classList.add("is-resizing-column");

        function onPointerMove(moveEvent) {
          const delta = moveEvent.clientX - startX;
          const nextWidth = Math.max(minWidthForKey(key), Math.round(startWidth + delta));
          const nextWidths = { ...readCurrentColumnWidths(), [key]: nextWidth };
          applyColumnWidths(nextWidths);
        }

        function onPointerUp() {
          handle.removeEventListener("pointermove", onPointerMove);
          handle.removeEventListener("pointerup", onPointerUp);
          handle.removeEventListener("pointercancel", onPointerUp);
          document.body.classList.remove("is-resizing-column");

          const finalized = readCurrentColumnWidths();
          if (Number.isFinite(finalized[key])) {
            customColumnWidths[key] = Math.round(finalized[key]);
            saveColumnWidths(customColumnWidths);
          }
        }

        handle.addEventListener("pointermove", onPointerMove);
        handle.addEventListener("pointerup", onPointerUp);
        handle.addEventListener("pointercancel", onPointerUp);
      });

      handle.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        delete customColumnWidths[key];
        saveColumnWidths(customColumnWidths);
        refreshColumnWidths();
      });
    });
  }

  function selectedStatusValues() {
    const selected = statusInputEls
      .filter((inputEl) => inputEl.checked)
      .map((inputEl) => String(inputEl.value || "").trim())
      .filter(Boolean);
    if (selected.length) {
      return selected;
    }
    return statusValues.slice();
  }

  function syncSelectAllButtonState() {
    if (!statusAllButtonEl) {
      return;
    }
    const selectedCount = statusInputEls.filter((inputEl) => inputEl.checked).length;
    const isAllSelected = selectedCount === 0 || selectedCount === statusInputEls.length;
    statusAllButtonEl.classList.toggle("is-active", isAllSelected);
  }

  function selectAllStatuses() {
    statusInputEls.forEach((inputEl) => {
      inputEl.checked = true;
    });
    syncSelectAllButtonState();
  }


  function applyLatePickupStyle(inputEl) {
    inputEl.classList.toggle("late-pickup", isLatePickupTime(inputEl.value));
  }

  function buildInputCell(value, field, type) {
    const td = document.createElement("td");
    td.dataset.colKey = field;
    const input = document.createElement("input");
    input.className = "control table-control";
    input.type = type || "text";
    input.value = value || "";
    input.dataset.field = field;
    td.appendChild(input);
    return td;
  }

  function applyPaymentButtonState(button, status) {
    button.classList.remove("is-paid", "is-pending");
    if (status === "PAID") {
      button.classList.add("is-paid");
      button.textContent = "결제완료";
      return;
    }
    button.classList.add("is-pending");
    button.textContent = "결제대기";
  }

  function syncPriceCellMeta(row) {
    const basePrepaidAmount = toNonNegativeInt(row.dataset.basePrepaidAmount);
    const tierSelect = row.querySelector('[data-field="flying_pass_tier"]');
    const priceInput = row.querySelector('[data-field="prepaid_amount"]');
    const paymentMethodSelect = row.querySelector('[data-field="payment_method"]');
    const amountText = row.querySelector('[data-role="price-amount-text"]');
    const hoverTierEl = row.querySelector('[data-role="price-hover-tier"]');
    const hoverDiscountEl = row.querySelector('[data-role="price-hover-discount"]');
    const hoverAutoEl = row.querySelector('[data-role="price-hover-auto"]');
    const hoverFinalEl = row.querySelector('[data-role="price-hover-final"]');
    if (!(tierSelect instanceof HTMLSelectElement) || !(priceInput instanceof HTMLInputElement) || !(paymentMethodSelect instanceof HTMLSelectElement)) {
      return;
    }

    const tier = String(tierSelect.value || "NONE").toUpperCase();
    const paymentMethodLabel = paymentMethodSelect.value === "CASH" ? "현금" : "QR";
    const discountAmount = memberDiscountByTier(basePrepaidAmount, tier);
    const autoPrepaidAmount = autoPrepaidByTier(basePrepaidAmount, tier);
    const editedPrepaidAmount = toNonNegativeInt(priceInput.value || autoPrepaidAmount);
    const isOverridden = editedPrepaidAmount !== autoPrepaidAmount;

    row.dataset.autoPrepaidAmount = String(autoPrepaidAmount);
    priceInput.value = String(editedPrepaidAmount);

    if (amountText instanceof HTMLElement) {
      amountText.textContent = `${formatYen(editedPrepaidAmount)} · ${paymentMethodLabel}`;
    }
    if (hoverTierEl instanceof HTMLElement) {
      hoverTierEl.textContent = tierLabel(tier);
    }
    if (hoverDiscountEl instanceof HTMLElement) {
      hoverDiscountEl.textContent = formatYen(discountAmount);
    }
    if (hoverAutoEl instanceof HTMLElement) {
      hoverAutoEl.textContent = formatYen(autoPrepaidAmount);
    }
    if (hoverFinalEl instanceof HTMLElement) {
      hoverFinalEl.textContent = formatYen(editedPrepaidAmount);
    }

    priceInput.classList.toggle("price-edit-overridden", isOverridden);
  }

  function closeAllPriceConfigs(exceptWrap = null) {
    Array.from(tbodyEl.querySelectorAll(".price-config-wrap.is-open")).forEach((wrap) => {
      if (wrap !== exceptWrap) {
        wrap.classList.remove("is-open");
      }
    });
  }

  function applyTierAutoPrice(row, tierValue) {
    const priceInput = row.querySelector('[data-field="prepaid_amount"]');
    if (!(priceInput instanceof HTMLInputElement)) {
      return;
    }
    const basePrepaidAmount = toNonNegativeInt(row.dataset.basePrepaidAmount);
    const nextAutoPrepaidAmount = autoPrepaidByTier(basePrepaidAmount, tierValue);
    priceInput.value = String(nextAutoPrepaidAmount);
    syncPriceCellMeta(row);
  }

  function buildPaymentPriceCell(order) {
    const td = document.createElement("td");
    td.className = "price-status-cell";
    const isPickedUp = Boolean(order.is_picked_up);

    const summary = document.createElement("div");
    summary.className = "price-summary-row";

    const priceHoverWrap = document.createElement("div");
    priceHoverWrap.className = "price-hover-wrap";

    const amountText = document.createElement("div");
    amountText.className = "price-amount";
    amountText.dataset.role = "price-amount-text";
    priceHoverWrap.appendChild(amountText);

    const hoverCard = document.createElement("div");
    hoverCard.className = "price-hover-card";
    hoverCard.setAttribute("aria-hidden", "true");

    const hoverTitle = document.createElement("p");
    hoverTitle.className = "price-hover-title";
    hoverTitle.textContent = "짐 요금 계산";
    hoverCard.appendChild(hoverTitle);

    const addHoverLine = (label, value, role = "") => {
      const line = document.createElement("p");
      line.className = "price-hover-line";
      const strong = document.createElement("strong");
      strong.textContent = label;
      const span = document.createElement("span");
      span.textContent = value;
      if (role) {
        span.dataset.role = role;
      }
      line.appendChild(strong);
      line.appendChild(span);
      hoverCard.appendChild(line);
      return span;
    };

    addHoverLine(
      "짐 수량",
      `캐리어 ${toNonNegativeInt(order.suitcase_qty)} / 백팩 ${toNonNegativeInt(order.backpack_qty)} / 세트 ${toNonNegativeInt(order.set_qty)}`
    );
    addHoverLine("1일 기본요금", formatYen(order.price_per_day));
    addHoverLine("예상 보관일수", `${toNonNegativeInt(order.expected_storage_days || 1)}일`);
    addHoverLine("할인 전 선결제", formatYen(order.base_prepaid_amount));
    addHoverLine("패스 등급", tierLabel(order.flying_pass_tier), "price-hover-tier");
    addHoverLine("패스 할인", formatYen(order.flying_pass_discount_amount), "price-hover-discount");
    addHoverLine("자동 계산요금", formatYen(order.auto_prepaid_amount), "price-hover-auto");
    addHoverLine("현재 적용요금", formatYen(order.prepaid_amount), "price-hover-final");

    priceHoverWrap.appendChild(hoverCard);
    summary.appendChild(priceHoverWrap);

    td.appendChild(summary);

    const configWrap = document.createElement("div");
    configWrap.className = "price-config-wrap";

    const configToggle = document.createElement("button");
    configToggle.className = "btn btn-secondary btn-sm";
    configToggle.type = "button";
    configToggle.dataset.action = "toggle-price-config";
    configToggle.textContent = "요금설정";
    if (isPickedUp) {
      configToggle.disabled = true;
      configToggle.classList.add("is-disabled");
    }
    configWrap.appendChild(configToggle);

    const configPopover = document.createElement("div");
    configPopover.className = "price-config-popover";

    const configTitle = document.createElement("div");
    configTitle.className = "price-config-title";
    configTitle.textContent = "요금/결제 설정";
    configPopover.appendChild(configTitle);

    const paymentMethodSelect = document.createElement("select");
    paymentMethodSelect.className = "control table-control member-tier-control";
    paymentMethodSelect.dataset.field = "payment_method";
    [
      { value: "PAY_QR", label: "QR결제" },
      { value: "CASH", label: "현금" },
    ].forEach((item) => {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      option.selected = item.value === String(order.payment_method_code || "PAY_QR");
      paymentMethodSelect.appendChild(option);
    });
    paymentMethodSelect.disabled = isPickedUp;
    configPopover.appendChild(paymentMethodSelect);

    const tierSelect = document.createElement("select");
    tierSelect.className = "control table-control member-tier-control";
    tierSelect.dataset.field = "flying_pass_tier";
    const selectedTier = String(order.flying_pass_tier || "NONE").toUpperCase();
    FLYING_PASS_TIER_OPTIONS.forEach((optionDef) => {
      const option = document.createElement("option");
      option.value = optionDef.value;
      option.textContent = optionDef.label;
      if (optionDef.value === selectedTier) {
        option.selected = true;
      }
      tierSelect.appendChild(option);
    });
    tierSelect.disabled = isPickedUp;
    configPopover.appendChild(tierSelect);

    const amountInput = document.createElement("input");
    amountInput.className = "control table-control price-edit-control";
    amountInput.type = "number";
    amountInput.min = "0";
    amountInput.step = "100";
    amountInput.dataset.field = "prepaid_amount";
    amountInput.value = String(toNonNegativeInt(order.prepaid_amount));
    amountInput.readOnly = isPickedUp;
    configPopover.appendChild(amountInput);

    const configActions = document.createElement("div");
    configActions.className = "price-config-actions";

    const applyButton = document.createElement("button");
    applyButton.className = "btn btn-primary btn-sm";
    applyButton.type = "button";
    applyButton.dataset.action = "save-price-config";
    applyButton.textContent = "적용";
    applyButton.disabled = isPickedUp;
    configActions.appendChild(applyButton);

    const closeButton = document.createElement("button");
    closeButton.className = "btn btn-secondary btn-sm";
    closeButton.type = "button";
    closeButton.dataset.action = "close-price-config";
    closeButton.textContent = "닫기";
    configActions.appendChild(closeButton);

    configPopover.appendChild(configActions);
    configWrap.appendChild(configPopover);
    td.appendChild(configWrap);

    const hidden = document.createElement("input");
    hidden.type = "hidden";
    hidden.dataset.field = "payment_status";
    hidden.value = order.payment_status || "PAYMENT_PENDING";
    td.appendChild(hidden);
    return td;
  }

  function buildPickupTimeCell(order) {
    const td = document.createElement("td");
    const timeInput = document.createElement("input");
    timeInput.className = "control table-control";
    timeInput.type = "time";
    timeInput.value = order.expected_pickup_time || "09:00";
    timeInput.dataset.field = "expected_pickup_time";
    applyLatePickupStyle(timeInput);
    td.appendChild(timeInput);

    const hiddenDate = document.createElement("input");
    hiddenDate.type = "hidden";
    hiddenDate.dataset.field = "expected_pickup_date";
    hiddenDate.value = order.expected_pickup_date || "";
    td.appendChild(hiddenDate);
    return td;
  }

  function buildImageLinkCell(href, imageLabel) {
    const td = document.createElement("td");
    td.className = "luggage-cell";
    if (!href) {
      td.textContent = "-";
      return td;
    }

    const wrap = document.createElement("div");
    wrap.className = "luggage-hover-wrap";

    const button = document.createElement("button");
    button.className = "btn btn-secondary btn-sm";
    button.type = "button";
    button.textContent = "보기";
    wrap.appendChild(button);

    const card = document.createElement("div");
    card.className = "luggage-hover-card";
    card.setAttribute("aria-hidden", "true");

    const image = document.createElement("img");
    image.src = href;
    image.alt = imageLabel || "짐 사진";
    image.loading = "lazy";
    card.appendChild(image);
    wrap.appendChild(card);

    td.appendChild(wrap);
    return td;
  }

  function buildPickupActionCell(order) {
    const td = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "inline-actions";

    const paymentButton = document.createElement("button");
    paymentButton.className = "btn btn-sm payment-state-btn";
    paymentButton.type = "button";
    paymentButton.dataset.action = "toggle-payment-status";
    applyPaymentButtonState(paymentButton, order.payment_status || "PAYMENT_PENDING");
    if (order.is_picked_up) {
      paymentButton.disabled = true;
      paymentButton.classList.add("is-disabled");
    }
    actions.appendChild(paymentButton);

    if (order.is_picked_up) {
      const undoButton = document.createElement("button");
      undoButton.className = "btn btn-sm pickup-undo-btn";
      undoButton.type = "button";
      undoButton.dataset.action = "undo-pickup";
      undoButton.textContent = "수령취소";
      actions.appendChild(undoButton);
    } else {
      const pickupButton = document.createElement("button");
      pickupButton.className = "btn btn-sm pickup-complete-btn";
      pickupButton.type = "button";
      pickupButton.dataset.action = "pickup";
      pickupButton.textContent = "수령완료";
      actions.appendChild(pickupButton);
    }
    td.appendChild(actions);
    return td;
  }

  function buildDetailCell(order) {
    const td = document.createElement("td");
    const link = document.createElement("a");
    link.className = "btn btn-secondary btn-sm";
    link.href = order.detail_url || "#";
    link.textContent = "상세";
    td.appendChild(link);
    return td;
  }

  function orderFingerprint(order) {
    return JSON.stringify(order, Object.keys(order).sort());
  }

  function rowIsActive(row) {
    var active = document.activeElement;
    if (active && row.contains(active)) {
      return true;
    }
    if (row.querySelector(".price-config-wrap.is-open")) {
      return true;
    }
    return false;
  }

  function buildOrderRow(order) {
    var row = document.createElement("tr");
    row.dataset.orderId = order.order_id;
    row.dataset.basePrepaidAmount = String(toNonNegativeInt(order.base_prepaid_amount));
    row.dataset.autoPrepaidAmount = String(toNonNegativeInt(order.auto_prepaid_amount));

    row.appendChild(buildInputCell(order.name, "name", "text"));
    row.appendChild(buildInputCell(order.tag_no, "tag_no", "text"));
    var createdTd = document.createElement("td");
    createdTd.dataset.colKey = "created_time";
    createdTd.textContent = order.created_time || "";
    row.appendChild(createdTd);
    var priceTd = buildPaymentPriceCell(order); priceTd.dataset.colKey = "price"; row.appendChild(priceTd);
    var pickupTd = buildPickupTimeCell(order); pickupTd.dataset.colKey = "pickup_time"; row.appendChild(pickupTd);
    var imgTd = buildImageLinkCell(order.luggage_image_url || "", `${order.name || "고객"} 짐 사진`); imgTd.dataset.colKey = "luggage_image"; row.appendChild(imgTd);
    var actionTd = buildPickupActionCell(order); actionTd.dataset.colKey = "pickup_action"; row.appendChild(actionTd);
    row.appendChild(buildInputCell(order.note, "note", "text"));
    var detailTd = buildDetailCell(order); detailTd.dataset.colKey = "detail"; row.appendChild(detailTd);
    syncPriceCellMeta(row);
    return row;
  }

  function renderOrders(orders) {
    if (!orders.length) {
      tbodyEl.innerHTML = "";
      lastRenderedOrders.clear();
      var emptyRow = document.createElement("tr");
      var emptyTd = document.createElement("td");
      emptyTd.colSpan = 9;
      emptyTd.textContent = tbodyEl.dataset.emptyText || "데이터가 없습니다.";
      emptyRow.appendChild(emptyTd);
      tbodyEl.appendChild(emptyRow);
      return;
    }

    var newOrderIds = new Set(orders.map(function (o) { return o.order_id; }));
    var existingRowsByOrderId = {};
    Array.from(tbodyEl.querySelectorAll("tr[data-order-id]")).forEach(function (row) {
      existingRowsByOrderId[row.dataset.orderId] = row;
    });

    // Remove rows no longer in data
    Object.keys(existingRowsByOrderId).forEach(function (id) {
      if (!newOrderIds.has(id)) {
        existingRowsByOrderId[id].remove();
        lastRenderedOrders.delete(id);
        delete existingRowsByOrderId[id];
      }
    });

    // Remove non-order rows (e.g. "no data" placeholder)
    Array.from(tbodyEl.querySelectorAll("tr:not([data-order-id])")).forEach(function (row) {
      row.remove();
    });

    var nextRendered = new Map();
    var previousRow = null;

    orders.forEach(function (order) {
      var fingerprint = orderFingerprint(order);
      var existingRow = existingRowsByOrderId[order.order_id];
      var effectiveFingerprint = fingerprint;
      var isActive = false;

      if (existingRow) {
        var unchanged = lastRenderedOrders.get(order.order_id) === fingerprint;
        isActive = rowIsActive(existingRow);
        if (!unchanged && !isActive) {
          var replacement = buildOrderRow(order);
          existingRow.replaceWith(replacement);
          existingRow = replacement;
          existingRowsByOrderId[order.order_id] = replacement;
        } else if (!unchanged && isActive) {
          // Preserve old fingerprint so next poll retries the update
          effectiveFingerprint = lastRenderedOrders.get(order.order_id) || fingerprint;
        }
      } else {
        existingRow = buildOrderRow(order);
        existingRowsByOrderId[order.order_id] = existingRow;
      }

      nextRendered.set(order.order_id, effectiveFingerprint);

      // Ensure correct ordering (skip repositioning for active rows)
      if (!isActive) {
        if (previousRow) {
          if (existingRow.previousElementSibling !== previousRow) {
            previousRow.after(existingRow);
          }
        } else if (existingRow !== tbodyEl.firstElementChild) {
          tbodyEl.prepend(existingRow);
        }
      }
      previousRow = existingRow;
    });

    lastRenderedOrders = nextRendered;
  }

  async function readErrorMessage(response) {
    try {
      const data = await response.json();
      if (data && typeof data.detail === "string" && data.detail) {
        return data.detail;
      }
    } catch (_error) {
      // Ignore parsing errors and fallback below.
    }
    return `요청 실패 (${response.status})`;
  }

  function valueOf(row, field) {
    const el = row.querySelector(`[data-field="${field}"]`);
    return el ? String(el.value || "").trim() : "";
  }

  function collectPayload(row) {
    const pickupDate = valueOf(row, "expected_pickup_date");
    const pickupTime = valueOf(row, "expected_pickup_time");

    return {
      name: valueOf(row, "name"),
      tag_no: valueOf(row, "tag_no"),
      prepaid_amount: valueOf(row, "prepaid_amount"),
      flying_pass_tier: valueOf(row, "flying_pass_tier"),
      payment_method: valueOf(row, "payment_method"),
      payment_status: valueOf(row, "payment_status"),
      expected_pickup_at: pickupDate && pickupTime ? `${pickupDate}T${pickupTime}` : "",
      note: valueOf(row, "note"),
    };
  }

  async function saveRow(row) {
    const orderId = row.dataset.orderId;
    if (!orderId) {
      return;
    }

    const response = await fetch(`/staff/api/orders/${encodeURIComponent(orderId)}/inline-update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(collectPayload(row)),
    });

    if (!response.ok) {
      window.alert(await readErrorMessage(response));
      return;
    }
    fetchOrders();
  }

  async function fetchOrders() {
    const params = new URLSearchParams();
    params.set("q", qEl.value || "");
    selectedStatusValues().forEach((value) => {
      params.append("status_filter", value);
    });
    if (showAllPickedUpEl && showAllPickedUpEl.checked) {
      params.set("show_all_picked_up", "true");
    }

    if (activeController) {
      activeController.abort();
    }
    activeController = new AbortController();

    try {
      const response = await fetch(`/staff/api/orders?${params.toString()}`, {
        signal: activeController.signal,
      });
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      renderOrders(Array.isArray(data.orders) ? data.orders : []);
    } catch (_error) {
      // Keep current rows for temporary network errors.
    }
  }

  function scheduleFetch() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(fetchOrders, 180);
  }

  formEl.addEventListener("submit", (event) => {
    event.preventDefault();
    fetchOrders();
  });
  qEl.addEventListener("input", scheduleFetch);
  statusInputEls.forEach((inputEl) => {
    inputEl.addEventListener("change", () => {
      syncSelectAllButtonState();
      fetchOrders();
    });
  });
  if (statusAllButtonEl) {
    statusAllButtonEl.addEventListener("click", () => {
      selectAllStatuses();
      fetchOrders();
    });
  }
  if (showAllPickedUpEl) {
    showAllPickedUpEl.addEventListener("change", fetchOrders);
  }

  tbodyEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }

    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    const row = target.closest("tr[data-order-id]");
    if (!row) {
      return;
    }

    const isPriceConfigInput = Boolean(target.closest(".price-config-popover"));
    if (isPriceConfigInput) {
      event.preventDefault();
      saveRow(row);
      const wrap = target.closest(".price-config-wrap");
      if (wrap) {
        wrap.classList.remove("is-open");
      }
      return;
    }

    event.preventDefault();
    if (!window.confirm(confirmSaveText)) {
      return;
    }
    saveRow(row);
  });

  tbodyEl.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const actionTarget = target.closest("[data-action]");
    if (!actionTarget) {
      return;
    }

    const row = actionTarget.closest("tr[data-order-id]");
    if (!row) {
      return;
    }

    const action = actionTarget.getAttribute("data-action");
    if (action === "toggle-price-config") {
      const wrap = actionTarget.closest(".price-config-wrap");
      if (!wrap) {
        return;
      }
      const shouldOpen = !wrap.classList.contains("is-open");
      closeAllPriceConfigs(shouldOpen ? wrap : null);
      wrap.classList.toggle("is-open", shouldOpen);
      return;
    }

    if (action === "close-price-config") {
      const wrap = actionTarget.closest(".price-config-wrap");
      if (wrap) {
        wrap.classList.remove("is-open");
      }
      return;
    }

    if (action === "save-price-config") {
      await saveRow(row);
      return;
    }

    if (action === "pickup") {
      if (!window.confirm(confirmPickupText)) {
        return;
      }

      const orderId = row.dataset.orderId;
      if (!orderId) {
        return;
      }
      const response = await fetch(`/staff/api/orders/${encodeURIComponent(orderId)}/pickup`, {
        method: "POST",
      });
      if (!response.ok) {
        window.alert(await readErrorMessage(response));
        return;
      }
      fetchOrders();
      return;
    }

    if (action === "undo-pickup") {
      if (!window.confirm(confirmUndoPickupText)) {
        return;
      }
      const orderId = row.dataset.orderId;
      if (!orderId) {
        return;
      }
      const response = await fetch(`/staff/api/orders/${encodeURIComponent(orderId)}/undo-pickup`, {
        method: "POST",
      });
      if (!response.ok) {
        window.alert(await readErrorMessage(response));
        return;
      }
      fetchOrders();
      return;
    }

    if (action === "toggle-payment-status") {
      if (!window.confirm(confirmSaveText)) {
        return;
      }

      const paymentStatusEl = row.querySelector('[data-field="payment_status"]');
      if (!(paymentStatusEl instanceof HTMLInputElement)) {
        return;
      }
      paymentStatusEl.value = paymentStatusEl.value === "PAID" ? "PAYMENT_PENDING" : "PAID";

      const button = actionTarget;
      if (button instanceof HTMLButtonElement) {
        applyPaymentButtonState(button, paymentStatusEl.value);
      }
      saveRow(row);
    }
  });

  tbodyEl.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const row = target.closest("tr[data-order-id]");
    if (!row) {
      return;
    }

    if (target instanceof HTMLInputElement && target.dataset.field === "expected_pickup_time") {
      applyLatePickupStyle(target);
      return;
    }

    if (target instanceof HTMLInputElement && target.dataset.field === "prepaid_amount") {
      syncPriceCellMeta(row);
      return;
    }

    if (target instanceof HTMLSelectElement && target.dataset.field === "flying_pass_tier") {
      applyTierAutoPrice(row, target.value);
      return;
    }

    if (target instanceof HTMLSelectElement && target.dataset.field === "payment_method") {
      syncPriceCellMeta(row);
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    if (target.closest(".price-config-wrap")) {
      return;
    }
    closeAllPriceConfigs();
  });

  window.addEventListener("resize", () => {
    if (viewportResizeTimer) {
      window.clearTimeout(viewportResizeTimer);
    }
    viewportResizeTimer = window.setTimeout(() => {
      refreshColumnWidths();
    }, 120);
  });

  setupColumnResizeHandles();
  refreshColumnWidths();
  syncSelectAllButtonState();
  fetchOrders();
})();
