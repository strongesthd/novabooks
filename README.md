# NovaBooks

NovaBooks là MVP SaaS B2B giúp doanh nghiệp tiếp nhận chứng từ, dùng Gemini Vision trích xuất dữ liệu, yêu cầu người có thẩm quyền kiểm tra trước khi ghi sổ và gửi báo cáo cuối ngày. Giao diện hiện hỗ trợ tiếng Việt; ứng dụng dùng Node.js/TypeScript, Express và PostgreSQL.

## Chạy local

### Yêu cầu

- Node.js 20+ (đã kiểm tra với Node 22)
- Docker Desktop có Docker Compose
- API key Gemini để bật trích xuất AI; tài khoản Telegram/Zalo và ElevenLabs là tùy chọn

### Khởi động

```powershell
Copy-Item .env.example .env
```

Tạo secret local bằng Node.js rồi cập nhật `.env`:

```powershell
node -e "console.log('JWT_SECRET=' + require('node:crypto').randomBytes(48).toString('base64url')); console.log('ENCRYPTION_KEY=' + require('node:crypto').randomBytes(32).toString('hex'))"
```

Sao chép giá trị được in vào `.env`, sau đó:

```powershell
npm install
docker compose up -d postgres
docker compose run --build --rm migrate
npm run dev
```

Mở `http://localhost:3000`. Migration được theo dõi trong `schema_migrations`, chạy theo thứ tự và an toàn khi deploy lại. **Không xóa volume có dữ liệu thật để chạy lại migration.** DB runtime dùng user riêng không có `BYPASSRLS`; tài khoản admin chỉ được migration container sử dụng.

`docker-compose.yml` dành cho local, có fallback password chỉ để phát triển. Không dùng fallback này trong production.

## Deploy tự động lên books.novatechhp.vn

Workflow `.github/workflows/deploy.yml` triển khai khi push vào `main` hoặc chạy thủ công:

1. Cài package, kiểm tra type/build/test/dependency audit.
2. Tạo gói release sạch, tải qua SCP tới VPS.
3. Chạy `docker-compose.prod.yml` tại release riêng dưới `/home/app/novabooks/releases/<run-id>-<attempt>`.
4. Chạy migration có version, khởi động container app sau PostgreSQL.
5. Cài cấu hình Nginx có rollback khi lỗi; lần đầu tự xin chứng thư Let's Encrypt qua webroot.
6. Kiểm tra dashboard và API HTTPS nội bộ trước khi hoàn tất.

### Chuẩn bị một lần trên VPS

- Ubuntu/Debian server có Docker Engine + Compose plugin, Nginx, Certbot (`certbot`), `curl`, `tar`; tạo user deploy `app`, cho vào nhóm `docker`.
- Bật SSH, mở TCP 80/443, tạo DNS cho hostname ứng dụng trỏ tới VPS (mặc định `books.novatechhp.vn`). Chỉ khai báo `AAAA` nếu IPv6 đã được định tuyến tới VPS. Với Cloudflare, để bản ghi DNS-only trong lần đầu xin chứng thư để HTTP-01 truy cập được; có thể bật proxy sau khi origin TLS hoạt động.
- Tạo `/home/app/novabooks/.env` từ [`deploy/production.env.example`](./deploy/production.env.example), sinh `DB_ADMIN_PASSWORD`, `DB_PASSWORD` (khác nhau, chỉ gồm ký tự URL-safe), `JWT_SECRET` (ít nhất 32 ký tự ngẫu nhiên) và `ENCRYPTION_KEY` (32 byte biểu diễn bằng 64 ký tự hex). Đặt quyền `chmod 600` và owner phù hợp. Không commit file này.
- Tạo `/var/www/certbot` và thư mục `/etc/letsencrypt/renewal-hooks/deploy`.
- Bảo đảm `app` có thể chạy Docker và các lệnh Nginx/Certbot không tương tác. Cấu hình `sudoers` có giới hạn cho `install`, `cp`, `rm`, `ln`, `nginx -t`, `systemctl reload nginx`, `certbot certonly` và `mkdir`; không cấp `NOPASSWD: ALL`.

### GitHub Actions secrets

Trong repository, tạo environment **`novabooks-production`** và thêm 4 secrets bắt buộc:

| Secret | Giá trị |
|---|---|
| `VPS_HOST` | Host/IP máy chủ |
| `VPS_USER` | User SSH deploy (thường là `app`) |
| `VPS_SSH_PORT` | Cổng SSH |
| `VPS_SSH_KEY` | Private key SSH của deploy user |

`APP_DOMAIN` là GitHub Environment variable tùy chọn (không phải secret), mặc định `books.novatechhp.vn`; hãy đặt giá trị này nếu dùng hostname khác. Workflow chỉ cài Nginx vhost cho hostname cấu hình, không ghi đè các vhost khác. Certbot đăng ký không kèm email, nên sẽ không có email nhắc gia hạn. Reviewers/branch protection có thể cấu hình trong GitHub Environment. Không đặt SSH secrets trong YAML, commit hay application `.env`.

### Kiểm tra sau khi cấu hình

Push vào `main` sẽ chạy CI và deploy. Khi hoàn tất, kiểm tra:

```text
https://books.novatechhp.vn/
https://books.novatechhp.vn/api/health
```

Health API cần trả `{"status":"ok","service":"novabooks"}`. Tích hợp Telegram/Zalo webhook chỉ dùng được sau khi cấu hình Bot/OA credentials trong UI. Nếu cần bật AI/TTS, đặt `GEMINI_API_KEY`, `TTS_API_KEY`, `TTS_VOICE_ID` trong file VPS `.env` rồi deploy lại.

PostgreSQL chỉ nằm trên Docker network, không publish ra Internet. `DB_ADMIN_PASSWORD` chỉ dùng container migration/DB initialization; ứng dụng chạy bằng role `novabooks` có RLS, không phải owner/superuser. Volume DB/tệp tồn tại qua các release. Sao lưu và kiểm thử khôi phục volume trước khi đưa dữ liệu thật vào.

### Cấu hình Gemini và TTS

- `GEMINI_API_KEY`: bật trích xuất hóa đơn với Gemini Structured Output. Thiếu API key thì voucher sẽ chuyển sang trạng thái lỗi rõ ràng, không tự tạo dữ liệu giả.
- `TTS_API_KEY`, `TTS_VOICE_ID`: bật tổng hợp ElevenLabs và gửi voice qua Telegram. Zalo OA hiện nhận bản tin dạng văn bản.
- `DAILY_REPORT_CRON`: thời gian gửi theo giờ địa phương của từng tenant, định dạng `phút giờ * * *` (ví dụ `0 18 * * *`).

### Nhập sổ cái Excel và định khoản hóa đơn

- Mở **Sổ sách → Tải mẫu Excel** để lấy workbook `.xlsx` chuẩn. Mỗi dòng là một tài khoản trong một bút toán; lặp lại số bút toán cho các dòng liên quan. Tổng Nợ/Có phải cân bằng cho từng bút toán.
- **Nhập sổ Excel** sẽ kiểm tra dữ liệu, báo trùng số bút toán trước khi nhập, rồi nhập sổ lịch sử và lấy danh mục tài khoản theo tenant trong cùng transaction. Chỉ nhập dữ liệu lịch sử đã đối soát; các bút toán nhập được ghi trạng thái đã hạch toán và không chỉnh sửa/xóa được.
- Sau khi nhập, mở **Cấu hình tài khoản** để chọn mặc định cho Chi phí/Hàng mua, Thuế GTGT đầu vào và Phải trả nhà cung cấp. Khi duyệt từng hóa đơn, kế toán có thể xác nhận hoặc đổi tài khoản riêng cho chứng từ đó.
- Danh sách hàng hóa và nhà cung cấp có tìm kiếm, lọc trạng thái và phân trang; có thể sửa hoặc lưu trữ/khôi phục. Lưu trữ giữ nguyên liên kết và lịch sử chứng từ, không xóa cứng dữ liệu.
- Bút toán đã hạch toán là bất biến, không hỗ trợ sửa/xóa trực tiếp. Dùng **Lập bút toán đảo** để tạo bút toán đối ứng vào ngày hiện tại; bút toán gốc được giữ nguyên và mỗi bút toán gốc chỉ được đảo một lần.
- Excel là nguồn dữ liệu do doanh nghiệp cung cấp; NovaBooks không tự suy diễn danh mục hay ánh xạ tài khoản. Hãy kiểm tra kỹ mapping với kế toán trưởng trước khi duyệt.

### Quản lý kho theo workbook nhập - xuất - tồn

- Mở **Quản lý kho → Tải mẫu** để tải workbook 5 sheet: `Tổng Quan (Dashboard)`, `Sổ Nhật Ký XNT`, `Báo Cáo Tồn Kho`, `Danh Mục Vật Tư` và `Cấp Phát Thợ`. Header nằm ở hàng 4, dữ liệu bắt đầu từ hàng 5. Có thể nhập trực tiếp workbook theo cấu trúc này; đây là luồng kho riêng, không dùng importer sổ kế toán Nợ/Có.
- Khi nhập, chọn **ngày hiệu lực của tồn đầu kỳ** trong sheet `Báo Cáo Tồn Kho`. Mã vật tư mới được tạo cùng số dư, mức tồn tối thiểu, phân loại, đơn vị, vị trí và ghi chú. Mã đã tồn tại giữ nguyên danh mục/số dư hiện có; nhật ký hoặc phiếu cấp phát trùng được bỏ qua. Preview báo số lượng được thêm, giao dịch bị bỏ qua và lỗi trước khi ghi dữ liệu.
- Nhật ký tồn được tính từ tồn đầu kỳ cộng giao dịch nhập/trả/điều chỉnh tăng trừ xuất sản xuất/cấp phát/điều chỉnh giảm. Nhập kho từ workbook bị chặn nếu giao dịch trước ngày tồn đầu kỳ, ghi lùi quá nhật ký đã có hoặc khiến tồn âm. Số dư đầu kỳ là bất biến; dùng giao dịch điều chỉnh thay vì sửa số dư.
- Khi duyệt hóa đơn OCR, kế toán có thể ghép từng dòng hàng với một vật tư và xác nhận số lượng/thành tiền. Chỉ dòng đã ghép mới tăng tồn, đồng thời ghi Nợ tài khoản hàng tồn kho (cấu hình tại **Sổ sách → Cấu hình tài khoản**) trong cùng transaction với bút toán và trạng thái duyệt. Dòng không ghép không tự cộng tồn và vẫn được ghi theo tài khoản chi phí/hàng mua.
- **Ghi nhập/xuất** hỗ trợ nhập mua, xuất sản xuất, thu hồi và điều chỉnh; giao dịch xuất không thể làm tồn âm và nhật ký đã ghi không sửa/xóa. **Cấp phát dụng cụ** tạo phiếu riêng, trừ tồn; xác nhận thu hồi sẽ thêm giao dịch nhập và giữ lịch sử cấp phát. Sheet mẫu không có ngày thu hồi nên trạng thái “Đã thu hồi” khi import chỉ lưu lịch sử cấp phát; cần có dòng thu hồi tương ứng trong nhật ký XNT để cập nhật tồn. Vật tư chỉ được lưu trữ khi tồn bằng 0, không còn phiếu cấp phát đang mở.
- **Xuất Excel** tạo workbook cùng 5 sheet với giá trị hiện tại (không phụ thuộc Excel tính lại công thức). Công thức có kết quả lưu sẵn được đọc từ giá trị đã lưu; công thức không có kết quả lưu sẵn và loại giao dịch chưa hỗ trợ sẽ bị từ chối, không tự đoán số liệu.
- Tồn kho, vật tư, giao dịch, cấp phát và các lượt nhập đều được phân tách theo `tenant_id` bằng RLS. Excel chỉ là phương tiện nhập/xuất; dữ liệu PostgreSQL theo tenant là nguồn sự thật sau khi nhập.

## Tích hợp Telegram

1. Tạo Bot qua BotFather và thêm Bot vào nhóm nhận chứng từ/báo cáo.
2. Cấu hình Chat ID và Bot token trong **Kết nối kênh**. Token được mã hóa AES-256-GCM trước khi lưu.
3. Telegram yêu cầu URL HTTPS có thể truy cập từ Internet. Cấu hình `APP_BASE_URL` bằng domain HTTPS trước khi kết nối; `localhost` chỉ dùng để chạy giao diện, không nhận được webhook công khai.
4. Khi kết nối thành công, NovaBooks đăng ký webhook kèm secret token và chỉ chấp nhận tin từ Chat ID đã cấu hình.

## Tích hợp Zalo OA

1. Nhập OA ID, access token, app secret và ID người nhận bản tin.
2. Cấu hình webhook OA trỏ tới URL hiện trong giao diện; URL chứa route key ngẫu nhiên và chỉ hiển thị sau khi tạo channel.
3. Endpoint hiện xác minh chữ ký HMAC-SHA256 trong `X-ZEvent-Signature` với dạng `mac=<hex>` trên raw request body. Cần xác nhận header/signature theo phiên bản Zalo OA đang dùng trước khi triển khai thật.
4. Nhận ảnh có URL nguồn phải HTTPS và host nằm dưới `zalo.me`, `zadn.vn` hoặc `zaloapp.com`; redirect bị từ chối để giảm nguy cơ SSRF.

## Tài khoản và phân quyền

- Đăng ký tạo tenant mới cùng Tenant Admin đầu tiên.
- Đăng nhập dùng email/mật khẩu; mật khẩu hash bằng bcrypt.
- User có thể thuộc nhiều tenant. API yêu cầu tenant ID đã được membership xác nhận; JWT hết hạn sau 8 giờ.
- Admin thêm user đã đăng ký NovaBooks vào tenant với vai trò Accountant hoặc Staff. Workflow email invitation chưa có trong MVP.
- Staff gửi và theo dõi chứng từ; Accountant/Admin duyệt hoặc từ chối. Duyệt tạo bút toán cân bằng theo mapping mẫu hiện tại.

## Bảo mật và ranh giới dữ liệu

- Bảng nghiệp vụ tenant-scoped dùng `tenant_id`, composite foreign key và PostgreSQL RLS.
- Mọi transaction nghiệp vụ thiết lập `app.tenant_id` bằng `set_config(..., true)` trên đúng transaction; không dùng session setting trong connection pool.
- API kết nối bằng role `novabooks` không phải owner/superuser và không có `BYPASSRLS`. Cấu hình production phải giữ điều kiện này.
- Tệp lưu private trên filesystem tại `UPLOAD_DIR`, không được static-serve. Local filesystem chưa thay thế object storage bền vững/riêng tư cho production.
- Credential Telegram/Zalo được mã hóa bằng key từ `ENCRYPTION_KEY`; tuyệt đối không commit `.env` hoặc dùng một key ở nhiều môi trường.
- Kết quả AI là gợi ý; người duyệt phải đối chiếu chứng từ gốc. Hệ thống không thay thế tư vấn kế toán/thuế.

## Kiểm tra

```powershell
npm run typecheck
npm test
npm run build
npm audit
```

## Phạm vi MVP và việc còn cần trước production

- Kế toán dùng mapping mẫu Chi phí/Hàng mua, Thuế GTGT đầu vào và Phải trả nhà cung cấp. Cần thay bằng chart of accounts, quy tắc thuế/tiền tệ và nghiệp vụ đã được kế toán xác nhận.
- Upload hiện lưu file local; cần object storage private, malware scanning, retention/backup và presigned download URL.
- Cần thêm email invitation, phục hồi mật khẩu, MFA, queue/outbox bền vững và dead-letter queue.
- Cần kiểm thử chữ ký thực tế từ Zalo, privacy/retention, giới hạn API, quyền Bot/OA, quota và TTS ở tenant staging.
- Chưa có bảo đảm exactly-once cho gửi tin bên ngoài; report_runs/idempotency giảm trùng nội bộ nhưng provider timeout có thể không xác định tin đã gửi hay chưa.
