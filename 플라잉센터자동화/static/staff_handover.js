(function () {
  "use strict";
  const boardEl = document.getElementById("handover-board");
  const unreadOnlyMode = boardEl ? boardEl.dataset.unreadOnly === "1" : false;
  const searchForm = document.querySelector(".staff-search-form");
  const searchInput = document.querySelector(".js-handover-search-input");
  const noteItems = Array.from(document.querySelectorAll(".js-note-item"));
  const emptyState = document.querySelector(".js-handover-empty");

  const applyRealtimeFilter = () => {
    const keepY = window.scrollY || window.pageYOffset || 0;
    const term = (searchInput?.value || "").trim().toLowerCase();
    let visibleCount = 0;
    noteItems.forEach((item) => {
      const searchText = (item.dataset.noteSearch || "").toLowerCase();
      const isRead = item.dataset.isRead === "1";
      const matchesKeyword = !term || searchText.includes(term);
      const matchesUnreadFilter = !unreadOnlyMode || !isRead;
      const shouldShow = matchesKeyword && matchesUnreadFilter;
      item.style.display = shouldShow ? "" : "none";
      if (shouldShow) {
        visibleCount += 1;
      }
    });
    if (emptyState) {
      emptyState.style.display = noteItems.length > 0 && visibleCount === 0 ? "" : "none";
    }
    if (Math.abs((window.scrollY || window.pageYOffset || 0) - keepY) > 2) {
      window.scrollTo({ top: keepY, left: 0, behavior: "auto" });
    }
  };

  if (searchInput) {
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
      }
    });
    searchInput.addEventListener("input", applyRealtimeFilter);
  }
  if (searchForm) {
    searchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      applyRealtimeFilter();
    });
  }

  const readForms = document.querySelectorAll(".js-read-toggle-form");
  readForms.forEach((form) => {
    const checkbox = form.querySelector(".js-note-read");
    const hiddenIsRead = form.querySelector('input[name="is_read"]');
    if (!checkbox || !hiddenIsRead) {
      return;
    }

    checkbox.addEventListener("change", async () => {
      const previousChecked = !checkbox.checked;
      const noteId = form.dataset.noteId || "";
      hiddenIsRead.value = checkbox.checked ? "1" : "0";
      checkbox.disabled = true;

      const payload = new URLSearchParams(new FormData(form));
      try {
        const response = await fetch(form.action, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: payload.toString(),
        });
        if (!response.ok) {
          throw new Error("save failed");
        }
        const data = await response.json();
        const article = document.querySelector(`.ops-item[data-note-id="${noteId}"]`);
        if (article) {
          article.classList.toggle("ops-item-unread", !data.is_read);
          article.dataset.isRead = data.is_read ? "1" : "0";
        }
        const readerNames = document.querySelector(`.js-reader-names[data-note-id="${noteId}"]`);
        if (readerNames) {
          readerNames.textContent = data.reader_names && data.reader_names.length ? data.reader_names.join(", ") : "-";
        }
        applyRealtimeFilter();
      } catch (error) {
        checkbox.checked = previousChecked;
        hiddenIsRead.value = previousChecked ? "1" : "0";
        window.alert("읽음 상태 저장에 실패했습니다. 다시 시도해 주세요.");
      } finally {
        checkbox.disabled = false;
      }
    });
  });

  applyRealtimeFilter();
})();
