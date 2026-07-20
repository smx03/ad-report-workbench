(() => {
  const CONTENT_PROTOCOL = 3;
  const CONTENT_BUILD = "calendar-click-v3";

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message, code: error.code || "PAGE_ERROR", stage: error.stage || "unknown" }));
    return true;
  });

  async function handleMessage(message) {
    if (message?.type === "PING_PAGE") return { url: location.href, protocol: CONTENT_PROTOCOL, contentBuild: CONTENT_BUILD };
    assertAuthenticated();
    if (message?.type === "SCAN_LIST_PAGE") return scanListPage();
    if (message?.type === "GO_FIRST_PAGE") return goToPage("first", message.signature);
    if (message?.type === "GO_NEXT_PAGE") return goToPage("next", message.signature);
    if (message?.type === "PREVIEW_TASK") return inspectTask(message, false);
    if (message?.type === "EXECUTE_TASK") return inspectTask(message, true);
    throw new Error("页面不支持该操作。");
  }

  function assertAuthenticated() {
    if (location.pathname.includes("/onestop/login") || document.body.innerText.includes("登录账号")) {
      throw codedError("一站式登录已失效，请先手动登录。", "AUTH_REQUIRED");
    }
    if (document.body.innerText.includes("验证码")) {
      throw codedError("页面要求验证码，请手动完成后重试。", "CAPTCHA_REQUIRED");
    }
  }

  function scanListPage() {
    const rows = [...document.querySelectorAll("table tbody tr")];
    const tasks = [];
    for (const row of rows) {
      const text = compact(row.innerText);
      const id = text.match(/ID\s*[:：]\s*(\d{6,})/)?.[1];
      if (!id) continue;
      const idCell = [...row.querySelectorAll("td")].find((cell) => /ID\s*[:：]/.test(cell.innerText));
      const name = compact(idCell?.innerText || "")
        .replace(/ID\s*[:：]\s*\d{6,}.*/s, "")
        .replace(/\s*复制\s*$/, "") || `任务 ${id}`;
      tasks.push({ id, name });
    }
    if (!tasks.length) throw new Error("当前页未读取到任务，请确认已打开“批量创建”列表。");
    const next = findNextControl();
    return { tasks, signature: tasks.map((task) => task.id).join("|"), hasNext: Boolean(next && !isDisabled(next)) };
  }

  async function goToPage(direction, previousSignature = "") {
    const before = previousSignature || currentSignature();
    const control = direction === "first" ? findFirstPageControl() : findNextControl();
    if (!control || isDisabled(control)) return { changed: false, signature: before };
    control.click();
    try {
      await waitFor(() => {
        const signature = currentSignature();
        return signature && signature !== before ? signature : false;
      }, 10000);
      return { changed: true, signature: currentSignature() };
    } catch {
      return { changed: false, signature: currentSignature() };
    }
  }

  async function inspectTask(message, shouldExecute) {
    const adConfigEdit = await waitForStage(
      findAdConfigEditButton,
      20000,
      "AD_CONFIG_NOT_READY",
      "广告统一配置编辑入口未加载完成，已停止操作。",
      "edit_page_ready",
    );
    adConfigEdit.click();

    const fields = await waitForStage(
      findDateFields,
      15000,
      "DATE_FIELDS_NOT_READY",
      "广告统一配置已打开，但开始日期或结束日期未出现。",
      "config_opened",
    );
    const currentStart = normalizeDate(fields.start.value);
    const currentEnd = normalizeDate(fields.end.value);
    const targetStart = normalizeDate(message.startDate);
    const targetEnd = normalizeDate(message.endDate);
    if (!targetStart || !targetEnd) {
      closeConfig(fields.root);
      throw codedError("目标日期不完整，请返回工作台检查。", "TARGET_DATE_INVALID", "date_validation");
    }
    if (!shouldExecute) {
      closeConfig(fields.root);
      return {
        currentStart,
        currentEnd,
        status: currentStart === targetStart && currentEnd === targetEnd ? "skipped" : "pending",
        result: currentStart === targetStart && currentEnd === targetEnd ? "日期范围已是目标值" : "等待人工确认",
      };
    }
    if (currentStart === targetStart && currentEnd === targetEnd) {
      closeConfig(fields.root);
      return { currentStart, currentEnd, status: "skipped", result: "日期范围已是目标值" };
    }

    const updatedFields = await selectDateRange(fields, targetStart, targetEnd);
    const modalConfirm = findExactButton(updatedFields.root, "确定");
    if (!modalConfirm) throw codedError("未找到日期配置的“确定”按钮。", "CONFIG_CONFIRM_NOT_FOUND", "date_verified");
    if (isDisabled(modalConfirm)) throw codedError("日期组件尚未接受目标日期，已停止提交。", "CONFIG_CONFIRM_DISABLED", "date_verified");
    modalConfirm.click();
    await waitForStage(
      () => !findDateFields(),
      12000,
      "CONFIG_NOT_CLOSED",
      "目标日期已校验，但广告统一配置弹窗未关闭。",
      "config_confirmed",
    );

    const submit = await waitForStage(
      () => findExactButton(document, "确认提交"),
      8000,
      "SUBMIT_NOT_FOUND",
      "日期配置已确认，但外层“确认提交”按钮未出现。",
      "config_closed",
    );
    submit.click();
    return {
      previousStart: currentStart,
      previousEnd: currentEnd,
      currentStart: targetStart,
      currentEnd: targetEnd,
      status: "success",
      result: "已发起提交，首次试运行请核对平台结果",
    };
  }

  async function selectDateRange(fields, targetStart, targetEnd) {
    let currentFields = fields;
    if (normalizeDate(currentFields.start.value) !== targetStart) {
      await selectCalendarDate(currentFields.start, targetStart);
      currentFields = await waitForStage(findDateFields, 5000, "DATE_FIELDS_LOST", "选择开始日期后，日期字段已丢失。", "start_date_selected");
    }
    if (normalizeDate(currentFields.end.value) !== targetEnd) {
      await selectCalendarDate(currentFields.end, targetEnd);
      currentFields = await waitForStage(findDateFields, 5000, "DATE_FIELDS_LOST", "选择结束日期后，日期字段已丢失。", "end_date_selected");
    }
    return waitForStage(() => {
      const latest = findDateFields();
      if (!latest) return false;
      const accepted = normalizeDate(latest.start.value) === targetStart && normalizeDate(latest.end.value) === targetEnd;
      return accepted ? latest : false;
    }, 5000, "DATE_RANGE_NOT_ACCEPTED", "日期组件未保留完整目标日期，已停止提交。", "date_range_verified");
  }

  async function selectCalendarDate(input, targetDate) {
    const target = parseDate(targetDate);
    if (!target) throw codedError("目标日期格式无效。", "TARGET_DATE_INVALID", "calendar_opening");
    input.click();
    await waitForStage(
      findOpenCalendar,
      5000,
      "CALENDAR_NOT_OPENED",
      `点击${input.placeholder || "日期"}后，Arco日历面板未打开。`,
      "calendar_opening",
    );
    const panel = await navigateCalendarToMonth(target.year, target.month);
    const cells = [...panel.querySelectorAll(".arco-picker-cell-in-view:not(.arco-picker-cell-disabled)")]
      .filter((cell) => compact(cell.innerText) === String(target.day));
    if (cells.length !== 1) throw codedError(`日历中未唯一找到 ${targetDate}，已停止提交。`, "DATE_CELL_NOT_UNIQUE", "calendar_ready");
    const clickTarget = cells[0].querySelector(".arco-picker-date") || cells[0];
    clickTarget.click();
    await waitForStage(
      () => normalizeDate(input.value) === targetDate,
      5000,
      "DATE_NOT_ACCEPTED",
      `已点击 ${targetDate}，但日期输入框未接受该值。`,
      "date_cell_clicked",
    );
  }

  async function navigateCalendarToMonth(targetYear, targetMonth) {
    const targetKey = targetYear * 12 + targetMonth;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const panels = visibleMonthPanels();
      const targetPanel = panels.find((panel) => panel.key === targetKey);
      if (targetPanel) return targetPanel.element;
      if (!panels.length) throw codedError("日历月份面板未显示。", "CALENDAR_MONTHS_MISSING", "calendar_opened");
      const before = panels.map((panel) => panel.label).join("|");
      const moveBackward = targetKey < panels[0].key;
      const anchor = moveBackward ? panels[0].element : panels[panels.length - 1].element;
      const iconClass = moveBackward ? ".arco-icon-left" : ".arco-icon-right";
      const control = anchor.querySelector(iconClass)?.closest(".arco-picker-header-icon");
      if (!control || isDisabled(control)) throw codedError("日历无法翻到目标月份。", "CALENDAR_NAV_UNAVAILABLE", "calendar_navigation");
      control.click();
      await waitForStage(() => {
        const after = visibleMonthPanels().map((panel) => panel.label).join("|");
        return after && after !== before;
      }, 3000, "CALENDAR_NAV_TIMEOUT", "点击翻月后，日历月份未变化。", "calendar_navigation");
    }
    throw codedError("目标日期超出日历可导航范围。", "CALENDAR_RANGE_EXCEEDED", "calendar_navigation");
  }

  function findAdConfigEditButton() {
    if (!document.body.innerText.includes("编辑任务") || !document.body.innerText.includes("广告统一配置")) return false;
    const editButtons = [...document.querySelectorAll("button")]
      .filter((button) => isVisible(button) && button.querySelector("svg.arco-icon-edit"));
    return editButtons.length >= 3 ? editButtons[editButtons.length - 1] : false;
  }

  function findOpenCalendar() {
    const wrapper = [...document.querySelectorAll(".arco-picker-range-wrapper")].find(isVisible);
    return wrapper && visibleMonthPanels().length ? wrapper : false;
  }

  function visibleMonthPanels() {
    return [...document.querySelectorAll(".arco-picker-header")]
      .filter(isVisible)
      .map((header) => {
        const label = compact(header.innerText);
        const match = label.match(/(\d{4})年(\d{1,2})月/);
        const element = header.parentElement;
        if (!match || !element?.querySelector(".arco-picker-body")) return null;
        const year = Number(match[1]);
        const month = Number(match[2]);
        return { label, year, month, key: year * 12 + month, element };
      })
      .filter(Boolean)
      .sort((left, right) => left.key - right.key);
  }

  function findDateFields() {
    const start = document.querySelector('input[placeholder="开始日期"], input[aria-label="开始日期"]');
    const end = document.querySelector('input[placeholder="结束日期"], input[aria-label="结束日期"]');
    if (!start || !end || !isVisible(start) || !isVisible(end)) return false;
    const root = end.closest(".arco-drawer, .arco-modal, [role=dialog]") || findConfigRoot(end);
    return { start, end, root: root || document };
  }

  function findConfigRoot(element) {
    let current = element.parentElement;
    while (current && current !== document.body) {
      if (current.innerText.includes("广告统一配置") && current.querySelectorAll("button").length > 2) return current;
      current = current.parentElement;
    }
    return document;
  }

  function closeConfig(root) {
    const cancel = findExactButton(root, "取消", true);
    if (cancel) cancel.click();
  }

  function findExactButton(root, label, takeLast = false) {
    const buttons = [...root.querySelectorAll("button")].filter((button) => isVisible(button) && compact(button.innerText) === label);
    return takeLast ? buttons[buttons.length - 1] : buttons[0];
  }

  function findNextControl() {
    return document.querySelector('li[aria-label="下一页"], .arco-pagination-item-next, [class*="pagination-item-next"]');
  }

  function findFirstPageControl() {
    return [...document.querySelectorAll(".arco-pagination-item, [class*='pagination-item']")]
      .find((item) => compact(item.innerText) === "1" && !item.className.toString().includes("next"));
  }

  function currentSignature() {
    return [...document.querySelectorAll("table tbody tr")]
      .map((row) => compact(row.innerText).match(/ID\s*[:：]\s*(\d{6,})/)?.[1])
      .filter(Boolean)
      .join("|");
  }

  function isDisabled(element) {
    return element.matches("[disabled], [aria-disabled='true']") || /disabled/.test(element.className.toString());
  }

  function isVisible(element) {
    return Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
  }

  function normalizeDate(value) {
    const match = String(value || "").match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
    return match ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}` : "";
  }

  function parseDate(value) {
    const normalized = normalizeDate(value);
    if (!normalized) return null;
    const [year, month, day] = normalized.split("-").map(Number);
    return { year, month, day };
  }

  function compact(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function codedError(message, code, stage = code) {
    const error = new Error(message);
    error.code = code;
    error.stage = stage;
    return error;
  }

  async function waitForStage(getValue, timeout, code, message, stage) {
    try {
      return await waitFor(getValue, timeout);
    } catch (error) {
      if (error?.code && error.code !== "WAIT_TIMEOUT") throw error;
      throw codedError(message, code, stage);
    }
  }

  function waitFor(getValue, timeout = 10000, interval = 120) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        try {
          const value = getValue();
          if (value) return resolve(value);
        } catch (error) {
          return reject(error);
        }
        if (Date.now() - started >= timeout) return reject(codedError("等待页面控件超时。", "WAIT_TIMEOUT", "unknown"));
        setTimeout(check, interval);
      };
      check();
    });
  }
})();
