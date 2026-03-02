/**
 * Shared utilities for Flying Japan luggage storage app.
 * Loaded before page-specific scripts (customer.js, staff_dashboard.js).
 */
(function () {
  "use strict";

  var yenFormatter = new Intl.NumberFormat("ja-JP");

  function normalizeAmount(value) {
    var num = Number(value || 0);
    if (Number.isNaN(num)) {
      return 0;
    }
    return Math.trunc(num);
  }

  function formatYen(value) {
    var amount = normalizeAmount(value);
    var safeAmount = Number.isFinite(amount) ? amount : 0;
    var sign = safeAmount < 0 ? "-" : "";
    return sign + "¥ " + yenFormatter.format(Math.abs(safeAmount));
  }

  function isLatePickupTime(timeValue) {
    if (!timeValue) {
      return false;
    }
    var parts = String(timeValue).split(":");
    if (parts.length < 2) {
      return false;
    }
    var hour = Number(parts[0]);
    var minute = Number(parts[1]);
    if (Number.isNaN(hour) || Number.isNaN(minute)) {
      return false;
    }
    if (hour < 19 || hour > 21) {
      return false;
    }
    return hour < 21 || minute === 0;
  }

  function safeStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (_error) {
      // Ignore storage quota/private mode errors.
    }
  }

  function safeStorageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function safeStorageRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (_error) {
      // Ignore storage errors.
    }
  }

  window.FJ = {
    yenFormatter: yenFormatter,
    normalizeAmount: normalizeAmount,
    formatYen: formatYen,
    isLatePickupTime: isLatePickupTime,
    safeStorageSet: safeStorageSet,
    safeStorageGet: safeStorageGet,
    safeStorageRemove: safeStorageRemove,
  };
})();
