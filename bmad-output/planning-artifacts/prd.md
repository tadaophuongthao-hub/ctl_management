---
title: Container Planner — đợt hoàn thiện theo BRD v0.3
created: 2026-09-07
updated: 2026-09-07
---
# PRD: Container Planner — đợt hoàn thiện

## 0. Mục đích

Biến bản HTML hiện có thành ứng dụng local dễ dùng cho người không chuyên kỹ thuật, bám BRD v0.3 và không làm thay đổi mô hình vận hành một người dùng.

## 1. Tầm nhìn

Người dùng nhập dữ liệu xe, tuyến, booking và container một lần; hệ thống tự tái sử dụng dữ liệu để lập lịch, phân xe và tạo báo cáo. Ứng dụng chạy trên chính máy người dùng qua localhost, dữ liệu nằm trong một file SQLite.

## 2. Đối tượng và hành trình

- Người dùng chính: chủ dự án/người lập kế hoạch container.
- UJ-1: Khai báo xe và tuyến → lập booking → khai list cont → phân xe/cont → xem báo cáo chuyến.
- [ASSUMPTION] V1 phục vụ một người dùng và dữ liệu nghiệp vụ hiện tại có thể tiếp tục dùng schema SQLite sẵn có.

## 3. Thuật ngữ

- Booking/Book/Bill: lệnh vận chuyển làm nguồn tạo các dòng container.
- Phân tách: số container phân bổ theo từng ngày, ngăn cách bằng dấu `-`.
- Chi tiết báo cáo: các dòng công việc tự sinh từ booking và phân tách.

## 4. Yêu cầu đợt này

- FR-1: Mọi bảng nhập liệu phải có độ rộng cột phù hợp nội dung và không che mất chữ tiêu biểu.
- FR-2: Mỗi dòng ở Module 1, 3 và 4 có icon bút chì để đưa con trỏ vào chế độ sửa và icon thùng rác để xóa.
- FR-3: Icon dùng SVG EditOutlined/DeleteOutlined từ kho ant-design-icons chính thức và hoạt động offline.
- FR-4: Bảng Module 5 khớp chính xác giữa tiêu đề và dữ liệu; không lặp cột “Cont thứ”.
- FR-5: Bộ lọc ngày/xe/từ khóa ở Module 6 phải gọi lại API và hiển thị đúng dữ liệu đã lọc.
- FR-6: Cấu trúc HTML hợp lệ, không có thẻ đóng dư làm lệch bố cục.
- FR-7: Các quy tắc BR-1..BR-11 đã có trong code tiếp tục hoạt động sau thay đổi.

## 5. Ngoài phạm vi

- Không thêm đăng nhập, cloud hosting, nhiều người dùng hay ứng dụng mobile.
- Không thay đổi chính sách xóa cứng/soft-delete khi Q-3 trong BRD chưa được chốt.
- Không mở rộng schema ngoài nhu cầu sửa lỗi đã xác định.

## 6. Phạm vi MVP

Toàn bộ FR-1..FR-7 ở trên.

## 7. Chỉ số thành công

- 100% kiểm thử nghiệp vụ tự động đạt.
- Không có lỗi cú pháp Python/JavaScript.
- Giao diện hoạt động ở viewport tối thiểu 1366×768; bảng rộng cho phép cuộn ngang, nội dung không bị cắt kín.

## 8. Vấn đề còn mở

- Q-1: Chính sách xóa dữ liệu lịch sử vẫn theo hiện trạng xóa cứng cho đến khi người dùng quyết định khác.
- Q-2: Tần suất backup SQLite chưa được chốt.

## 9. Giả định

- [ASSUMPTION] Icon “Sửa” chỉ cần focus/chọn ô nhập đầu tiên của dòng vì bản hiện tại đã lưu trực tiếp khi thay đổi ô.
- [ASSUMPTION] Thêm dòng vẫn là nút cấp bảng; NFR-10 chỉ yêu cầu icon cho thao tác trực tiếp trên từng dòng.

