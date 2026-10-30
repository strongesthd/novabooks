(() => {
  "use strict";

  let token = "";
  let currentUser = null;
  let registerMode = false;
  let activePage = "overview";
  const inventoryState = {
    itemPage: 1, movementPage: 1, assignmentPage: 1,
    search: "", itemStatus: "active", assignmentStatus: "active"
  };
  const $ = (selector) => document.querySelector(selector);
  const authView = $("#auth-view");
  const appView = $("#app-view");
  const content = $("#page-content");
  const pageTitles = {
    overview: "Tổng quan",
    vouchers: "Chứng từ",
    entries: "Sổ sách",
    suppliers: "Nhà cung cấp",
    products: "Hàng hóa",
    inventory: "Quản lý kho",
    reports: "Báo cáo",
    channels: "Kết nối kênh",
    members: "Thành viên"
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  async function api(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
    const response = await fetch(url, { ...options, headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && token) logout(false);
      const error = new Error(body.error || `Yêu cầu thất bại (${response.status})`);
      error.memberships = body.memberships;
      error.details = body.details;
      throw error;
    }
    return body;
  }

  function toast(message, failed = false) {
    const node = $("#toast");
    node.textContent = message;
    node.classList.toggle("toast-error", failed);
    node.classList.remove("hidden");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.add("hidden"), 4200);
  }

  function showFormDialog({
    title,
    description = "",
    fields = [],
    confirmLabel = "Lưu",
    confirmClass = "button-primary",
    cancelLabel = "Hủy"
  }) {
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      dialog.className = "app-dialog";
      const form = document.createElement("form");
      form.className = "app-dialog-form";

      const heading = document.createElement("h2");
      heading.textContent = title;
      form.append(heading);
      if (description) {
        const help = document.createElement("p");
        help.className = "app-dialog-description";
        help.textContent = description;
        form.append(help);
      }

      const fieldList = document.createElement("div");
      fieldList.className = "app-dialog-fields";
      for (const field of fields) {
        const label = document.createElement("label");
        label.className = "app-dialog-field";
        label.textContent = field.label;
        let control;
        if (field.type === "textarea") {
          control = document.createElement("textarea");
          control.rows = field.rows || 3;
        } else if (field.type === "select") {
          control = document.createElement("select");
          for (const option of field.options || []) {
            const item = document.createElement("option");
            item.value = option.value;
            item.textContent = option.label;
            control.append(item);
          }
        } else {
          control = document.createElement("input");
          control.type = field.type || "text";
        }
        control.name = field.name;
        control.value = field.value ?? "";
        control.required = Boolean(field.required);
        control.autocomplete = "off";
        if (field.minLength) control.minLength = field.minLength;
        if (field.step) control.step = field.step;
        if (field.min !== undefined) control.min = field.min;
        if (field.max !== undefined) control.max = field.max;
        if (field.placeholder) control.placeholder = field.placeholder;
        label.append(control);
        fieldList.append(label);
      }
      form.append(fieldList);

      const actions = document.createElement("div");
      actions.className = "app-dialog-actions";
      const cancel = document.createElement("button");
      cancel.className = "button button-secondary";
      cancel.type = "button";
      cancel.textContent = cancelLabel;
      cancel.addEventListener("click", () => dialog.close("cancel"));
      const submit = document.createElement("button");
      submit.className = `button ${confirmClass}`;
      submit.type = "submit";
      submit.textContent = confirmLabel;
      actions.append(cancel, submit);
      form.append(actions);
      dialog.append(form);

      let result = null;
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        result = Object.fromEntries(new FormData(form).entries());
        dialog.close("submit");
      });
      dialog.addEventListener("close", () => {
        dialog.remove();
        resolve(result);
      }, { once: true });
      document.body.append(dialog);
      dialog.showModal();
      fieldList.querySelector("input, select, textarea")?.focus();
    });
  }

  function showConfirmDialog(title, description, confirmLabel = "Xác nhận") {
    return showFormDialog({ title, description, confirmLabel, confirmClass: "button-danger" })
      .then((result) => result !== null);
  }

  function showAuth(message = "") {
    authView.classList.remove("hidden");
    appView.classList.add("hidden");
    $("#auth-error").textContent = message;
    $("#auth-error").classList.toggle("hidden", !message);
  }

  function showApp(user) {
    currentUser = user;
    authView.classList.add("hidden");
    appView.classList.remove("hidden");
    $("#tenant-name").textContent = user.tenant_name;
    $("#user-name").textContent = user.full_name;
    $("#user-role").textContent = roleLabel(user.role);
    $("#top-avatar").textContent = initials(user.full_name);
    $("#today-date").textContent = new Intl.DateTimeFormat("vi-VN", {
      weekday: "short", day: "2-digit", month: "short", year: "numeric"
    }).format(new Date());
    document.querySelectorAll(".admin-only").forEach((item) => {
      item.classList.toggle("hidden", user.role !== "tenant_admin");
    });
    document.querySelector('[data-page="suppliers"]').classList.toggle("hidden", user.role === "staff");
    document.querySelector('[data-page="products"]').classList.toggle("hidden", user.role === "staff");
    document.querySelector('[data-page="inventory"]').classList.toggle("hidden", user.role === "staff");
    navigate("overview");
  }

  function roleLabel(role) {
    return ({ tenant_admin: "Quản trị doanh nghiệp", accountant: "Kế toán viên", staff: "Nhân viên" })[role] || role;
  }

  function initials(name) {
    return String(name || "N").split(/\s+/).slice(-2).map((part) => part[0]).join("").toUpperCase();
  }

  function money(amount, currency = "VND") {
    if (amount === null || amount === undefined || amount === "") return "—";
    return `${Number(amount).toLocaleString("vi-VN", { maximumFractionDigits: 2 })} ${escapeHtml(currency)}`;
  }

  function decimalInput(value) {
    if (value === null || value === undefined || value === "") return "";
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(4).replace(/\.?0+$/, "") : "";
  }

  function statusLabel(status) {
    return ({
      received: "Đã tiếp nhận", extracting: "Đang trích xuất", needs_review: "Chờ duyệt",
      approved: "Đã duyệt", posted: "Đã ghi sổ", rejected: "Đã từ chối",
      failed: "Cần xử lý", active: "Đang hoạt động", archived: "Đã lưu trữ",
      disabled: "Đã tắt", error: "Lỗi kết nối", returned: "Đã thu hồi",
      low_stock: "Cần nhập", in_stock: "Đủ tồn"
    })[status] || status;
  }

  function statusPill(status) {
    return `<span class="status status-${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>`;
  }

  async function navigate(page) {
    if (!pageTitles[page]) return;
    activePage = page;
    $("#page-title").textContent = pageTitles[page];
    document.querySelectorAll(".nav-item").forEach((button) => {
      button.classList.toggle("active", button.dataset.page === page);
    });
    content.innerHTML = '<div class="loading">Đang tải dữ liệu an toàn…</div>';
    try {
      if (page === "overview") await renderOverview();
      if (page === "vouchers") await renderVouchers();
      if (page === "entries") await renderEntries();
      if (page === "suppliers") await renderSuppliers();
      if (page === "products") await renderProducts();
      if (page === "inventory") await renderInventory();
      if (page === "reports") await renderReports();
      if (page === "channels") await renderChannels();
      if (page === "members") await renderMembers();
    } catch (error) {
      content.innerHTML = `<section class="panel empty-state"><div class="empty-icon">!</div>${escapeHtml(error.message)}</section>`;
    }
  }

  function heading(title, description, action = "") {
    return `<div class="page-heading"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>${action ? `<div class="heading-actions">${action}</div>` : ""}</div>`;
  }

  async function renderOverview() {
    const [stats, vouchers, entries] = await Promise.all([
      api("/api/dashboard"), api("/api/vouchers"), api("/api/entries").catch(() => ({ entries: [] }))
    ]);
    const pending = vouchers.vouchers.filter((item) => item.status === "needs_review").length;
    const badge = $("#pending-badge");
    badge.textContent = String(pending);
    badge.classList.toggle("hidden", pending === 0);
    const recent = vouchers.vouchers.slice(0, 5);
    content.innerHTML = `${heading(`Chào ${currentUser.full_name.split(" ")[0]}`, "Đây là tình hình sổ sách của doanh nghiệp bạn hôm nay.", '<button class="button button-primary" data-action="upload">＋ Tải chứng từ</button>')}
      <section class="metric-grid">
        ${metric("Chứng từ chờ xử lý", stats.pending_vouchers, "Cần được kiểm tra", "▤")}
        ${metric("Bút toán tháng này", stats.posted_this_month, "Đã ghi nhận vào sổ", "↗")}
        ${metric("Nhà cung cấp", stats.suppliers, "Trong danh mục doanh nghiệp", "◇")}
        ${metric("Thành viên", stats.members, "Có quyền truy cập", "♧")}
      </section>
      <div class="content-grid">
        <section class="panel"><div class="panel-header"><div><h2>Chứng từ gần đây</h2><p>Theo dõi chứng từ và trạng thái xử lý</p></div><button class="text-button" data-nav="vouchers">Xem tất cả →</button></div>${recent.length ? `<div class="table-wrap"><table><thead><tr><th>Chứng từ</th><th>Ngày nhận</th><th>Số tiền</th><th>Trạng thái</th></tr></thead><tbody>${recent.map(voucherRow).join("")}</tbody></table></div>` : empty("Chưa có chứng từ", "Tải hóa đơn đầu tiên để bắt đầu.")}</section>
        <section class="panel"><div class="panel-header"><div><h2>Thao tác nhanh</h2><p>Công việc thường dùng</p></div></div><div class="quick-actions">
          <button class="quick-action" data-action="upload"><span class="quick-action-icon">＋</span><span><strong>Thêm chứng từ</strong><small>Tải ảnh hoặc PDF hóa đơn</small></span></button>
          <button class="quick-action" data-nav="entries"><span class="quick-action-icon">↗</span><span><strong>Mở sổ sách</strong><small>Xem các bút toán đã ghi sổ</small></span></button>
          <button class="quick-action" data-nav="reports"><span class="quick-action-icon">▥</span><span><strong>Báo cáo cuối ngày</strong><small>Xem lịch sử gửi báo cáo</small></span></button>
        </div></section>
      </div>
      <input id="quick-upload" class="hidden" type="file" accept="image/jpeg,image/png,image/webp,application/pdf">`;
    bindCommon();
    bindUpload();
  }

  function metric(label, value, hint, icon) {
    return `<article class="metric-card"><div class="metric-top"><span>${escapeHtml(label)}</span><span class="metric-icon">${icon}</span></div><div class="metric-value">${escapeHtml(value)}</div><div class="metric-hint">${escapeHtml(hint)}</div></article>`;
  }

  function voucherRow(voucher) {
    const ref = voucher.invoice_number || `#${String(voucher.id).slice(0, 8)}`;
    return `<tr><td><strong>${escapeHtml(ref)}</strong><br><span style="color:#929d96;font-size:9px">${escapeHtml(voucher.document_type || "Hóa đơn")}</span></td><td>${escapeHtml(voucher.invoice_date || new Date(voucher.created_at).toLocaleDateString("vi-VN"))}</td><td>${money(voucher.total_amount, voucher.currency)}</td><td>${statusPill(voucher.status)}</td></tr>`;
  }

  function empty(title, subtitle) {
    return `<div class="empty-state"><div class="empty-icon">✳</div><strong>${escapeHtml(title)}</strong><br>${escapeHtml(subtitle)}</div>`;
  }

  function pagination(page, pageSize, total) {
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    if (pageCount <= 1) return `<div class="list-pagination"><span>${total} bản ghi</span></div>`;
    return `<div class="list-pagination"><span>${total} bản ghi · trang ${page}/${pageCount}</span><div>
      <button class="button button-secondary compact" data-list-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>← Trước</button>
      <button class="button button-secondary compact" data-list-page="${page + 1}" ${page >= pageCount ? "disabled" : ""}>Sau →</button>
    </div></div>`;
  }

  function bindPagination(onPage) {
    content.querySelectorAll("[data-list-page]").forEach((button) => {
      button.addEventListener("click", () => void onPage(Number(button.dataset.listPage)));
    });
  }

  function catalogToolbar(search, status, placeholderSuffix = "") {
    return `<form class="catalog-toolbar" data-catalog-filter>
      <input name="q" type="search" maxlength="100" placeholder="Tìm mã, tên${placeholderSuffix}" value="${escapeHtml(search)}">
      ${status === undefined ? "" : `<select name="status" aria-label="Lọc trạng thái">
        <option value="active" ${status === "active" ? "selected" : ""}>Đang hoạt động</option>
        <option value="archived" ${status === "archived" ? "selected" : ""}>Đã lưu trữ</option>
        <option value="all" ${status === "all" ? "selected" : ""}>Tất cả</option>
      </select>`}
      <button class="button button-secondary compact" type="submit">Tìm kiếm</button>
    </form>`;
  }

  function bindCatalogFilter(render) {
    content.querySelector("[data-catalog-filter]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget).entries());
      void render(1, String(values.q || ""), String(values.status || "active"));
    });
  }

  async function renderVouchers() {
    const [result, ledger, inventory] = await Promise.all([
      api("/api/vouchers"),
      currentUser.role === "staff" ? Promise.resolve({ accounts: [], mappings: {} }) : api("/api/ledger/accounts"),
      currentUser.role === "staff" ? Promise.resolve({ items: [] }) : api("/api/inventory/items/options")
    ]);
    const items = result.vouchers;
    content.innerHTML = `${heading("Chứng từ", "Kiểm tra kết quả AI và duyệt trước khi ghi sổ.", '<button class="button button-primary" data-action="upload">＋ Tải chứng từ</button>')}
      <div class="toolbar"><input id="voucher-search" type="search" placeholder="Tìm số hóa đơn hoặc trạng thái"><span class="voucher-meta">${items.length} chứng từ gần nhất</span></div>
      <div id="voucher-list" class="voucher-list">${items.length ? items.map(voucherCard).join("") : empty("Hộp thư chứng từ đang trống", "Tải ảnh hoặc PDF để NovaBooks bắt đầu xử lý.")}</div>
      <input id="quick-upload" class="hidden" type="file" accept="image/jpeg,image/png,image/webp,application/pdf">`;
    bindCommon();
    bindUpload();
    $("#voucher-search").addEventListener("input", (event) => {
      const query = event.target.value.toLowerCase();
      document.querySelectorAll(".voucher-card").forEach((card) => {
        card.classList.toggle("hidden", !card.dataset.search.includes(query));
      });
    });
    content.querySelectorAll("[data-review]").forEach((button) => button.addEventListener("click", async () => {
      const decision = button.dataset.review;
      let note = "";
      let accountMappings;
      let inventoryLines = [];
      if (decision === "reject") {
        const response = await showFormDialog({
          title: "Từ chối chứng từ",
          description: "Bạn có thể ghi lý do để người gửi biết cần bổ sung hoặc chỉnh sửa gì.",
          fields: [{ name: "note", label: "Lý do (không bắt buộc)", type: "textarea" }],
          confirmLabel: "Từ chối",
          confirmClass: "button-danger"
        });
        if (response === null) return;
        note = response.note;
      } else {
        const defaults = {
          expense: ledger.mappings.expense,
          input_tax: ledger.mappings.input_tax,
          accounts_payable: ledger.mappings.accounts_payable
        };
        if (!ledger.accounts.length || !defaults.expense || !defaults.accounts_payable || !defaults.input_tax) {
          toast("Hãy nhập sổ Excel và cấu hình đủ tài khoản định khoản trong mục Sổ sách trước.", true);
          return;
        }
        const accountOptions = ledger.accounts.map((account) => ({
          value: account.account_code,
          label: `${account.account_code} · ${account.account_name}`
        }));
        const stockOptions = [
          { value: "", label: "Không nhập kho" },
          ...inventory.items.map((item) => ({
            value: item.id,
            label: `${item.code} · ${item.name} (tồn ${item.current_quantity} ${item.unit || ""})`
          }))
        ];
        const voucher = items.find((item) => item.id === button.dataset.id);
        const invoiceLines = Array.isArray(voucher?.extracted_data?.lineItems)
          ? voucher.extracted_data.lineItems.slice(0, 100)
          : [];
        const selected = await showFormDialog({
          title: "Duyệt và ghi sổ",
          description: "Ghép dòng hàng với vật tư nếu cần cập nhật tồn kho. Chỉ dòng đã ghép mới nhập kho; phần còn lại tiếp tục ghi nhận vào chi phí/hàng mua.",
          fields: [
            { name: "expenseAccountCode", label: "Chi phí / hàng mua", type: "select", value: defaults.expense, options: accountOptions },
            { name: "inputTaxAccountCode", label: "Thuế GTGT đầu vào", type: "select", value: defaults.input_tax, options: accountOptions },
            { name: "payableAccountCode", label: "Phải trả nhà cung cấp", type: "select", value: defaults.accounts_payable, options: accountOptions },
            { name: "inventoryAccountCode", label: "Tài khoản hàng tồn kho (tùy chọn)", type: "select", value: ledger.mappings.inventory_asset || "", options: [{ value: "", label: "Chưa cấu hình" }, ...accountOptions] },
            ...invoiceLines.flatMap((line, index) => [
              { name: `stockItem_${index}`, label: `Dòng ${index + 1}: ${line.description || "Hàng hóa"}`, type: "select", options: stockOptions },
              { name: `stockQuantity_${index}`, label: "Số lượng nhập kho", type: "number", min: "0.0001", step: "0.0001", value: decimalInput(line.quantity), placeholder: "Để trống nếu không nhập kho" },
              { name: `stockAmount_${index}`, label: "Thành tiền phân bổ", type: "number", min: "0.0001", step: "0.0001", value: decimalInput(line.amount), placeholder: "Để trống nếu không nhập kho" }
            ])
          ],
          confirmLabel: "Duyệt & ghi sổ"
        });
        if (selected === null) return;
        accountMappings = {
          expenseAccountCode: selected.expenseAccountCode,
          inputTaxAccountCode: selected.inputTaxAccountCode,
          payableAccountCode: selected.payableAccountCode,
          inventoryAccountCode: selected.inventoryAccountCode || null
        };
        for (const [lineIndex, line] of invoiceLines.entries()) {
          const itemId = selected[`stockItem_${lineIndex}`];
          if (!itemId) continue;
          const quantity = selected[`stockQuantity_${lineIndex}`];
          const amount = selected[`stockAmount_${lineIndex}`];
          if (!quantity || Number(quantity) <= 0 || !amount || Number(amount) <= 0) {
            toast(`Dòng ${lineIndex + 1}: cần nhập số lượng và thành tiền lớn hơn 0.`, true);
            return;
          }
          inventoryLines.push({ lineIndex, itemId, quantity, amount });
        }
        if (inventoryLines.length && !accountMappings.inventoryAccountCode) {
          toast("Hãy chọn tài khoản hàng tồn kho khi ghép dòng hóa đơn với vật tư.", true);
          return;
        }
      }
      button.disabled = true;
      try {
        await api(`/api/vouchers/${encodeURIComponent(button.dataset.id)}/review`, {
          method: "POST", body: JSON.stringify({ decision, note: note || undefined, accountMappings, inventoryLines })
        });
        toast(decision === "approve" ? "Đã duyệt và ghi sổ chứng từ." : "Đã từ chối chứng từ.");
        await navigate("vouchers");
      } catch (error) {
        toast(error.message, true);
        button.disabled = false;
      }
    }));
    content.querySelectorAll("[data-edit-voucher]").forEach((button) => button.addEventListener("click", () => {
      void editVoucherWithDialog(items.find((item) => item.id === button.dataset.editVoucher));
    }));
    content.querySelectorAll("[data-retry-voucher]").forEach((button) => button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api(`/api/vouchers/${encodeURIComponent(button.dataset.retryVoucher)}/retry`, { method: "POST" });
        toast("Đã đưa chứng từ vào hàng đợi xử lý lại.");
        await navigate("vouchers");
      } catch (error) {
        toast(error.message, true);
        button.disabled = false;
      }
    }));
    content.querySelectorAll("[data-document]").forEach((button) => button.addEventListener("click", () => {
      void openDocument(button.dataset.document);
    }));
  }

  function voucherCard(voucher) {
    const data = voucher.extracted_data || {};
    const details = [
      data.supplierName && `Nhà cung cấp: ${data.supplierName}`,
      data.supplierTaxId && `Mã số thuế: ${data.supplierTaxId}`,
      voucher.invoice_number && `Số hóa đơn: ${voucher.invoice_number}`,
      data.lineItems?.length && `Hàng hóa: ${data.lineItems.slice(0, 8).map((item) => `${item.description}${item.amount == null ? "" : ` (${money(item.amount, voucher.currency)})`}`).join("; ")}`,
      `Tiền trước thuế: ${money(voucher.subtotal, voucher.currency)}`,
      `Thuế: ${money(voucher.tax_amount, voucher.currency)}`,
      data.warnings?.length && `Cảnh báo: ${data.warnings.join("; ")}`,
      voucher.review_note && `Ghi chú: ${voucher.review_note}`
    ].filter(Boolean).join("\n");
    const canReview = currentUser.role === "tenant_admin" || currentUser.role === "accountant";
    const actions = voucher.status === "needs_review" && canReview
      ? `<div class="voucher-actions"><button class="button button-secondary compact" data-document="${escapeHtml(voucher.id)}">Xem chứng từ gốc</button><button class="button button-secondary compact" data-edit-voucher="${escapeHtml(voucher.id)}">Sửa dữ liệu</button><button class="button button-secondary compact" data-review="reject" data-id="${escapeHtml(voucher.id)}">Từ chối</button><button class="button button-primary compact" data-review="approve" data-id="${escapeHtml(voucher.id)}">Duyệt & ghi sổ</button></div>`
      : voucher.status === "failed" && canReview
        ? `<div class="voucher-actions"><button class="button button-secondary compact" data-document="${escapeHtml(voucher.id)}">Xem tệp</button><button class="button button-primary compact" data-retry-voucher="${escapeHtml(voucher.id)}">Thử trích xuất lại</button></div>`
        : `<div class="voucher-actions"><button class="button button-secondary compact" data-document="${escapeHtml(voucher.id)}">Xem chứng từ gốc</button></div>`;
    const search = `${voucher.invoice_number || ""} ${voucher.status} ${data.supplierName || ""}`.toLowerCase();
    return `<article class="voucher-card" data-search="${escapeHtml(search)}"><div class="voucher-main"><div class="voucher-title"><span class="document-icon">▤</span><div><h3>${escapeHtml(voucher.invoice_number || `Chứng từ ${String(voucher.id).slice(0, 8)}`)}</h3><p>${escapeHtml(data.supplierName || "Đang nhận diện nhà cung cấp")} · ${escapeHtml(new Date(voucher.created_at).toLocaleString("vi-VN"))}</p></div></div><div>${statusPill(voucher.status)}<div class="voucher-amount">${money(voucher.total_amount, voucher.currency)}<small>Độ tin cậy AI: ${voucher.ai_confidence == null ? "—" : `${Math.round(Number(voucher.ai_confidence) * 100)}%`}</small></div></div></div>${details ? `<div class="voucher-details">${escapeHtml(details)}</div>` : ""}<div class="voucher-footer"><span class="voucher-meta">${voucher.status === "failed" ? "Có thể kiểm tra tệp/cấu hình AI và tải lại." : "Luôn đối chiếu với chứng từ gốc trước khi ghi sổ."}</span>${actions}</div></article>`;
  }

  async function editVoucherWithDialog(voucher) {
    if (!voucher) return;
    const data = voucher.extracted_data || {};
    const fields = [
      { name: "supplierName", label: "Nhà cung cấp", value: data.supplierName ?? "" },
      { name: "invoiceNumber", label: "Số hóa đơn", value: voucher.invoice_number ?? "" },
      { name: "invoiceDate", label: "Ngày hóa đơn", type: "date", value: voucher.invoice_date ?? "" },
      { name: "currency", label: "Tiền tệ (mã 3 ký tự)", value: voucher.currency ?? "" },
      { name: "subtotal", label: "Tiền trước thuế", type: "number", step: "0.0001", min: "0", value: voucher.subtotal ?? "" },
      { name: "taxAmount", label: "Tiền thuế", type: "number", step: "0.0001", min: "0", value: voucher.tax_amount ?? "" },
      { name: "totalAmount", label: "Tổng tiền", type: "number", step: "0.0001", min: "0", value: voucher.total_amount ?? "" }
    ];
    const values = await showFormDialog({
      title: "Chỉnh sửa dữ liệu chứng từ",
      description: "Để trống trường không bắt buộc nếu muốn xóa dữ liệu đó.",
      fields,
      confirmLabel: "Lưu thay đổi"
    });
    if (values === null) return;
    const updates = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, value.trim() === "" ? null : value.trim()])
    );
    try {
      await api(`/api/vouchers/${encodeURIComponent(voucher.id)}`, {
        method: "PATCH",
        body: JSON.stringify(updates)
      });
      toast("Đã cập nhật dữ liệu trích xuất.");
      await navigate("vouchers");
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function openDocument(voucherId) {
    const viewer = window.open("about:blank", "_blank");
    if (!viewer) {
      toast("Cho phép cửa sổ bật lên để xem chứng từ.", true);
      return;
    }
    try {
      const response = await fetch(`/api/vouchers/${encodeURIComponent(voucherId)}/document`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Không thể tải chứng từ");
      }
      const url = URL.createObjectURL(await response.blob());
      viewer.location.replace(url);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      viewer.close();
      toast(error.message, true);
    }
  }

  async function renderEntries(page = 1, search = "") {
    const query = new URLSearchParams({ page: String(page), q: search });
    const [result, ledger] = await Promise.all([
      api(`/api/entries?${query}`),
      api("/api/ledger/accounts")
    ]);
    const rows = result.entries;
    content.innerHTML = `${heading(
      "Sổ sách",
      "Nhập sổ Excel, cấu hình tài khoản và tra cứu bút toán. Đã hạch toán thì không sửa/xóa; dùng bút toán đảo để điều chỉnh có kiểm toán.",
      '<button class="button button-secondary" data-action="download-ledger-template">Tải mẫu Excel</button><button class="button button-secondary" data-action="configure-ledger-accounts">Cấu hình tài khoản</button><button class="button button-primary" data-action="import-ledger">Nhập sổ Excel</button>'
    )}
      <section class="panel ledger-mapping-panel"><div class="panel-header"><div><h2>Định khoản hóa đơn mới</h2><p>Tài khoản sử dụng khi duyệt và ghi sổ chứng từ. Có thể cập nhật cấu hình bất kỳ lúc nào.</p></div></div>
        <div class="ledger-mapping-list">
          ${[
            ["expense", "Chi phí / hàng mua"],
            ["input_tax", "Thuế GTGT đầu vào"],
            ["accounts_payable", "Phải trả nhà cung cấp"],
            ["inventory_asset", "Hàng tồn kho (tùy chọn)"]
          ].map(([key, label]) => {
            const code = ledger.mappings[key];
            const account = ledger.accounts.find((item) => item.account_code === code);
            return `<div><span>${label}</span><strong>${account ? `${escapeHtml(account.account_code)} · ${escapeHtml(account.account_name)}` : "Chưa cấu hình"}</strong></div>`;
          }).join("")}
        </div>
      </section>
      <form class="catalog-toolbar" data-entry-filter><input name="q" type="search" maxlength="100" placeholder="Tìm số bút toán hoặc diễn giải" value="${escapeHtml(search)}"><button class="button button-secondary compact" type="submit">Tìm kiếm</button></form>
      <section class="panel ledger-entry-panel">${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Số bút toán</th><th>Ngày</th><th>Nội dung</th><th>Phát sinh Nợ</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>${rows.map((entry) => `<tr><td><strong>${escapeHtml(entry.entry_number)}</strong>${entry.reverses_entry_id ? `<br><small>Bút toán đảo · ${escapeHtml(String(entry.reverses_entry_id).slice(0, 8))}</small>` : ""}</td><td>${escapeHtml(new Date(entry.entry_date).toLocaleDateString("vi-VN"))}</td><td>${escapeHtml(entry.description)}</td><td>${money(entry.debit_total, entry.currency)}</td><td>${statusPill(entry.status)}</td><td><div class="table-actions">${entry.status === "posted" && !entry.reverses_entry_id && !entry.reversal_entry_id ? `<button class="button button-secondary compact" data-reverse-entry="${escapeHtml(entry.id)}">Lập bút toán đảo</button>` : entry.reversal_entry_id ? `<span class="muted-text">Đã có bút toán đảo</span>` : "—"}</div></td></tr>`).join("")}</tbody></table></div>` : empty("Chưa có bút toán", search ? "Thử từ khóa khác." : "Nhập sổ Excel lịch sử hoặc duyệt chứng từ để tạo bút toán.")}${pagination(result.page, result.pageSize, result.total)}</section>
      <input id="ledger-upload" class="hidden" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">`;
    bindCommon();
    content.querySelector("[data-entry-filter]").addEventListener("submit", (event) => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      void renderEntries(1, String(values.get("q") || ""));
    });
    bindPagination((nextPage) => renderEntries(nextPage, search));
    content.querySelectorAll("[data-reverse-entry]").forEach((button) => button.addEventListener("click", async () => {
      if (!await showConfirmDialog(
        "Lập bút toán đảo?",
        "NovaBooks sẽ tạo bút toán mới với các dòng Nợ/Có đảo ngược vào ngày hiện tại. Bút toán gốc được giữ nguyên và thao tác được ghi nhật ký kiểm toán.",
        "Lập bút toán đảo"
      )) return;
      try {
        await api(`/api/entries/${encodeURIComponent(button.dataset.reverseEntry)}/reverse`, { method: "POST" });
        toast("Đã lập bút toán đảo.");
        await renderEntries(page, search);
      } catch (error) { toast(error.message, true); }
    }));
    content.querySelector('[data-action="download-ledger-template"]').addEventListener("click", async () => {
      try {
        const response = await fetch("/api/ledger/template", { headers: { Authorization: "Bearer " + token } });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || "Không thể tải mẫu Excel.");
        }
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = url;
        link.download = "novabooks-ledger-template.xlsx";
        link.click();
        URL.revokeObjectURL(url);
      } catch (error) { toast(error.message, true); }
    });
    content.querySelector('[data-action="configure-ledger-accounts"]').addEventListener("click", async () => {
      if (!ledger.accounts.length) {
        toast("Hãy nhập sổ Excel trước để tải danh mục tài khoản.", true);
        return;
      }
      const options = ledger.accounts.map((account) => ({
        value: account.account_code,
        label: `${account.account_code} · ${account.account_name}`
      }));
      const mappings = await showFormDialog({
        title: "Cấu hình định khoản",
        description: "Chọn tài khoản mặc định lấy từ sổ cái đã nhập. Đảm bảo chọn đúng hệ thống tài khoản của doanh nghiệp.",
        fields: [
          { name: "expenseAccountCode", label: "Chi phí / hàng mua", type: "select", value: ledger.mappings.expense, options },
          { name: "inputTaxAccountCode", label: "Thuế GTGT đầu vào", type: "select", value: ledger.mappings.input_tax, options },
          { name: "payableAccountCode", label: "Phải trả nhà cung cấp", type: "select", value: ledger.mappings.accounts_payable, options },
          { name: "inventoryAccountCode", label: "Hàng tồn kho (tùy chọn)", type: "select", value: ledger.mappings.inventory_asset || "", options: [{ value: "", label: "Chưa cấu hình" }, ...options] }
        ],
        confirmLabel: "Lưu cấu hình"
      });
      if (!mappings) return;
      try {
        await api("/api/ledger/mappings", {
          method: "PUT",
          body: JSON.stringify({ ...mappings, inventoryAccountCode: mappings.inventoryAccountCode || null })
        });
        toast("Đã lưu tài khoản định khoản mặc định.");
        await navigate("entries");
      } catch (error) { toast(error.message, true); }
    });
    const ledgerFile = $("#ledger-upload");
    content.querySelector('[data-action="import-ledger"]').addEventListener("click", () => ledgerFile.click());
    ledgerFile.addEventListener("change", async () => {
      const file = ledgerFile.files?.[0];
      if (!file) return;
      const formData = new FormData();
      formData.append("ledger", file);
      try {
        const preview = await api("/api/ledger/import/preview", { method: "POST", body: formData });
        if (!preview.canImport) {
          const duplicatePreview = preview.duplicateEntryNumbers.slice(0, 10).join(", ");
          toast(`Có ${preview.duplicateEntryNumbers.length} số bút toán đã tồn tại: ${duplicatePreview}`, true);
          return;
        }
        const proceed = await showConfirmDialog(
          "Xác nhận nhập sổ cái",
          `Sẽ nhập ${preview.entryCount} bút toán, ${preview.lineCount} dòng và ${preview.accountCount} tài khoản. Bút toán nhập sẽ được ghi nhận là đã hạch toán, chỉ nên nhập dữ liệu lịch sử hợp lệ và đã khóa sổ.`,
          "Nhập dữ liệu"
        );
        if (!proceed) return;
        const result = await api("/api/ledger/import", { method: "POST", body: formData });
        toast(`Đã nhập ${result.entryCount} bút toán và ${result.accountCount} tài khoản.`);
        await navigate("entries");
      } catch (error) {
        const detail = error.details?.slice(0, 3).join(" · ");
        toast(detail ? `${error.message} ${detail}` : error.message, true);
      } finally {
        ledgerFile.value = "";
      }
    });
  }

  async function renderSuppliers(page = 1, search = "", status = "active") {
    const query = new URLSearchParams({ page: String(page), q: search, status });
    const result = await api(`/api/suppliers?${query}`);
    const rows = result.suppliers;
    content.innerHTML = `${heading("Nhà cung cấp", "Danh mục riêng của doanh nghiệp; lưu trữ thay vì xóa để giữ nguyên lịch sử chứng từ.", '<button class="button button-primary" data-action="add-supplier">＋ Thêm nhà cung cấp</button>')}
      ${catalogToolbar(search, status, " hoặc mã số thuế")}
      <section class="panel">${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Mã</th><th>Tên nhà cung cấp</th><th>Mã số thuế</th><th>Email</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>${rows.map((item) => `<tr><td>${escapeHtml(item.code)}</td><td><strong>${escapeHtml(item.name)}</strong></td><td>${escapeHtml(item.tax_id || "—")}</td><td>${escapeHtml(item.email || "—")}</td><td>${statusPill(item.status)}</td><td><div class="table-actions">
        <button class="button button-secondary compact" data-edit-supplier="${escapeHtml(item.id)}">Sửa</button>
        ${item.status === "active"
          ? `<button class="button button-danger compact" data-archive-supplier="${escapeHtml(item.id)}">Lưu trữ</button>`
          : `<button class="button button-secondary compact" data-restore-supplier="${escapeHtml(item.id)}">Khôi phục</button>`}
      </div></td></tr>`).join("")}</tbody></table></div>` : empty("Không có nhà cung cấp", search ? "Thử từ khóa hoặc bộ lọc khác." : "Thêm danh mục để quản lý đối tác kế toán.")}${pagination(result.page, result.pageSize, result.total)}</section>`;
    bindCommon();
    bindCatalogFilter(renderSuppliers);
    bindPagination((nextPage) => renderSuppliers(nextPage, search, status));
    const action = content.querySelector('[data-action="add-supplier"]');
    if (action) action.addEventListener("click", async () => {
      await editSupplierWithDialog();
    });
    content.querySelectorAll("[data-edit-supplier]").forEach((button) => button.addEventListener("click", () => {
      void editSupplierWithDialog(
        rows.find((item) => item.id === button.dataset.editSupplier),
        () => renderSuppliers(page, search, status)
      );
    }));
    content.querySelectorAll("[data-archive-supplier]").forEach((button) => button.addEventListener("click", () => {
      void setCatalogArchived("suppliers", button.dataset.archiveSupplier, true, () =>
        renderSuppliers(rows.length === 1 && page > 1 ? page - 1 : page, search, status));
    }));
    content.querySelectorAll("[data-restore-supplier]").forEach((button) => button.addEventListener("click", () => {
      void setCatalogArchived("suppliers", button.dataset.restoreSupplier, false, () =>
        renderSuppliers(rows.length === 1 && page > 1 ? page - 1 : page, search, status));
    }));
  }

  async function renderProducts(page = 1, search = "", status = "active") {
    const query = new URLSearchParams({ page: String(page), q: search, status });
    const result = await api(`/api/products?${query}`);
    const rows = result.products;
    content.innerHTML = `${heading("Hàng hóa & dịch vụ", "Danh mục doanh nghiệp; lưu trữ thay vì xóa để giữ nguyên lịch sử kế toán.", '<button class="button button-primary" data-action="add-product">＋ Thêm mặt hàng</button>')}
      ${catalogToolbar(search, status)}
      <section class="panel">${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Mã</th><th>Tên hàng hóa/dịch vụ</th><th>Đơn vị</th><th>Đơn giá</th><th>Thuế suất</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>${rows.map((item) => `<tr><td>${escapeHtml(item.code)}</td><td><strong>${escapeHtml(item.name)}</strong></td><td>${escapeHtml(item.unit || "—")}</td><td>${money(item.default_unit_price, item.currency)}</td><td>${item.tax_rate == null ? "—" : `${escapeHtml(item.tax_rate)}%`}</td><td>${statusPill(item.status)}</td><td><div class="table-actions">
        <button class="button button-secondary compact" data-edit-product="${escapeHtml(item.id)}">Sửa</button>
        ${item.status === "active"
          ? `<button class="button button-danger compact" data-archive-product="${escapeHtml(item.id)}">Lưu trữ</button>`
          : `<button class="button button-secondary compact" data-restore-product="${escapeHtml(item.id)}">Khôi phục</button>`}
      </div></td></tr>`).join("")}</tbody></table></div>` : empty("Không có hàng hóa/dịch vụ", search ? "Thử từ khóa hoặc bộ lọc khác." : "Thêm hàng hóa hoặc dịch vụ để quản lý tập trung.")}${pagination(result.page, result.pageSize, result.total)}</section>`;
    bindCommon();
    bindCatalogFilter(renderProducts);
    bindPagination((nextPage) => renderProducts(nextPage, search, status));
    content.querySelector('[data-action="add-product"]').addEventListener("click", async () => {
      await editProductWithDialog();
    });
    content.querySelectorAll("[data-edit-product]").forEach((button) => button.addEventListener("click", () => {
      void editProductWithDialog(
        rows.find((item) => item.id === button.dataset.editProduct),
        () => renderProducts(page, search, status)
      );
    }));
    content.querySelectorAll("[data-archive-product]").forEach((button) => button.addEventListener("click", () => {
      void setCatalogArchived("products", button.dataset.archiveProduct, true, () =>
        renderProducts(rows.length === 1 && page > 1 ? page - 1 : page, search, status));
    }));
    content.querySelectorAll("[data-restore-product]").forEach((button) => button.addEventListener("click", () => {
      void setCatalogArchived("products", button.dataset.restoreProduct, false, () =>
        renderProducts(rows.length === 1 && page > 1 ? page - 1 : page, search, status));
    }));
  }

  async function renderInventory() {
    const itemQuery = new URLSearchParams({
      page: String(inventoryState.itemPage),
      q: inventoryState.search,
      status: inventoryState.itemStatus
    });
    const movementQuery = new URLSearchParams({
      page: String(inventoryState.movementPage),
      q: inventoryState.search
    });
    const assignmentQuery = new URLSearchParams({
      page: String(inventoryState.assignmentPage),
      q: inventoryState.search,
      status: inventoryState.assignmentStatus
    });
    const [items, movements, assignments] = await Promise.all([
      api(`/api/inventory/items?${itemQuery}`),
      api(`/api/inventory/movements?${movementQuery}`),
      api(`/api/inventory/assignments?${assignmentQuery}`)
    ]);
    content.innerHTML = `${heading(
      "Quản lý kho",
      "Theo dõi danh mục vật tư, số dư đầu kỳ, nhập-xuất-tồn và dụng cụ đang cấp phát.",
      '<button class="button button-secondary" data-inventory-action="template">Tải mẫu</button><button class="button button-secondary" data-inventory-action="export">Xuất Excel</button><button class="button button-secondary" data-inventory-action="import">Nhập workbook</button><button class="button button-secondary" data-inventory-action="movement">Ghi nhập/xuất</button><button class="button button-primary" data-inventory-action="assignment">Cấp phát dụng cụ</button><button class="button button-primary" data-inventory-action="item">＋ Thêm vật tư</button>'
    )}
      <form class="catalog-toolbar" data-inventory-filter>
        <input name="q" type="search" maxlength="100" placeholder="Tìm mã vật tư, tên, phiếu hoặc người nhận" value="${escapeHtml(inventoryState.search)}">
        <select name="itemStatus" aria-label="Lọc trạng thái vật tư">
          <option value="active" ${inventoryState.itemStatus === "active" ? "selected" : ""}>Vật tư đang dùng</option>
          <option value="archived" ${inventoryState.itemStatus === "archived" ? "selected" : ""}>Vật tư lưu trữ</option>
          <option value="all" ${inventoryState.itemStatus === "all" ? "selected" : ""}>Tất cả vật tư</option>
        </select>
        <select name="assignmentStatus" aria-label="Lọc trạng thái cấp phát">
          <option value="active" ${inventoryState.assignmentStatus === "active" ? "selected" : ""}>Đang cấp phát</option>
          <option value="returned" ${inventoryState.assignmentStatus === "returned" ? "selected" : ""}>Đã thu hồi</option>
          <option value="all" ${inventoryState.assignmentStatus === "all" ? "selected" : ""}>Tất cả cấp phát</option>
        </select>
        <button class="button button-secondary compact" type="submit">Lọc dữ liệu</button>
      </form>
      <section class="panel inventory-panel">
        <div class="panel-header"><div><h2>Danh mục & tồn kho</h2><p>Số tồn được tính từ tồn đầu kỳ cộng nhật ký kho; lưu trữ không xóa lịch sử.</p></div></div>
        ${items.items.length ? `<div class="table-wrap"><table><thead><tr><th>Mã</th><th>Vật tư</th><th>Phân loại</th><th>Đơn vị</th><th>Tồn hiện tại</th><th>Tồn tối thiểu</th><th>Cảnh báo tồn</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>${items.items.map((item) => `<tr>
          <td><strong>${escapeHtml(item.code)}</strong></td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.category || "—")}</td>
          <td>${escapeHtml(item.unit || "—")}</td><td><strong>${escapeHtml(item.current_quantity)}</strong></td>
          <td>${escapeHtml(item.minimum_quantity)}</td><td>${statusPill(isLowStock(item.current_quantity, item.minimum_quantity) ? "low_stock" : "in_stock")}</td>
          <td>${statusPill(item.status)}</td>
          <td><div class="table-actions"><button class="button button-secondary compact" data-edit-inventory-item="${escapeHtml(item.id)}">Sửa</button>
            ${item.status === "active"
              ? `<button class="button button-danger compact" data-inventory-status="${escapeHtml(item.id)}" data-next-status="archived">Lưu trữ</button>`
              : `<button class="button button-secondary compact" data-inventory-status="${escapeHtml(item.id)}" data-next-status="active">Khôi phục</button>`}
          </div></td>
        </tr>`).join("")}</tbody></table></div>` : empty("Chưa có vật tư", "Thêm thủ công hoặc nhập workbook kho để tải danh mục, số dư và lịch sử.")}${inventoryPagination("items", items.page, items.pageSize, items.total)}
      </section>
      <section class="panel inventory-panel">
        <div class="panel-header"><div><h2>Nhật ký nhập - xuất - tồn</h2><p>Mọi thay đổi tồn được ghi thành giao dịch; không sửa/xóa lịch sử đã ghi.</p></div></div>
        ${movements.movements.length ? `<div class="table-wrap"><table><thead><tr><th>Ngày</th><th>Mã phiếu</th><th>Loại</th><th>Vật tư</th><th>Số lượng</th><th>Nơi nhận</th><th>Ghi chú</th></tr></thead><tbody>${movements.movements.map((movement) => `<tr>
          <td>${escapeHtml(new Date(`${movement.movement_date}T00:00:00`).toLocaleDateString("vi-VN"))}</td>
          <td><strong>${escapeHtml(movement.document_number)}</strong></td><td>${escapeHtml(inventoryMovementLabel(movement.movement_type))}</td>
          <td>${escapeHtml(movement.item_code)} · ${escapeHtml(movement.item_name)}</td><td>${escapeHtml(movement.quantity)} ${escapeHtml(movement.unit || "")}</td>
          <td>${escapeHtml(movement.recipient || "—")}</td><td>${escapeHtml(movement.notes || "—")}</td>
        </tr>`).join("")}</tbody></table></div>` : empty("Chưa có giao dịch kho", "Nhập workbook, ghi nhập/xuất hoặc duyệt hóa đơn đã ghép vật tư.")}${inventoryPagination("movements", movements.page, movements.pageSize, movements.total)}
      </section>
      <section class="panel inventory-panel">
        <div class="panel-header"><div><h2>Cấp phát dụng cụ</h2><p>Thu hồi sẽ tạo giao dịch nhập kho và lưu dấu thời gian; cấp phát được kiểm tra tồn trước khi ghi.</p></div></div>
        ${assignments.assignments.length ? `<div class="table-wrap"><table><thead><tr><th>Phiếu / ngày</th><th>Dụng cụ</th><th>Người nhận</th><th>Số lượng</th><th>Tình trạng</th><th>Hạn thu hồi</th><th>Thao tác</th></tr></thead><tbody>${assignments.assignments.map((entry) => `<tr>
          <td>${escapeHtml(entry.document_number)}<br><small>${escapeHtml(entry.issued_at)}</small></td>
          <td>${escapeHtml(entry.item_code)} · ${escapeHtml(entry.item_name)}</td><td>${escapeHtml(entry.recipient)}${entry.team ? `<br><small>${escapeHtml(entry.team)}</small>` : ""}</td>
          <td>${escapeHtml(entry.quantity)} ${escapeHtml(entry.unit || "")}</td><td>${statusPill(entry.status)}</td><td>${escapeHtml(entry.due_date || "—")}</td>
          <td>${entry.status === "active" ? `<button class="button button-secondary compact" data-return-assignment="${escapeHtml(entry.id)}">Đã thu hồi</button>` : "—"}</td>
        </tr>`).join("")}</tbody></table></div>` : empty("Không có phiếu cấp phát", "Phiếu đang cấp phát và lịch sử thu hồi sẽ hiển thị tại đây.")}${inventoryPagination("assignments", assignments.page, assignments.pageSize, assignments.total)}
      </section>
      <input id="inventory-upload" class="hidden" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">`;

    content.querySelector("[data-inventory-filter]").addEventListener("submit", (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget).entries());
      inventoryState.search = String(values.q || "").trim();
      inventoryState.itemStatus = String(values.itemStatus || "active");
      inventoryState.assignmentStatus = String(values.assignmentStatus || "active");
      inventoryState.itemPage = inventoryState.movementPage = inventoryState.assignmentPage = 1;
      void renderInventory();
    });
    content.querySelectorAll("[data-inventory-page]").forEach((button) => button.addEventListener("click", () => {
      const [list, page] = button.dataset.inventoryPage.split(":");
      if (list === "items") inventoryState.itemPage = Number(page);
      if (list === "movements") inventoryState.movementPage = Number(page);
      if (list === "assignments") inventoryState.assignmentPage = Number(page);
      void renderInventory();
    }));
    content.querySelector('[data-inventory-action="item"]').addEventListener("click", () => void editInventoryItem());
    content.querySelectorAll("[data-edit-inventory-item]").forEach((button) => {
      button.addEventListener("click", () => void editInventoryItem(
        items.items.find((item) => item.id === button.dataset.editInventoryItem)
      ));
    });
    content.querySelectorAll("[data-inventory-status]").forEach((button) => button.addEventListener("click", async () => {
      const status = button.dataset.nextStatus;
      if (status === "archived" && !await showConfirmDialog(
        "Lưu trữ vật tư?",
        "Vật tư chỉ được lưu trữ khi tồn bằng 0 và không có phiếu cấp phát đang mở. Lịch sử kho vẫn được giữ lại.",
        "Lưu trữ"
      )) return;
      try {
        await api(`/api/inventory/items/${encodeURIComponent(button.dataset.inventoryStatus)}/status`, {
          method: "PATCH", body: JSON.stringify({ status })
        });
        toast(status === "archived" ? "Đã lưu trữ vật tư." : "Đã khôi phục vật tư.");
        await renderInventory();
      } catch (error) { toast(error.message, true); }
    }));
    content.querySelector('[data-inventory-action="movement"]').addEventListener("click", () => void createMovementDialog());
    content.querySelector('[data-inventory-action="assignment"]').addEventListener("click", () => void createAssignmentDialog());
    content.querySelector('[data-inventory-action="template"]').addEventListener("click", () => void downloadInventory("/api/inventory/template", "novabooks-inventory-template.xlsx"));
    content.querySelector('[data-inventory-action="export"]').addEventListener("click", () => void downloadInventory("/api/inventory/export", "novabooks-inventory.xlsx"));
    const uploadInput = $("#inventory-upload");
    content.querySelector('[data-inventory-action="import"]').addEventListener("click", () => uploadInput.click());
    uploadInput.addEventListener("change", () => void importInventoryWorkbook(uploadInput));
    content.querySelectorAll("[data-return-assignment]").forEach((button) => button.addEventListener("click", async () => {
      if (!await showConfirmDialog(
        "Xác nhận thu hồi dụng cụ?",
        "Hệ thống sẽ ghi một giao dịch nhập kho cho toàn bộ số lượng đang cấp; lịch sử cấp phát được giữ nguyên.",
        "Xác nhận thu hồi"
      )) return;
      try {
        await api(`/api/inventory/assignments/${encodeURIComponent(button.dataset.returnAssignment)}/return`, { method: "POST" });
        toast("Đã ghi nhận thu hồi và cập nhật tồn kho.");
        await renderInventory();
      } catch (error) { toast(error.message, true); }
    }));
  }

  function inventoryPagination(key, page, pageSize, total) {
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    return `<div class="list-pagination"><span>${total} bản ghi · trang ${page}/${pageCount}</span><div>
      <button class="button button-secondary compact" data-inventory-page="${key}:${page - 1}" ${page <= 1 ? "disabled" : ""}>← Trước</button>
      <button class="button button-secondary compact" data-inventory-page="${key}:${page + 1}" ${page >= pageCount ? "disabled" : ""}>Sau →</button>
    </div></div>`;
  }

  function inventoryMovementLabel(type) {
    return ({
      purchase_in: "Nhập mua", production_out: "Xuất sản xuất", issue_out: "Cấp phát thợ",
      return_in: "Thu hồi", adjustment_in: "Điều chỉnh tăng", adjustment_out: "Điều chỉnh giảm"
    })[type] || type;
  }

  function isLowStock(current, minimum) {
    const units = (value) => {
      const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(String(value));
      return match?.[1] ? BigInt(match[1]) * 10000n + BigInt((match[2] || "").padEnd(4, "0") || "0") : 0n;
    };
    return units(current) <= units(minimum);
  }

  async function editInventoryItem(item) {
    const values = await showFormDialog({
      title: item ? "Sửa thông tin vật tư" : "Thêm vật tư",
      description: "Số dư đầu kỳ chỉ thay đổi qua import hoặc giao dịch điều chỉnh để không làm sai lịch sử kho.",
      fields: [
        { name: "code", label: "Mã vật tư", value: item?.code, required: true },
        { name: "name", label: "Tên vật tư", value: item?.name, required: true, minLength: 2 },
        { name: "category", label: "Phân loại", value: item?.category },
        { name: "unit", label: "Đơn vị tính", value: item?.unit },
        { name: "minimumQuantity", label: "Tồn tối thiểu", type: "number", min: "0", step: "0.0001", value: item?.minimum_quantity || "0" },
        { name: "location", label: "Vị trí kho", value: item?.location },
        { name: "notes", label: "Ghi chú", type: "textarea", value: item?.notes }
      ],
      confirmLabel: item ? "Lưu thay đổi" : "Thêm vật tư"
    });
    if (!values) return;
    const payload = {
      code: values.code.trim(), name: values.name.trim(), category: values.category.trim() || null,
      unit: values.unit.trim() || null, minimumQuantity: values.minimumQuantity || "0",
      location: values.location.trim() || null, notes: values.notes.trim() || null
    };
    try {
      await api(item ? `/api/inventory/items/${encodeURIComponent(item.id)}` : "/api/inventory/items", {
        method: item ? "PUT" : "POST", body: JSON.stringify(payload)
      });
      toast(item ? "Đã cập nhật vật tư." : "Đã thêm vật tư.");
      await renderInventory();
    } catch (error) { toast(error.message, true); }
  }

  async function inventoryItemOptions() {
    const result = await api("/api/inventory/items/options");
    if (!result.items.length) throw new Error("Hãy thêm vật tư hoặc nhập workbook kho trước.");
    return result.items.map((item) => ({
      value: item.id,
      label: `${item.code} · ${item.name} (tồn ${item.current_quantity} ${item.unit || ""})`
    }));
  }

  async function createMovementDialog() {
    let itemOptions;
    try { itemOptions = await inventoryItemOptions(); }
    catch (error) { toast(error.message, true); return; }
    const values = await showFormDialog({
      title: "Ghi giao dịch kho",
      description: "Giao dịch xuất sẽ bị từ chối nếu tồn khả dụng không đủ. Điều chỉnh được ghi nối tiếp, không sửa số dư gốc.",
      fields: [
        { name: "itemId", label: "Vật tư", type: "select", options: itemOptions, required: true },
        { name: "type", label: "Loại giao dịch", type: "select", required: true, options: [
          { value: "purchase_in", label: "Nhập mua" }, { value: "production_out", label: "Xuất sản xuất" },
          { value: "return_in", label: "Thu hồi" }, { value: "adjustment_in", label: "Điều chỉnh tăng" },
          { value: "adjustment_out", label: "Điều chỉnh giảm" }
        ] },
        { name: "date", label: "Ngày giao dịch", type: "date", value: localDate(), required: true },
        { name: "documentNumber", label: "Mã phiếu", required: true },
        { name: "quantity", label: "Số lượng", type: "number", min: "0.0001", step: "0.0001", required: true },
        { name: "recipient", label: "Nơi nhận / người nhận" },
        { name: "notes", label: "Ghi chú", type: "textarea" }
      ],
      confirmLabel: "Ghi giao dịch"
    });
    if (!values) return;
    try {
      await api("/api/inventory/movements", {
        method: "POST",
        body: JSON.stringify({
          ...values, recipient: values.recipient.trim() || null, notes: values.notes.trim() || null
        })
      });
      toast("Đã ghi giao dịch kho.");
      await renderInventory();
    } catch (error) { toast(error.message, true); }
  }

  async function createAssignmentDialog() {
    let itemOptions;
    try { itemOptions = await inventoryItemOptions(); }
    catch (error) { toast(error.message, true); return; }
    const values = await showFormDialog({
      title: "Cấp phát dụng cụ",
      description: "Tạo phiếu theo dõi người nhận và tự động trừ tồn. Có thể thu hồi từ danh sách bên dưới.",
      fields: [
        { name: "itemId", label: "Dụng cụ", type: "select", options: itemOptions, required: true },
        { name: "documentNumber", label: "Mã phiếu cấp", required: true },
        { name: "issuedAt", label: "Ngày cấp", type: "date", value: localDate(), required: true },
        { name: "recipient", label: "Người nhận", required: true },
        { name: "team", label: "Bộ phận / nhóm" },
        { name: "quantity", label: "Số lượng", type: "number", min: "0.0001", step: "0.0001", required: true },
        { name: "condition", label: "Tình trạng", value: "Đang sử dụng" },
        { name: "dueDate", label: "Hạn thu hồi / kiểm định", type: "date" },
        { name: "notes", label: "Ghi chú", type: "textarea" }
      ],
      confirmLabel: "Cấp phát"
    });
    if (!values) return;
    try {
      await api("/api/inventory/assignments", {
        method: "POST",
        body: JSON.stringify({
          ...values, team: values.team.trim() || null, condition: values.condition.trim() || null,
          dueDate: values.dueDate || null, notes: values.notes.trim() || null
        })
      });
      toast("Đã cấp phát và trừ tồn kho.");
      await renderInventory();
    } catch (error) { toast(error.message, true); }
  }

  async function importInventoryWorkbook(input) {
    const file = input.files?.[0];
    if (!file) return;
    const dateForm = await showFormDialog({
      title: "Ngày bắt đầu tồn kho",
      description: "Nhập ngày hiệu lực của số dư đầu kỳ trong sheet Báo Cáo Tồn Kho. Các giao dịch trong nhật ký phải từ ngày này trở đi.",
      fields: [{ name: "openingDate", label: "Ngày tồn đầu kỳ", type: "date", required: true }],
      confirmLabel: "Kiểm tra workbook"
    });
    if (!dateForm) { input.value = ""; return; }
    const formData = new FormData();
    formData.append("inventory", file);
    formData.append("openingDate", dateForm.openingDate);
    try {
      const preview = await api("/api/inventory/import/preview", { method: "POST", body: formData });
      if (!preview.canImport) {
        toast(preview.duplicateBatch
          ? "Workbook này đã được nhập trước đó."
          : (preview.errors || []).slice(0, 3).join(" ") || "Workbook chưa thể nhập.", true);
        input.value = "";
        return;
      }
      const summary = [
        `${preview.itemCount} vật tư mới`,
        `${preview.movementCount} giao dịch kho`,
        `${preview.assignmentCount} phiếu cấp phát`
      ].join(" · ");
      const warnings = preview.warnings?.length ? `\n\nLưu ý:\n${preview.warnings.join("\n")}` : "";
      if (!await showConfirmDialog(
        "Xác nhận nhập workbook kho",
        `${summary}. Số dư và danh mục của mã đã tồn tại sẽ được giữ nguyên; giao dịch trùng được bỏ qua.${warnings}`,
        "Nhập dữ liệu"
      )) { input.value = ""; return; }
      const imported = await api("/api/inventory/import", { method: "POST", body: formData });
      toast(`Đã nhập ${imported.itemCount} vật tư, ${imported.movementCount} giao dịch và ${imported.assignmentCount} phiếu cấp phát.`);
      await renderInventory();
    } catch (error) {
      toast(error.message, true);
    } finally {
      input.value = "";
    }
  }

  async function downloadInventory(url, filename) {
    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Không thể tải workbook kho.");
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(objectUrl);
    } catch (error) { toast(error.message, true); }
  }

  function localDate() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  async function editSupplierWithDialog(supplier, refresh = () => renderSuppliers()) {
    const values = await showFormDialog({
      title: supplier ? "Sửa nhà cung cấp" : "Thêm nhà cung cấp",
      fields: [
        { name: "code", label: "Mã nhà cung cấp", value: supplier?.code, required: true },
        { name: "name", label: "Tên nhà cung cấp", value: supplier?.name, required: true, minLength: 2 },
        { name: "taxId", label: "Mã số thuế", value: supplier?.tax_id },
        { name: "email", label: "Email", type: "email", value: supplier?.email },
        { name: "phone", label: "Số điện thoại", value: supplier?.phone },
        { name: "address", label: "Địa chỉ", value: supplier?.address }
      ],
      confirmLabel: supplier ? "Lưu thay đổi" : "Thêm nhà cung cấp"
    });
    if (values === null) return;
    const payload = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim() || null]));
    try {
      await api(supplier ? `/api/suppliers/${encodeURIComponent(supplier.id)}` : "/api/suppliers", {
        method: supplier ? "PUT" : "POST", body: JSON.stringify(payload)
      });
      toast(supplier ? "Đã cập nhật nhà cung cấp." : "Đã thêm nhà cung cấp.");
      await refresh();
    } catch (error) { toast(error.message, true); }
  }

  async function editProductWithDialog(product, refresh = () => renderProducts()) {
    const values = await showFormDialog({
      title: product ? "Sửa hàng hóa/dịch vụ" : "Thêm hàng hóa/dịch vụ",
      fields: [
        { name: "code", label: "Mã hàng hóa/dịch vụ", value: product?.code, required: true },
        { name: "name", label: "Tên hàng hóa/dịch vụ", value: product?.name, required: true, minLength: 2 },
        { name: "unit", label: "Đơn vị tính", value: product?.unit },
        { name: "defaultUnitPrice", label: "Đơn giá", type: "number", min: "0", step: "0.0001", value: product?.default_unit_price },
        { name: "taxRate", label: "Thuế suất (%)", type: "number", min: "0", max: "100", step: "0.01", value: product?.tax_rate }
      ],
      confirmLabel: product ? "Lưu thay đổi" : "Thêm mặt hàng"
    });
    if (values === null) return;
    const payload = {
      code: values.code.trim(),
      name: values.name.trim(),
      unit: values.unit.trim() || null,
      defaultUnitPrice: values.defaultUnitPrice.trim() || null,
      taxRate: values.taxRate.trim() === "" ? null : Number(values.taxRate),
      currency: product?.currency || currentUser.default_currency || "VND"
    };
    try {
      await api(product ? `/api/products/${encodeURIComponent(product.id)}` : "/api/products", {
        method: product ? "PUT" : "POST", body: JSON.stringify(payload)
      });
      toast(product ? "Đã cập nhật hàng hóa/dịch vụ." : "Đã thêm hàng hóa/dịch vụ.");
      await refresh();
    } catch (error) { toast(error.message, true); }
  }

  async function setCatalogArchived(resource, id, archive, refresh) {
    if (archive && !await showConfirmDialog(
      "Lưu trữ mục này?",
      "Mục sẽ không còn xuất hiện trong danh sách đang hoạt động. Lịch sử chứng từ và bút toán được giữ nguyên; bạn có thể khôi phục sau.",
      "Lưu trữ"
    )) return;
    try {
      await api(`/api/${resource}/${encodeURIComponent(id)}${archive ? "" : "/restore"}`, {
        method: archive ? "DELETE" : "POST"
      });
      toast(archive ? "Đã lưu trữ." : "Đã khôi phục.");
      await refresh();
    } catch (error) { toast(error.message, true); }
  }

  async function renderChannels() {
    const result = await api("/api/channels");
    content.innerHTML = `${heading("Kết nối kênh", "Nhận chứng từ và gửi thông báo tới đúng kênh của doanh nghiệp.")}
      <section class="panel"><div class="panel-header"><div><h2>Kênh đã kết nối</h2><p>Thông tin xác thực được mã hóa, chỉ hiển thị khi cấu hình.</p></div></div>
      ${result.channels.length ? result.channels.map((channel) => `<div class="channel-card"><div class="channel-info"><span class="channel-logo">${channel.provider === "telegram" ? "✈" : "Z"}</span><div><strong>${escapeHtml(channel.display_name || channel.provider)}</strong><small>${escapeHtml(channel.provider)} · ${escapeHtml(channel.external_account_id || "")}</small></div></div><div>${statusPill(channel.status)}${channel.provider === "telegram" && ["error", "disabled"].includes(channel.status) ? `<button class="button button-secondary compact" data-retry-channel="${escapeHtml(channel.id)}">Đăng ký lại webhook</button>` : ""}${channel.status !== "disabled" ? `<button class="button button-secondary compact" data-disable-channel="${escapeHtml(channel.id)}">Tắt</button>` : ""}</div></div>`).join("") : empty("Chưa có kênh kết nối", "Kết nối Telegram Bot hoặc Zalo OA để nhận chứng từ.")}</section>
      <section class="panel" style="margin-top:15px"><div class="panel-header"><div><h2>Thêm kênh</h2><p>Token chỉ gửi qua HTTPS và không được hiển thị lại sau khi lưu.</p></div></div>
        <form id="channel-form" class="form-grid">
          <label>Nhà cung cấp<select id="channel-provider"><option value="telegram">Telegram Bot</option><option value="zalo_oa">Zalo OA</option></select></label>
          <span></span>
          <label id="telegram-token-field">Bot token<input id="telegram-token" type="password" autocomplete="new-password" placeholder="Token do BotFather cấp"></label>
          <label id="telegram-chat-field">Chat ID nội bộ<input id="telegram-chat" placeholder="-100... hoặc chat ID"></label>
          <label id="zalo-oa-field" class="hidden">OA ID<input id="zalo-oa" placeholder="ID Zalo Official Account"></label>
          <label id="zalo-token-field" class="hidden">Access token<input id="zalo-token" type="password" autocomplete="new-password"></label>
          <label id="zalo-secret-field" class="hidden">App secret<input id="zalo-secret" type="password" autocomplete="new-password"></label>
          <label id="zalo-recipient-field" class="hidden">Recipient ID nhận báo cáo<input id="zalo-recipient" placeholder="ID người nhận đã quan tâm OA"></label>
          <button class="button button-primary compact form-full" type="submit">Kết nối kênh</button>
          <div id="channel-result" class="notice hidden form-full"></div>
        </form>
      </section>`;
    bindCommon();
    const provider = $("#channel-provider");
    provider.addEventListener("change", () => {
      const telegram = provider.value === "telegram";
      ["telegram-token-field", "telegram-chat-field"].forEach((id) => $(`#${id}`).classList.toggle("hidden", !telegram));
      ["zalo-oa-field", "zalo-token-field", "zalo-secret-field", "zalo-recipient-field"].forEach((id) => $(`#${id}`).classList.toggle("hidden", telegram));
    });
    $("#channel-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = provider.value === "telegram"
        ? { provider: "telegram", botToken: $("#telegram-token").value, chatId: $("#telegram-chat").value }
        : { provider: "zalo_oa", oaId: $("#zalo-oa").value, accessToken: $("#zalo-token").value, appSecret: $("#zalo-secret").value, recipientId: $("#zalo-recipient").value };
      try {
        const connected = await api("/api/channels", { method: "POST", body: JSON.stringify(input) });
        const notice = $("#channel-result");
        notice.className = "notice form-full";
        notice.textContent = `Đã kết nối. Webhook: ${connected.webhookUrl}`;
        $("#channel-form").reset();
        toast("Kênh đã được cấu hình. Hãy lưu URL webhook ở vị trí an toàn.");
      } catch (error) {
        toast(error.message, true);
      }
    });
    content.querySelectorAll("[data-disable-channel]").forEach((button) => button.addEventListener("click", async () => {
      if (!await showConfirmDialog("Tắt kênh?", "Kênh sẽ không nhận webhook mới.", "Tắt kênh")) return;
      try {
        await api(`/api/channels/${encodeURIComponent(button.dataset.disableChannel)}/disable`, { method: "POST" });
        toast("Đã tắt kênh.");
        await navigate("channels");
      } catch (error) { toast(error.message, true); }
    }));
    content.querySelectorAll("[data-retry-channel]").forEach((button) => button.addEventListener("click", async () => {
      try {
        const result = await api(`/api/channels/${encodeURIComponent(button.dataset.retryChannel)}/retry-webhook`, { method: "POST" });
        toast(`Đã đăng ký webhook: ${result.webhookUrl}`);
        await navigate("channels");
      } catch (error) { toast(error.message, true); }
    }));
  }

  async function renderMembers() {
    const result = await api("/api/members");
    content.innerHTML = `${heading("Thành viên", "Quản lý quyền truy cập trong không gian doanh nghiệp.", '<button class="button button-primary" data-action="add-member">＋ Thêm thành viên</button>')}
      <section class="panel"><div class="panel-header"><div><h2>Thành viên doanh nghiệp</h2><p>Phân quyền theo vai trò, chỉ có hiệu lực trong tenant này.</p></div></div>
      ${result.members.map((member) => `<div class="member-row"><div class="channel-info"><span class="user-avatar">${escapeHtml(initials(member.full_name))}</span><div><strong>${escapeHtml(member.full_name)}</strong><small>${escapeHtml(member.email)}</small></div></div><div>${escapeHtml(roleLabel(member.role))} · ${escapeHtml(member.status)}</div>${member.user_id !== currentUser.id ? `<button class="button button-danger compact" data-remove-member="${escapeHtml(member.id)}">Gỡ</button>` : ""}</div>`).join("")}</section>`;
    bindCommon();
    content.querySelector('[data-action="add-member"]').addEventListener("click", async () => {
      const values = await showFormDialog({
        title: "Thêm thành viên",
        description: "Người được thêm cần có tài khoản NovaBooks đã đăng ký.",
        fields: [
          { name: "email", label: "Email", type: "email", required: true },
          {
            name: "role",
            label: "Vai trò",
            type: "select",
            options: [
              { value: "accountant", label: "Kế toán viên" },
              { value: "staff", label: "Nhân viên gửi chứng từ" }
            ]
          }
        ],
        confirmLabel: "Thêm thành viên"
      });
      if (!values) return;
      try {
        await api("/api/members", { method: "POST", body: JSON.stringify(values) });
        toast("Đã thêm thành viên.");
        await navigate("members");
      } catch (error) { toast(error.message, true); }
    });
    content.querySelectorAll("[data-remove-member]").forEach((button) => button.addEventListener("click", async () => {
      if (!await showConfirmDialog("Gỡ thành viên?", "Người này sẽ mất quyền truy cập vào doanh nghiệp.", "Gỡ thành viên")) return;
      try {
        await api(`/api/members/${encodeURIComponent(button.dataset.removeMember)}/remove`, { method: "POST" });
        toast("Đã gỡ thành viên.");
        await navigate("members");
      } catch (error) { toast(error.message, true); }
    }));
  }

  async function renderReports() {
    const result = await api("/api/reports");
    content.innerHTML = `${heading("Báo cáo", "Bản tin cuối ngày được tổng hợp riêng theo múi giờ và sổ sách doanh nghiệp.")}<section class="panel">${result.reports.length ? `<div class="table-wrap"><table><thead><tr><th>Ngày báo cáo</th><th>Kênh</th><th>Trạng thái</th><th>Nội dung</th><th>Thời điểm gửi</th></tr></thead><tbody>${result.reports.map((report) => `<tr><td>${escapeHtml(new Date(report.report_date).toLocaleDateString("vi-VN"))}</td><td>${escapeHtml(report.channel_id || "—")}</td><td>${statusPill(report.status)}</td><td>${escapeHtml(report.summary)}</td><td>${escapeHtml(new Date(report.created_at).toLocaleString("vi-VN"))}</td></tr>`).join("")}</tbody></table></div>` : empty("Chưa có báo cáo", "Báo cáo được gửi khi doanh nghiệp đã kết nối kênh.")}</section>`;
    bindCommon();
  }

  function bindCommon() {
    content.querySelectorAll("[data-nav]").forEach((button) => button.addEventListener("click", () => void navigate(button.dataset.nav)));
    content.querySelectorAll('[data-action="upload"]').forEach((button) => button.addEventListener("click", () => $("#quick-upload").click()));
  }

  function bindUpload() {
    const input = $("#quick-upload");
    if (!input) return;
    input.addEventListener("change", async () => {
      if (!input.files?.[0]) return;
      const form = new FormData();
      form.append("document", input.files[0]);
      try {
        const result = await api("/api/vouchers/upload", { method: "POST", body: form });
        toast("Đã nhận chứng từ. AI đang trích xuất dữ liệu; vui lòng kiểm tra trước khi duyệt.");
        await navigate("vouchers");
        if (result.voucherId) setTimeout(() => void navigate(activePage), 2500);
      } catch (error) {
        toast(error.message, true);
      } finally {
        input.value = "";
      }
    });
  }

  function logout(show = true) {
    token = "";
    currentUser = null;
    if (show) toast("Bạn đã đăng xuất.");
    showAuth();
  }

  $("#auth-switch").addEventListener("click", () => {
    registerMode = !registerMode;
    $("#register-fields").classList.toggle("hidden", !registerMode);
    $("#auth-heading").innerHTML = registerMode
      ? '<span class="eyebrow">BẮT ĐẦU CÙNG NOVABOOKS</span><h2>Tạo không gian</h2><p>Thiết lập doanh nghiệp riêng trong vài phút.</p>'
      : '<span class="eyebrow">CHÀO MỪNG TRỞ LẠI</span><h2>Đăng nhập</h2><p>Truy cập không gian kế toán doanh nghiệp của bạn.</p>';
    $("#auth-submit").innerHTML = registerMode ? 'Tạo tài khoản <span>→</span>' : 'Đăng nhập <span>→</span>';
    $("#auth-switch-label").textContent = registerMode ? "Đã có tài khoản?" : "Chưa có tài khoản?";
    $("#auth-switch").textContent = registerMode ? "Đăng nhập" : "Tạo doanh nghiệp";
    $("#auth-password").autocomplete = registerMode ? "new-password" : "current-password";
    $("#auth-password").minLength = registerMode ? 12 : 1;
    $("#auth-error").classList.add("hidden");
  });

  $("#auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#auth-submit");
    button.disabled = true;
    $("#auth-error").classList.add("hidden");
    try {
      const endpoint = registerMode ? "/api/auth/register" : "/api/auth/login";
      const payload = {
        email: $("#auth-email").value.trim(),
        password: $("#auth-password").value
      };
      if (registerMode) {
        Object.assign(payload, {
          fullName: $("#auth-name").value.trim(),
          companyName: $("#company-name").value.trim(),
          tenantSlug: $("#tenant-slug").value.trim()
        });
      }
      let result;
      try {
        result = await api(endpoint, { method: "POST", body: JSON.stringify(payload) });
      } catch (error) {
        if (error.memberships?.length) {
          const choice = await showFormDialog({
            title: "Chọn doanh nghiệp",
            description: "Tài khoản thuộc nhiều doanh nghiệp. Chọn không gian làm việc cần đăng nhập.",
            fields: [{
              name: "tenantId",
              label: "Doanh nghiệp",
              type: "select",
              required: true,
              options: error.memberships.map((item) => ({
                value: item.tenantId,
                label: item.tenantName || item.tenantId
              }))
            }],
            confirmLabel: "Tiếp tục"
          });
          if (!choice) throw error;
          result = await api(endpoint, { method: "POST", body: JSON.stringify({ ...payload, tenantId: choice.tenantId }) });
        } else {
          throw error;
        }
      }
      token = result.token;
      const me = await api("/api/auth/me");
      showApp(me);
    } catch (error) {
      $("#auth-error").textContent = error.message;
      $("#auth-error").classList.remove("hidden");
    } finally {
      button.disabled = false;
    }
  });

  $("#logout").addEventListener("click", () => logout());
  $("#main-nav").addEventListener("click", (event) => {
    const button = event.target.closest("[data-page]");
    if (button && !button.classList.contains("hidden")) void navigate(button.dataset.page);
  });

  $("#tenant-slug").addEventListener("input", (event) => {
    event.target.value = event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  });
})();
