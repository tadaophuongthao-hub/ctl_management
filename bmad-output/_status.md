# Container Planner — BMAD status

- [2026-09-07] Giai đoạn 0: Xác định đây là phần mềm nội bộ, một người dùng, chạy local; ưu tiên đơn giản, offline và không phát sinh chi phí hosting.
- [2026-09-07] Giai đoạn 1: Dùng BRD v0.3 làm nguồn yêu cầu chính; áp dụng fast path và ghi rõ các giả định còn mở.
- [2026-09-07] Giai đoạn 2: Giữ phong cách Ant Design hiện tại; chuẩn hóa độ rộng cột và dùng SVG EditOutlined/DeleteOutlined từ kho ant-design-icons chính thức.
- [2026-09-07] Giai đoạn 3: Giữ kiến trúc Python stdlib + SQLite + HTML/CSS/JavaScript thuần để chạy trực tiếp trên Windows/macOS.
- [2026-09-07] Giai đoạn 4-5: Chia phạm vi sửa thành UI bảng/icon, sửa lỗi bố cục, sửa lọc báo cáo và kiểm thử hồi quy; Readiness Gate = PASS.
- [2026-09-07] Giai đoạn 6: Hoàn tất stories 1.1-1.4; không đổi schema và không làm mất dữ liệu hiện có.
- [2026-09-07] Giai đoạn 7: QC đạt — cú pháp Python/JavaScript/HTML hợp lệ, 24 assertion tự động đạt, kiểm tra trực quan xác nhận icon, 8 cột Module 5 và bộ lọc Module 6; sửa lỗi UTC khiến khoảng tháng lệch một ngày ở múi giờ Việt Nam.
- [2026-09-07] Giai đoạn 8: Epic 1 được chấp nhận; Import/Export Excel tiếp tục để mở vì BRD chưa chốt định dạng file (Q-2).
- [2026-09-07] Correct Course: Người dùng chốt tách dữ liệu theo kỳ tháng, chọn ngày trước khi đồng bộ Báo cáo sản lượng, import Excel list cont có xem trước và không ghi dòng lỗi.
- [2026-09-07] Architecture: Thêm `period` cho xe/tuyến/booking; container kế thừa kỳ từ booking; `daily_syncs` và `daily_detail_rows` kiểm soát đồng bộ từng ngày. Migration cộng thêm và có backup database.
- [2026-09-07] UX: Sidebar đổi sang menu inline kiểu Ant Design với ba nhóm Khai báo/Kế hoạch/Báo cáo; MonthPicker toàn cục và DatePicker ngày cho Báo cáo sản lượng.
- [2026-09-07] Build/QA Epic 2: Hoàn tất migration, phân kỳ, đồng bộ ngày, sao chép tháng trước và import Excel 4 cột. Kiểm thử migration/API/Excel/UI đạt.
