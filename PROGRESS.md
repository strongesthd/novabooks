# PROJECT PROGRESS & HANDOVER LOG

## 1. MỤC TIÊU HIỆN TẠI (Current Goal)
- [x] Hoàn thiện source code MVP NovaBooks: backend TypeScript/PostgreSQL multi-tenant, xác thực/RBAC, chứng từ và duyệt, Telegram/Zalo, Gemini/TTS có cấu hình, dashboard web và kiểm thử.
- [x] Xây module kho theo workbook `Quan_Ly_Kho_va_Dung_Cu_Xuong.xlsx`: nhập danh mục/số dư/nhật ký, theo dõi tồn theo tenant, đối chiếu OCR và ghi phiếu nhập sau duyệt.
- [ ] Triển khai NovaBooks trên hostname riêng `books.novatechhp.vn`; giữ nguyên Twenty CRM tại `novabooks.novatechhp.vn`.

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
- [x] Commit `bd09769` và push thành công lên `origin/main`.
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
- [x] GitHub CI pass trên `bc94c40`; commit handover `3280d6c` đã push.
- [x] Xác nhận với chủ sở hữu: DNS domain trỏ đúng VPS, nhưng không được thay site Twenty CRM hiện tại tại `novabooks.novatechhp.vn`.
- [x] Chủ sở hữu chọn hostname riêng `books.novatechhp.vn`; DNS công khai đã phân giải qua Cloudflare, chưa thể xác nhận origin từ các IP proxy.
- [x] Cấu hình deploy theo `APP_DOMAIN` (mặc định `books.novatechhp.vn`), render Nginx/Let's Encrypt/health checks theo hostname và giữ nguyên vhost `novabooks.novatechhp.vn`.
- [x] Kiểm thử `npm test` (10/10), production Compose config, frontend syntax, `git diff --check` và cú pháp Bash deploy đều pass.
- [x] Commit/push cấu hình `71cd769`; GitHub Actions run `41172953836` dừng trước deploy do audit báo 8 cảnh báo moderate trong `minimatch`.
- [x] Thêm npm override `minimatch ^11.0.1`; `npm audit --audit-level=moderate` sạch và toàn bộ 10 tests/build đều pass.
- [x] Commit/push dependency fix `802d608`; GitHub Actions run `41173151625` verify job đã pass.
- [ ] Theo dõi deploy job của run `41173151625` (đang queued) và xác nhận dashboard mới qua HTTPS; nếu DNS origin chưa trỏ đúng VPS, deploy có thể thất bại an toàn trước khi đổi vhost CRM.
- [ ] Chạy API/RLS end-to-end test khi có PostgreSQL local; migration runner production báo schema đã up to date.
- [ ] Nếu doanh nghiệp có workbook khác template NovaBooks, lấy file đã ẩn dữ liệu nhạy cảm để bổ sung mapping cột.
- [ ] Task hiện tại: kiểm thử và triển khai NovaBooks lên hostname riêng `books.novatechhp.vn`, không ảnh hưởng site hiện tại.

### Lượt cấu hình hostname production riêng
- [x] Đọc `.ai/runs/copilot-instructions.md`, giữ nguyên workbook untracked của người dùng.
- [x] Thay domain hardcode bằng `APP_DOMAIN` trong deploy, Compose, Nginx và README; mặc định dùng `books.novatechhp.vn`.
- [x] Đảm bảo workflow chỉ quản lý site/cert của hostname cấu hình; `novabooks.novatechhp.vn` không còn là target deploy.
- [x] Xác nhận `books.novatechhp.vn` có DNS public (Cloudflare proxy); origin chưa thể xác nhận độc lập qua DNS.
- [x] Kiểm thử build/test, Compose, Bash syntax, frontend và whitespace thành công.
- [x] Push cấu hình `71cd769`; phát hiện GitHub Actions audit block do dependency cũ của ExcelJS kéo `minimatch` bị cảnh báo.
- [x] Dùng npm override patched `minimatch@11.0.3` không đổi ExcelJS major; test Excel round-trip và 10 unit tests vẫn pass, audit 0 vulnerabilities.
- [x] Push audit fix `802d608`; workflow verify job pass.
- [ ] Kiểm tra kết quả deploy job và health endpoint của hostname mới.

### Lượt triển khai module kho
- [x] Đọc hướng dẫn `.ai/runs/copilot-instructions.md`, giữ nguyên workbook mẫu đang có trong worktree và xác nhận luồng Nợ/Có không phù hợp cho nhật ký nhập-xuất-tồn.
- [x] Tạo parser workbook riêng, hỗ trợ danh mục, số dư đầu kỳ, nhật ký XNT và cấp phát dụng cụ; từ chối công thức/ô dữ liệu không hợp lệ.
- [x] Tạo migration kho tenant-scoped với RLS, chỉ mục, chống nhập/ghi trùng và quyền append-only cho giao dịch.
- [x] Thêm API danh mục/tồn kho/giao dịch/cấp phát, import-preview/import có chống nhập trùng và xuất workbook 5 sheet; các thao tác ghi tồn chạy trong transaction tenant.
- [x] Khi duyệt OCR, dòng chỉ vào kho sau khi người duyệt ghép vật tư; movement, bút toán Hàng tồn kho và duyệt voucher cùng transaction.
- [x] Build TypeScript thành công sau các thay đổi parser, API và service.
- [x] Hoàn thiện UI danh mục/tồn kho, giao dịch, cấp phát/thu hồi, import preview/import, export/template; thêm ghép dòng OCR và mapping tài khoản hàng tồn kho.
- [x] Thêm test cho workbook 5 sheet, round-trip export/import, công thức thiếu cached result, giao dịch không hỗ trợ và validation số lượng.
- [x] Kiểm thử parser trực tiếp trên file `Quan_Ly_Kho_va_Dung_Cu_Xuong.xlsx`: nhận 8 vật tư, 5 giao dịch và 4 phiếu cấp phát.
- [x] Thêm kiểm tra fixed-point để không ghi xuất làm tồn âm; chặn sửa số dư đầu kỳ, ghi xuất/cấp phát lùi ngày và lưu trữ vật tư còn tồn/cấp phát mở.
- [x] `npm test` pass (10/10), `node --check public/app.js`, `git diff --check` và `npm audit --audit-level=moderate` đều pass (0 lỗ hổng).
- [x] Kiểm tra trình duyệt cho trang đăng nhập/điều hướng; parser đã chạy trực tiếp trên workbook mẫu.
- [x] Deploy run `41066731477` chạy migration runner và báo database migrations up to date; chưa xác nhận API/RLS end-to-end.
- [x] Commit `bc94c40` đã push lên `main`; GitHub CI thành công.

**Files thay đổi trong lượt triển khai kho:** `src/inventory.ts`, `src/inventory-service.ts`, `src/http-error.ts`, `src/server.ts`, `src/vouchers.ts`, `src/validation.ts`, `database/migrations/008_tenant_inventory.sql`, `public/index.html`, `public/app.js`, `public/styles.css`, `tests/core.test.cjs`, `README.md`, `PROGRESS.md`.

## 5. LƯU Ý KỸ THUẬT & LỖI CẦN TRÁNH (Notes & Blockers)
- Docker Desktop hiện ở trạng thái `paused`; `docker compose up -d` không thể khởi động DB nên migration/API chưa được chạy thực tế.
- Typecheck/build, cú pháp frontend, 7 unit tests, `npm audit --audit-level=moderate` và `git diff --check` đã pass sau thay đổi CRUD/phân trang.
- GitHub Actions CI pass. Deploy runs cũ và run `41066731477` thất bại trước thông báo `NovaBooks deployment complete`. Run mới báo migrations up to date, app container started, một lần `curl (56) Connection reset by peer`, rồi `nginx -t` thành công; chưa đủ log để phân biệt lỗi HTTPS/SNI với body không khớp.
- 5 bài test hiện là unit tests không cần DB; cần bổ sung/chạy integration tests RLS trên runtime role sau khi có PostgreSQL.
- Không thể gửi Telegram/Zalo/TTS thật hoặc gọi Gemini nếu chưa có credentials; tích hợp phải fail rõ ràng, không giả lập thành công.
- Giữ RLS, transaction-scoped tenant context và membership authorization; không dựa riêng vào WHERE ở repository.
- Worker trích xuất hiện là in-process, chưa có queue/outbox bền vững; cần thay trước production. Zalo webhook signature/header cần xác nhận với phiên bản API thực tế.
- GitHub branch `main` đã nhận source; workflow cần 4 secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_SSH_PORT`. `VPS_FINGERPRINT` tùy chọn; `LETSENCRYPT_EMAIL` là variable tùy chọn.
- Chủ sở hữu xác nhận DNS `novabooks.novatechhp.vn` trỏ đúng VPS nhưng yêu cầu giữ nguyên site Twenty CRM. Không deploy lại lên hostname này nếu chưa được cho phép cutover hoặc chuyển sang hostname riêng.
- Chủ sở hữu chọn `books.novatechhp.vn`; DNS trả về Cloudflare proxy IP. Deploy dùng variable GitHub Environment `APP_DOMAIN` nếu cần đổi hostname, mặc định `books.novatechhp.vn`; chỉ cài vhost có hostname đó.
- Nhập Excel hiện theo template NovaBooks cho sổ giao dịch lịch sử và trích danh mục tài khoản; chưa xác nhận tương thích workbook thực tế của doanh nghiệp.
- Migration mới `006_ledger_accounts_and_mappings.sql` cần được chạy trên môi trường đã deploy trước khi dùng các API tài khoản/nhập Excel.