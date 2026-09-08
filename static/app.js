/* ======================================================================
   Container Planner — Frontend (gọi API thật, không còn dữ liệu giả lập)
   ====================================================================== */

let vehicles = [];
let routes = [];
let bookings = [];
let containers = [];
let detailRows = [];
let activePeriod = '';
let pendingContainerImport = [];
let containerDirty = false;
let contListRows = [];        // các dòng cont đang mở trên màn "Khai báo list cont"
let activeContBookBill = '';  // số Book/Bill đã bấm Load; rỗng = chưa load, chưa hiện dữ liệu
let detailUnsyncedDates = [];
let detailUsedContNos = {};
let beeRows = [];

/* ======================= HTTP HELPER ======================= */

async function api(url, method, body) {
  if (!activePeriod) throw new Error('Vui lòng chọn tháng/năm trước khi nhập liệu');
  if (url.startsWith('/api/')) {
    const sep = url.includes('?') ? '&' : '?';
    url += sep + 'period=' + encodeURIComponent(activePeriod);
  }
  const opts = { method: method || 'GET' };
  if (body !== undefined) {
    body = Object.assign({}, body, { period: activePeriod });
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('Phiên đăng nhập đã hết hạn');
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = j.error || msg; } catch (e) {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function logout() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch (e) {}
  window.location.href = '/login.html';
}

function currentMonthValue() {
  const now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
}

function isoDateLocal(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

function pickerFor(inputId) {
  const input = document.getElementById(inputId);
  return input ? input.closest('.date-picker') : null;
}

function setDatePickerValue(inputId, value) {
  const input = document.getElementById(inputId), picker = pickerFor(inputId);
  if (!input || !picker) return;
  input.value = value || '';
  const text = picker.querySelector('.date-picker-text');
  const mode = picker.dataset.mode;
  if (!value) {
    text.textContent = mode === 'period' ? 'Chọn tháng' : 'Chọn ngày';
    picker.querySelector('.date-picker-trigger').classList.add('placeholder');
    return;
  }
  picker.querySelector('.date-picker-trigger').classList.remove('placeholder');
  const parts = value.split('-');
  text.textContent = mode === 'period' ? 'Tháng ' + parts[1] + '/' + parts[0] : parts[2] + '/' + parts[1] + '/' + parts[0];
  picker.dataset.view = value.slice(0, 7);
}

function closeDatePickers(except) {
  document.querySelectorAll('.date-picker.open').forEach(p => {
    if (p !== except) { p.classList.remove('open'); restoreCellPanel(p); }
  });
}

// Ô ngày trong bảng (.cell-date) nằm trong .table-scroll (overflow:auto) nên panel lịch dạng
// position:absolute bị cắt mất. Khi mở, tách panel ra <body> và định vị bằng position:fixed
// theo toạ độ của nút bấm để lịch luôn hiện đầy đủ; khi đóng thì trả panel về đúng chỗ cũ.
function positionCellPanel(picker, trigger) {
  const panel = picker.querySelector('.date-picker-panel');
  if (!panel) return;
  const rect = trigger.getBoundingClientRect();
  const panelWidth = panel.offsetWidth || 294;
  let left = rect.left;
  if (left + panelWidth > window.innerWidth - 8) left = Math.max(8, window.innerWidth - panelWidth - 8);
  panel.style.position = 'fixed';
  panel.style.top = (rect.bottom + 4) + 'px';
  panel.style.left = left + 'px';
  panel.style.display = 'block'; // đã tách khỏi .date-picker.open nên mất luật CSS hiển thị theo cha
  document.body.appendChild(panel);
  picker._detachedPanel = panel;
}

function restoreCellPanel(picker) {
  const panel = picker._detachedPanel;
  if (!panel) return;
  panel.style.position = '';
  panel.style.top = '';
  panel.style.left = '';
  panel.style.display = '';
  picker.appendChild(panel);
  picker._detachedPanel = null;
}

function toggleDatePicker(trigger) {
  const picker = trigger.closest('.date-picker');
  const opening = !picker.classList.contains('open');
  closeDatePickers(picker);
  picker.classList.toggle('open', opening);
  if (opening) {
    if (!picker.dataset.view) picker.dataset.view = (picker.querySelector('input').value || isoDateLocal(new Date())).slice(0, 7);
    renderDatePicker(picker);
    if (picker.classList.contains('cell-date')) positionCellPanel(picker, trigger);
  } else {
    restoreCellPanel(picker);
  }
}

function moveCalendar(inputId, months) {
  const picker = pickerFor(inputId), parts = picker.dataset.view.split('-').map(Number);
  const date = new Date(parts[0], parts[1] - 1 + months, 1);
  picker.dataset.view = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
  renderDatePicker(picker);
}

function pickCalendarDate(inputId, iso) {
  const picker = pickerFor(inputId), mode = picker.dataset.mode;
  const value = mode === 'period' ? iso.slice(0, 7) : iso;
  picker.dataset.selectedDate = iso;
  setDatePickerValue(inputId, value);
  picker.classList.remove('open');
  restoreCellPanel(picker);
  const callback = picker.dataset.change;
  if (callback && typeof window[callback] === 'function') window[callback](value, inputId);
}

function pickToday(inputId) { pickCalendarDate(inputId, isoDateLocal(new Date())); }

function pickCalendarMonth(inputId, month) {
  const picker = pickerFor(inputId);
  const year = Number(picker.dataset.view.split('-')[0]);
  const value = year + '-' + String(month).padStart(2, '0');
  setDatePickerValue(inputId, value);
  picker.classList.remove('open');
  restoreCellPanel(picker);
  const callback = picker.dataset.change;
  if (callback && typeof window[callback] === 'function') window[callback](value);
}

function renderDatePicker(picker) {
  const input = picker.querySelector('input'), panel = picker._detachedPanel || picker.querySelector('.date-picker-panel');
  const [year, month] = picker.dataset.view.split('-').map(Number);
  if (picker.dataset.mode === 'period') {
    const current = currentMonthValue();
    const selected = input.value;
    const labels = ['Thg 1','Thg 2','Thg 3','Thg 4','Thg 5','Thg 6','Thg 7','Thg 8','Thg 9','Thg 10','Thg 11','Thg 12'];
    const months = labels.map((label, index) => {
      const value = year + '-' + String(index + 1).padStart(2, '0');
      const cls = 'calendar-month' + (value === selected ? ' selected' : '');
      return '<button type="button" class="' + cls + '" ' + (value < current ? 'disabled ' : '') + 'onclick="pickCalendarMonth(\'' + input.id + '\',' + (index + 1) + ')">' + label + '</button>';
    }).join('');
    panel.innerHTML = '<div class="calendar-head">' +
      '<button type="button" class="calendar-nav" title="Năm trước" onclick="moveCalendar(\'' + input.id + '\',-12)">«</button>' +
      '<strong>' + year + '</strong>' +
      '<button type="button" class="calendar-nav" title="Năm sau" onclick="moveCalendar(\'' + input.id + '\',12)">»</button></div>' +
      '<div class="calendar-month-grid">' + months + '</div>';
    return;
  }
  const first = new Date(year, month - 1, 1);
  const start = new Date(year, month - 1, 1 - first.getDay());
  const today = isoDateLocal(new Date());
  const selected = picker.dataset.selectedDate || (picker.dataset.mode === 'date' ? input.value : (input.value ? input.value + '-01' : ''));
  const weekdays = ['CN','T2','T3','T4','T5','T6','T7'].map(x => '<span>' + x + '</span>').join('');
  let days = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const iso = isoDateLocal(d);
    let cls = 'calendar-day';
    if (d.getMonth() !== month - 1) cls += ' muted';
    if (iso === today) cls += ' today';
    if (iso === selected) cls += ' selected';
    days += '<button type="button" class="' + cls + '" onclick="pickCalendarDate(\'' + input.id + '\',\'' + iso + '\')">' + d.getDate() + '</button>';
  }
  panel.innerHTML = '<div class="calendar-head">' +
    '<button type="button" class="calendar-nav" title="Năm trước" onclick="moveCalendar(\'' + input.id + '\',-12)">«</button>' +
    '<button type="button" class="calendar-nav" title="Tháng trước" onclick="moveCalendar(\'' + input.id + '\',-1)">‹</button>' +
    '<strong>Tháng ' + String(month).padStart(2, '0') + ' / ' + year + '</strong>' +
    '<button type="button" class="calendar-nav" title="Tháng sau" onclick="moveCalendar(\'' + input.id + '\',1)">›</button>' +
    '<button type="button" class="calendar-nav" title="Năm sau" onclick="moveCalendar(\'' + input.id + '\',12)">»</button></div>' +
    '<div class="calendar-body"><div class="calendar-week">' + weekdays + '</div><div class="calendar-grid">' + days + '</div></div>' +
    '<div class="calendar-foot"><button type="button" class="calendar-today" onclick="pickToday(\'' + input.id + '\')">Hôm nay</button></div>';
}

async function confirmInitialPeriod() {
  const value = document.getElementById('gatePeriod').value;
  if (!value) return toast('Vui lòng chọn tháng/năm');
  activePeriod = value;
  setDatePickerValue('activePeriod', value);
  document.getElementById('periodGate').classList.add('hidden');
  localStorage.setItem('containerPlannerLastPeriod', value);
  await reloadPeriodData();
}

async function changeActivePeriod(value) {
  if (!value || value === activePeriod) return;
  if (containerDirty) {
    setDatePickerValue('activePeriod', activePeriod);
    return toast('Bạn đang có dữ liệu cont chưa lưu — hãy bấm “Lưu danh sách cont” trước khi đổi kỳ');
  }
  activePeriod = value;
  localStorage.setItem('containerPlannerLastPeriod', value);
  ['dFrom', 'dTo', 'beeFrom', 'beeTo'].forEach(id => setDatePickerValue(id, ''));
  // Đổi kỳ thì phải Load lại Book/Bill vì dữ liệu cont thuộc về kỳ khác
  activeContBookBill = '';
  contListRows = [];
  document.getElementById('contBookBill').value = '';
  await reloadPeriodData();
  toast('Đã chuyển sang kỳ ' + value.split('-').reverse().join('/'));
}

async function reloadPeriodData() {
  selection = { vehicle: new Set(), route: new Set(), booking: new Set(), cont: new Set() };
  await loadRoutes();
  await loadBookings();
  await loadVehicles();
  populateDetailVehicleFilter();
  await loadContainers();
  detailRows = [];
  renderDetailTable(false);
  beeRows = [];
  renderBeeTable(false);
  applyTripMonth();
}

async function copyPrevious(resource) {
  try {
    const res = await api('/api/' + resource + '/copy-previous', 'POST', {});
    if (resource === 'vehicles') await loadVehicles(); else await loadRoutes();
    toast('Đã sao chép ' + res.copied + ' dòng từ kỳ ' + res.fromPeriod);
  } catch (err) { toast('Không thể sao chép: ' + err.message); }
}

function toast(msg, requestedType) {
  const t = document.getElementById('toast');
  const lower = String(msg).toLowerCase();
  let type = requestedType;
  if (!type) {
    if (/lỗi|thất bại|không đọc được/.test(lower)) type = 'error';
    else if (/vui lòng|hãy |chưa |không thể|sai |phải thuộc|đang có/.test(lower)) type = 'warning';
    else if (/đã |thành công/.test(lower)) type = 'success';
    else type = 'info';
  }
  const titles = { success: 'Thành công', info: 'Thông tin', warning: 'Cảnh báo', error: 'Lỗi' };
  const icons = { success: '✓', info: 'i', warning: '!', error: '×' };
  t.className = 'toast ' + type;
  t.innerHTML = '<span class="toast-icon">' + icons[type] + '</span>' +
    '<div class="toast-title">' + titles[type] + '</div>' +
    '<div class="toast-description">' + escapeHtml(msg) + '</div>' +
    '<button type="button" class="toast-close" aria-label="Đóng thông báo" onclick="closeToast()">×</button>';
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(closeToast, 800);
}
function closeToast() {
  const t = document.getElementById('toast');
  if (t) t.classList.remove('show');
}

function downloadExport(module) {
  if (!activePeriod) return toast('Vui lòng chọn kỳ làm việc');
  const params = new URLSearchParams({ module, period: activePeriod });
  if (module === 'trips') {
    params.set('from', document.getElementById('tripFrom').value);
    params.set('to', document.getElementById('tripTo').value);
  }
  // Báo cáo sản lượng / BEE: xuất đúng khoảng ngày và bộ lọc đang hiển thị trên màn hình.
  if (module === 'detail' || module === 'bee') {
    const prefix = module === 'detail' ? 'd' : 'bee';
    const range = reportRange(module === 'detail' ? 'dFrom' : 'beeFrom', module === 'detail' ? 'dTo' : 'beeTo');
    if (!range) return toast('Vui lòng chọn khoảng ngày cần xuất báo cáo');
    params.set('from', range.from);
    params.set('to', range.to);
    const vehicleId = document.getElementById(prefix === 'd' ? 'dVehicle' : 'beeVehicle').value;
    const q = document.getElementById(prefix === 'd' ? 'dSearch' : 'beeSearch').value;
    if (vehicleId) params.set('vehicleId', vehicleId);
    if (q) params.set('q', q);
  }
  const link = document.createElement('a');
  link.href = '/api/export?' + params.toString();
  link.download = '';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function saveDeclarations(kind) {
  if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur();
  await Promise.all(Object.values(_rowUpdateQueues));
  const rows = kind === 'vehicles' ? vehicles : routes;
  const resource = kind === 'vehicles' ? 'vehicles' : 'routes';
  await Promise.all(rows.map(row => api('/api/' + resource + '/' + row.id, 'PUT', row)));
  if (kind === 'vehicles') await loadVehicles(); else await loadRoutes();
  toast('Đã lưu ' + (kind === 'vehicles' ? 'danh sách xe' : 'danh sách tuyến đường'));
}
function formatDateVN(str) {
  if (!str) return '—';
  const p = str.split('-');
  if (p.length !== 3) return str;
  return p[2] + '/' + p[1] + '/' + p[0];
}
function formatDateInputLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}
function formatVND(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('vi-VN');
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Ant Design Icons — EditOutlined và DeleteOutlined, nhúng inline để ứng dụng dùng được khi offline.
const ANT_EDIT_ICON = '<svg viewBox="0 0 1024 1024" aria-hidden="true" focusable="false"><path d="M257.7 752c2 0 4-.2 6-.5L431.9 722c2-.4 3.9-1.3 5.3-2.8l423.9-423.9a9.96 9.96 0 0 0 0-14.1L694.9 114.9c-1.9-1.9-4.4-2.9-7.1-2.9s-5.2 1-7.1 2.9L256.8 538.8c-1.5 1.5-2.4 3.3-2.8 5.3l-29.5 168.2a33.5 33.5 0 0 0 9.4 29.8c6.6 6.4 14.9 9.9 23.8 9.9zm67.4-174.4L687.8 215l73.3 73.3-362.7 362.6-88.9 15.7 15.6-89zM880 836H144c-17.7 0-32 14.3-32 32v36c0 4.4 3.6 8 8 8h784c4.4 0 8-3.6 8-8v-36c0-17.7-14.3-32-32-32z"/></svg>';
const ANT_DELETE_ICON = '<svg viewBox="0 0 1024 1024" aria-hidden="true" focusable="false"><path d="M360 184h-8c4.4 0 8-3.6 8-8v8h304v-8c0 4.4 3.6 8 8 8h-8v72h72v-80c0-35.3-28.7-64-64-64H352c-35.3 0-64 28.7-64 64v80h72v-72zm504 72H160c-17.7 0-32 14.3-32 32v32c0 4.4 3.6 8 8 8h60.4l24.7 523c1.6 34.1 29.8 61 63.9 61h454c34.2 0 62.3-26.8 63.9-61l24.7-523H888c4.4 0 8-3.6 8-8v-32c0-17.7-14.3-32-32-32zM731.3 840H292.7l-24.2-512h487l-24.2 512z"/></svg>';

function focusRowEditor(tbodyId, id) {
  const row = document.querySelector('#' + tbodyId + ' [data-id="' + id + '"]');
  if (!row) return;
  const tr = row.closest('tr');
  const editor = tr && tr.querySelector('input[data-field], select[data-field]');
  if (!editor) return;
  editor.focus();
  if (typeof editor.select === 'function') editor.select();
}

function rowActionButtons(tbodyId, id, deleteHandler, deleteLabel) {
  return '<div class="row-actions">' +
    '<button type="button" class="btn icon-btn" title="Sửa" aria-label="Sửa dòng" onclick="focusRowEditor(\'' + tbodyId + '\',\'' + id + '\')">' + ANT_EDIT_ICON + '</button>' +
    '<button type="button" class="btn icon-btn danger" title="' + deleteLabel + '" aria-label="' + deleteLabel + '" onclick="' + deleteHandler + '(\'' + id + '\')">' + ANT_DELETE_ICON + '</button>' +
    '</div>';
}

let selection = { vehicle: new Set(), route: new Set(), booking: new Set(), cont: new Set() };

function updateBulkState(group) {
  const checks = document.querySelectorAll('.row-ck[data-group="' + group + '"]');
  const sel = selection[group];
  sel.clear();
  checks.forEach(c => { if (c.checked) sel.add(c.value); });
  const btn = document.getElementById(group + 'BulkDeleteBtn');
  const countEl = document.getElementById(group + 'SelCount');
  if (countEl) countEl.textContent = sel.size;
  if (btn) btn.disabled = sel.size === 0;
  const all = document.getElementById(group + 'CheckAll');
  if (all) {
    all.checked = checks.length > 0 && sel.size === checks.length;
    all.indeterminate = sel.size > 0 && sel.size < checks.length;
  }
}
function toggleAll(group, checked) {
  document.querySelectorAll('.row-ck[data-group="' + group + '"]').forEach(c => { c.checked = checked; });
  updateBulkState(group);
}

/* ======================= GENERIC TABLE HELPERS (BR-9 paste + onchange) ======================= */

// Xếp hàng các lệnh lưu theo từng dòng (theo id): nếu người dùng sửa nhiều ô của
// CÙNG 1 dòng liên tiếp nhanh (gõ nhanh, hoặc dán nhiều cột), các lệnh PUT phải
// hoàn thành ĐÚNG THỨ TỰ đã gửi — nếu không, lệnh gửi trước nhưng phản hồi về sau
// có thể ghi đè mất dữ liệu của lệnh gửi sau. Mỗi id có 1 hàng đợi riêng.
const _rowUpdateQueues = {};
function queueRowUpdate(id, fn) {
  const prev = _rowUpdateQueues[id] || Promise.resolve();
  const next = prev.then(fn, fn);
  _rowUpdateQueues[id] = next;
  return next;
}

// Excel đặt vào clipboard dạng text: xuống dòng ngăn cách DÒNG, ký tự Tab ngăn cách CỘT.
// Nhờ vậy dán được cả khối nhiều dòng × nhiều cột, không chỉ dán dọc theo một cột.
function parseClipboardGrid(text) {
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.map(line => line.split('\t').map(cell => cell.trim()));
}

// Chỉ chặn hành vi dán mặc định khi thực sự là khối nhiều ô (nhiều dòng hoặc nhiều cột).
function isClipboardBlock(grid) {
  return grid.length > 1 || (grid.length === 1 && grid[0].length > 1);
}

// Ngày dán từ Excel có thể là 07/09/2026, 07-09-2026 hoặc 2026-09-07 -> đưa hết về ISO yyyy-mm-dd.
// Không đọc được thì trả rỗng để không ghi dữ liệu rác vào ô ngày.
function parsePastedDate(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const m = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (!m) return '';
  return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
}

function attachTableHandlers(tbodyId, cfg) {
  // cfg: { getArray, createRemote(): Promise<row>, updateRemote(row): Promise<row>, renderFn, sanitizers, formatters, patchRowFn }
  // Quan trọng: onchange của 1 ô KHÔNG được render lại toàn bảng — nếu không, trong lúc
  // người dùng đang gõ tiếp các ô khác (cùng dòng hoặc dòng khác), DOM bị thay mới giữa
  // chừng sẽ xóa mất nội dung đang gõ dở. Chỉ patch đúng ô cần cập nhật (nếu có).
  const tbody = document.getElementById(tbodyId);

  tbody.addEventListener('change', function (e) {
    const t = e.target;
    if (!t.dataset || !t.dataset.field || t.classList.contains('row-ck')) return;
    const arr = cfg.getArray();
    const row = arr.find(x => x.id === t.dataset.id);
    if (!row) return;
    let val = t.value;
    if (cfg.sanitizers && cfg.sanitizers[t.dataset.field]) val = cfg.sanitizers[t.dataset.field](val);
    row[t.dataset.field] = val;
    // Giá trị hiển thị trên ô có thể khác giá trị lưu (VD: định dạng dấu . phần nghìn cho lương) —
    // formatters cho phép tách hiển thị khỏi giá trị thực sự gửi lên backend.
    const display = (cfg.formatters && cfg.formatters[t.dataset.field]) ? cfg.formatters[t.dataset.field](val) : val;
    if (display !== t.value) t.value = display; // phản ánh giá trị đã chuẩn hóa (VD: FR-1.1 bỏ ký tự đặc biệt)
    queueRowUpdate(row.id, async () => {
      try {
        const updated = await cfg.updateRemote(row);
        Object.assign(row, updated);
        if (cfg.patchRowFn) cfg.patchRowFn(row);
      } catch (err) { toast('Lỗi lưu: ' + err.message); }
    });
  });

  // Dán từ Excel: hỗ trợ cả dán DỌC (một cột nhiều dòng) lẫn dán NGANG / theo khối
  // (nhiều cột × nhiều dòng). Ô đang đặt con trỏ là góc trên-trái của vùng dán.
  tbody.addEventListener('paste', async function (e) {
    const t = e.target;
    if (!t.dataset || !t.dataset.field) return;
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (!text) return;
    const grid = parseClipboardGrid(text);
    if (!isClipboardBlock(grid)) return; // đúng 1 ô -> để hành vi dán mặc định của trình duyệt
    e.preventDefault();
    const fields = cfg.fieldOrder || [t.dataset.field];
    const startCol = Math.max(0, fields.indexOf(t.dataset.field));
    const arr = cfg.getArray();
    let startRow = arr.findIndex(x => x.id === t.dataset.id);
    if (startRow === -1) startRow = 0;
    let cells = 0, ignoredCols = 0;
    for (let i = 0; i < grid.length; i++) {
      const target = startRow + i;
      while (target >= arr.length) {
        // BR-9/A-7: tự tạo thêm dòng mới nếu dán dư
        arr.push(await cfg.createRemote());
      }
      const row = arr[target];
      grid[i].forEach((raw, j) => {
        const field = fields[startCol + j];
        if (!field) { ignoredCols++; return; } // dán tràn qua phải cột cuối -> bỏ qua
        let val = raw;
        if (cfg.sanitizers && cfg.sanitizers[field]) val = cfg.sanitizers[field](val);
        row[field] = val;
        cells++;
      });
      await queueRowUpdate(row.id, async () => {
        try {
          Object.assign(row, await cfg.updateRemote(row));
        } catch (err) { toast('Lỗi lưu: ' + err.message); }
      });
    }
    cfg.renderFn();
    const width = Math.max(...grid.map(r => r.length));
    toast('Đã dán ' + grid.length + ' dòng × ' + width + ' cột (' + cells + ' ô)' +
      (ignoredCols ? ' — bỏ qua ' + ignoredCols + ' ô vượt quá cột cuối' : ''));
  });
}

/* ======================= 1. KHAI BÁO XE ======================= */

async function loadVehicles() {
  vehicles = await api('/api/vehicles');
  renderVehicleTable();
}

function tagClass(tag) {
  if (tag === 'Ưu tiên phân công') return 'tag green';
  if (tag === 'Nghỉ nhiều · phân ít chuyến') return 'tag red';
  return 'tag blue';
}

function renderVehicleTable() {
  const q = (document.getElementById('vehicleSearch').value || '').toLowerCase();
  const body = document.getElementById('vehicleTableBody');
  const filtered = vehicles.filter(v => v.plate.toLowerCase().includes(q) || v.driver.toLowerCase().includes(q));
  if (filtered.length === 0) {
    body.innerHTML = '<tr class="empty-row"><td colspan="8">Không có xe nào — bấm "+ Thêm dòng" để bắt đầu.</td></tr>';
    updateBulkState('vehicle'); return;
  }
  body.innerHTML = filtered.map(v => (
    '<tr>' +
    '<td><input type="checkbox" class="ck row-ck" data-group="vehicle" value="' + v.id + '" onchange="updateBulkState(\'vehicle\')"></td>' +
    '<td><input type="text" data-field="plate" data-id="' + v.id + '" value="' + v.plate + '" placeholder="51D12345"></td>' +
    '<td><input type="text" data-field="driver" data-id="' + v.id + '" value="' + v.driver + '" placeholder="Nguyễn Văn A"></td>' +
    '<td><input type="text" data-field="phone" data-id="' + v.id + '" value="' + (v.phone || '') + '" placeholder="09xxxxxxxx"></td>' +
    '<td><input type="text" data-field="cccd" data-id="' + v.id + '" value="' + (v.cccd || '') + '" placeholder="CCCD"></td>' +
    '<td><input type="number" min="0" data-field="restDays" data-id="' + v.id + '" value="' + v.restDays + '"></td>' +
    '<td><span class="' + tagClass(v.tag) + '">' + v.tag + '</span></td>' +
    '<td>' + rowActionButtons('vehicleTableBody', v.id, 'deleteVehicleRow', 'Xóa xe') + '</td>' +
    '</tr>'
  )).join('');
  updateBulkState('vehicle');
}

async function addVehicleRow() {
  const v = await api('/api/vehicles', 'POST', { plate: '', driver: '', phone: '', cccd: '', restDays: 0 });
  vehicles.push(v);
  renderVehicleTable();
}
async function deleteVehicleRow(id) {
  await api('/api/vehicles/' + id, 'DELETE');
  vehicles = vehicles.filter(x => x.id !== id);
  renderVehicleTable();
  await refreshVehicleDependents();
}
async function deleteSelectedVehicles() {
  const ids = Array.from(selection.vehicle);
  if (ids.length === 0) return;
  await api('/api/vehicles/bulk-delete', 'POST', { ids });
  vehicles = vehicles.filter(v => !ids.includes(v.id));
  renderVehicleTable();
  await refreshVehicleDependents();
  toast('Đã xóa ' + ids.length + ' xe');
}
async function refreshVehicleDependents() {
  populateDetailVehicleFilter();
  await loadDetail();
  await loadTrips();
}

attachTableHandlers('vehicleTableBody', {
  getArray: () => vehicles,
  createRemote: () => api('/api/vehicles', 'POST', { plate: '', driver: '', phone: '', cccd: '', restDays: 0 }),
  updateRemote: (row) => api('/api/vehicles/' + row.id, 'PUT', row),
  renderFn: renderVehicleTable,
  fieldOrder: ['plate', 'driver', 'phone', 'cccd', 'restDays'], // thứ tự cột để dán ngang
  sanitizers: {
    plate: (v) => v.trim().replace(/[^a-zA-Z0-9]/g, ''), // FR-1.1
    restDays: (v) => Math.max(0, parseInt(String(v).replace(/\D/g, ''), 10) || 0),
  },
  patchRowFn: (row) => {
    // Chỉ cập nhật lại ô "Gợi ý phân công" (BR-1) — không đụng các ô khác đang có thể đang gõ dở
    const cell = document.querySelector('#vehicleTableBody tr:has(input[data-id="' + row.id + '"]) td:nth-child(7)');
    if (cell) cell.innerHTML = '<span class="' + tagClass(row.tag) + '">' + row.tag + '</span>';
    const plateInput = document.querySelector('#vehicleTableBody input[data-field="plate"][data-id="' + row.id + '"]');
    if (plateInput && document.activeElement !== plateInput) plateInput.value = row.plate;
  }
});

/* ======================= 2. CHUYẾN ĐI THÁNG NÀY ======================= */

function applyTripMonth() {
  const val = activePeriod;
  if (!val) return;
  document.getElementById('tripMonth').value = val.split('-').reverse().join('/');
  const [y, m] = val.split('-').map(Number);
  const first = new Date(y, m - 1, 1), last = new Date(y, m, 0);
  setDatePickerValue('tripFrom', formatDateInputLocal(first));
  setDatePickerValue('tripTo', formatDateInputLocal(last));
  loadTrips();
}

async function loadTrips() {
  const from = document.getElementById('tripFrom').value;
  const to = document.getElementById('tripTo').value;
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const data = await api('/api/trips?' + params.toString());

  document.getElementById('tripTotal').textContent = data.total;
  document.getElementById('tripNear').textContent = data.near;
  document.getElementById('tripFar').textContent = data.far;

  const body = document.getElementById('tripTableBody');
  if (data.byVehicle.length === 0) {
    body.innerHTML = '<tr class="empty-row"><td colspan="6">Chưa có xe nào.</td></tr>'; return;
  }
  body.innerHTML = data.byVehicle.map(s => (
    '<tr><td class="nowrap">' + s.plate + '</td><td>' + s.driver + '</td>' +
    '<td>' + s.near + '</td><td>' + s.far + '</td><td>' + s.total + '</td><td>' + s.restDays + '</td></tr>'
  )).join('');
}

// Callback chung cho hai DatePicker “Từ ngày / Đến ngày”.
function renderTrips() { return loadTrips(); }

/* ======================= 3. KHAI BÁO TUYẾN ĐƯỜNG ======================= */

async function loadRoutes() {
  routes = await api('/api/routes');
  renderRouteTable();
}

function renderRouteTable() {
  const body = document.getElementById('routeTableBody');
  if (routes.length === 0) {
    body.innerHTML = '<tr class="empty-row"><td colspan="6">Chưa có tuyến nào — bấm "+ Thêm dòng" để bắt đầu.</td></tr>';
    updateBulkState('route'); return;
  }
  body.innerHTML = routes.map(r => (
    '<tr>' +
    '<td><input type="checkbox" class="ck row-ck" data-group="route" value="' + r.id + '" onchange="updateBulkState(\'route\')"></td>' +
    '<td><input type="text" data-field="from" data-id="' + r.id + '" value="' + r.from + '" placeholder="Cảng Cát Lái"></td>' +
    '<td><input type="text" data-field="to" data-id="' + r.id + '" value="' + r.to + '" placeholder="KCN Sóng Thần"></td>' +
    '<td><select data-field="group" data-id="' + r.id + '"><option value="short" ' + (r.group === 'short' ? 'selected' : '') + '>Ngắn</option><option value="long" ' + (r.group === 'long' ? 'selected' : '') + '>Dài</option></select></td>' +
    '<td><input type="text" inputmode="numeric" data-field="wage" data-id="' + r.id + '" value="' + formatVND(r.wage || 0) + '" placeholder="0"></td>' +
    '<td>' + rowActionButtons('routeTableBody', r.id, 'deleteRouteRow', 'Xóa tuyến') + '</td>' +
    '</tr>'
  )).join('');
  updateBulkState('route');
}

async function addRouteRow() {
  const r = await api('/api/routes', 'POST', { from: '', to: '', group: 'short', wage: 0 });
  routes.push(r);
  renderRouteTable();
}
async function deleteRouteRow(id) {
  await api('/api/routes/' + id, 'DELETE');
  routes = routes.filter(x => x.id !== id);
  renderRouteTable();
  await refreshRouteDependents();
}
async function deleteSelectedRoutes() {
  const ids = Array.from(selection.route);
  if (ids.length === 0) return;
  await api('/api/routes/bulk-delete', 'POST', { ids });
  routes = routes.filter(r => !ids.includes(r.id));
  renderRouteTable();
  await refreshRouteDependents();
  toast('Đã xóa ' + ids.length + ' tuyến');
}
async function refreshRouteDependents() {
  await loadBookings();
  await loadDetail();
  await loadTrips();
}

attachTableHandlers('routeTableBody', {
  getArray: () => routes,
  createRemote: () => api('/api/routes', 'POST', { from: '', to: '', group: 'short', wage: 0 }),
  updateRemote: async (row) => {
    const updated = await api('/api/routes/' + row.id, 'PUT', row);
    // Tuyến đổi (điểm đi/đến/nhóm/lương) ảnh hưởng tới Module 4/6/2 (BR-10) — làm mới các màn đó,
    // nhưng KHÔNG render lại bảng Tuyến đường đang thao tác để tránh xóa nội dung đang gõ dở.
    await loadBookingsQuietly();
    await loadDetail();
    await loadTrips();
    return updated;
  },
  renderFn: renderRouteTable,
  fieldOrder: ['from', 'to', 'group', 'wage'],
  sanitizers: {
    wage: (v) => Math.max(0, parseInt(String(v).replace(/\D/g, ''), 10) || 0),
    // Dán từ Excel có thể là "Ngắn"/"Dài" (như cột hiển thị) hoặc "short"/"long"
    group: (v) => /^(long|dài|dai|xa)$/i.test(String(v).trim()) ? 'long' : 'short',
  },
  formatters: { wage: (v) => formatVND(v) }
});

// Nạp lại danh sách booking để cập nhật sổ chọn Tuyến đường, nhưng không vẽ lại bảng Booking
// (tránh xóa nội dung người dùng đang gõ dở ở màn Kế hoạch phân công nếu đang mở song song).
async function loadBookingsQuietly() {
  bookings = await api('/api/bookings');
}

/* ======================= 4. KẾ HOẠCH PHÂN CÔNG ======================= */

const DATE_ICON_SVG = '<svg viewBox="0 0 1024 1024"><path d="M880 184H712v-40c0-4.4-3.6-8-8-8h-56c-4.4 0-8 3.6-8 8v40H384v-40c0-4.4-3.6-8-8-8h-56c-4.4 0-8 3.6-8 8v40H144c-17.7 0-32 14.3-32 32v664c0 17.7 14.3 32 32 32h736c17.7 0 32-14.3 32-32V216c0-17.7-14.3-32-32-32zm-40 656H184V456h656v384zM184 384V256h136v32c0 4.4 3.6 8 8 8h48c4.4 0 8-3.6 8-8v-32h256v32c0 4.4 3.6 8 8 8h48c4.4 0 8-3.6 8-8v-32h136v128H184z"/></svg>';

// Ô ngày trong bảng Booking dùng chung DatePicker kiểu Ant Design với các màn khác (FR-6),
// thay cho <input type="date"> gốc trình duyệt. inputId mã hoá field+rowId để callback đổi ngày
// biết cần cập nhật ô nào (bảng render nhiều dòng nên không thể dùng id cố định như các DatePicker đơn lẻ khác).
function bookingDateCell(field, id, value) {
  const inputId = 'bk__' + field + '__' + id;
  const placeholderCls = value ? '' : ' placeholder';
  const text = value ? formatDateVN(value) : 'Chọn ngày';
  return '<div class="date-picker cell-date" data-input="' + inputId + '" data-mode="date" data-change="onBookingDateChange">' +
    '<input type="hidden" id="' + inputId + '" data-field="' + field + '" data-id="' + id + '" value="' + (value || '') + '">' +
    '<button type="button" class="date-picker-trigger' + placeholderCls + '" onclick="toggleDatePicker(this)">' +
    '<span class="date-picker-text">' + text + '</span>' + DATE_ICON_SVG + '</button>' +
    '<div class="date-picker-panel"></div></div>';
}

function onBookingDateChange(value, inputId) {
  const parts = inputId.split('__');
  if (parts.length !== 3) return;
  const field = parts[1], rowId = parts[2];
  const row = bookings.find(b => b.id === rowId);
  if (!row) return;
  row[field] = value;
  queueRowUpdate(rowId, async () => {
    try {
      const updated = await api('/api/bookings/' + rowId, 'PUT', row); // FR-4.2: backend tự tính lại Phân tách
      Object.assign(row, updated);
      await cascadeAfterBookingChange();
      // Chỉ patch 2 ô backend tự tính, không render lại toàn bảng (tránh xóa nội dung đang gõ dở ở dòng khác)
      const splitInput = document.querySelector('#bookingTableBody input[data-field="split"][data-id="' + rowId + '"]');
      if (splitInput && document.activeElement !== splitInput) splitInput.value = row.split || '';
      const progInput = document.querySelector('#bookingTableBody input[data-field="progress"][data-id="' + rowId + '"]');
      if (progInput && document.activeElement !== progInput) progInput.value = row.progress || '';
    } catch (err) { toast('Lỗi lưu: ' + err.message); }
  });
}

function routeOptionsHtml(selectedId) {
  return '<option value="">— chọn tuyến —</option>' + routes.map(r =>
    '<option value="' + r.id + '" ' + (r.id === selectedId ? 'selected' : '') + '>' + r.from + ' → ' + r.to + '</option>'
  ).join('');
}

async function loadBookings() {
  bookings = await api('/api/bookings');
  renderBookingTable();
}

function renderBookingTable() {
  const body = document.getElementById('bookingTableBody');
  document.getElementById('bookingCount').textContent = bookings.length + ' booking';
  if (bookings.length === 0) {
    body.innerHTML = '<tr class="empty-row"><td colspan="16">Chưa có booking nào — bấm "+ Thêm dòng" để bắt đầu.</td></tr>';
    updateBulkState('booking'); return;
  }
  body.innerHTML = bookings.map(b => {
    const id = b.id;
    return '<tr>' +
      '<td><input type="checkbox" class="ck row-ck" data-group="booking" value="' + id + '" onchange="updateBulkState(\'booking\')"></td>' +
      '<td><input type="text" data-field="customer" data-id="' + id + '" value="' + (b.customer || '') + '" placeholder="Công ty TNHH..."></td>' +
      '<td><select data-field="type" data-id="' + id + '"><option value="EXP" ' + (b.type === 'EXP' ? 'selected' : '') + '>EXP</option><option value="IMP" ' + (b.type === 'IMP' ? 'selected' : '') + '>IMP</option></select></td>' +
      '<td><input type="text" class="autofit" data-field="bookBill" data-id="' + id + '" value="' + (b.bookBill || '') + '" placeholder="BK-0906-001" oninput="autofitInput(this)"></td>' +
      '<td><input type="number" min="1" data-field="qty" data-id="' + id + '" value="' + (b.qty || 1) + '"></td>' +
      '<td><input type="text" data-field="carrier" data-id="' + id + '" value="' + (b.carrier || '') + '" placeholder="ONE, MSC..."></td>' +
      '<td>' + bookingDateCell('fromDate', id, b.fromDate) + '</td>' +
      '<td>' + bookingDateCell('toDate', id, b.toDate) + '</td>' +
      '<td><input type="text" data-field="cutoff" data-id="' + id + '" value="' + (b.cutoff || '') + '" placeholder="17:00-09/09/2026"></td>' +
      '<td><input type="text" data-field="legOutVessel" data-id="' + id + '" value="' + (b.legOutVessel || '') + '" placeholder="Tên tàu + ngày"></td>' +
      '<td><input type="text" data-field="legInVessel" data-id="' + id + '" value="' + (b.legInVessel || '') + '" placeholder="Tên tàu + ngày"></td>' +
      '<td><input type="text" data-field="split" data-id="' + id + '" value="' + (b.split || '') + '" placeholder="Tự tính"></td>' +
      '<td><input type="text" data-field="progress" data-id="' + id + '" value="' + (b.progress || '') + '" placeholder="0/' + (b.qty || 1) + '"></td>' +
      '<td><select data-field="routeId" data-id="' + id + '">' + routeOptionsHtml(b.routeId) + '</select></td>' +
      '<td><input type="text" data-field="note" data-id="' + id + '" value="' + (b.note || '') + '" placeholder="Ghi chú"></td>' +
      '<td>' + rowActionButtons('bookingTableBody', id, 'deleteBookingRow', 'Xóa booking') + '</td>' +
      '</tr>';
  }).join('');
  document.querySelectorAll('#bookingTableBody input.autofit').forEach(autofitInput);
  updateBulkState('booking');
}

// Ô Book/Bill co dãn theo độ dài ký tự đang gõ — đo bằng canvas với đúng font của ô
// (nhanh và không phải chèn thêm phần tử ẩn vào DOM ở mỗi lần gõ).
function autofitInput(el) {
  if (!el) return;
  const ctx = autofitInput._ctx || (autofitInput._ctx = document.createElement('canvas').getContext('2d'));
  const style = getComputedStyle(el);
  ctx.font = style.fontSize + ' ' + style.fontFamily;
  const text = el.value || el.placeholder || '';
  const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 4;
  el.style.width = Math.max(90, Math.ceil(ctx.measureText(text).width + padding)) + 'px';
}

async function addBookingRow() {
  const b = await api('/api/bookings', 'POST', {
    customer: '', type: 'EXP', bookBill: '', qty: 1, carrier: '', fromDate: '', toDate: '', cutoff: '',
    legOutVessel: '', legInVessel: '', split: '', progress: '', routeId: '', note: ''
  });
  bookings.push(b);
  renderBookingTable();
  await loadContainers();
}
async function deleteBookingRow(id) {
  await api('/api/bookings/' + id, 'DELETE');
  bookings = bookings.filter(x => x.id !== id);
  renderBookingTable();
  await cascadeAfterBookingChange();
}
async function deleteSelectedBookings() {
  const ids = Array.from(selection.booking);
  if (ids.length === 0) return;
  await api('/api/bookings/bulk-delete', 'POST', { ids });
  bookings = bookings.filter(b => !ids.includes(b.id));
  renderBookingTable();
  await cascadeAfterBookingChange();
  toast('Đã xóa ' + ids.length + ' booking');
}
async function cascadeAfterBookingChange() {
  await loadDetail();
  await loadTrips();
  await loadContainers();
}

attachTableHandlers('bookingTableBody', {
  getArray: () => bookings,
  createRemote: () => api('/api/bookings', 'POST', {
    customer: '', type: 'EXP', bookBill: '', qty: 1, carrier: '', fromDate: '', toDate: '', cutoff: '',
    legOutVessel: '', legInVessel: '', split: '', progress: '', routeId: '', note: ''
  }),
  updateRemote: async (row) => {
    const updated = await api('/api/bookings/' + row.id, 'PUT', row); // FR-4.2: backend tự tính lại Phân tách
    await cascadeAfterBookingChange(); // cập nhật Chi tiết/List cont/Trips ở CÁC MÀN KHÁC
    return updated;
  },
  renderFn: renderBookingTable,
  fieldOrder: ['customer', 'type', 'bookBill', 'qty', 'carrier', 'fromDate', 'toDate', 'cutoff',
    'legOutVessel', 'legInVessel', 'split', 'progress', 'routeId', 'note'],
  sanitizers: {
    qty: (v) => Math.max(1, parseInt(v, 10) || 1),
    type: (v) => /imp/i.test(String(v)) ? 'IMP' : 'EXP',
    fromDate: parsePastedDate,
    toDate: parsePastedDate,
    // Dán tên tuyến ("NSI - NSLC" hoặc "NSI → NSLC") thì tự tìm đúng tuyến đã khai
    routeId: (v) => {
      const text = String(v || '').replace(/[→-]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!text) return '';
      const hit = routes.find(r => (r.from + ' ' + r.to).replace(/\s+/g, ' ').trim().toLowerCase() === text);
      return hit ? hit.id : '';
    },
  },
  patchRowFn: (row) => {
    // Chỉ cập nhật đúng 2 ô do backend tự tính (Phân tách, Tiến độ) — không đụng các ô khác
    // của dòng này hay dòng khác đang có thể được gõ dở cùng lúc.
    const splitInput = document.querySelector('#bookingTableBody input[data-field="split"][data-id="' + row.id + '"]');
    if (splitInput && document.activeElement !== splitInput) splitInput.value = row.split || '';
    const progInput = document.querySelector('#bookingTableBody input[data-field="progress"][data-id="' + row.id + '"]');
    if (progInput && document.activeElement !== progInput) progInput.value = row.progress || '';
  }
});

async function saveAllBookings() {
  const res = await api('/api/bookings/save-all', 'POST', {});
  await loadBookings();
  await cascadeAfterBookingChange();
  if (res.mismatchCount > 0) toast('Đã lưu thay đổi — ' + res.mismatchCount + ' ô Phân tách không khớp nên đã tự tính lại');
  else toast('Đã lưu thay đổi');
}
// Đẩy toàn bộ booking (Số lượng/Phân tách/Từ ngày-Đến ngày) sang Báo cáo sản lượng: tự đồng bộ
// MỌI ngày có booking trong kỳ (tương đương bấm "Đồng bộ dữ liệu ngày này" cho từng ngày ở màn đó),
// rồi chuyển sang màn đó và mở sẵn ngày sớm nhất để xem ngay kết quả.
async function pushToProductionReport() {
  await saveAllBookings();
  try {
    await api('/api/containers/seed-from-bookings', 'POST', {}); // vẫn tạo sẵn dòng cont còn thiếu ở list cont
  } catch (err) { /* không chặn nếu seed list cont lỗi */ }
  let syncedFrom = '', syncedTo = '';
  try {
    const res = await api('/api/detail/sync-all', 'POST', {});
    syncedFrom = bookings.map(b => b.fromDate).filter(Boolean).sort()[0] || '';
    syncedTo = bookings.map(b => b.toDate || b.fromDate).filter(Boolean).sort().pop() || '';
    toast('Đã đồng bộ ' + res.rowCount + ' dòng trên ' + res.datesSynced + ' ngày sang Báo cáo sản lượng');
  } catch (err) {
    toast('Lỗi đồng bộ Báo cáo sản lượng: ' + err.message);
  }
  document.querySelector('.menu-item[data-screen="detail"]').click();
  if (syncedFrom && syncedTo) {
    setDatePickerValue('dFrom', syncedFrom);
    setDatePickerValue('dTo', syncedTo);
    await onDetailDateChange();
  }
}

/* ======================= 5. KHAI BÁO LIST CONT (màn độc lập, không phụ thuộc Kế hoạch phân công) ======================= */

// `containers` giữ TOÀN BỘ cont của kỳ (các màn Báo cáo cần đủ để map Số cont -> Loại cont/Số seal),
// còn `contListRows` chỉ là các dòng của Book/Bill đang mở trên màn "Khai báo list cont".
async function loadContainers() {
  containers = await api('/api/containers');
  if (activeContBookBill) contListRows = containers.filter(c => c.bookBill === activeContBookBill);
  renderContainerTable();
}

// Phải nhập số Book/Bill rồi bấm Load mới hiện dữ liệu — tránh sửa nhầm sang Book/Bill khác.
async function loadContainersByBookBill() {
  const bookBill = (document.getElementById('contBookBill').value || '').trim();
  if (!bookBill) return toast('Vui lòng nhập số Book/Bill rồi bấm Load');
  if (containerDirty && !confirm('Bạn đang có thay đổi chưa lưu — vẫn tải Book/Bill khác?')) return;
  activeContBookBill = bookBill;
  containerDirty = false;
  contListRows = await api('/api/containers?bookBill=' + encodeURIComponent(bookBill));
  containers = await api('/api/containers');
  renderContainerTable();
  toast(contListRows.length
    ? 'Đã tải ' + contListRows.length + ' dòng cont của ' + bookBill
    : 'Book/Bill ' + bookBill + ' chưa có dòng cont nào — bấm "+ Thêm dòng" để khai báo');
}

function renderContainerTable() {
  const body = document.getElementById('contTableBody');
  document.getElementById('contCount').textContent = contListRows.length + ' cont';
  if (!activeContBookBill) {
    body.innerHTML = '<tr class="empty-row"><td colspan="5">Nhập số Book/Bill ở ô phía trên rồi bấm <strong>Load</strong> để xem danh sách cont.</td></tr>';
    updateBulkState('cont'); return;
  }
  if (contListRows.length === 0) {
    body.innerHTML = '<tr class="empty-row"><td colspan="5">Book/Bill ' + escapeHtml(activeContBookBill) + ' chưa có dòng cont nào — bấm "+ Thêm dòng" để bắt đầu.</td></tr>';
    updateBulkState('cont'); return;
  }
  body.innerHTML = contListRows.map(c => (
    '<tr>' +
    '<td><input type="checkbox" class="ck row-ck" data-group="cont" value="' + c.id + '" onchange="updateBulkState(\'cont\')"></td>' +
    '<td><input type="text" data-field="bookBill" data-id="' + c.id + '" value="' + (c.bookBill || '') + '" placeholder="BK-0906-001"></td>' +
    '<td><input type="text" data-field="contNo" data-id="' + c.id + '" value="' + c.contNo + '" placeholder="TCLU1234567"></td>' +
    '<td><input type="text" data-field="contType" data-id="' + c.id + '" value="' + (c.contType || '') + '" placeholder="40HC"></td>' +
    '<td><input type="text" data-field="seal" data-id="' + c.id + '" value="' + c.seal + '" placeholder="SL1234567"></td>' +
    '</tr>'
  )).join('');
  updateBulkState('cont');
}

async function addContainerRow() {
  if (!activeContBookBill) return toast('Vui lòng nhập số Book/Bill rồi bấm Load trước');
  const c = await api('/api/containers', 'POST', { bookBill: activeContBookBill, contNo: '', contType: '', seal: '' });
  contListRows.push(c);
  containers.push(c);
  renderContainerTable();
  return c;
}
async function deleteSelectedContainers() {
  const ids = Array.from(selection.cont);
  if (ids.length === 0) return;
  await api('/api/containers/bulk-delete', 'POST', { ids });
  contListRows = contListRows.filter(c => !ids.includes(c.id));
  containers = containers.filter(c => !ids.includes(c.id));
  renderContainerTable();
  await loadDetail();
  toast('Đã xóa ' + ids.length + ' dòng cont');
}

// Đọc giá trị đang gõ trên bảng (nguồn sự thật là DOM vì màn này lưu thủ công bằng nút Lưu).
function collectContainerRowsFromDom() {
  return contListRows.map(c => {
    const get = (field) => {
      const el = document.querySelector('#contTableBody input[data-field="' + field + '"][data-id="' + c.id + '"]');
      return el ? el.value : c[field];
    };
    return {
      id: c.id,
      bookBill: get('bookBill'),
      customer: c.customer,
      contNo: get('contNo'),
      contType: get('contType'),
      seal: get('seal'),
    };
  });
}

async function saveContainers() {
  if (!activeContBookBill) return toast('Vui lòng nhập số Book/Bill rồi bấm Load trước');
  const items = collectContainerRowsFromDom();
  await api('/api/containers/save', 'POST', { items });
  containerDirty = false;
  toast('Đã lưu danh sách cont');
  await loadContainers();
  await loadDetail();
}

function renderContainerUploadFile(name, status, message, percent) {
  const list = document.getElementById('contUploadList');
  if (!list) return;
  if (!name) { list.innerHTML = ''; return; }
  const statusText = message || ({ uploading: 'Đang xử lý', done: 'Hoàn tất', error: 'Lỗi' }[status] || '');
  const fileIcon = '<svg class="upload-file-icon" viewBox="0 0 1024 1024" aria-hidden="true"><path d="M534 64H208c-26.5 0-48 21.5-48 48v800c0 26.5 21.5 48 48 48h608c26.5 0 48-21.5 48-48V394L534 64zm6 114.5L749.5 388H540V178.5zM792 888H232V136h236v296c0 15.5 12.5 28 28 28h296v428z"/></svg>';
  list.innerHTML = '<div class="upload-file ' + status + '">' + fileIcon +
    '<span class="upload-file-name" title="' + escapeHtml(name) + '">' + escapeHtml(name) + '</span>' +
    '<span class="upload-file-status">' + escapeHtml(statusText) + '</span>' +
    '<button type="button" class="upload-file-remove" title="Bỏ file" aria-label="Bỏ file" onclick="clearContainerUpload()">×</button>' +
    (status === 'uploading' ? '<div class="upload-progress"><span style="width:' + (percent || 35) + '%"></span></div>' : '') + '</div>';
}

function clearContainerUpload() {
  pendingContainerImport = [];
  const fileInput = document.getElementById('contExcelFile');
  if (fileInput) fileInput.value = '';
  renderContainerUploadFile('', '', '');
  const preview = document.getElementById('contImportPreview');
  if (preview) {
    preview.classList.remove('show', 'import-failed');
    preview.innerHTML = '';
  }
}

function showContainerImportError(message) {
  const box = document.getElementById('contImportPreview');
  if (!box) return;
  box.innerHTML = '<div class="import-preview-head"><span class="import-preview-mark">!</span><div>' +
    '<strong>Không thể đọc file Excel</strong><div class="import-preview-message">' + escapeHtml(message) + '</div></div></div>' +
    '<div class="import-preview-actions"><button class="btn primary" onclick="document.getElementById(\'contExcelFile\').click()">Chọn file khác</button>' +
    '<button class="btn" onclick="downloadExport(\'containers\')">Tải file mẫu đúng định dạng</button></div>';
  box.classList.add('show', 'import-failed');
}

async function previewContainerExcel(file) {
  if (!file) return;
  const preview = document.getElementById('contImportPreview');
  if (preview) {
    preview.classList.remove('show', 'import-failed');
    preview.innerHTML = '';
  }
  if (!file.name.toLowerCase().endsWith('.xlsx')) {
    renderContainerUploadFile(file.name, 'error', 'Chỉ nhận file .xlsx');
    showContainerImportError('Vui lòng chọn file Excel có định dạng .xlsx.');
    return;
  }
  renderContainerUploadFile(file.name, 'uploading', 'Đang kiểm tra', 40);
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const result = await api('/api/containers/import-preview', 'POST', { data: String(dataUrl).split(',')[1] });
    pendingContainerImport = result.valid || [];
    document.getElementById('contUploadList').dataset.fileName = file.name;
    renderContainerUploadFile(file.name, result.errorCount ? 'error' : 'done', result.errorCount ? result.errorCount + ' dòng lỗi' : result.validCount + ' dòng hợp lệ');
    const box = document.getElementById('contImportPreview');
    const errors = (result.errors || []).map(e => '<div>Dòng ' + e.line + ' (' + escapeHtml(e.bookBill) + '): ' + escapeHtml(e.errors.join('; ')) + '</div>').join('');
    box.innerHTML = '<strong>Xem trước import</strong><div>Hợp lệ: ' + result.validCount + ' dòng · Lỗi: ' + result.errorCount + ' dòng</div>' +
      (errors ? '<div class="import-errors">' + errors + '</div>' : '<div style="color:var(--success);margin:8px 0">Tất cả dữ liệu đều hợp lệ.</div>') +
      '<button class="btn primary" ' + (result.validCount === 0 ? 'disabled' : '') + ' onclick="confirmContainerImport()">Xác nhận nhập ' + result.validCount + ' dòng hợp lệ</button>';
    box.classList.remove('import-failed');
    box.classList.add('show');
  } catch (err) {
    pendingContainerImport = [];
    renderContainerUploadFile(file.name, 'error', 'Không xử lý được');
    showContainerImportError(err.message);
  }
}

async function confirmContainerImport() {
  if (!pendingContainerImport.length) return;
  const result = await api('/api/containers/import-confirm', 'POST', { items: pendingContainerImport });
  const uploadedName = document.getElementById('contUploadList').dataset.fileName || 'File Excel';
  pendingContainerImport = [];
  document.getElementById('contImportPreview').classList.remove('show');
  document.getElementById('contExcelFile').value = '';
  await loadContainers();
  await loadDetail();
  renderContainerUploadFile(uploadedName, 'done', 'Đã nhập ' + result.saved + ' dòng');
  toast('Đã import ' + result.saved + ' dòng container');
}

// Module 5: dán được cả dọc lẫn ngang. Màn này lưu thủ công (nút "Lưu danh sách cont") nên chỉ
// điền vào ô trên màn hình; thiếu dòng thì tự tạo thêm (giữ nguyên nội dung đang gõ dở khi vẽ lại).
const CONT_FIELDS = ['bookBill', 'contNo', 'contType', 'seal'];
document.getElementById('contTableBody').addEventListener('paste', async function (e) {
  const t = e.target;
  if (!t.dataset || !t.dataset.field) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if (!text) return;
  const grid = parseClipboardGrid(text);
  if (!isClipboardBlock(grid)) return; // 1 ô -> dán mặc định
  e.preventDefault();
  if (!activeContBookBill) return toast('Vui lòng nhập số Book/Bill rồi bấm Load trước');
  containerDirty = true;

  const startCol = Math.max(0, CONT_FIELDS.indexOf(t.dataset.field));
  const startRow = contListRows.findIndex(c => c.id === t.dataset.id);
  const from = startRow === -1 ? 0 : startRow;

  // Giữ lại nội dung đang gõ trên bảng trước khi tạo dòng mới (tạo dòng sẽ vẽ lại bảng).
  const pending = collectContainerRowsFromDom();
  contListRows.forEach((c, i) => Object.assign(c, pending[i]));
  let ignored = 0;
  while (from + grid.length > contListRows.length) {
    const created = await api('/api/containers', 'POST', { bookBill: activeContBookBill, contNo: '', contType: '', seal: '' });
    contListRows.push(created);
    containers.push(created);
  }
  grid.forEach((cells, i) => {
    cells.forEach((raw, j) => {
      const field = CONT_FIELDS[startCol + j];
      if (!field) { ignored++; return; }
      contListRows[from + i][field] = raw;
    });
  });
  renderContainerTable();
  const width = Math.max(...grid.map(r => r.length));
  toast('Đã dán ' + grid.length + ' dòng × ' + width + ' cột' +
    (ignored ? ' (bỏ qua ' + ignored + ' ô vượt cột cuối)' : '') + ' — nhớ bấm "Lưu danh sách cont"');
});
document.getElementById('contTableBody').addEventListener('change', function (e) {
  if (e.target && e.target.dataset && e.target.dataset.field) containerDirty = true;
});

/* ======================= 6. CHI TIẾT BÁO CÁO ======================= */

// Kiểm tra khoảng "từ ngày - đến ngày" của một màn báo cáo; trả null nếu chưa hợp lệ.
function reportRange(fromId, toId) {
  const from = document.getElementById(fromId).value;
  const to = document.getElementById(toId).value;
  if (!from || !to) return null;
  for (const value of [from, to]) {
    if (!value.startsWith(activePeriod + '-')) {
      toast('Khoảng ngày phải thuộc kỳ ' + activePeriod);
      return null;
    }
  }
  if (from > to) { toast("'Từ ngày' phải trước hoặc bằng 'Đến ngày'"); return null; }
  return { from, to };
}

async function loadDetail() {
  const range = reportRange('dFrom', 'dTo');
  if (!range) { detailRows = []; renderDetailTable(false); return; }
  const vehicleId = document.getElementById('dVehicle').value;
  const q = document.getElementById('dSearch').value;
  const params = new URLSearchParams();
  params.set('from', range.from);
  params.set('to', range.to);
  if (vehicleId) params.set('vehicleId', vehicleId);
  if (q) params.set('q', q);
  const result = await api('/api/detail?' + params.toString());
  detailRows = result.rows || [];
  detailUnsyncedDates = result.unsyncedDates || [];
  detailUsedContNos = result.usedContNos || {};
  renderDetailTable(result.synced);
}

async function onDetailDateChange() {
  await loadDetail();
}

async function syncDetailDay() {
  const range = reportRange('dFrom', 'dTo');
  if (!range) return toast('Vui lòng chọn khoảng ngày trước khi đồng bộ');
  const result = await api('/api/detail/sync', 'POST', { from: range.from, to: range.to });
  await loadDetail();
  toast('Đã đồng bộ ' + result.rowCount + ' dòng trong ' + result.datesSynced + ' ngày; dữ liệu đã nhập trước đó được giữ nguyên');
}

function scheduleDetailLoad() {
  clearTimeout(window.__detailFilterTimer);
  window.__detailFilterTimer = setTimeout(() => {
    loadDetail().catch(err => toast('Lỗi lọc báo cáo: ' + err.message));
  }, 250);
}

// Chỉ hiện biển số xe (không kèm tên tài xế) — tên tài xế xem ở màn Báo cáo BEE.
// Vẫn sắp xe nghỉ ít lên trước để ưu tiên phân công (BR-1).
function vehicleSelectOptions(selectedId) {
  const sorted = [...vehicles].sort((a, b) => a.restDays - b.restDays);
  return '<option value="">— chọn xe —</option>' + sorted.map(v =>
    '<option value="' + v.id + '" ' + (v.id === selectedId ? 'selected' : '') + '>' + v.plate + '</option>'
  ).join('');
}

// BR-11/US-6: cont đã chọn cho một Book/Bill thì không hiện lại ở dòng khác của cùng Book/Bill.
// Danh sách cont đã dùng lấy từ server theo CẢ KỲ (detailUsedContNos) nên vẫn loại trừ đúng khi
// 1 Book/Bill trải qua nhiều ngày mà màn hình chỉ đang xem một khoảng ngày.
function usedContNosForBookBill(bookBill, excludeKey) {
  const used = new Set(detailUsedContNos[bookBill || ''] || []);
  // Bổ sung các dòng đang hiển thị (phòng khi vừa đổi mà chưa kịp tải lại từ server).
  detailRows.forEach(r => { if (r.bookBill === bookBill && r.key !== excludeKey && r.contNo) used.add(r.contNo); });
  // Cont của chính dòng đang xét vẫn phải hiện ra để giữ lựa chọn hiện tại.
  const self = detailRows.find(r => r.key === excludeKey);
  if (self && self.contNo) used.delete(self.contNo);
  return used;
}
// Mapping theo Book/Bill (không còn theo bookingId nội bộ) — Khai báo list cont là màn độc lập,
// cont nào khai đúng Book/Bill của dòng thì hiện ra cho chọn.
function contSelectOptionsForRow(row) {
  const allForBookBill = containers.filter(c => c.bookBill === row.bookBill && c.contNo);
  const used = usedContNosForBookBill(row.bookBill, row.key);
  const available = allForBookBill.filter(c => !used.has(c.contNo));
  if (available.length === 0 && !row.contNo) return '<option value="">— chưa khai list cont —</option>';
  return '<option value="">— chọn cont —</option>' + available.map(c =>
    '<option value="' + c.contNo + '" ' + (c.contNo === row.contNo ? 'selected' : '') + '>' + c.contNo + '</option>'
  ).join('');
}

// Sau khi đã chọn Số cont, ẩn sổ chọn đi (chỉ hiện lại khi bấm "Đổi") — tránh chọn nhầm/đổi liên tục.
let detailContEditing = new Set();
function contNoCellHtml(row) {
  if (row.contNo && !detailContEditing.has(row.key)) {
    return '<span class="readonly">' + escapeHtml(row.contNo) + '</span> ' +
      '<button type="button" class="btn text" onclick="reopenContSelect(\'' + row.key + '\')">Đổi</button>';
  }
  return '<select data-key="' + row.key + '" data-field="contNo" onchange="onDetailFieldChange(this)">' + contSelectOptionsForRow(row) + '</select>';
}
function reopenContSelect(key) {
  detailContEditing.add(key);
  renderDetailTable();
}

function populateDetailVehicleFilter() {
  ['dVehicle', 'beeVehicle'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">Tất cả xe</option>' + vehicles.map(v => '<option value="' + v.id + '">' + v.plate + '</option>').join('');
    sel.value = current;
  });
}
function renderDetailTable(synced) {
  document.getElementById('detailCount').textContent = detailRows.length + ' dòng';
  const body = document.getElementById('detailTableBody');
  if (detailRows.length === 0) {
    const hasRange = document.getElementById('dFrom').value && document.getElementById('dTo').value;
    let message = 'Hãy chọn khoảng ngày làm việc trước khi đồng bộ dữ liệu.';
    if (hasRange && synced === false) message = 'Khoảng ngày này chưa được đồng bộ — bấm “Đồng bộ khoảng ngày này”.';
    if (hasRange && synced === true) message = 'Khoảng ngày này đã đồng bộ nhưng không có booking cần thực hiện.';
    body.innerHTML = '<tr class="empty-row"><td colspan="12">' + message + '</td></tr>';
    return;
  }
  body.innerHTML = detailRows.map((r, i) => (
    '<tr>' +
    '<td>' + (i + 1) + '</td>' +
    '<td class="nowrap readonly">' + r.bookBill + '</td>' +
    '<td>' + contNoCellHtml(r) + '</td>' +
    '<td class="readonly">' + (r.contType || '—') + '</td>' +
    '<td class="readonly">' + (r.seal || '—') + '</td>' +
    '<td class="readonly">' + r.customer + '</td>' +
    '<td><select data-key="' + r.key + '" data-field="vehicleId" onchange="onDetailFieldChange(this)">' + vehicleSelectOptions(r.vehicleId) + '</select></td>' +
    '<td class="nowrap readonly">' + formatDateVN(r.date) + '</td>' +
    '<td class="readonly">' + (r.routeLabel || '—') + '</td>' +
    '<td class="readonly">' + (r.wage !== null && r.wage !== undefined ? formatVND(r.wage) : '—') + '</td>' +
    '<td><input type="text" data-key="' + r.key + '" data-field="note" value="' + (r.note || '') + '" onchange="onDetailFieldChange(this)" placeholder="Ghi chú"></td>' +
    '<td><input type="text" data-key="' + r.key + '" data-field="vendor" value="' + (r.vendor || 'GRAI') + '" onchange="onDetailFieldChange(this)"></td>' +
    '</tr>'
  )).join('');
}

async function onDetailFieldChange(el) {
  const key = el.dataset.key, field = el.dataset.field, value = el.value;
  await api('/api/detail/' + encodeURIComponent(key), 'PUT', { [field]: value });
  if (field === 'contNo') detailContEditing.delete(key); // đã chọn xong -> ẩn sổ chọn lại
  await loadDetail(); // để cập nhật lại loại trừ cont (BR-11) và các ô chỉ-đọc phụ thuộc
  if (field === 'vehicleId') await loadTrips();
  await loadBee();
}

/* ======================= 7. BÁO CÁO BEE ======================= */

// Dùng chung dữ liệu với Báo cáo sản lượng (/api/detail), chỉ hiển thị từ cột STT đến cột Ngày
// và chèn thêm Họ tên + Số điện thoại tài xế lấy theo xe đã phân công.
async function loadBee() {
  const range = reportRange('beeFrom', 'beeTo');
  if (!range) { beeRows = []; renderBeeTable(false); return; }
  const vehicleId = document.getElementById('beeVehicle').value;
  const q = document.getElementById('beeSearch').value;
  const params = new URLSearchParams();
  params.set('from', range.from);
  params.set('to', range.to);
  if (vehicleId) params.set('vehicleId', vehicleId);
  if (q) params.set('q', q);
  const result = await api('/api/detail?' + params.toString());
  beeRows = result.rows || [];
  renderBeeTable(result.synced);
}

async function onBeeDateChange() {
  await loadBee();
}

function scheduleBeeLoad() {
  clearTimeout(window.__beeFilterTimer);
  window.__beeFilterTimer = setTimeout(() => {
    loadBee().catch(err => toast('Lỗi lọc báo cáo BEE: ' + err.message));
  }, 250);
}

function renderBeeTable(synced) {
  document.getElementById('beeCount').textContent = beeRows.length + ' dòng';
  const body = document.getElementById('beeTableBody');
  if (beeRows.length === 0) {
    const hasRange = document.getElementById('beeFrom').value && document.getElementById('beeTo').value;
    let message = 'Hãy chọn khoảng ngày để xem báo cáo.';
    if (hasRange && synced === false) message = 'Khoảng ngày này chưa được đồng bộ — vào Báo cáo sản lượng bấm “Đồng bộ khoảng ngày này”.';
    if (hasRange && synced === true) message = 'Khoảng ngày này không có dòng nào.';
    body.innerHTML = '<tr class="empty-row"><td colspan="10">' + message + '</td></tr>';
    return;
  }
  body.innerHTML = beeRows.map((r, i) => (
    '<tr>' +
    '<td>' + (i + 1) + '</td>' +
    '<td class="nowrap readonly">' + escapeHtml(r.bookBill || '') + '</td>' +
    '<td class="readonly">' + escapeHtml(r.contNo || '—') + '</td>' +
    '<td class="readonly">' + escapeHtml(r.contType || '—') + '</td>' +
    '<td class="readonly">' + escapeHtml(r.seal || '—') + '</td>' +
    '<td class="readonly">' + escapeHtml(r.customer || '') + '</td>' +
    '<td class="nowrap readonly">' + escapeHtml(r.vehiclePlate || '—') + '</td>' +
    '<td class="readonly">' + escapeHtml(r.vehicleDriver || '—') + '</td>' +
    '<td class="nowrap readonly">' + escapeHtml(r.vehiclePhone || '—') + '</td>' +
    '<td class="nowrap readonly">' + formatDateVN(r.date) + '</td>' +
    '</tr>'
  )).join('');
}

/* ======================= INIT ======================= */

function toggleMenuGroup(head) {
  head.parentElement.classList.toggle('collapsed');
}

// Kéo giãn/thu hẹp bề ngang cột: kéo đường viền phải của tiêu đề cột. Chỉ cần gắn 1 lần lúc khởi
// động vì <thead> là markup tĩnh — mỗi lần render lại bảng chỉ thay <tbody>, không tạo lại <th>.
// Bề rộng đã chỉnh được nhớ theo trình duyệt (localStorage) để lần sau mở lại vẫn giữ nguyên.
function initResizableTables() {
  document.querySelectorAll('.table-scroll table').forEach(table => {
    const tbody = table.querySelector('tbody');
    const tableKey = tbody ? tbody.id : '';
    table.querySelectorAll('thead th').forEach((th, idx) => {
      if (th.classList.contains('col-check')) return; // cột checkbox không cần kéo giãn
      if (th.classList.contains('col-autofit')) return; // cột tự co dãn theo nội dung — không kéo tay/không nhớ bề rộng
      const storageKey = tableKey ? 'colw:' + tableKey + ':' + idx : '';
      const saved = storageKey ? localStorage.getItem(storageKey) : null;
      if (saved) { th.style.width = saved + 'px'; th.style.minWidth = saved + 'px'; }
      const handle = document.createElement('span');
      handle.className = 'col-resize-handle';
      handle.title = 'Kéo để đổi bề ngang cột — bấm đúp để về mặc định';
      handle.addEventListener('mousedown', (e) => startColumnResize(e, th, storageKey));
      handle.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        th.style.width = '';
        th.style.minWidth = '';
        if (storageKey) localStorage.removeItem(storageKey);
      });
      th.appendChild(handle);
    });
  });
}

function startColumnResize(e, th, storageKey) {
  e.preventDefault();
  const startX = e.clientX;
  const startWidth = th.getBoundingClientRect().width;
  const handle = e.target;
  handle.classList.add('active');
  document.body.classList.add('col-resizing');
  function onMove(ev) {
    const newWidth = Math.max(50, Math.round(startWidth + (ev.clientX - startX)));
    th.style.width = newWidth + 'px';
    th.style.minWidth = newWidth + 'px';
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    handle.classList.remove('active');
    document.body.classList.remove('col-resizing');
    if (storageKey) localStorage.setItem(storageKey, String(Math.round(th.getBoundingClientRect().width)));
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

async function init() {
  try {
    const session = await fetch('/api/session').then(r => r.json());
    if (!session.authenticated) {
      window.location.href = '/login.html';
      return;
    }
  } catch (e) {}
  initResizableTables();
  document.querySelectorAll('.menu-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.menu-item').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.screen').forEach(x => x.classList.remove('active'));
      item.classList.add('active');
      const id = item.dataset.screen;
      document.getElementById(id).classList.add('active');
      document.getElementById('pageTitle').textContent = item.querySelector('.label').textContent;
    });
  });
  const suggested = localStorage.getItem('containerPlannerLastPeriod') || currentMonthValue();
  setDatePickerValue('activePeriod', '');
  setDatePickerValue('gatePeriod', suggested);
  document.addEventListener('click', (event) => {
    // .date-picker-panel: bù cho panel của ô ngày trong bảng (.cell-date) — panel này bị tách ra
    // <body> khi mở (xem positionCellPanel) nên không còn nằm trong .date-picker để closest() nhận ra.
    if (!event.target.closest('.date-picker, .date-picker-panel')) closeDatePickers();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDatePickers(); });
}

init();
