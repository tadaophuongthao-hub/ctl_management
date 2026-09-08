"""
Container Planner — Backend (Python stdlib only, không cần pip install)
=========================================================================
Kiến trúc (AD-1): chỉ dùng http.server + sqlite3 (có sẵn trong Python) để
người dùng chỉ cần cài Python 3, không cần "pip install" gì thêm.

Kiến trúc (AD-2): toàn bộ quy tắc nghiệp vụ BR-1..BR-11 trong BRD được cài
đặt Ở ĐÂY (backend) — frontend chỉ gọi API và hiển thị, không tự tính lại
để tránh lệch dữ liệu giữa 2 nơi.

Chạy: python3 server.py   (mặc định cổng 8765, tự mở trình duyệt)
"""

import base64
import hashlib
import hmac
import html
import io
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
import unicodedata
import webbrowser
import zipfile
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

try:
    from openpyxl import Workbook, load_workbook
    HAS_OPENPYXL = True
except ImportError:
    HAS_OPENPYXL = False

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "data.db")
STATIC_DIR = os.path.join(BASE_DIR, "static")
PORT = int(os.environ.get("PORT", "8765"))

# ======================================================================
# AUTH
# ======================================================================
# Mật khẩu KHÔNG lưu dạng chữ thường — chỉ lưu salt + hash PBKDF2-HMAC-SHA256
# (200,000 vòng lặp). Tài khoản: namyeuthao / Nam212@
AUTH_USERNAME = "namyeuthao"
AUTH_SALT = bytes.fromhex("f8123388120ed77ae55e6ba2c72f02b2")
AUTH_HASH = bytes.fromhex("ea360bee7cb315528b8f5e88e3ab10da0a24b7c391edf6cbd51a154c0e4d05e0")
AUTH_ITERATIONS = 200_000

SESSION_COOKIE = "cp_session"
SESSION_TTL = 12 * 3600          # 12 giờ (đăng nhập thường)
SESSION_TTL_REMEMBER = 30 * 86400  # 30 ngày (tick "Ghi nhớ đăng nhập")

MAX_LOGIN_ATTEMPTS = 5
LOGIN_LOCKOUT_SECONDS = 5 * 60

_sessions = {}          # token -> expiry epoch (giây)
_sessions_lock = threading.Lock()
_login_attempts = {}    # ip -> [số lần sai liên tiếp, khóa tới epoch]
_login_lock = threading.Lock()


def _hash_password(password):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), AUTH_SALT, AUTH_ITERATIONS)


def verify_credentials(username, password):
    username = username or ""
    password = password or ""
    # Luôn hash để tránh lộ thông tin qua thời gian phản hồi (timing attack)
    digest = _hash_password(password)
    username_ok = hmac.compare_digest(username.encode("utf-8"), AUTH_USERNAME.encode("utf-8"))
    password_ok = hmac.compare_digest(digest, AUTH_HASH)
    return username_ok and password_ok


def create_session(remember=False):
    token = secrets.token_urlsafe(32)
    ttl = SESSION_TTL_REMEMBER if remember else SESSION_TTL
    with _sessions_lock:
        _sessions[token] = (time.time() + ttl, ttl)
    return token, ttl


def destroy_session(token):
    with _sessions_lock:
        _sessions.pop(token, None)


def is_session_valid(token):
    if not token:
        return False
    with _sessions_lock:
        entry = _sessions.get(token)
        if not entry:
            return False
        expiry, ttl = entry
        if expiry < time.time():
            _sessions.pop(token, None)
            return False
        _sessions[token] = (time.time() + ttl, ttl)  # sliding expiration
        return True


def is_ip_locked(ip):
    with _login_lock:
        entry = _login_attempts.get(ip)
        return bool(entry and entry[1] > time.time())


def register_failed_login(ip):
    now = time.time()
    with _login_lock:
        count, locked_until = _login_attempts.get(ip, [0, 0])
        count += 1
        if count >= MAX_LOGIN_ATTEMPTS:
            locked_until = now + LOGIN_LOCKOUT_SECONDS
            count = 0
        _login_attempts[ip] = [count, locked_until]


def reset_login_attempts(ip):
    with _login_lock:
        _login_attempts.pop(ip, None)


# ======================================================================
# DATABASE
# ======================================================================

SCHEMA = """
CREATE TABLE IF NOT EXISTS vehicles (
    id TEXT PRIMARY KEY,
    period TEXT NOT NULL DEFAULT '2026-09',
    plate TEXT NOT NULL,
    driver TEXT NOT NULL,
    phone TEXT,
    cccd TEXT,
    rest_days INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS routes (
    id TEXT PRIMARY KEY,
    period TEXT NOT NULL DEFAULT '2026-09',
    from_point TEXT NOT NULL,
    to_point TEXT NOT NULL,
    route_group TEXT NOT NULL DEFAULT 'short',
    wage INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    period TEXT NOT NULL DEFAULT '2026-09',
    customer TEXT,
    type TEXT NOT NULL DEFAULT 'EXP',
    book_bill TEXT,
    qty INTEGER NOT NULL DEFAULT 1,
    carrier TEXT,
    from_date TEXT,
    to_date TEXT,
    cutoff TEXT,
    leg_out_vessel TEXT,
    leg_out_date TEXT,
    leg_in_vessel TEXT,
    leg_in_date TEXT,
    split TEXT,
    progress TEXT,
    route_id TEXT,
    note TEXT
);

CREATE TABLE IF NOT EXISTS containers (
    id TEXT PRIMARY KEY,
    period TEXT NOT NULL DEFAULT '2026-09',
    book_bill TEXT DEFAULT '',
    customer TEXT DEFAULT '',
    cont_no TEXT DEFAULT '',
    cont_type TEXT DEFAULT '',
    seal TEXT DEFAULT '',
    booking_id TEXT DEFAULT '',
    unit_index INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS detail_overrides (
    key TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL,
    date TEXT NOT NULL,
    unit_index INTEGER NOT NULL,
    vehicle_id TEXT DEFAULT '',
    cont_no TEXT DEFAULT '',
    vendor TEXT DEFAULT 'GRAI',
    note TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS daily_syncs (
    period TEXT NOT NULL,
    date TEXT NOT NULL,
    synced_at TEXT NOT NULL,
    PRIMARY KEY (period, date)
);

CREATE TABLE IF NOT EXISTS daily_detail_rows (
    period TEXT NOT NULL,
    date TEXT NOT NULL,
    key TEXT NOT NULL,
    PRIMARY KEY (period, date, key)
);
"""

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    first_time = not os.path.exists(DB_PATH)
    conn = get_db()
    conn.executescript(SCHEMA)
    migrate_periods(conn)
    migrate_containers_independent(conn)
    migrate_merge_leg_columns(conn)
    conn.commit()
    if first_time:
        seed_demo_data(conn)
    conn.close()


def migrate_periods(conn):
    """Migration cộng thêm, giữ nguyên dữ liệu cũ và gán vào kỳ từ ngày booking."""
    for table in ("vehicles", "routes", "bookings"):
        cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if "period" not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN period TEXT NOT NULL DEFAULT '2026-09'")
    conn.execute("UPDATE bookings SET period=substr(from_date,1,7) WHERE length(from_date)>=7")
    fallback = conn.execute("SELECT period FROM bookings WHERE period<>'' ORDER BY period DESC LIMIT 1").fetchone()
    fallback_period = fallback["period"] if fallback else datetime.now().strftime("%Y-%m")
    conn.execute("UPDATE vehicles SET period=? WHERE period='' OR period IS NULL", (fallback_period,))
    conn.execute("UPDATE routes SET period=? WHERE period='' OR period IS NULL", (fallback_period,))
    conn.execute("CREATE INDEX IF NOT EXISTS idx_vehicles_period ON vehicles(period)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_routes_period ON routes(period)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_bookings_period ON bookings(period)")
    conn.commit()


def migrate_containers_independent(conn):
    """Tách 'Khai báo list cont' khỏi 'Kế hoạch phân công': trước đây mỗi dòng cont bắt buộc
    thuộc 1 booking (booking_id) và số dòng luôn khớp Số lượng của booking. Nay list cont là
    màn độc lập — mỗi dòng tự có period/book_bill/customer riêng, biên tập/thêm/xóa tự do."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(containers)").fetchall()}
    added = False
    if "period" not in cols:
        conn.execute("ALTER TABLE containers ADD COLUMN period TEXT NOT NULL DEFAULT '2026-09'")
        added = True
    if "book_bill" not in cols:
        conn.execute("ALTER TABLE containers ADD COLUMN book_bill TEXT DEFAULT ''")
        added = True
    if "customer" not in cols:
        conn.execute("ALTER TABLE containers ADD COLUMN customer TEXT DEFAULT ''")
        added = True
    if added:
        # Dữ liệu cũ: lấy period/book_bill/customer từ booking đang liên kết (nếu còn) trước khi bỏ liên kết.
        conn.execute("""
            UPDATE containers SET
                period = COALESCE((SELECT period FROM bookings WHERE bookings.id = containers.booking_id), period),
                book_bill = COALESCE((SELECT book_bill FROM bookings WHERE bookings.id = containers.booking_id), book_bill),
                customer = COALESCE((SELECT customer FROM bookings WHERE bookings.id = containers.booking_id), customer)
            WHERE booking_id <> ''
        """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_containers_period ON containers(period)")
    conn.commit()


def migrate_merge_leg_columns(conn):
    """2 cột tàu (HPH→NSI, NSI→HPH) trước đây tách làm 2 ô: tên tàu + ngày. Nay mỗi cột chỉ còn
    1 ô text tự do, nên ghép dữ liệu cũ 'tên tàu' + 'ngày' lại thành một chuỗi để không mất
    thông tin đã nhập (VD: 'MSC ABC' + '2026-09-10' -> 'MSC ABC 10/09/2026')."""
    for vessel_col, date_col in (("leg_out_vessel", "leg_out_date"), ("leg_in_vessel", "leg_in_date")):
        rows = conn.execute(
            f"SELECT id, {vessel_col} AS vessel, {date_col} AS date FROM bookings WHERE {date_col} IS NOT NULL AND {date_col} <> ''"
        ).fetchall()
        for r in rows:
            try:
                d = date.fromisoformat(r["date"]).strftime("%d/%m/%Y")
            except ValueError:
                d = r["date"]
            merged = " ".join(x for x in [(r["vessel"] or "").strip(), d] if x)
            conn.execute(f"UPDATE bookings SET {vessel_col}=?, {date_col}='' WHERE id=?", (merged, r["id"]))
    conn.commit()


def require_period(value):
    period = (value or "").strip()
    if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", period):
        raise ValueError("Vui lòng chọn tháng/năm hợp lệ trước khi nhập liệu")
    return period


def previous_period(period):
    y, m = map(int, period.split("-"))
    return f"{y - 1:04d}-12" if m == 1 else f"{y:04d}-{m - 1:02d}"


def read_xlsx_rows(raw):
    """Đọc worksheet đầu tiên bằng stdlib để người dùng không phải pip install."""
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        shared = []
        if "xl/sharedStrings.xml" in zf.namelist():
            root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in root.findall("m:si", ns):
                shared.append("".join(t.text or "" for t in si.iterfind(".//m:t", ns)))
        sheet_names = sorted(n for n in zf.namelist() if n.startswith("xl/worksheets/sheet") and n.endswith(".xml"))
        if not sheet_names:
            raise ValueError("File Excel không có worksheet")
        root = ET.fromstring(zf.read(sheet_names[0]))
        rows = []
        for row in root.findall(".//m:sheetData/m:row", ns):
            values = {}
            for cell in row.findall("m:c", ns):
                ref = cell.get("r", "A1")
                col = re.match(r"[A-Z]+", ref).group(0)
                idx = 0
                for ch in col:
                    idx = idx * 26 + ord(ch) - 64
                typ = cell.get("t")
                if typ == "inlineStr":
                    value = "".join(t.text or "" for t in cell.iterfind(".//m:t", ns))
                else:
                    v = cell.find("m:v", ns)
                    value = v.text if v is not None else ""
                    if typ == "s" and value:
                        value = shared[int(value)]
                values[idx - 1] = str(value).strip()
            if values:
                rows.append([values.get(i, "") for i in range(max(values) + 1)])
        return rows


def _xlsx_col(index):
    """Đổi số cột 1-based thành A, B, ..., AA để tạo file Excel thuần stdlib."""
    out = ""
    while index:
        index, rem = divmod(index - 1, 26)
        out = chr(65 + rem) + out
    return out


def make_xlsx(headers, rows, sheet_name="Dữ liệu"):
    """Tạo workbook .xlsx đơn giản, tương thích Excel/LibreOffice, không cần thư viện ngoài."""
    def cell_xml(row_no, col_no, value):
        ref = f"{_xlsx_col(col_no)}{row_no}"
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return f'<c r="{ref}"><v>{value}</v></c>'
        safe = html.escape("" if value is None else str(value))
        return f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{safe}</t></is></c>'

    all_rows = [headers] + list(rows)
    sheet_rows = []
    for ri, row in enumerate(all_rows, 1):
        cells = "".join(cell_xml(ri, ci, value) for ci, value in enumerate(row, 1))
        sheet_rows.append(f'<row r="{ri}">{cells}</row>')
    widths = "".join(f'<col min="{i}" max="{i}" width="18" customWidth="1"/>' for i in range(1, len(headers) + 1))
    sheet = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
             '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
             f'<cols>{widths}</cols><sheetData>{"".join(sheet_rows)}</sheetData></worksheet>')
    safe_sheet = html.escape(sheet_name[:31] or "Dữ liệu")
    workbook = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                f'<sheets><sheet name="{safe_sheet}" sheetId="1" r:id="rId1"/></sheets></workbook>')
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
        zf.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        zf.writestr("xl/workbook.xml", workbook)
        zf.writestr("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
        zf.writestr("xl/worksheets/sheet1.xml", sheet)
    return output.getvalue()


# ---------- Định dạng hiển thị trong file Excel xuất ra ----------

def fmt_date_vn(value):
    """2026-09-07 -> 07-09-2026 (giữ nguyên nếu không phải ngày ISO)."""
    try:
        return date.fromisoformat((value or "").strip()).strftime("%d-%m-%Y")
    except ValueError:
        return value or ""


def fmt_wage(value):
    """150000 -> '150.000' (dấu chấm ngăn cách hàng nghìn theo cách viết Việt Nam)."""
    if value is None or value == "":
        return ""
    try:
        return f"{int(value):,}".replace(",", ".")
    except (TypeError, ValueError):
        return str(value)


def fmt_route(from_point, to_point):
    """Tuyến đường trong Excel dùng dấu gạch ngang: 'NSI - NSLC'."""
    if not from_point and not to_point:
        return ""
    return f"{from_point or ''} - {to_point or ''}"


def fmt_route_label(label):
    """Đổi nhãn tuyến đã dựng sẵn ('NSI → NSLC') sang dạng dùng dấu gạch ngang."""
    return (label or "").replace("→", "-")


IMPORT_HEADERS = ["Book/Bill", "Số cont", "Loại cont", "Số seal"]

# Chấp nhận nhiều cách đặt tên cột thường gặp trong file thực tế (VD: "BL/BK" thay vì "Book/Bill",
# viết hoa/thường khác nhau, có dấu hoặc không) — so khớp không phân biệt hoa/thường và dấu tiếng Việt.
IMPORT_HEADER_ALIASES = {
    "bookBill": {"book/bill", "bl/bk", "bill/book", "booking", "book bill", "so book/bill", "book", "bill", "bl", "bk"},
    "contNo": {"so cont", "cont no", "container no", "container", "so container", "so cont no"},
    "contType": {"loai cont", "cont type", "loai container", "type", "loai"},
    "seal": {"so seal", "seal", "seal no"},
}


def _normalize_header(value):
    text = str(value or "").strip().lower()
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    return re.sub(r"\s+", " ", text).strip()


def detect_import_columns(header_row):
    """Tìm vị trí 4 cột Book/Bill, Số cont, Loại cont, Số seal trong dòng tiêu đề — bỏ qua các cột
    thừa (VD: STT) và chấp nhận vài cách đặt tên khác nhau. Trả về None nếu thiếu cột nào."""
    normalized = [_normalize_header(h) for h in header_row]
    mapping = {}
    for field, aliases in IMPORT_HEADER_ALIASES.items():
        for i, h in enumerate(normalized):
            if h in aliases and i not in mapping.values():
                mapping[field] = i
                break
    if len(mapping) != 4:
        return None
    return [mapping["bookBill"], mapping["contNo"], mapping["contType"], mapping["seal"]]


def validate_container_import(conn, period, rows):
    """Khai báo list cont là màn độc lập — không còn yêu cầu Book/Bill phải khớp booking có sẵn
    hay giới hạn theo Số lượng của booking; chỉ kiểm tra dữ liệu cont hợp lệ và không trùng."""
    seen = set()
    valid, errors = [], []
    allowed = {"20DC", "40DC", "40HC", "45HC"}
    for line_no, raw in enumerate(rows, start=2):
        vals = (list(raw) + ["", "", "", ""])[:4]
        book_bill, cont_no, cont_type, seal = [str(x).strip() for x in vals]
        if not book_bill and not cont_no and not cont_type and not seal:
            continue  # dòng trống hoàn toàn (VD: dòng thừa cuối file Excel) — bỏ qua, không báo lỗi
        problems = []
        if not book_bill:
            problems.append("Book/Bill đang trống")
        if not cont_no:
            problems.append("Số cont đang trống")
        if cont_type not in allowed:
            problems.append("Loại cont phải là 20DC/40DC/40HC/45HC")
        key = cont_no.upper()
        if key in seen:
            problems.append("Số cont bị trùng trong file")
        seen.add(key)
        # Cont đã tồn tại (thuộc Book/Bill khác) sẽ được ghi đè Book/Bill mới khi xác nhận — không chặn.
        item = {"line": line_no, "bookBill": book_bill, "contNo": cont_no, "contType": cont_type, "seal": seal}
        if problems:
            item["errors"] = problems
            errors.append(item)
        else:
            valid.append(item)
    return valid, errors


def seed_demo_data(conn):
    """Dữ liệu mẫu — giống hệt bản mockup HTML trước đó, để bạn xem quen mắt."""
    conn.executemany(
        "INSERT INTO vehicles (id, plate, driver, phone, cccd, rest_days) VALUES (?,?,?,?,?,?)",
        [
            ("v1", "51D12345", "Nguyễn Văn Minh", "0901234567", "079204001234", 2),
            ("v2", "50H88821", "Trần Quốc Bảo", "0908663121", "079198002345", 5),
            ("v3", "51C50219", "Lê Hoàng Nam", "0938115778", "079203003456", 0),
        ],
    )
    conn.executemany(
        "INSERT INTO routes (id, from_point, to_point, route_group, wage) VALUES (?,?,?,?,?)",
        [
            ("r1", "Cảng Cát Lái", "KCN Sóng Thần", "short", 300000),
            ("r2", "Cảng Cát Lái", "KCN Amata", "long", 800000),
            ("r3", "ICD Phước Long", "KCN Tân Bình", "short", 250000),
        ],
    )
    conn.executemany(
        """INSERT INTO bookings (id, customer, type, book_bill, qty, carrier, from_date, to_date,
           cutoff, leg_out_vessel, leg_out_date, leg_in_vessel, leg_in_date, split, progress, route_id, note)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        [
            ("bk1", "Công ty TNHH ABC", "EXP", "BK-0906-001", 4, "ONE",
             "2026-09-07", "2026-09-09", "17:00 - 09/09/2026",
             "MSC ABC", "2026-09-10", "MSC XYZ", "2026-09-20", "2-1-1", "0/4", "r2", ""),
            ("bk2", "Công ty CP XNK Miền Nam", "IMP", "BK-0906-002", 2, "HMM",
             "2026-09-08", "2026-09-08", "—", "", "", "", "", "2", "0/2", "r1", ""),
        ],
    )
    conn.executemany(
        "INSERT INTO containers (id, booking_id, unit_index, cont_no, cont_type, seal) VALUES (?,?,?,?,?,?)",
        [
            ("bk1_0", "bk1", 0, "TCLU1234567", "40HC", "SL9988771"),
            ("bk1_1", "bk1", 1, "TCLU1234568", "40HC", "SL9988772"),
            ("bk1_2", "bk1", 2, "", "", ""),
            ("bk1_3", "bk1", 3, "", "", ""),
            ("bk2_0", "bk2", 0, "", "", ""),
            ("bk2_1", "bk2", 1, "", "", ""),
        ],
    )
    conn.executemany(
        "INSERT INTO detail_overrides (key, booking_id, date, unit_index, vehicle_id, cont_no, vendor, note) VALUES (?,?,?,?,?,?,?,?)",
        [
            ("bk1_2026-09-07_0", "bk1", "2026-09-07", 0, "v3", "TCLU1234567", "GRAI", ""),
            ("bk1_2026-09-08_0", "bk1", "2026-09-08", 0, "v1", "TCLU1234568", "GRAI", ""),
        ],
    )
    conn.commit()


# ======================================================================
# QUY TẮC NGHIỆP VỤ (BR-1 .. BR-11) — thuần Python, không phụ thuộc gì khác
# ======================================================================

def days_between_inclusive(from_str, to_str):
    if not from_str or not to_str:
        return 0
    f = date.fromisoformat(from_str)
    t = date.fromisoformat(to_str)
    diff = (t - f).days
    return diff + 1 if diff >= 0 else 0


def date_range_array(from_str, to_str):
    n = days_between_inclusive(from_str, to_str)
    if n <= 0:
        return []
    f = date.fromisoformat(from_str)
    return [(f + timedelta(days=i)).isoformat() for i in range(n)]


def compute_split(qty, days):
    """BR-3: chia đều Số lượng theo số ngày, phần dư dồn vào các ngày đầu."""
    if days <= 0 or not qty or qty <= 0:
        return []
    base, rem = divmod(qty, days)
    arr = [base] * days
    for i in range(rem):
        arr[i] += 1
    return arr


def parse_split(s):
    if not s:
        return None
    try:
        parts = [int(x.strip()) for x in str(s).split("-")]
    except ValueError:
        return None
    if any(p < 0 for p in parts):
        return None
    return parts


def vehicle_tag(rest_days):
    """BR-1: nhãn gợi ý phân công theo Số ngày nghỉ."""
    if rest_days == 0:
        return "Ưu tiên phân công"
    if rest_days >= 4:
        return "Nghỉ nhiều · phân ít chuyến"
    return "Bình thường"


def recompute_booking_split(booking_row):
    """FR-4.2/4.3: tự tính lại Phân tách nếu trống hoặc không khớp Số lượng/số ngày."""
    days = days_between_inclusive(booking_row["from_date"], booking_row["to_date"])
    qty = booking_row["qty"] or 0
    parsed = parse_split(booking_row["split"])
    valid = parsed is not None and len(parsed) == days and sum(parsed) == qty
    if valid:
        return booking_row["split"], False
    new_split = "-".join(str(x) for x in compute_split(qty, days))
    mismatched = bool(booking_row["split"]) and not valid
    return new_split, mismatched


def recompute_booking_progress(progress, qty):
    """Tiến độ luôn hiển thị theo Số lượng hiện tại: giữ nguyên phần đã hoàn thành (tử số),
    thay mẫu số bằng qty. VD sửa Số lượng 1 -> 4 thì '2/1' thành '2/4', trống thành '0/4'."""
    done = 0
    m = re.match(r"\s*(\d+)", str(progress or ""))
    if m:
        done = min(int(m.group(1)), qty)
    return f"{done}/{qty}"


def cleanup_booking_children(conn, booking_id):
    # Khai báo list cont giờ độc lập với booking (BR-5 cũ đã bỏ) — xóa booking không còn xóa theo cont.
    conn.execute("DELETE FROM detail_overrides WHERE booking_id=?", (booking_id,))
    conn.execute("DELETE FROM daily_detail_rows WHERE key LIKE ?", (booking_id + "_%",))


def cleanup_vehicle_refs(conn, vehicle_id):
    """AC-10: xóa xe -> các dòng Chi tiết đang gán xe đó trở về 'chưa chọn xe'."""
    conn.execute("UPDATE detail_overrides SET vehicle_id='' WHERE vehicle_id=?", (vehicle_id,))


def default_detail_note(booking_type):
    """Ghi chú mặc định ở Báo cáo sản lượng: hàng nhập thì RÚT HÀNG, hàng xuất thì ĐÓNG HÀNG."""
    return "RÚT HÀNG" if (booking_type or "").upper() == "IMP" else "ĐÓNG HÀNG"


def build_detail_rows(conn, filters=None):
    """FR-6.1: tự sinh đúng số dòng theo Phân tách, join Route/Container/Vehicle."""
    filters = filters or {}
    period = filters.get("period")
    bookings = conn.execute(
        "SELECT * FROM bookings WHERE period=?" if period else "SELECT * FROM bookings",
        (period,) if period else (),
    ).fetchall()
    routes = {r["id"]: r for r in conn.execute("SELECT * FROM routes").fetchall()}
    overrides = {o["key"]: o for o in conn.execute("SELECT * FROM detail_overrides").fetchall()}
    containers = {c["cont_no"]: c for c in conn.execute("SELECT * FROM containers").fetchall() if c["cont_no"]}
    vehicles = {v["id"]: v for v in conn.execute("SELECT * FROM vehicles").fetchall()}

    rows = []
    for b in bookings:
        days = date_range_array(b["from_date"], b["to_date"])
        split_arr = parse_split(b["split"])
        if split_arr is None or len(split_arr) != len(days):
            split_arr = compute_split(b["qty"] or 0, len(days))
        for di, d in enumerate(days):
            count = split_arr[di] if di < len(split_arr) else 0
            for u in range(count):
                key = f'{b["id"]}_{d}_{u}'
                ov = overrides.get(key)
                vehicle_id = ov["vehicle_id"] if ov else ""
                cont_no = ov["cont_no"] if ov else ""
                vendor = (ov["vendor"] if ov and ov["vendor"] else "GRAI")
                # Ghi chú mặc định theo loại hàng: IMP -> RÚT HÀNG, EXP -> ĐÓNG HÀNG.
                note = (ov["note"] if ov and ov["note"] else default_detail_note(b["type"]))
                route = routes.get(b["route_id"])
                cont = containers.get(cont_no)
                vehicle = vehicles.get(vehicle_id)
                rows.append({
                    "key": key, "date": d, "bookingId": b["id"], "bookBill": b["book_bill"],
                    "customer": b["customer"], "routeId": b["route_id"],
                    "routeLabel": (f'{route["from_point"]} → {route["to_point"]}' if route else None),
                    "routeGroup": route["route_group"] if route else None,
                    "wage": route["wage"] if route else None,
                    "vehicleId": vehicle_id,
                    "vehiclePlate": vehicle["plate"] if vehicle else None,
                    "vehicleDriver": vehicle["driver"] if vehicle else None,
                    "vehiclePhone": vehicle["phone"] if vehicle else None,
                    "contNo": cont_no,
                    "contType": cont["cont_type"] if cont else None,
                    "seal": cont["seal"] if cont else None,
                    "vendor": vendor, "note": note,
                })
    rows.sort(key=lambda r: r["date"])

    if filters.get("from"):
        rows = [r for r in rows if r["date"] >= filters["from"]]
    if filters.get("to"):
        rows = [r for r in rows if r["date"] <= filters["to"]]
    if filters.get("vehicleId"):
        rows = [r for r in rows if r["vehicleId"] == filters["vehicleId"]]
    if filters.get("q"):
        q = filters["q"].lower()
        rows = [r for r in rows if q in (r["bookBill"] or "").lower() or q in (r["customer"] or "").lower()]
    return rows


# ======================================================================
# JSON HELPERS
# ======================================================================

def row_to_vehicle(r):
    return {"id": r["id"], "plate": r["plate"], "driver": r["driver"], "phone": r["phone"],
            "cccd": r["cccd"], "restDays": r["rest_days"], "tag": vehicle_tag(r["rest_days"])}


def row_to_route(r):
    return {"id": r["id"], "from": r["from_point"], "to": r["to_point"],
            "group": r["route_group"], "wage": r["wage"]}


def row_to_booking(r):
    return {"id": r["id"], "customer": r["customer"], "type": r["type"], "bookBill": r["book_bill"],
            "qty": r["qty"], "carrier": r["carrier"], "fromDate": r["from_date"], "toDate": r["to_date"],
            "cutoff": r["cutoff"], "legOutVessel": r["leg_out_vessel"], "legOutDate": r["leg_out_date"],
            "legInVessel": r["leg_in_vessel"], "legInDate": r["leg_in_date"], "split": r["split"],
            "progress": r["progress"], "routeId": r["route_id"], "note": r["note"]}


def row_to_container(r):
    return {"id": r["id"], "bookBill": r["book_bill"], "customer": r["customer"],
            "contNo": r["cont_no"], "contType": r["cont_type"], "seal": r["seal"]}


# ======================================================================
# HTTP SERVER
# ======================================================================

class Handler(BaseHTTPRequestHandler):
    server_version = "ContainerPlanner/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    # ---------- tiện ích ----------
    def _send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_binary(self, data, filename, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", 'attachment; filename="%s"' % filename)
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    # ---------- auth ----------
    def _client_ip(self):
        return self.client_address[0]

    def _session_token(self):
        cookie_header = self.headers.get("Cookie")
        if not cookie_header:
            return None
        jar = SimpleCookie()
        try:
            jar.load(cookie_header)
        except Exception:  # noqa: BLE001
            return None
        morsel = jar.get(SESSION_COOKIE)
        return morsel.value if morsel else None

    def _is_authenticated(self):
        return is_session_valid(self._session_token())

    def _set_session_cookie(self, token, ttl):
        self.send_header(
            "Set-Cookie",
            f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={ttl}",
        )

    def _clear_session_cookie(self):
        self.send_header(
            "Set-Cookie",
            f"{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
        )

    def _send_redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _require_api_auth(self):
        """Trả True nếu đã xác thực; nếu chưa thì tự gửi 401 và trả False."""
        if self._is_authenticated():
            return True
        self._send_json({"error": "unauthorized"}, 401)
        return False

    def h_login(self, body):
        ip = self._client_ip()
        if is_ip_locked(ip):
            return self._send_json(
                {"error": "Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau ít phút."}, 429
            )
        username = (body.get("username") or "").strip()
        password = body.get("password") or ""
        if not verify_credentials(username, password):
            register_failed_login(ip)
            return self._send_json({"error": "Sai tên đăng nhập hoặc mật khẩu."}, 401)
        reset_login_attempts(ip)
        token, ttl = create_session(remember=bool(body.get("remember")))
        payload = json.dumps({"ok": True}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self._set_session_cookie(token, ttl)
        self.end_headers()
        self.wfile.write(payload)

    def h_logout(self):
        token = self._session_token()
        if token:
            destroy_session(token)
        payload = json.dumps({"ok": True}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self._clear_session_cookie()
        self.end_headers()
        self.wfile.write(payload)

    def h_session(self):
        authenticated = self._is_authenticated()
        self._send_json({"authenticated": authenticated, "username": AUTH_USERNAME if authenticated else None})

    def _serve_static(self, path):
        if path == "/":
            path = "/index.html"
        safe_path = os.path.normpath(path).lstrip("/\\")
        if safe_path in ("", "index.html") and not self._is_authenticated():
            return self._send_redirect("/login.html")
        if safe_path == "login.html" and self._is_authenticated():
            return self._send_redirect("/")
        full_path = os.path.join(STATIC_DIR, safe_path)
        if not full_path.startswith(STATIC_DIR) or not os.path.isfile(full_path):
            self.send_error(404, "Not found")
            return
        ctype = "text/html; charset=utf-8"
        if full_path.endswith(".js"):
            ctype = "application/javascript; charset=utf-8"
        elif full_path.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        with open(full_path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---------- routing ----------
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        try:
            if path == "/api/session":
                return self.h_session()
            if path == "/api/logout":
                return self.h_logout()
            if path.startswith("/api/"):
                if not self._require_api_auth():
                    return
                if path == "/api/vehicles":
                    return self.h_list_vehicles(qs)
                if path == "/api/routes":
                    return self.h_list_routes(qs)
                if path == "/api/bookings":
                    return self.h_list_bookings(qs)
                if path == "/api/containers":
                    return self.h_list_containers(qs)
                if path == "/api/detail":
                    return self.h_list_detail(qs)
                if path == "/api/trips":
                    return self.h_trips(qs)
                if path == "/api/export":
                    return self.h_export(qs)
                return self._send_json({"error": "not found"}, 404)
            return self._serve_static(path)
        except Exception as e:  # noqa: BLE001
            self._send_json({"error": str(e)}, 500)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self._read_json()
        try:
            if path == "/api/login":
                return self.h_login(body)
            if path == "/api/logout":
                return self.h_logout()
            if path.startswith("/api/") and not self._require_api_auth():
                return
            if path == "/api/vehicles":
                return self.h_create_vehicle(body)
            if path == "/api/vehicles/bulk-delete":
                return self.h_bulk_delete_vehicles(body)
            if path == "/api/vehicles/copy-previous":
                return self.h_copy_previous("vehicles", body)
            if path == "/api/routes":
                return self.h_create_route(body)
            if path == "/api/routes/bulk-delete":
                return self.h_bulk_delete_routes(body)
            if path == "/api/routes/copy-previous":
                return self.h_copy_previous("routes", body)
            if path == "/api/bookings":
                return self.h_create_booking(body)
            if path == "/api/bookings/bulk-delete":
                return self.h_bulk_delete_bookings(body)
            if path == "/api/bookings/save-all":
                return self.h_save_all_bookings(body)
            if path == "/api/containers":
                return self.h_create_container(body)
            if path == "/api/containers/save":
                return self.h_save_containers(body)
            if path == "/api/containers/bulk-delete":
                return self.h_bulk_delete_containers(body)
            if path == "/api/containers/seed-from-bookings":
                return self.h_seed_containers_from_bookings(body)
            if path == "/api/containers/import-preview":
                return self.h_container_import_preview(body)
            if path == "/api/containers/import-confirm":
                return self.h_container_import_confirm(body)
            if path == "/api/detail/sync":
                return self.h_sync_detail_day(body)
            if path == "/api/detail/sync-all":
                return self.h_sync_detail_bulk(body)
            return self._send_json({"error": "not found"}, 404)
        except Exception as e:  # noqa: BLE001
            self._send_json({"error": str(e)}, 500)

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self._read_json()
        try:
            if path.startswith("/api/") and not self._require_api_auth():
                return
            m = re.match(r"^/api/vehicles/([^/]+)$", path)
            if m:
                return self.h_update_vehicle(m.group(1), body)
            m = re.match(r"^/api/routes/([^/]+)$", path)
            if m:
                return self.h_update_route(m.group(1), body)
            m = re.match(r"^/api/bookings/([^/]+)$", path)
            if m:
                return self.h_update_booking(m.group(1), body)
            m = re.match(r"^/api/detail/(.+)$", path)
            if m:
                return self.h_update_detail(m.group(1), body)
            return self._send_json({"error": "not found"}, 404)
        except Exception as e:  # noqa: BLE001
            self._send_json({"error": str(e)}, 500)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path.startswith("/api/") and not self._require_api_auth():
                return
            m = re.match(r"^/api/vehicles/([^/]+)$", path)
            if m:
                return self.h_delete_vehicle(m.group(1))
            m = re.match(r"^/api/routes/([^/]+)$", path)
            if m:
                return self.h_delete_route(m.group(1))
            m = re.match(r"^/api/bookings/([^/]+)$", path)
            if m:
                return self.h_delete_booking(m.group(1))
            m = re.match(r"^/api/containers/([^/]+)$", path)
            if m:
                return self.h_delete_container(m.group(1))
            return self._send_json({"error": "not found"}, 404)
        except Exception as e:  # noqa: BLE001
            self._send_json({"error": str(e)}, 500)

    # ---------- MODULE 1: XE ----------
    def h_list_vehicles(self, qs):
        period = require_period(qs.get("period"))
        conn = get_db()
        rows = conn.execute("SELECT * FROM vehicles WHERE period=? ORDER BY plate", (period,)).fetchall()
        conn.close()
        self._send_json([row_to_vehicle(r) for r in rows])

    def h_create_vehicle(self, b):
        period = require_period(b.get("period"))
        conn = get_db()
        vid = "v" + str(time.time_ns())
        plate = re.sub(r"[^a-zA-Z0-9]", "", (b.get("plate") or "").strip())  # FR-1.1
        conn.execute(
            "INSERT INTO vehicles (id, period, plate, driver, phone, cccd, rest_days) VALUES (?,?,?,?,?,?,?)",
            (vid, period, plate, b.get("driver", ""), b.get("phone", ""), b.get("cccd", ""), int(b.get("restDays") or 0)),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM vehicles WHERE id=?", (vid,)).fetchone()
        conn.close()
        self._send_json(row_to_vehicle(row), 201)

    def h_update_vehicle(self, vid, b):
        conn = get_db()
        plate = re.sub(r"[^a-zA-Z0-9]", "", (b.get("plate") or "").strip())
        conn.execute(
            "UPDATE vehicles SET plate=?, driver=?, phone=?, cccd=?, rest_days=? WHERE id=?",
            (plate, b.get("driver", ""), b.get("phone", ""), b.get("cccd", ""), int(b.get("restDays") or 0), vid),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM vehicles WHERE id=?", (vid,)).fetchone()
        conn.close()
        if not row:
            return self._send_json({"error": "not found"}, 404)
        self._send_json(row_to_vehicle(row))

    def h_delete_vehicle(self, vid):
        conn = get_db()
        cleanup_vehicle_refs(conn, vid)
        conn.execute("DELETE FROM vehicles WHERE id=?", (vid,))
        conn.commit()
        conn.close()
        self._send_json({"ok": True})

    def h_bulk_delete_vehicles(self, b):
        ids = b.get("ids") or []
        conn = get_db()
        for vid in ids:
            cleanup_vehicle_refs(conn, vid)
        conn.executemany("DELETE FROM vehicles WHERE id=?", [(i,) for i in ids])
        conn.commit()
        conn.close()
        self._send_json({"ok": True, "deleted": len(ids)})

    # ---------- MODULE 3: TUYẾN ĐƯỜNG ----------
    def h_list_routes(self, qs):
        period = require_period(qs.get("period"))
        conn = get_db()
        rows = conn.execute("SELECT * FROM routes WHERE period=? ORDER BY from_point", (period,)).fetchall()
        conn.close()
        self._send_json([row_to_route(r) for r in rows])

    def h_create_route(self, b):
        period = require_period(b.get("period"))
        conn = get_db()
        rid = "r" + str(time.time_ns())
        conn.execute(
            "INSERT INTO routes (id, period, from_point, to_point, route_group, wage) VALUES (?,?,?,?,?,?)",
            (rid, period, b.get("from", ""), b.get("to", ""), b.get("group", "short"), int(b.get("wage") or 0)),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM routes WHERE id=?", (rid,)).fetchone()
        conn.close()
        self._send_json(row_to_route(row), 201)

    def h_update_route(self, rid, b):
        conn = get_db()
        conn.execute(
            "UPDATE routes SET from_point=?, to_point=?, route_group=?, wage=? WHERE id=?",
            (b.get("from", ""), b.get("to", ""), b.get("group", "short"), int(b.get("wage") or 0), rid),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM routes WHERE id=?", (rid,)).fetchone()
        conn.close()
        if not row:
            return self._send_json({"error": "not found"}, 404)
        self._send_json(row_to_route(row))

    def h_delete_route(self, rid):
        conn = get_db()
        conn.execute("DELETE FROM routes WHERE id=?", (rid,))
        conn.commit()
        conn.close()
        self._send_json({"ok": True})

    def h_bulk_delete_routes(self, b):
        ids = b.get("ids") or []
        conn = get_db()
        conn.executemany("DELETE FROM routes WHERE id=?", [(i,) for i in ids])
        conn.commit()
        conn.close()
        self._send_json({"ok": True, "deleted": len(ids)})

    def h_copy_previous(self, table, b):
        period = require_period(b.get("period"))
        source = previous_period(period)
        conn = get_db()
        existing = conn.execute(f"SELECT COUNT(*) n FROM {table} WHERE period=?", (period,)).fetchone()["n"]
        if existing:
            conn.close()
            return self._send_json({"error": "Kỳ đang chọn đã có dữ liệu; không thể sao chép để tránh trùng"}, 409)
        rows = conn.execute(f"SELECT * FROM {table} WHERE period=?", (source,)).fetchall()
        if table == "vehicles":
            for r in rows:
                conn.execute(
                    "INSERT INTO vehicles (id,period,plate,driver,phone,cccd,rest_days) VALUES (?,?,?,?,?,?,?)",
                    ("v" + str(time.time_ns()), period, r["plate"], r["driver"], r["phone"], r["cccd"], 0),
                )
        else:
            for r in rows:
                conn.execute(
                    "INSERT INTO routes (id,period,from_point,to_point,route_group,wage) VALUES (?,?,?,?,?,?)",
                    ("r" + str(time.time_ns()), period, r["from_point"], r["to_point"], r["route_group"], r["wage"]),
                )
        conn.commit(); conn.close()
        self._send_json({"ok": True, "copied": len(rows), "fromPeriod": source})

    # ---------- MODULE 4: KẾ HOẠCH PHÂN CÔNG ----------
    def h_list_bookings(self, qs):
        period = require_period(qs.get("period"))
        conn = get_db()
        rows = conn.execute("SELECT * FROM bookings WHERE period=? ORDER BY book_bill", (period,)).fetchall()
        conn.close()
        self._send_json([row_to_booking(r) for r in rows])

    def _save_booking_row(self, conn, bid, b, is_new):
        period = require_period(b.get("period"))
        for field in ("fromDate", "toDate"):
            value = (b.get(field) or "").strip()
            if value and not value.startswith(period + "-"):
                raise ValueError("Ngày dự kiến phải thuộc kỳ đang làm việc " + period)
        qty = int(b.get("qty") or 1)
        vals = (
            b.get("customer", ""), b.get("type", "EXP"), b.get("bookBill", ""), qty, b.get("carrier", ""),
            b.get("fromDate", ""), b.get("toDate", ""), b.get("cutoff", ""),
            # 2 cột tàu giờ là 1 ô text tự do mỗi chiều (tên tàu + ngày gộp chung),
            # nên leg_out_date/leg_in_date không còn dùng — luôn ghi rỗng.
            b.get("legOutVessel", ""), "", b.get("legInVessel", ""), "",
            b.get("split", ""), b.get("progress", f"0/{qty}"), b.get("routeId") or None, b.get("note", ""),
        )
        if is_new:
            conn.execute(
                """INSERT INTO bookings (id, period, customer, type, book_bill, qty, carrier, from_date, to_date,
                   cutoff, leg_out_vessel, leg_out_date, leg_in_vessel, leg_in_date, split, progress, route_id, note)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (bid, period) + vals,
            )
        else:
            conn.execute(
                """UPDATE bookings SET customer=?, type=?, book_bill=?, qty=?, carrier=?, from_date=?, to_date=?,
                   cutoff=?, leg_out_vessel=?, leg_out_date=?, leg_in_vessel=?, leg_in_date=?, split=?, progress=?,
                   route_id=?, note=? WHERE id=?""",
                vals + (bid,),
            )
        row = conn.execute("SELECT * FROM bookings WHERE id=?", (bid,)).fetchone()
        # FR-4.2/4.3: tự tính lại Phân tách nếu trống/không khớp
        new_split, _ = recompute_booking_split(row)
        new_progress = recompute_booking_progress(row["progress"], row["qty"] or 0)
        conn.execute("UPDATE bookings SET split=?, progress=? WHERE id=?", (new_split, new_progress, bid))

    def h_create_booking(self, b):
        conn = get_db()
        bid = "bk" + str(time.time_ns())
        self._save_booking_row(conn, bid, b, is_new=True)
        conn.commit()
        row = conn.execute("SELECT * FROM bookings WHERE id=?", (bid,)).fetchone()
        conn.close()
        self._send_json(row_to_booking(row), 201)

    def h_update_booking(self, bid, b):
        conn = get_db()
        exists = conn.execute("SELECT 1 FROM bookings WHERE id=?", (bid,)).fetchone()
        if not exists:
            conn.close()
            return self._send_json({"error": "not found"}, 404)
        self._save_booking_row(conn, bid, b, is_new=False)
        conn.commit()
        row = conn.execute("SELECT * FROM bookings WHERE id=?", (bid,)).fetchone()
        conn.close()
        self._send_json(row_to_booking(row))

    def h_delete_booking(self, bid):
        conn = get_db()
        cleanup_booking_children(conn, bid)
        conn.execute("DELETE FROM bookings WHERE id=?", (bid,))
        conn.commit()
        conn.close()
        self._send_json({"ok": True})

    def h_bulk_delete_bookings(self, b):
        ids = b.get("ids") or []
        conn = get_db()
        for bid in ids:
            cleanup_booking_children(conn, bid)
        conn.executemany("DELETE FROM bookings WHERE id=?", [(i,) for i in ids])
        conn.commit()
        conn.close()
        self._send_json({"ok": True, "deleted": len(ids)})

    def h_save_all_bookings(self, b):
        """FR-4.5 'Lưu thay đổi': tính lại Phân tách cho toàn bộ booking hiện có."""
        period = require_period(b.get("period"))
        conn = get_db()
        rows = conn.execute("SELECT * FROM bookings WHERE period=?", (period,)).fetchall()
        mismatch = 0
        for row in rows:
            new_split, was_mismatch = recompute_booking_split(row)
            if was_mismatch:
                mismatch += 1
            conn.execute("UPDATE bookings SET split=? WHERE id=?", (new_split, row["id"]))
        conn.commit()
        conn.close()
        self._send_json({"ok": True, "mismatchCount": mismatch})

    # ---------- MODULE 5: KHAI BÁO LIST CONT (màn độc lập, không phụ thuộc booking) ----------
    def h_list_containers(self, qs):
        """Màn 'Khai báo list cont' làm việc theo từng số Book/Bill: chỉ trả về các dòng cont của
        Book/Bill được yêu cầu. Không truyền bookBill thì trả về toàn bộ kỳ (các màn khác vẫn cần
        đủ danh sách để map Số cont -> Loại cont/Số seal)."""
        period = require_period(qs.get("period"))
        book_bill = (qs.get("bookBill") or "").strip()
        conn = get_db()
        if book_bill:
            rows = conn.execute(
                "SELECT * FROM containers WHERE period=? AND book_bill=? ORDER BY id", (period, book_bill)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM containers WHERE period=? ORDER BY book_bill, id", (period,)).fetchall()
        conn.close()
        self._send_json([row_to_container(r) for r in rows])

    def h_create_container(self, b):
        period = require_period(b.get("period"))
        conn = get_db()
        cid = "c" + str(time.time_ns())
        conn.execute(
            "INSERT INTO containers (id, period, book_bill, customer, cont_no, cont_type, seal, booking_id, unit_index) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (cid, period, b.get("bookBill", ""), b.get("customer", ""), b.get("contNo", ""), b.get("contType", ""), b.get("seal", ""), "", 0),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM containers WHERE id=?", (cid,)).fetchone()
        conn.close()
        self._send_json(row_to_container(row), 201)

    def h_delete_container(self, cid):
        conn = get_db()
        conn.execute("DELETE FROM containers WHERE id=?", (cid,))
        conn.commit()
        conn.close()
        self._send_json({"ok": True})

    def h_bulk_delete_containers(self, b):
        ids = b.get("ids") or []
        conn = get_db()
        conn.executemany("DELETE FROM containers WHERE id=?", [(i,) for i in ids])
        conn.commit()
        conn.close()
        self._send_json({"ok": True, "deleted": len(ids)})

    def h_seed_containers_from_bookings(self, b):
        """Tiện ích một lần từ nút 'Đẩy dữ liệu → Khai báo list cont': tạo sẵn cho mỗi booking
        đúng số dòng cont còn thiếu (so với Số lượng), điền sẵn Book/Bill + Khách hàng. Chỉ tạo
        thêm dòng còn thiếu (không xóa/không đụng dòng đã có) vì list cont giờ độc lập, có thể
        đã được biên tập tự do sau khi tạo."""
        period = require_period(b.get("period"))
        conn = get_db()
        bookings = conn.execute(
            "SELECT book_bill, customer, qty FROM bookings WHERE period=? AND book_bill<>''", (period,)
        ).fetchall()
        created = 0
        for bk in bookings:
            existing = conn.execute(
                "SELECT COUNT(*) n FROM containers WHERE period=? AND book_bill=?", (period, bk["book_bill"])
            ).fetchone()["n"]
            missing = max(0, (bk["qty"] or 0) - existing)
            for i in range(missing):
                cid = "c" + str(time.time_ns()) + "_" + str(created)
                conn.execute(
                    "INSERT INTO containers (id, period, book_bill, customer, cont_no, cont_type, seal, booking_id, unit_index) "
                    "VALUES (?,?,?,?,?,?,?,?,?)",
                    (cid, period, bk["book_bill"], bk["customer"] or "", "", "", "", "", 0),
                )
                created += 1
        conn.commit()
        conn.close()
        self._send_json({"ok": True, "created": created})

    def h_save_containers(self, b):
        """Lưu đồng thời toàn bộ các dòng đang hiển thị."""
        items = b.get("items") or []
        conn = get_db()
        for it in items:
            conn.execute(
                "UPDATE containers SET book_bill=?, customer=?, cont_no=?, cont_type=?, seal=? WHERE id=?",
                (it.get("bookBill", "").strip(), it.get("customer", "").strip(),
                 it.get("contNo", "").strip(), it.get("contType", ""), it.get("seal", "").strip(), it.get("id")),
            )
        conn.commit()
        conn.close()
        self._send_json({"ok": True, "saved": len(items)})

    def h_container_import_preview(self, b):
        period = require_period(b.get("period"))
        try:
            raw = base64.b64decode(b.get("data") or "", validate=True)
            rows = read_xlsx_rows(raw)
        except Exception as exc:
            return self._send_json({"error": "Không đọc được file Excel: " + str(exc)}, 400)
        if not rows:
            return self._send_json({"error": "File Excel không có dữ liệu"}, 400)
        columns = detect_import_columns(rows[0])
        if not columns:
            return self._send_json({
                "error": "Không nhận diện được đủ 4 cột Book/Bill, Số cont, Loại cont, Số seal trong dòng tiêu đề. "
                         "Có thể để thêm cột khác (VD: STT) và đặt tên gần đúng, nhưng phải có đủ 4 cột này."
            }, 400)
        data_rows = [[(r[i] if i < len(r) else "") for i in columns] for r in rows[1:]]
        conn = get_db()
        valid, errors = validate_container_import(conn, period, data_rows)
        conn.close()
        self._send_json({"valid": valid, "errors": errors, "validCount": len(valid), "errorCount": len(errors)})

    def h_container_import_confirm(self, b):
        period = require_period(b.get("period"))
        raw_items = b.get("items") or []
        rows = [[i.get("bookBill", ""), i.get("contNo", ""), i.get("contType", ""), i.get("seal", "")] for i in raw_items]
        conn = get_db()
        valid, errors = validate_container_import(conn, period, rows)
        if errors or len(valid) != len(raw_items):
            conn.close()
            return self._send_json({"error": "Dữ liệu đã thay đổi; vui lòng xem trước lại file"}, 409)
        saved = 0
        for item in valid:
            # Cont đã khai (bất kỳ book/bill nào) thì cập nhật lại; chưa có thì tạo dòng mới —
            # màn list cont độc lập, không cần booking đã tồn tại trước.
            existing = conn.execute(
                "SELECT id FROM containers WHERE period=? AND upper(cont_no)=upper(?)", (period, item["contNo"])
            ).fetchone()
            if existing:
                conn.execute(
                    "UPDATE containers SET book_bill=?, cont_type=?, seal=? WHERE id=?",
                    (item["bookBill"], item["contType"], item["seal"], existing["id"]),
                )
            else:
                cid = "c" + str(time.time_ns()) + "_" + str(saved)
                conn.execute(
                    "INSERT INTO containers (id, period, book_bill, customer, cont_no, cont_type, seal, booking_id, unit_index) "
                    "VALUES (?,?,?,?,?,?,?,?,?)",
                    (cid, period, item["bookBill"], "", item["contNo"], item["contType"], item["seal"], "", 0),
                )
            saved += 1
        conn.commit(); conn.close()
        self._send_json({"ok": True, "saved": saved})

    # ---------- MODULE 6: CHI TIẾT BÁO CÁO ----------
    def _detail_range(self, source, period):
        """Đọc khoảng ngày 'từ ngày - đến ngày' và kiểm tra thuộc kỳ đang làm việc."""
        start = (source.get("from") or "").strip()
        end = (source.get("to") or "").strip()
        for value in (start, end):
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) or not value.startswith(period + "-"):
                raise ValueError("Vui lòng chọn khoảng ngày trong kỳ đang làm việc")
        if start > end:
            raise ValueError("'Từ ngày' phải trước hoặc bằng 'Đến ngày'")
        return start, end

    def h_list_detail(self, qs):
        period = require_period(qs.get("period"))
        try:
            start, end = self._detail_range(qs, period)
        except ValueError as exc:
            return self._send_json({"rows": [], "synced": False, "unsyncedDates": [], "error": str(exc)})
        conn = get_db()
        wanted = date_range_array(start, end)
        synced_dates = {r["date"] for r in conn.execute(
            "SELECT date FROM daily_syncs WHERE period=? AND date>=? AND date<=?", (period, start, end)
        ).fetchall()}
        unsynced = [d for d in wanted if d not in synced_dates]
        if not synced_dates:
            conn.close()
            return self._send_json({"rows": [], "synced": False, "unsyncedDates": unsynced})
        rows = build_detail_rows(conn, {
            "period": period, "from": start, "to": end,
            "vehicleId": qs.get("vehicleId"), "q": qs.get("q"),
        })
        allowed = {r["key"] for r in conn.execute(
            "SELECT key FROM daily_detail_rows WHERE period=? AND date>=? AND date<=?", (period, start, end)
        ).fetchall()}
        rows = [r for r in rows if r["key"] in allowed]
        used_cont_nos = self._used_cont_nos(conn, period)
        conn.close()
        self._send_json({"rows": rows, "synced": True, "unsyncedDates": unsynced, "usedContNos": used_cont_nos})

    def _used_cont_nos(self, conn, period):
        """BR-11: cont đã gán cho một Book/Bill thì không được chọn lại ở dòng khác của CÙNG Book/Bill,
        kể cả dòng đó thuộc ngày khác. Trả về {book_bill: [cont_no, ...]} cho cả kỳ (không giới hạn theo
        khoảng ngày đang xem) để màn hình lọc đúng dù chỉ đang xem một vài ngày."""
        used = {}
        for r in conn.execute(
            """SELECT b.book_bill AS book_bill, o.cont_no AS cont_no
               FROM detail_overrides o JOIN bookings b ON b.id = o.booking_id
               WHERE b.period = ? AND o.cont_no <> ''""",
            (period,),
        ).fetchall():
            used.setdefault(r["book_bill"] or "", []).append(r["cont_no"])
        return used

    def h_sync_detail_day(self, b):
        """Đồng bộ toàn bộ các ngày trong khoảng 'từ ngày - đến ngày' đang chọn."""
        period = require_period(b.get("period"))
        try:
            start, end = self._detail_range(b, period)
        except ValueError as exc:
            return self._send_json({"error": str(exc)}, 400)
        conn = get_db()
        now = datetime.now().isoformat(timespec="seconds")
        rows = build_detail_rows(conn, {"period": period, "from": start, "to": end})
        by_date = {}
        for r in rows:
            by_date.setdefault(r["date"], []).append(r["key"])
        for d in date_range_array(start, end):
            conn.execute(
                "INSERT OR REPLACE INTO daily_syncs(period,date,synced_at) VALUES (?,?,?)",
                (period, d, now),
            )
            conn.execute("DELETE FROM daily_detail_rows WHERE period=? AND date=?", (period, d))
            conn.executemany(
                "INSERT INTO daily_detail_rows(period,date,key) VALUES (?,?,?)",
                [(period, d, key) for key in by_date.get(d, [])],
            )
        conn.commit(); conn.close()
        self._send_json({"ok": True, "rowCount": len(rows), "datesSynced": len(date_range_array(start, end))})

    def h_sync_detail_bulk(self, b):
        """Nút 'Đẩy dữ liệu → Báo cáo sản lượng' ở Kế hoạch phân công: đồng bộ MỌI ngày có booking
        trong kỳ (dựa vào Số lượng/Phân tách/Từ ngày-Đến ngày của từng booking) — tương đương bấm
        'Đồng bộ dữ liệu ngày này' lần lượt cho từng ngày, nhưng làm một lần cho cả kỳ."""
        period = require_period(b.get("period"))
        conn = get_db()
        rows = build_detail_rows(conn, {"period": period})
        by_date = {}
        for r in rows:
            by_date.setdefault(r["date"], []).append(r["key"])
        now = datetime.now().isoformat(timespec="seconds")
        for d, keys in by_date.items():
            conn.execute(
                "INSERT OR REPLACE INTO daily_syncs(period,date,synced_at) VALUES (?,?,?)",
                (period, d, now),
            )
            conn.execute("DELETE FROM daily_detail_rows WHERE period=? AND date=?", (period, d))
            conn.executemany(
                "INSERT INTO daily_detail_rows(period,date,key) VALUES (?,?,?)",
                [(period, d, key) for key in keys],
            )
        conn.commit(); conn.close()
        self._send_json({"ok": True, "datesSynced": len(by_date), "rowCount": len(rows)})

    def h_update_detail(self, key, b):
        """FR-6.3/6.4/6.5: cập nhật Xe/Số cont/Vendor/Ghi chú cho 1 dòng chi tiết."""
        conn = get_db()
        parts = key.rsplit("_", 2)
        if len(parts) != 3:
            conn.close()
            return self._send_json({"error": "bad key"}, 400)
        booking_id, d, unit_index = parts[0], parts[1], int(parts[2])
        existing = conn.execute("SELECT * FROM detail_overrides WHERE key=?", (key,)).fetchone()
        vehicle_id = b.get("vehicleId", existing["vehicle_id"] if existing else "")
        cont_no = b.get("contNo", existing["cont_no"] if existing else "")
        vendor = b.get("vendor", existing["vendor"] if existing else "GRAI")
        note = b.get("note", existing["note"] if existing else "")
        if existing:
            conn.execute(
                "UPDATE detail_overrides SET vehicle_id=?, cont_no=?, vendor=?, note=? WHERE key=?",
                (vehicle_id, cont_no, vendor, note, key),
            )
        else:
            conn.execute(
                "INSERT INTO detail_overrides (key, booking_id, date, unit_index, vehicle_id, cont_no, vendor, note) VALUES (?,?,?,?,?,?,?,?)",
                (key, booking_id, d, unit_index, vehicle_id, cont_no, vendor, note),
            )
        conn.commit()
        conn.close()
        self._send_json({"ok": True})

    # ---------- MODULE 2: CHUYẾN ĐI THÁNG NÀY ----------
    def h_trips(self, qs):
        period = require_period(qs.get("period"))
        conn = get_db()
        rows = build_detail_rows(conn, {"period": period, "from": qs.get("from"), "to": qs.get("to")})
        vehicles = conn.execute("SELECT * FROM vehicles WHERE period=? ORDER BY plate", (period,)).fetchall()
        conn.close()

        per_vehicle = {v["id"]: {"total": 0, "near": 0, "far": 0} for v in vehicles}
        total_near = total_far = 0
        for r in rows:
            if not r["vehicleId"] or r["vehicleId"] not in per_vehicle:
                continue
            per_vehicle[r["vehicleId"]]["total"] += 1
            if r["routeGroup"] == "short":
                per_vehicle[r["vehicleId"]]["near"] += 1
                total_near += 1
            elif r["routeGroup"] == "long":
                per_vehicle[r["vehicleId"]]["far"] += 1
                total_far += 1

        by_vehicle = []
        for v in vehicles:
            s = per_vehicle[v["id"]]
            by_vehicle.append({
                "plate": v["plate"], "driver": v["driver"], "restDays": v["rest_days"],
                "total": s["total"], "near": s["near"], "far": s["far"],
            })
        total = sum(s["total"] for s in per_vehicle.values())
        active = sum(1 for s in per_vehicle.values() if s["total"] > 0)
        self._send_json({"total": total, "near": total_near, "far": total_far, "activeVehicles": active, "byVehicle": by_vehicle})

    def h_export(self, qs):
        """Xuất các bảng chính ra Excel theo đúng kỳ/ khoảng ngày đang chọn."""
        period = require_period(qs.get("period"))
        module = (qs.get("module") or "").strip()
        conn = get_db()
        try:
            if module == "vehicles":
                headers = ["Số xe", "Tài xế", "SĐT", "CCCD", "Số ngày nghỉ", "Gợi ý phân công"]
                data = conn.execute("SELECT * FROM vehicles WHERE period=? ORDER BY plate", (period,)).fetchall()
                rows = [[r["plate"], r["driver"], r["phone"], r["cccd"], r["rest_days"], vehicle_tag(r["rest_days"])] for r in data]
                title = "Khai báo xe"
            elif module == "routes":
                headers = ["Điểm đi", "Điểm đến", "Nhóm quãng đường", "Tiền lương (VNĐ)"]
                data = conn.execute("SELECT * FROM routes WHERE period=? ORDER BY from_point,to_point", (period,)).fetchall()
                rows = [[r["from_point"], r["to_point"], "Ngắn" if r["route_group"] == "short" else "Dài", r["wage"]] for r in data]
                title = "Tuyến đường"
            elif module == "bookings":
                headers = ["Khách hàng", "IMP/EXP", "Book/Bill", "Số lượng", "Hãng", "Từ ngày", "Đến ngày", "Cutoff/DET", "HPH→NSI", "NSI→HPH", "Phân tách", "Tiến độ", "Tuyến đường", "Ghi chú"]
                data = conn.execute("SELECT b.*,r.from_point,r.to_point FROM bookings b LEFT JOIN routes r ON r.id=b.route_id WHERE b.period=? ORDER BY b.book_bill", (period,)).fetchall()
                rows = [[r["customer"], r["type"], r["book_bill"], r["qty"], r["carrier"], fmt_date_vn(r["from_date"]), fmt_date_vn(r["to_date"]), r["cutoff"], r["leg_out_vessel"], r["leg_in_vessel"], r["split"], r["progress"], fmt_route(r["from_point"], r["to_point"]), r["note"]] for r in data]
                title = "Kế hoạch phân công"
            elif module == "containers":
                headers = IMPORT_HEADERS
                data = conn.execute("SELECT book_bill, cont_no, cont_type, seal FROM containers WHERE period=? ORDER BY book_bill, id", (period,)).fetchall()
                rows = [[r["book_bill"], r["cont_no"], r["cont_type"], r["seal"]] for r in data]
                title = "Danh sách container"
            elif module in ("detail", "bee"):
                # Xuất đúng khoảng ngày + bộ lọc đang hiển thị trên màn hình.
                data = build_detail_rows(conn, {
                    "period": period,
                    "from": (qs.get("from") or "").strip() or None,
                    "to": (qs.get("to") or "").strip() or None,
                    "vehicleId": qs.get("vehicleId"), "q": qs.get("q"),
                })
                if module == "detail":
                    headers = ["STT", "Bill/Book", "Số cont", "Loại cont", "Số seal", "Chủ hàng", "Số xe", "Ngày", "Tuyến đường", "Tiền lương", "Ghi chú", "Vendor"]
                    rows = [[i, r["bookBill"], r["contNo"], r["contType"], r["seal"], r["customer"], r["vehiclePlate"],
                             fmt_date_vn(r["date"]), fmt_route_label(r["routeLabel"]), fmt_wage(r["wage"]), r["note"], r["vendor"]]
                            for i, r in enumerate(data, 1)]
                    title = "Báo cáo sản lượng"
                else:
                    headers = ["STT", "Bill/Book", "Số cont", "Loại cont", "Số seal", "Chủ hàng", "Số xe", "Họ tên", "Số điện thoại", "Ngày"]
                    rows = [[i, r["bookBill"], r["contNo"], r["contType"], r["seal"], r["customer"], r["vehiclePlate"],
                             r["vehicleDriver"], r["vehiclePhone"], fmt_date_vn(r["date"])]
                            for i, r in enumerate(data, 1)]
                    title = "Báo cáo BEE"
            elif module == "trips":
                start, end = qs.get("from") or period + "-01", qs.get("to") or period + "-31"
                if not start.startswith(period + "-") or not end.startswith(period + "-") or start > end:
                    raise ValueError("Khoảng ngày báo cáo không hợp lệ")
                details = build_detail_rows(conn, {"period": period, "from": start, "to": end})
                stats = {}
                for r in details:
                    if r["vehicleId"]:
                        s = stats.setdefault(r["vehicleId"], [0, 0, 0]); s[0] += 1
                        if r["routeGroup"] == "short": s[1] += 1
                        if r["routeGroup"] == "long": s[2] += 1
                vehicles = conn.execute("SELECT * FROM vehicles WHERE period=? ORDER BY plate", (period,)).fetchall()
                headers = ["Xe", "Tài xế", "Số chuyến gần", "Số chuyến xa", "Tổng số chuyến", "Số ngày nghỉ", "Từ ngày", "Đến ngày"]
                rows = []
                for v in vehicles:
                    total, near, far = stats.get(v["id"], [0, 0, 0])
                    rows.append([v["plate"], v["driver"], near, far, total, v["rest_days"], fmt_date_vn(start), fmt_date_vn(end)])
                title = "Chuyến đi tháng này"
            else:
                return self._send_json({"error": "Loại báo cáo không hợp lệ"}, 400)
            self._send_binary(make_xlsx(headers, rows, title), f"container-planner-{module}-{period}.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        finally:
            conn.close()


def open_browser_later():
    time.sleep(0.8)
    try:
        webbrowser.open(f"http://localhost:{PORT}")
    except Exception:  # noqa: BLE001
        pass


def main():
    init_db()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"==> Container Planner đang chạy tại: http://localhost:{PORT}")
    print("==> Nhấn Ctrl+C để dừng server.")
    threading.Thread(target=open_browser_later, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n==> Đã dừng server.")


if __name__ == "__main__":
    main()
