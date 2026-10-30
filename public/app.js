(() => {
  "use strict";

  let token = "";
  let currentUser = null;
  let registerMode = false;
  let activePage = "overview";
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

  function statusLabel(status) {
    return ({
      received: "Đã tiếp nhận", extracting: "Đang trích xuất", needs_review: "Chờ duyệt",
      approved: "Đã duyệt", posted: "Đã ghi sổ", rejected: "Đã từ chối",
      failed: "Cần xử lý", active: "Đang hoạt động", disabled: "Đã tắt", error: "Lỗi kết nối"
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

  async function renderVouchers() {
    const result = await api("/api/vouchers");
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
      const note = decision === "reject" ? window.prompt("Lý do từ chối (không bắt buộc):") : "";
      if (decision === "reject" && note === null) return;
      button.disabled = true;
      try {
        await api(`/api/vouchers/${encodeURIComponent(button.dataset.id)}/review`, {
          method: "POST", body: JSON.stringify({ decision, note: note || undefined })
        });
        toast(decision === "approve" ? "Đã duyệt và ghi sổ chứng từ." : "Đã từ chối chứng từ.");
        await navigate("vouchers");
      } catch (error) {
        toast(error.message, true);
        button.disabled = false;
      }
    }));
    content.querySelectorAll("[data-edit-voucher]").forEach((button) => button.addEventListener("click", () => {
      void editVoucherFromPrompt(items.find((item) => item.id === button.dataset.editVoucher));
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

  async function editVoucherFromPrompt(voucher) {
    if (!voucher) return;
    const data = voucher.extracted_data || {};
    const fields = [
      ["supplierName", "Nhà cung cấp", data.supplierName ?? ""],
      ["invoiceNumber", "Số hóa đơn", voucher.invoice_number ?? ""],
      ["invoiceDate", "Ngày hóa đơn (YYYY-MM-DD)", voucher.invoice_date ?? ""],
      ["currency", "Tiền tệ (mã 3 ký tự)", voucher.currency ?? ""],
      ["subtotal", "Tiền trước thuế", voucher.subtotal ?? ""],
      ["taxAmount", "Tiền thuế", voucher.tax_amount ?? ""],
      ["totalAmount", "Tổng tiền", voucher.total_amount ?? ""]
    ];
    const updates = {};
    for (const [key, label, initial] of fields) {
      const value = window.prompt(`${label} (để trống để xóa):`, String(initial));
      if (value === null) return;
      updates[key] = value.trim() === "" ? null : value.trim();
    }
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

  async function renderEntries() {
    const result = await api("/api/entries");
    const rows = result.entries;
    content.innerHTML = `${heading("Sổ sách", "Các bút toán đã ghi sổ và được liên kết với chứng từ gốc.")}<section class="panel">${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Số bút toán</th><th>Ngày</th><th>Nội dung</th><th>Phát sinh Nợ</th><th>Trạng thái</th></tr></thead><tbody>${rows.map((entry) => `<tr><td><strong>${escapeHtml(entry.entry_number)}</strong></td><td>${escapeHtml(new Date(entry.entry_date).toLocaleDateString("vi-VN"))}</td><td>${escapeHtml(entry.description)}</td><td>${money(entry.debit_total, entry.currency)}</td><td>${statusPill(entry.status)}</td></tr>`).join("")}</tbody></table></div>` : empty("Chưa có bút toán", "Bút toán xuất hiện sau khi chứng từ được duyệt.")}</section>`;
    bindCommon();
  }

  async function renderSuppliers() {
    const result = await api("/api/suppliers");
    content.innerHTML = `${heading("Nhà cung cấp", "Danh mục riêng của doanh nghiệp, không chia sẻ với tenant khác.", currentUser.role !== "staff" ? '<button class="button button-primary" data-action="add-supplier">＋ Thêm nhà cung cấp</button>' : "")}
      <section class="panel">${result.suppliers.length ? `<div class="table-wrap"><table><thead><tr><th>Mã</th><th>Tên nhà cung cấp</th><th>Mã số thuế</th><th>Email</th></tr></thead><tbody>${result.suppliers.map((item) => `<tr><td>${escapeHtml(item.code)}</td><td><strong>${escapeHtml(item.name)}</strong></td><td>${escapeHtml(item.tax_id || "—")}</td><td>${escapeHtml(item.email || "—")}</td></tr>`).join("")}</tbody></table></div>` : empty("Chưa có nhà cung cấp", "Thêm danh mục để quản lý đối tác kế toán.")}</section>`;
    bindCommon();
    const action = content.querySelector('[data-action="add-supplier"]');
    if (action) action.addEventListener("click", () => {
      const code = window.prompt("Mã nhà cung cấp:");
      if (!code) return;
      const name = window.prompt("Tên nhà cung cấp:");
      if (!name) return;
      void api("/api/suppliers", { method: "POST", body: JSON.stringify({ code, name }) })
        .then(() => { toast("Đã thêm nhà cung cấp."); void navigate("suppliers"); })
        .catch((error) => toast(error.message, true));
    });
  }

  async function renderProducts() {
    const result = await api("/api/products");
    content.innerHTML = `${heading("Hàng hóa & dịch vụ", "Danh mục riêng của doanh nghiệp dùng khi đối chiếu chứng từ.", '<button class="button button-primary" data-action="add-product">＋ Thêm mặt hàng</button>')}
      <section class="panel">${result.products.length ? `<div class="table-wrap"><table><thead><tr><th>Mã</th><th>Tên hàng hóa/dịch vụ</th><th>Đơn vị</th><th>Đơn giá</th><th>Thuế suất</th></tr></thead><tbody>${result.products.map((item) => `<tr><td>${escapeHtml(item.code)}</td><td><strong>${escapeHtml(item.name)}</strong></td><td>${escapeHtml(item.unit || "—")}</td><td>${money(item.default_unit_price, item.currency)}</td><td>${item.tax_rate == null ? "—" : `${escapeHtml(item.tax_rate)}%`}</td></tr>`).join("")}</tbody></table></div>` : empty("Danh mục đang trống", "Thêm hàng hóa hoặc dịch vụ để quản lý tập trung.")}</section>`;
    bindCommon();
    content.querySelector('[data-action="add-product"]').addEventListener("click", async () => {
      const code = window.prompt("Mã hàng hóa/dịch vụ:");
      if (!code) return;
      const name = window.prompt("Tên hàng hóa/dịch vụ:");
      if (!name) return;
      const unit = window.prompt("Đơn vị tính (không bắt buộc):") || undefined;
      const price = window.prompt("Đơn giá (để trống nếu chưa có):") || undefined;
      try {
        await api("/api/products", {
          method: "POST",
          body: JSON.stringify({ code, name, unit, defaultUnitPrice: price, currency: currentUser.default_currency || "VND" })
        });
        toast("Đã thêm hàng hóa/dịch vụ.");
        await navigate("products");
      } catch (error) { toast(error.message, true); }
    });
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
      if (!window.confirm("Tắt kênh này? Kênh sẽ không nhận webhook mới.")) return;
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
      const email = window.prompt("Email của người đã đăng ký NovaBooks:");
      if (!email) return;
      const role = window.prompt("Vai trò: accountant hoặc staff", "accountant");
      if (!["accountant", "staff"].includes(role)) return toast("Vai trò không hợp lệ.", true);
      try {
        await api("/api/members", { method: "POST", body: JSON.stringify({ email, role }) });
        toast("Đã thêm thành viên.");
        await navigate("members");
      } catch (error) { toast(error.message, true); }
    });
    content.querySelectorAll("[data-remove-member]").forEach((button) => button.addEventListener("click", async () => {
      if (!window.confirm("Gỡ thành viên này khỏi doanh nghiệp?")) return;
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
          const picked = window.prompt(
            `Tài khoản thuộc nhiều doanh nghiệp. Nhập mã tenant cần dùng:\n${error.memberships.map((item) => item.tenantId).join("\n")}`
          );
          if (!picked) throw error;
          result = await api(endpoint, { method: "POST", body: JSON.stringify({ ...payload, tenantId: picked.trim() }) });
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
