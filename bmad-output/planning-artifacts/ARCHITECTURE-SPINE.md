# Architecture Spine

## Design Paradigm

Ứng dụng local 3 lớp gọn: SQLite (`data.db`) → HTTP/API (`server.py`) → giao diện tĩnh (`static/`).

## Invariants & Rules

### AD-1 — Local-first, không phụ thuộc Internet khi vận hành
- Binds: backend, frontend, cách dùng icon.
- Prevents: ứng dụng hỏng khi mất mạng hoặc cần cài package frontend.
- Rule: tài nguyên cốt lõi và SVG icon phải được nhúng/lưu cục bộ.

### AD-2 — Quy tắc nghiệp vụ nằm ở backend
- Binds: BR-1..BR-11 và API.
- Prevents: frontend/backend tính khác nhau.
- Rule: frontend chỉ hiển thị và gửi thao tác; phép tính phân tách và dữ liệu liên kết do `server.py` quyết định.

### AD-3 — Migration bảo toàn dữ liệu
- Binds: SQLite schema.
- Prevents: người dùng mất dữ liệu khi cập nhật giao diện.
- Rule: migration chỉ thêm cột/bảng, gán dữ liệu cũ vào kỳ suy ra từ ngày booking và tạo backup trước khi chạy trên database thật.

### AD-4 — Phân vùng dữ liệu theo kỳ
- Binds: Xe, Tuyến, Booking, Container và Báo cáo.
- Prevents: dữ liệu tháng 8 và tháng 9 bị hiển thị hoặc ghi lẫn nhau.
- Rule: mọi API nghiệp vụ bắt buộc nhận `period` dạng `YYYY-MM`; container lấy kỳ qua booking.

### AD-5 — Báo cáo chỉ xuất hiện sau đồng bộ ngày
- Binds: Báo cáo sản lượng và dữ liệu phân công.
- Prevents: người dùng nhập lên dữ liệu của sai ngày hoặc dữ liệu chưa chốt.
- Rule: mỗi ngày phải có bản ghi đồng bộ; đồng bộ lại thay danh sách dòng nguồn nhưng giữ override xe/cont/vendor/ghi chú có cùng key.

## Consistency Conventions

| Mối quan tâm | Quy ước |
|---|---|
| ID | Chuỗi ổn định do backend tạo |
| Ngày | API dùng ISO `YYYY-MM-DD`, UI hiển thị tiếng Việt |
| Lỗi | API trả JSON `{error}`; UI hiển thị toast |
| Icon | SVG Ant Design nhúng inline, `currentColor`, có nhãn truy cập |

## Stack

| Tên | Phiên bản |
|---|---|
| Python | 3.x có `http.server` và `sqlite3` |
| SQLite | Bản đi kèm Python |
| HTML/CSS/JavaScript | Chuẩn trình duyệt hiện hành, không build step |

## Deferred

- Soft-delete/lịch sử: chờ quyết định Q-3 trong BRD.
- Đóng gói thành file cài đặt: để sau khi bản local ổn định.
