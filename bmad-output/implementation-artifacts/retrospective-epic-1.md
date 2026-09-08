# Retrospective — Epic 1

## Việc đã làm tốt

- Giữ nguyên kiến trúc local-first và schema dữ liệu theo AD-1/AD-3.
- NFR-9/NFR-10 được hiện thực bằng độ rộng cột, cuộn ngang và SVG Ant Design chạy offline.
- QC trình duyệt phát hiện cột “Cont thứ” bị thiếu sau lần sửa đầu; lỗi được sửa và kiểm tra lại đủ 8 cột.
- Log API khi QC phát hiện bộ lọc tháng dùng UTC và lệch một ngày ở Việt Nam; đã thay bằng định dạng ngày địa phương.

## Việc nên làm khác đi

- Lần thay đổi tiếp theo nên có test UI tự động đếm số `th`/`td` cho từng bảng để bắt lỗi lệch cột sớm hơn.

## Ảnh hưởng tới epic tiếp theo

- Import/Export Excel chưa nên code khi Q-2 trong BRD chưa có mẫu cột và quy tắc xử lý lỗi.
- Cần chốt Q-3 trước khi thay đổi hành vi xóa cứng hiện tại.

## Quyết định

Epic 1 hoàn tất và có thể sử dụng. Không có migration dữ liệu.
