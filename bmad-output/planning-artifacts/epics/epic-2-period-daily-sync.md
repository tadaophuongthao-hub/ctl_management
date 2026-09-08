# Epic 2: Phân kỳ dữ liệu và đồng bộ báo cáo theo ngày

## Story 2.1 — Chọn kỳ bắt buộc
Given ứng dụng vừa mở, when chưa chọn tháng/năm, then người dùng không thể bắt đầu nhập liệu.

## Story 2.2 — Tách dữ liệu theo tháng
Given kỳ 08/2026 và 09/2026 có dữ liệu khác nhau, when đổi kỳ, then mọi màn hình chỉ hiển thị dữ liệu đúng kỳ.

## Story 2.3 — Đồng bộ báo cáo theo ngày
Given đã chọn kỳ và một ngày thuộc kỳ, when bấm đồng bộ, then các dòng đúng ngày được tạo; đồng bộ lại giữ dữ liệu xe/cont/vendor/ghi chú có key còn tồn tại.

## Story 2.4 — Import Excel list cont
Given file `.xlsx` có đúng 4 cột, when xem trước, then hệ thống phân loại dòng hợp lệ/lỗi; when xác nhận, then chỉ các dòng hợp lệ được map vào booking của kỳ.

## Story 2.5 — Điều hướng Ant Design
Given ứng dụng được mở, when dùng sidebar, then ba nhóm Khai báo/Kế hoạch/Báo cáo mở/đóng và chuyển đúng 6 màn hình.
