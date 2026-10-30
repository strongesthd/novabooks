# PROJECT PROGRESS & HANDOVER LOG

## 1. MỤC TIÊU HIỆN TẠI (Current Goal)
- [x] Hoàn thiện source code MVP NovaBooks: backend TypeScript/PostgreSQL multi-tenant, xác thực/RBAC, chứng từ và duyệt, Telegram/Zalo, Gemini/TTS có cấu hình, dashboard web và kiểm thử.
- [ ] Hoàn thiện dialog, CRUD mềm, tìm kiếm/phân trang cho danh mục và sổ; kiểm thử rồi push toàn bộ thay đổi đang chờ lên GitHub.

## 2. TIẾN ĐỘ THỰC HIỆN (Work Completed)
- [x] Đọc `.ai/runs/copilot-instructions.md`, PROGRESS.md và tài liệu nghiệp vụ/schema hiện có.
- [x] Xác nhận workspace chưa có ứng dụng, package manifest hay môi trường PostgreSQL.
- [x] Khởi tạo cấu trúc ứng dụng, package manifest, cấu hình môi trường và Docker Compose.
- [x] Cài đặt nền tảng TypeScript: cấu hình env, PostgreSQL transaction-scoping, mã hóa credential và Gemini Structured Output.
- [x] Triển khai API xác thực/RBAC, membership, dashboard endpoints, upload chứng từ, duyệt/ghi sổ và webhook Telegram/Zalo.
- [x] Bổ sung credential encryption, bảo vệ runtime DB role/RLS và các hàm truy vấn webhook/scheduler tối thiểu.
- [x] Hoàn thiện giao diện dashboard: xác thực/đăng ký, tổng quan, chứng từ và duyệt, sổ sách, danh mục nhà cung cấp, thành viên, kênh và báo cáo.
- [x] Bổ sung worker tổng hợp báo cáo theo tenant và timezone, gửi qua kênh cấu hình; TTS Telegram tùy chọn.
- [x] Tạo giao diện web responsive cho đăng nhập, duyệt chứng từ, sổ sách, danh mục và cấu hình doanh nghiệp.
- [x] Bổ sung xem chứng từ gốc có xác thực, sửa kết quả AI, thử lại trích xuất và audit các quyết định.
- [x] Bổ sung danh mục sản phẩm, gỡ thành viên có kiểm soát và giới hạn Staff chỉ xem chứng từ do mình gửi.
- [x] Chặn tenant hết hạn/đình chỉ và ràng buộc nhận webhook/báo cáo với trạng thái thuê bao.
- [x] Bổ sung trigger DB kiểm tra bút toán cân bằng và khóa bất biến sau ghi sổ; credential webhook được đăng ký sau khi transaction đã commit.
- [x] Giới hạn dung lượng luồng tải từ Telegram/Zalo, xác thực MIME/magic bytes và kiểm tra UUID đường dẫn API.
- [x] Bổ sung luồng khôi phục Telegram webhook khi URL cấu hình ban đầu không truy cập được; cho phép tái thêm membership đã bị gỡ.
- [x] Viết hướng dẫn local/prod, cấu hình Gemini/TTS/kênh và giới hạn MVP trong README.
- [x] Typecheck, syntax check, build và 5 bài test lõi đều thành công.
- [x] `npm audit` không phát hiện lỗ hổng dependency.
- [x] `docker compose config --quiet` hợp lệ; cổng PostgreSQL local chỉ bind localhost.
- [x] Đọc cấu trúc deploy NovaSEO: release directory, GitHub Actions SSH/SCP, Docker Compose, Nginx với rollback; xác nhận repo NovaBooks remote đang trống.
- [x] Thêm production Docker image/Compose, PostgreSQL runtime role, migration runner có tracking/advisory lock và health checks.
- [x] Thêm GitHub Actions CI/deploy, Nginx reverse proxy/HTTPS bootstrap và chứng thư Let's Encrypt cho domain NovaBooks.
- [x] Kiểm tra typecheck, build/test (5/5), cú pháp frontend, audit dependencies và Compose local/production với env mẫu.
- [x] Khởi tạo Git branch `main`, loại `.ai`/secrets khỏi source publish; push source và handover commits lên `strongesthd/novabooks`.
- [x] GitHub CI pass; deploy workflow dừng trước khi kết nối VPS do thiếu secrets `novabooks-production` (bắt đầu từ `VPS_HOST`).
- [x] Xác nhận `novabooks.novatechhp.vn` hiện đang phục vụ giao diện Twenty CRM; không tự ghi đè site hiện có khi chưa xác nhận cutover.
- [x] Điều chỉnh deploy workflow: chỉ 4 secrets SSH là bắt buộc; SSH fingerprint và email Certbot chuyển thành tùy chọn, đồng bộ README.
- [x] Thay toàn bộ `prompt/confirm` trình duyệt trong frontend bằng dialog form đồng bộ giao diện, hỗ trợ thêm/sửa nhà cung cấp, hàng hóa, thành viên, duyệt chứng từ và chọn tenant.
- [x] Xác nhận `public/app.js` không còn gọi `window.prompt/confirm/alert`; syntax check, typecheck và 5 unit tests đều pass.
- [x] Bổ sung template Excel, parser có kiểm tra ngày/số/công thức, cân bằng Nợ-Có, giới hạn dòng và preview trùng số bút toán.
- [x] Thêm migration tài khoản/mapping có RLS; API import bút toán lịch sử theo transaction, kiểm tra trùng lần nữa khi ghi và tạo audit log.
- [x] Định khoản hóa đơn mới từ mapping mặc định theo tenant; cho phép override tài khoản theo từng chứng từ và chặn ghi sổ khi thiếu cấu hình.
- [x] Cập nhật hướng dẫn nhập Excel; xác nhận frontend syntax, typecheck, build/test (7/7), `npm audit --audit-level=moderate` (0 lỗ hổng) và `git diff --check` đều pass.
- [x] Xác nhận thêm hàng hóa, cấu hình/import sổ, sửa dữ liệu chứng từ và xác nhận/từ chối đều dùng form dialog trong ứng dụng.
- [x] Bổ sung sửa/lưu trữ/khôi phục nhà cung cấp và hàng hóa; API có tenant scoping, audit log, tìm kiếm, lọc trạng thái và phân trang server-side.
- [x] Bổ sung phân trang/tìm kiếm sổ; thay sửa/xóa bút toán đã hạch toán bằng bút toán đảo bất biến có liên kết duy nhất/audit, giữ nguyên bản gốc.
- [x] Thêm test cho dữ liệu cập nhật tùy chọn/nullable; cú pháp frontend, build/typecheck, 7 tests, audit dependency và diff check đều pass.
- [ ] Gỡ hẳn tham chiếu SSH fingerprint khỏi action inputs; lần thất bại gần nhất là chạy lại attempt của workflow cũ (commit `62ec82b`), chưa dùng phiên bản mới trên `main`.
- [ ] Khởi động PostgreSQL/Docker, chạy migration và kiểm tra API end-to-end.
- [ ] Docker Desktop hiện đang paused; cần tiếp tục kiểm tra DB khi daemon hoạt động.

## 3. CÁC FILE ĐÃ CHỈNH SỬA GẦN NHẤT (Modified Files)
- `PROGRESS.md`
- `package.json`, `tsconfig.json`, `.env.example`, `docker-compose.yml`, `.gitignore`
- `database/migrations/002_auth_membership_policy.sql`
- `database/migrations/005_accounting_integrity.sql`
- `Dockerfile`, `.dockerignore`, `docker-compose.prod.yml`, `database/bootstrap/00-create-runtime-role.sh`, `src/migrate.ts`
- `deploy/nginx-novabooks-bootstrap.conf`, `deploy/nginx-novabooks.conf`, `deploy/certbot-reload-nginx.sh`, `deploy/production.env.example`
- `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`
- `src/config.ts`, `src/db.ts`, `src/crypto.ts`, `src/types.ts`, `src/validation.ts`, `src/gemini.ts`
- `src/auth.ts`, `src/channels.ts`, `src/storage.ts`, `src/vouchers.ts`, `src/reporting.ts`, `src/server.ts`
- `public/index.html`, `public/app.js`, `public/styles.css`
- Lượt hiện tại: `public/app.js`, `public/styles.css`, `src/server.ts`, `src/validation.ts`, `database/migrations/007_catalog_lifecycle_and_entry_reversals.sql`, `tests/core.test.cjs`, `README.md`, `PROGRESS.md`; cùng thay đổi nhập Excel đang chờ từ lượt trước.
- `package-lock.json`
- `README.md`, `tests/core.test.cjs`
- `.ai/runs/copilot-instructions.md` đã đọc; cập nhật trạng thái và handover tại `PROGRESS.md`.

## 4. BƯỚC TIẾP THEO CẦN LÀM NGAY (Next Immediate Steps)
- [ ] Chạy syntax/typecheck/tests/audit/build và kiểm tra diff.
- [ ] Commit các thay đổi yêu cầu và push branch `main` lên `origin`.
- [ ] Sau khi deploy, áp dụng migrations 006-007; kiểm tra API trên PostgreSQL thật khi Docker hoạt động.
- [ ] Nếu doanh nghiệp có workbook khác template NovaBooks, lấy file đã ẩn dữ liệu nhạy cảm để bổ sung mapping cột.

## 5. LƯU Ý KỸ THUẬT & LỖI CẦN TRÁNH (Notes & Blockers)
- Docker Desktop hiện ở trạng thái `paused`; `docker compose up -d` không thể khởi động DB nên migration/API chưa được chạy thực tế.
- Typecheck/build, cú pháp frontend, 7 unit tests, `npm audit --audit-level=moderate` và `git diff --check` đã pass sau thay đổi CRUD/phân trang.
- 5 bài test hiện là unit tests không cần DB; cần bổ sung/chạy integration tests RLS trên runtime role sau khi có PostgreSQL.
- Không thể gửi Telegram/Zalo/TTS thật hoặc gọi Gemini nếu chưa có credentials; tích hợp phải fail rõ ràng, không giả lập thành công.
- Giữ RLS, transaction-scoped tenant context và membership authorization; không dựa riêng vào WHERE ở repository.
- Worker trích xuất hiện là in-process, chưa có queue/outbox bền vững; cần thay trước production. Zalo webhook signature/header cần xác nhận với phiên bản API thực tế.
- GitHub branch `main` đã nhận source; workflow cần 4 secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_SSH_PORT`. `VPS_FINGERPRINT` tùy chọn; `LETSENCRYPT_EMAIL` là variable tùy chọn.
- DNS trả về Cloudflare proxy addresses; trang hiện tại là Twenty CRM. Deploy workflow sẽ thay cấu hình Nginx cùng hostname, nên cần chủ sở hữu xác nhận trước khi cutover.
- Nhập Excel hiện theo template NovaBooks cho sổ giao dịch lịch sử và trích danh mục tài khoản; chưa xác nhận tương thích workbook thực tế của doanh nghiệp.
- Migration mới `006_ledger_accounts_and_mappings.sql` cần được chạy trên môi trường đã deploy trước khi dùng các API tài khoản/nhập Excel.