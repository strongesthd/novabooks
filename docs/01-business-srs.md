# NovaBooks — Tài liệu nghiệp vụ và SRS

**Phiên bản:** 1.0

**Trạng thái:** Bản nền tảng — phạm vi Bước 1
**Ngôn ngữ:** Tiếng Việt

## 1. Tổng quan sản phẩm

NovaBooks là nền tảng SaaS B2B giúp doanh nghiệp tiếp nhận chứng từ từ nhiều kênh, trích xuất dữ liệu hóa đơn bằng Gemini Vision, yêu cầu người có thẩm quyền kiểm tra trước khi ghi sổ, và nhận báo cáo cuối ngày dưới dạng văn bản/giọng nói. Mỗi doanh nghiệp là một tenant với dữ liệu, cấu hình kênh, thành viên và sổ sách tách biệt.

### 1.1 Mục tiêu

- Giảm nhập liệu thủ công nhưng không tự động ghi sổ khi chưa được phê duyệt.
- Hỗ trợ nhiều doanh nghiệp trên cùng nền tảng mà không làm lộ dữ liệu chéo tenant.
- Định tuyến chứng từ, yêu cầu duyệt và báo cáo đúng cấu hình Telegram Bot hoặc Zalo OA của tenant.
- Lưu vết nguồn chứng từ, kết quả AI, quyết định phê duyệt và các thay đổi quan trọng.
- Cho phép mở rộng sang nhiều loại chứng từ, quy tắc kế toán và kênh tiếp nhận.

### 1.2 Ngoài phạm vi của bản đầu

- Thay thế hệ thống ERP/kế toán tổng hợp hoặc tự khai thuế.
- Tự động phát hành hóa đơn điện tử.
- Tự phê duyệt và tự ghi sổ dựa trên kết quả AI mà không có người kiểm tra.
- Hỗ trợ tùy biến bảng quyền hoàn toàn tự do theo từng tenant; bản đầu dùng các vai trò chuẩn.

## 2. Mô hình kinh doanh và ranh giới tenant

- **Tenant:** một doanh nghiệp/đơn vị thuê bao; sở hữu cấu hình, thành viên, nhà cung cấp, hàng hóa, chứng từ, bút toán và nhật ký riêng.
- **Gói dịch vụ:** xác định giới hạn người dùng, dung lượng, số chứng từ/tháng, kênh tích hợp và thời hạn dùng. Gói/hạn thuê bao không được dùng làm cơ chế phân quyền dữ liệu.
- **Tài khoản người dùng:** danh tính đăng nhập toàn hệ thống. Một tài khoản có thể là thành viên của nhiều tenant; mọi thao tác nghiệp vụ phải có tenant đang hoạt động và membership hợp lệ.
- **Kênh tích hợp:** mỗi cấu hình Telegram/Zalo thuộc đúng một tenant. Bí mật kết nối được mã hóa, không trả về trình duyệt và không ghi vào log.
- **Đơn vị thời gian:** báo cáo dùng múi giờ cấu hình của tenant; thời điểm lưu trong DB dùng `timestamptz` theo UTC.

## 3. Vai trò và quyền hạn (RBAC)

| Vai trò | Chứng từ | Ghi sổ | Thành viên/kênh/cấu hình | Báo cáo |
|---|---|---|---|---|
| Tenant Admin | Xem, sửa, duyệt, từ chối | Xem và ghi sổ/đảo bút toán theo chính sách | Quản lý tenant, gói hiển thị, thành viên và kênh | Xem và cấu hình gửi |
| Accountant | Xem, sửa trường trích xuất, duyệt/từ chối | Tạo/xem bút toán; không quản trị tenant | Không quản lý bí mật/kênh hoặc quyền thành viên | Xem báo cáo kế toán |
| Staff | Gửi và xem trạng thái chứng từ do mình gửi | Không ghi sổ | Không truy cập cấu hình tenant | Không xem báo cáo tài chính tổng hợp |

**Nguyên tắc:** quyền luôn được kiểm tra đồng thời theo danh tính, membership, tenant hiện hành và hành động. Không suy ra quyền từ `tenant_id` do client gửi. Bản đầu yêu cầu ít nhất một Tenant Admin hoạt động trong mỗi tenant; thao tác xóa/khóa chủ sở hữu cuối cùng phải bị từ chối.

## 4. Quy trình nghiệp vụ chính

### 4.1 Đăng ký và cấu hình tenant

1. Người dùng đăng ký tài khoản và tạo tenant.
2. Nền tảng tạo tenant, membership Tenant Admin và cấu hình mặc định trong một quy trình có tính nguyên tử/idempotent.
3. Admin mời thành viên; lời mời gắn với tenant, thời hạn và vai trò.
4. Admin kết nối Telegram Bot hoặc Zalo OA; hệ thống xác thực quyền kết nối, mã hóa credential, lưu định danh tài khoản và cấu hình đích gửi.
5. Tenant chỉ được xử lý nghiệp vụ khi trạng thái thuê bao cho phép; trạng thái thuê bao không xóa dữ liệu.

### 4.2 Tiếp nhận và trích xuất chứng từ

1. Webhook nhận sự kiện từ kênh đã đăng ký; xác minh chữ ký/secret, tìm cấu hình kênh và tenant, kiểm tra trạng thái tenant/kênh.
2. Xác thực loại và kích thước tệp, MIME thực tế, giới hạn tần suất; tải tệp vào object storage riêng tư. Không lưu nội dung tệp trong log.
3. Ghi sự kiện idempotent và tạo `temp_voucher` trạng thái `received`.
4. Worker xử lý bất đồng bộ, gửi ảnh/PDF phù hợp tới Gemini Vision; chỉ yêu cầu dữ liệu theo JSON Schema đã định nghĩa.
5. Lưu kết quả có phiên bản schema, model, thời điểm, độ tin cậy và cảnh báo; trạng thái chuyển sang `needs_review`. Lỗi được ghi rõ và có thể retry có giới hạn.
6. Gửi thông báo duyệt đến nhóm/đích nội bộ đã cấu hình của đúng tenant. Thông báo không chứa bí mật và hạn chế dữ liệu nhạy cảm; liên kết duyệt phải xác thực lại.

### 4.3 Human-in-the-loop và ghi sổ

1. Accountant/Admin mở chứng từ, đối chiếu ảnh gốc và dữ liệu AI, sửa trường sai.
2. Người duyệt xác nhận hoặc từ chối kèm lý do. Lưu người duyệt, thời gian, phiên bản dữ liệu và audit log.
3. Chỉ chứng từ ở trạng thái `approved` mới được ghi sổ; ghi sổ và đổi trạng thái phải nằm trong cùng transaction.
4. Bút toán phải cân bằng Nợ/Có theo đơn vị tiền tệ, tham chiếu chứng từ và không được ghi trùng. Bút toán đã ghi sổ không bị sửa/xóa trực tiếp; điều chỉnh bằng bút toán đảo/điều chỉnh có audit.

### 4.4 Báo cáo cuối ngày và TTS

1. Scheduler xác định tenant đang hoạt động và đến giờ chạy theo múi giờ riêng.
2. Với từng tenant, worker mở transaction/context tenant riêng và tính tổng từ bút toán đã ghi sổ trong ngày kế toán.
3. Tạo bản tổng hợp văn bản; nếu tenant bật TTS, chuyển văn bản đã lọc dữ liệu nhạy cảm thành âm thanh.
4. Gửi tới đích Telegram/Zalo đã cấu hình; lưu kết quả gửi và mã lỗi để retry idempotent.
5. Một tenant lỗi không làm dừng các tenant khác. Báo cáo không được lấy dữ liệu từ tenant khác hoặc từ chứng từ chưa ghi sổ.

## 5. Yêu cầu chức năng

| ID | Yêu cầu |
|---|---|
| FR-01 | Tạo, đọc và cập nhật tenant theo quyền platform/tenant; tenant có trạng thái thuê bao, gói, thời hạn, múi giờ và tiền tệ mặc định. |
| FR-02 | Đăng nhập và quản lý membership theo vai trò Tenant Admin, Accountant, Staff; cho phép một user tham gia nhiều tenant. |
| FR-03 | Mọi API nghiệp vụ xác định tenant từ JWT đã xác thực và membership đang hoạt động; từ chối tenant ID không thuộc membership. |
| FR-04 | Admin cấu hình, kiểm tra, bật/tắt và xoay vòng Telegram Bot/Zalo OA credentials của tenant. |
| FR-05 | Webhook xác thực nguồn gửi, ánh xạ định danh kênh đến đúng tenant và chống xử lý sự kiện trùng. |
| FR-06 | Nhận ảnh/PDF trong giới hạn cấu hình; lưu object storage riêng tư và metadata tenant-scoped. |
| FR-07 | Gọi Gemini Vision với schema cấu trúc; lưu dữ liệu trích xuất, lỗi, model/schema version và dấu vết xử lý. |
| FR-08 | Cho phép Staff theo dõi chứng từ mình gửi; Accountant/Admin xem chứng từ thuộc tenant theo quyền. |
| FR-09 | Hỗ trợ sửa, duyệt, từ chối và yêu cầu xử lý lại; kiểm tra chuyển trạng thái hợp lệ phía server. |
| FR-10 | Chỉ chứng từ được duyệt mới được ghi thành bút toán; chống ghi trùng và lưu lịch sử kiểm toán. |
| FR-11 | Quản lý nhà cung cấp và sản phẩm theo tenant; mã định danh duy nhất trong phạm vi tenant. |
| FR-12 | Tổng hợp báo cáo theo ngày/múi giờ tenant và gửi văn bản/giọng nói tới đúng đích nội bộ. |
| FR-13 | Ghi nhật ký tác nhân, hành động, đối tượng, thời gian, request/correlation ID và kết quả; loại trừ secret và dữ liệu nhạy cảm không cần thiết. |
| FR-14 | Admin có thể cấu hình retention; xóa/ẩn danh dữ liệu theo chính sách và nghĩa vụ lưu trữ kế toán áp dụng. |

## 6. Yêu cầu phi chức năng và bảo mật

- **NFR-01 Cô lập tenant:** mọi bảng nghiệp vụ có `tenant_id`; ràng buộc khóa ngoại ghép; PostgreSQL RLS là lớp bảo vệ bổ sung bắt buộc. Không chỉ dựa vào quy ước ở repository.
- **NFR-02 Fail closed:** thiếu/sai tenant context, membership bị thu hồi, tenant/kênh bị khóa hoặc xác minh webhook thất bại phải dừng xử lý.
- **NFR-03 Giao dịch:** đặt tenant context bằng `SET LOCAL`/`set_config(..., true)` bên trong transaction; không dùng session setting rò rỉ qua connection pool.
- **NFR-04 Bí mật:** mã hóa credential ở tầng ứng dụng bằng KMS/envelope encryption; chỉ lưu ciphertext và key version; secret webhook lưu hash khi có thể; không log token/PII.
- **NFR-05 Tệp:** object private, truy cập qua URL ký ngắn hạn; giới hạn kích thước/định dạng; quét malware và kiểm tra nội dung trước xử lý.
- **NFR-06 AI:** xem kết quả AI là dữ liệu đề xuất, không phải sự thật kế toán; validate schema, số tiền/ngày/tiền tệ và cho phép người dùng đối chiếu ảnh.
- **NFR-07 Khả dụng và phục hồi:** webhook trả ACK sau khi ghi nhận bền vững; xử lý nặng qua queue; retry có backoff, dead-letter và idempotency key.
- **NFR-08 Hiệu năng:** truy vấn tenant-scoped có index bắt đầu bằng `tenant_id`; đo p95 cho API và thời gian xử lý theo kích thước tệp trước khi chốt SLA.
- **NFR-09 Audit:** audit log append-only cho vai trò ứng dụng; hạn chế quyền đọc; không cho phép sửa/xóa bởi account runtime thông thường.
- **NFR-10 Tuân thủ:** xác định chính sách lưu trữ chứng từ, dữ liệu cá nhân, vị trí lưu trữ và xử lý yêu cầu xóa theo quy định áp dụng tại thị trường triển khai.

## 7. Quy tắc nghiệp vụ và tiêu chí nghiệm thu

1. Không truy vấn, sửa, duyệt hoặc tải chứng từ nếu tenant context không hợp lệ.
2. Một webhook event có cùng provider event ID trong cùng channel chỉ tạo tối đa một lần xử lý nghiệp vụ.
3. Một tenant không thể tham chiếu channel, supplier, product, voucher hoặc entry của tenant khác; DB từ chối bằng khóa ngoại ghép/RLS.
4. Chứng từ chưa được duyệt không tạo bút toán; từ chối phải có trạng thái và tác nhân lưu lại.
5. Không cho phép chuyển trạng thái trái state machine hoặc duyệt bởi membership đã bị khóa.
6. Mỗi bút toán ghi sổ phải cân bằng; lặp lại yêu cầu ghi sổ không tạo entry trùng.
7. Scheduler xử lý từng tenant độc lập; kiểm chứng bằng test với hai tenant có cùng ngày và dữ liệu khác nhau.
8. Test bảo mật phải xác nhận truy vấn trực tiếp dưới DB role ứng dụng không đọc/ghi được hàng tenant khác kể cả khi code bỏ sót filter.

## 8. Giả định cần xác nhận trước production

- Telegram/Zalo là các kênh đầu tiên; quyền gửi tin, quy trình xác minh OA, giới hạn API và kiểu chữ ký webhook cần đối chiếu theo tài khoản/ứng dụng thực tế.
- Bản đầu chỉ hỗ trợ hóa đơn/chứng từ mua vào; danh mục trường trích xuất và quy tắc thuế cần được kế toán nghiệp vụ duyệt.
- Lưu trữ tệp dùng object storage private tương thích S3; retention mặc định cần chốt theo quy định và hợp đồng khách hàng.
- Quy tắc kế toán, tài khoản Nợ/Có, tiền tệ, làm tròn và bút toán điều chỉnh cần được định nghĩa trước khi bật ghi sổ production.
- Chỉ rõ nhà cung cấp TTS và khu vực xử lý dữ liệu; không đưa dữ liệu cá nhân không cần thiết vào nội dung đọc.
- RPO/RTO, SLA, hạn mức tenant, billing và quy trình xóa tenant chưa được chốt trong yêu cầu ban đầu.
