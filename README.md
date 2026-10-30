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

## Deploy tự động lên novabooks.novatechhp.vn

Workflow `.github/workflows/deploy.yml` triển khai khi push vào `main` hoặc chạy thủ công:

1. Cài package, kiểm tra type/build/test/dependency audit.
2. Tạo gói release sạch, tải qua SCP tới VPS.
3. Chạy `docker-compose.prod.yml` tại release riêng dưới `/home/app/novabooks/releases/<run-id>-<attempt>`.
4. Chạy migration có version, khởi động container app sau PostgreSQL.
5. Cài cấu hình Nginx có rollback khi lỗi; lần đầu tự xin chứng thư Let's Encrypt qua webroot.
6. Kiểm tra dashboard và API HTTPS nội bộ trước khi hoàn tất.

### Chuẩn bị một lần trên VPS

- Ubuntu/Debian server có Docker Engine + Compose plugin, Nginx, Certbot (`certbot`), `curl`, `tar`; tạo user deploy `app`, cho vào nhóm `docker`.
- Bật SSH, mở TCP 80/443, DNS `A novabooks.novatechhp.vn` trỏ tới địa chỉ IPv4 máy chủ. Chỉ khai báo `AAAA` nếu IPv6 đã được định tuyến tới VPS.
- Tạo `/home/app/novabooks/.env` từ [`deploy/production.env.example`](./deploy/production.env.example), sinh `DB_ADMIN_PASSWORD`, `DB_PASSWORD` (khác nhau, chỉ gồm ký tự URL-safe), `JWT_SECRET` (ít nhất 32 ký tự ngẫu nhiên) và `ENCRYPTION_KEY` (32 byte biểu diễn bằng 64 ký tự hex). Đặt quyền `chmod 600` và owner phù hợp. Không commit file này.
- Tạo `/var/www/certbot` và thư mục `/etc/letsencrypt/renewal-hooks/deploy`.
- Bảo đảm `app` có thể chạy Docker và các lệnh Nginx/Certbot không tương tác. Cấu hình `sudoers` có giới hạn cho `install`, `cp`, `rm`, `ln`, `nginx -t`, `systemctl reload nginx`, `certbot certonly` và `mkdir`; không cấp `NOPASSWD: ALL`.
- (Tùy chọn) Cấu hình SSH host fingerprint để xác minh máy chủ trong CI.

### GitHub Actions secrets

Trong repository, tạo environment **`novabooks-production`** và thêm 4 secrets bắt buộc:

| Secret | Giá trị |
|---|---|
| `VPS_HOST` | Host/IP máy chủ |
| `VPS_USER` | User SSH deploy (thường là `app`) |
| `VPS_SSH_PORT` | Cổng SSH |
| `VPS_SSH_KEY` | Private key SSH của deploy user |

`VPS_FINGERPRINT` là secret tùy chọn để pin SSH host fingerprint. `LETSENCRYPT_EMAIL` là GitHub Environment variable tùy chọn (không phải secret); nếu không đặt, Certbot vẫn cấp chứng thư nhưng không có email nhắc gia hạn. Reviewers/branch protection có thể cấu hình trong GitHub Environment. Không đặt SSH secrets trong YAML, commit hay application `.env`.

### Kiểm tra sau khi cấu hình

Push vào `main` sẽ chạy CI và deploy. Khi hoàn tất, kiểm tra:

```text
https://novabooks.novatechhp.vn/
https://novabooks.novatechhp.vn/api/health
```

Health API cần trả `{"status":"ok","service":"novabooks"}`. Tích hợp Telegram/Zalo webhook chỉ dùng được sau khi cấu hình Bot/OA credentials trong UI. Nếu cần bật AI/TTS, đặt `GEMINI_API_KEY`, `TTS_API_KEY`, `TTS_VOICE_ID` trong file VPS `.env` rồi deploy lại.

PostgreSQL chỉ nằm trên Docker network, không publish ra Internet. `DB_ADMIN_PASSWORD` chỉ dùng container migration/DB initialization; ứng dụng chạy bằng role `novabooks` có RLS, không phải owner/superuser. Volume DB/tệp tồn tại qua các release. Sao lưu và kiểm thử khôi phục volume trước khi đưa dữ liệu thật vào.

### Cấu hình Gemini và TTS

- `GEMINI_API_KEY`: bật trích xuất hóa đơn với Gemini Structured Output. Thiếu API key thì voucher sẽ chuyển sang trạng thái lỗi rõ ràng, không tự tạo dữ liệu giả.
- `TTS_API_KEY`, `TTS_VOICE_ID`: bật tổng hợp ElevenLabs và gửi voice qua Telegram. Zalo OA hiện nhận bản tin dạng văn bản.
- `DAILY_REPORT_CRON`: thời gian gửi theo giờ địa phương của từng tenant, định dạng `phút giờ * * *` (ví dụ `0 18 * * *`).

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
