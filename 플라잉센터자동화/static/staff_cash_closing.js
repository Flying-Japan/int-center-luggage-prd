(function () {
  "use strict";
  const countInputs = Array.from(document.querySelectorAll(".cash-count-input"));
  const dateInput = document.getElementById("cash-business-date");
  const totalPreview = document.getElementById("cash-total-preview");
  const qrPreview = document.getElementById("cash-qr-preview");
  const actualQrInput = document.getElementById("cash-actual-qr-input");
  const autoPreview = document.getElementById("cash-auto-preview");
  const diffPreview = document.getElementById("cash-diff-preview");
  const qrDiffPreview = document.getElementById("cash-qr-diff-preview");
  const totalDiffPreview = document.getElementById("cash-total-diff-preview");

  if (!countInputs.length || !dateInput || !totalPreview || !qrPreview || !actualQrInput || !autoPreview || !diffPreview || !qrDiffPreview || !totalDiffPreview) {
    return;
  }

  let autoCash = 0;
  let autoQr = 0;
  let actualQrTouched = false;
  function toInteger(value) {
    const num = Number(value || 0);
    if (Number.isNaN(num)) {
      return 0;
    }
    return Math.trunc(num);
  }

  function toNumber(value) {
    const num = Number(value || 0);
    if (Number.isNaN(num) || num < 0) {
      return 0;
    }
    return Math.floor(num);
  }

  function recalc() {
    let total = 0;
    countInputs.forEach((input) => {
      const denom = toNumber(input.dataset.denom);
      const count = toNumber(input.value);
      total += denom * count;
    });

    const actualQr = toNumber(actualQrInput.value);
    const cashDiff = total - autoCash;
    const qrDiff = actualQr - autoQr;
    const totalDiff = cashDiff + qrDiff;

    totalPreview.value = FJ.formatYen(total);
    qrPreview.value = FJ.formatYen(autoQr);
    autoPreview.value = FJ.formatYen(autoCash);
    diffPreview.value = FJ.formatYen(cashDiff);
    qrDiffPreview.value = FJ.formatYen(qrDiff);
    totalDiffPreview.value = FJ.formatYen(totalDiff);
  }

  async function fetchAutoSales() {
    const businessDate = String(dateInput.value || "").trim();
    if (!businessDate) {
      autoCash = 0;
      autoQr = 0;
      if (!actualQrTouched) {
        actualQrInput.value = "0";
      }
      recalc();
      return;
    }
    try {
      const response = await fetch(`/staff/api/cash-closing/auto-sales?business_date=${encodeURIComponent(businessDate)}`);
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      autoCash = toNumber(data.cash_amount);
      autoQr = toNumber(data.qr_amount);
      if (!actualQrTouched || actualQrInput.value === "") {
        actualQrInput.value = String(autoQr);
      }
      recalc();
    } catch (_error) {
      // Ignore temporary fetch errors.
    }
  }

  countInputs.forEach((input) => {
    input.addEventListener("input", recalc);
  });
  actualQrInput.addEventListener("input", () => {
    actualQrTouched = true;
    recalc();
  });
  dateInput.addEventListener("change", fetchAutoSales);
  fetchAutoSales();
})();
