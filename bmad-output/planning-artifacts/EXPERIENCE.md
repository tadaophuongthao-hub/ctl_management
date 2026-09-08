# User Experience

## Màn hình chính

Giữ nguyên 6 màn hình của BRD. Trạng thái rỗng, dữ liệu và lỗi API tiếp tục dùng thông báo tiếng Việt.

## Hành vi chỉnh sửa bảng

- Bấm icon bút chì: focus ô nhập liệu đầu tiên của đúng dòng và chọn nội dung để sửa nhanh.
- Bấm icon thùng rác: thực hiện hành vi xóa hiện có của đúng dòng.
- Bấm Tab/Shift+Tab vẫn di chuyển qua các ô nhập liệu theo chuẩn trình duyệt.
- Bộ lọc Module 6 tải lại dữ liệu theo ngày/xe/từ khóa thay vì chỉ lọc phần đã có trên DOM.

## Kỳ làm việc và điều hướng

- Mỗi lần mở ứng dụng phải chọn tháng/năm; toàn bộ 6 màn hình dùng cùng kỳ.
- Sidebar kiểu Ant Design gồm ba nhóm mở/đóng: Khai báo, Kế hoạch, Báo cáo.
- Báo cáo sản lượng yêu cầu chọn một ngày thuộc kỳ rồi mới cho đồng bộ dữ liệu ngày.
- Import Excel container luôn có bước xem trước lỗi trước khi xác nhận ghi dữ liệu.
