# Container Planner — Quản lý Kế hoạch Phân xe Container & Booking

Phần mềm chạy **hoàn toàn local trên máy bạn**, không cần Internet, không tốn phí hosting
(đúng NFR-1/NFR-2/NFR-3 trong BRD). Dữ liệu lưu trong 1 file SQLite duy nhất (`data.db`).

## Yêu cầu duy nhất: Python 3.8 trở lên

Không cần cài thêm bất kỳ thư viện nào khác (`pip install` gì cả) — toàn bộ backend chỉ
dùng các module có sẵn trong Python (`http.server`, `sqlite3`, `json`).

Kiểm tra máy đã có Python chưa:
```bash
python3 --version      # Mac/Linux
python --version       # Windows
```
Nếu chưa có, tải tại: https://www.python.org/downloads/ (khi cài trên Windows, nhớ tích
vào ô "Add Python to PATH").

## Cách chạy

**Mac/Linux:**
```bash
cd container-app
python3 server.py
```

**Windows:**
```bat
cd container-app
python server.py
```

Hoặc bấm đúp vào `run.sh` (Mac/Linux) / `run.bat` (Windows).

Server sẽ tự mở trình duyệt tại `http://localhost:8765`. Nếu trình duyệt không tự mở,
tự vào địa chỉ đó.

Khi mở ứng dụng, hãy chọn **Kỳ làm việc (tháng/năm)**. Tất cả màn hình chỉ hiển thị
dữ liệu của kỳ đã chọn. Ở **Báo cáo sản lượng**, chọn thêm một ngày rồi bấm
**Đồng bộ dữ liệu ngày này** trước khi phân xe/container.

## Import Excel danh sách container

Vào **Khai báo → Khai báo list cont**, chọn **Import Excel**. Worksheet đầu tiên phải
có đúng 4 cột theo thứ tự: `Book/Bill`, `Số cont`, `Loại cont`, `Số seal`.
Ứng dụng sẽ xem trước số dòng hợp lệ/lỗi; chỉ ghi dữ liệu khi bạn bấm xác nhận.
Loại cont hợp lệ: `20DC`, `40DC`, `40HC`, `45HC`.

Để dừng: quay lại cửa sổ dòng lệnh, nhấn `Ctrl + C`.

## Dữ liệu của bạn nằm ở đâu

Toàn bộ dữ liệu (xe, tuyến đường, booking, cont...) nằm trong file `data.db` cùng thư mục
với `server.py`. File này tự được tạo ra ở lần chạy đầu tiên, kèm sẵn vài dòng dữ liệu mẫu
để bạn xem quen mắt — xóa hết đi và nhập dữ liệu thật của bạn vào là dùng được ngay.

**Sao lưu dữ liệu:** chỉ cần copy file `data.db` sang nơi khác (USB, Google Drive...).
**Phục hồi dữ liệu:** chép file `data.db` đã sao lưu đè lại vào thư mục này.
**Làm lại từ đầu:** xóa file `data.db`, chạy lại `server.py`, hệ thống tự tạo file mới.

## Cấu trúc dự án

```
container-app/
├── server.py          ← toàn bộ backend (API + toàn bộ quy tắc nghiệp vụ BR-1..BR-11)
├── static/
│   ├── index.html     ← giao diện (6 màn hình theo BRD)
│   └── app.js         ← logic frontend, gọi API để đọc/ghi dữ liệu
├── data.db            ← cơ sở dữ liệu (tự tạo khi chạy lần đầu)
├── run.sh / run.bat    ← script chạy nhanh
└── README.md           ← file này
```

## Những gì đã cài đặt đúng theo BRD (bản 0.3)

- **6 module** đúng thứ tự: Khai báo xe → Chuyến đi tháng này → Khai báo tuyến đường →
  Kế hoạch phân công → Khai báo list cont → Chi tiết Báo cáo.
- **BR-1 → BR-11**: toàn bộ quy tắc nghiệp vụ nằm ở `server.py`, không lặp lại ở frontend
  — tự tính Phân tách (BR-3), tự đồng bộ số dòng cont theo Số lượng (BR-5), tự điền Loại
  cont/Seal theo Số cont (BR-6), tự điền Tuyến đường/Tiền lương ở Chi tiết Báo cáo
  (BR-10/FR-6.2.1/6.2.2), tự loại trừ cont đã chọn ở dòng khác cùng booking (BR-11).
- **Chọn hàng loạt + xóa (BR-8)** và **dán nhiều dòng từ Excel vào 1 cột (BR-9)** ở
  Module 1, 3, 4; Module 5 áp dụng "xóa hàng loạt" theo nghĩa xóa dữ liệu đã nhập (số
  dòng giữ cố định theo BR-5, xem ghi chú trong BRD).
- **NFR-9/NFR-10**: bố cục cột ưu tiên không gian theo độ dài nội dung; bảng dài có
  thanh cuộn ngang. Nút Sửa/Xóa từng dòng dùng SVG EditOutlined/DeleteOutlined của
  Ant Design Icons và vẫn hoạt động khi máy không có Internet.

## Giới hạn đã biết (theo đúng Open Questions trong BRD — chưa có câu trả lời nên chưa làm)

- **Q-2**: Nhập/Xuất Excel hiện chỉ là placeholder (hiện thông báo) — chưa có định dạng cột
  cụ thể để cài thật.
- **Q-3**: Xóa xe/booking hiện là xóa cứng (hard-delete), chưa làm soft-delete.
- Nút Sửa đưa con trỏ vào ô đầu tiên của dòng; dữ liệu vẫn được sửa trực tiếp trên bảng
  và tự lưu khi người dùng đổi giá trị.
