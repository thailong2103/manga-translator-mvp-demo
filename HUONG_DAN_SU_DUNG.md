# Sổ Tay Hướng Dẫn Sử Dụng MangaStream AI

> **Tài liệu hướng dẫn chi tiết dành cho người dùng: Quy trình cài đặt tự động, đọc truyện trực tiếp trên MangaDex đè tiếng Việt thời gian thực, đọc truyện cục bộ từ máy tính và thiết lập cấu hình dịch thuật.**

---

## Mục Lục

1. [Tổng Quan Hệ Thống](#1-tổng-quan-hệ-thống)
2. [Quy Trình Cài Đặt 3 Bước](#2-quy-trình-cài-đặt-3-bước)
3. [Sử Dụng Tiện Ích Trực Tiếp Trên MangaDex](#3-sử-dụng-tiện-ích-trực-tiếp-trên-mangadex)
4. [Đọc Truyện Cục Bộ Qua Web Reader](#4-đọc-truyện-cục-bộ-qua-web-reader)
5. [Thiết Lập API & Mô Hình Dịch Thuật](#5-thiết-lập-api--mô-hình-dịch-thuật)
6. [Bảng Phím Tắt Thao Tác](#6-bảng-phím-tắt-thao-tác)
7. [Giải Đáp Các Vấn Đề Thường Gặp (FAQ)](#7-giải-đáp-các-vấn-đề-thường-gặp-faq)

---

## 1. Tổng Quan Hệ Thống

MangaStream AI là giải pháp dịch truyện tranh tự động được tối ưu hóa cho môi trường cục bộ:
- **Đọc trực tiếp trên website MangaDex**: Tự động nhận diện khung thoại và phủ bản dịch tiếng Việt trực tiếp lên trang truyện khi người dùng lướt web.
- **Đọc truyện ngoại tuyến từ máy tính**: Kéo thả thư mục ảnh scan vào giao diện Web Reader để đọc và dịch tự động.
- **Hỗ trợ 3 ngôn ngữ nguồn**:
  - Tiếng Nhật (Manga): Sử dụng mô hình Manga-OCR nhận diện Kanji, chữ viết dọc và chữ phiên âm nhỏ (Furigana).
  - Tiếng Anh (Scanlation): Sử dụng mô hình RapidOCR EN bóc tách chữ in hoa cách điệu và font Comic.
  - Tiếng Trung (Manhua): Sử dụng mô hình RapidOCR CH nhận diện chữ Hán Giản thể và Phồn thể.
- **Chế độ miễn phí mặc định**: Tích hợp Google Translate API tốc độ cao (~150ms/trang), không bắt buộc đăng ký API Key.

---

## 2. Quy Trình Cài Đặt 3 Bước

### Bước 2.1: Chuẩn Bị Python
1. Tải bộ cài đặt Python (phiên bản 3.10, 3.11 hoặc 3.12) từ [python.org/downloads](https://www.python.org/downloads/).
2. Trong trình cài đặt, bắt buộc tích chọn ô:
   ```text
   [x] Add python.exe to PATH
   ```
3. Nhấn **Install Now** và chờ quá trình cài đặt hoàn tất.

### Bước 2.2: Cài Đặt Thư Viện & Mô Hình AI Tự Động
1. Truy cập thư mục dự án `manga-translator-mvp-demo`.
2. Khởi chạy file: **`install_requirements.bat`**.
3. Quá trình tự động bao gồm:
   - Tạo môi trường ảo `.venv` độc lập.
   - Cài đặt các thư viện DirectML GPU, OpenCV, Transformers, RapidOCR, Manga-OCR.
   - Kiểm tra và tải 3 mô hình AI: `comic-text-detector.onnx`, `manga-ocr-onnx` và `rapidocr`.
4. Khi nhận được thông báo hoàn tất, đóng cửa sổ dòng lệnh.

### Bước 2.3: Khởi Động Máy Chủ Dịch
1. Khởi chạy file: **`start_server.bat`**.
2. Trình duyệt tự động mở giao diện Web Reader tại địa chỉ: `http://127.0.0.1:8765`.
3. Duy trì cửa sổ dòng lệnh chạy ngầm trong suốt phiên đọc truyện.

---

## 3. Sử Dụng Tiện Ích Trực Tiếp Trên MangaDex

### 3.1. Cài Đặt Userscript (Thực hiện một lần duy nhất)
1. Cài đặt tiện ích mở rộng Tampermonkey cho trình duyệt:
   - [Tampermonkey cho Chrome / Edge / Brave](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - [Tampermonkey cho Firefox](https://addons.mozilla.org/vi/firefox/addon/tampermonkey/)
2. Mở Web Reader tại `http://127.0.0.1:8765`, chọn nút **MangaDex Script** trên thanh điều hướng.
3. Nhấp chọn **Cài Đặt Userscript (1-Click)**.
4. Trình duyệt chuyển hướng đến tab xác nhận của Tampermonkey, bấm chọn **Install**.

### 3.2. Đọc Truyện Trên MangaDex
1. Truy cập vào bất kỳ chương truyện nào trên [mangadex.org](https://mangadex.org).
2. Thanh công cụ điều khiển tự động hiển thị ở góc dưới bên phải màn hình:
   - Bấm **Dịch Chapter Này** để bắt đầu quy trình nhận diện và dịch thuật.
   - Sử dụng phím tắt **`T`** để ẩn hoặc hiện lớp phủ tiếng Việt nhằm so sánh với bản vẽ gốc.
3. Trường hợp nhãn ngôn ngữ bị gán nhầm:
   - Nếu chương truyện tiếng Anh bị gán nhãn tiếng Nhật, bấm chọn mô hình OCR từ `Auto` sang cố định `Rapid EN`. Hệ thống sẽ khóa cấu hình này cho chương hiện tại.

---

## 4. Đọc Truyện Cục Bộ Qua Web Reader

1. Truy cập `http://127.0.0.1:8765` trên trình duyệt và chọn tab **Trình Đọc**.
2. Thêm truyện vào ứng dụng:
   - Kéo thả trực tiếp thư mục ảnh hoặc tập hợp các file ảnh (`.jpg`, `.png`, `.webp`) vào cửa sổ trình duyệt.
   - Hoặc bấm chọn **Thêm Truyện** trên thanh điều hướng và chọn thư mục cần đọc.
3. Điền tiêu đề tập truyện và nhấn **Bắt Đầu Dịch**.
4. Các chế độ xem:
   - **Chế độ cuộn**: Tối ưu hóa cho định dạng Webtoon cuộn dọc.
   - **Chế độ lật trang**: Đọc từng trang với phím mũi tên `←` / `→` hoặc `A` / `D`.
5. Tùy chỉnh bong bóng thoại:
   - Nhấp vào nút tinh chỉnh hiển thị trên thanh điều hướng.
   - Điều chỉnh thanh trượt độ mờ nền khung thoại và tỷ lệ kích thước chữ theo nhu cầu.

---

## 5. Thiết Lập API & Mô Hình Dịch Thuật

Trên thanh điều hướng chính, chuyển sang tab **Cài Đặt**.

### 5.1. Chế Độ Mặc Định (Google Translate Miễn Phí)
- Tại mục Bộ Dịch Thuật, chọn **Google Dịch (Free)**.
- Hệ thống nhận diện chữ bằng phần cứng máy trạm và dịch qua Google Translate API, không đòi hỏi API Key.

### 5.2. Chế Độ Mô Hình Ngôn Ngữ Lớn (LLM)
Khi cần nâng cao chất lượng câu thoại theo ngữ cảnh văn học:
1. Tại mục Bộ Dịch Thuật, chọn **LLM Text (API Key)**.
2. Tại mục Thông Tin API Key:
   - Chọn nhà cung cấp từ danh sách cấu hình mẫu (xKiro API, Google Gemini, OpenRouter, Groq, OpenAI, Ollama).
   - Nhập khóa API của nhà cung cấp vào ô tương ứng.
3. Nhấp chọn **Kiểm Tra Kết Nối** để xác nhận tính hợp lệ của endpoint và khóa truy cập.
4. Bấm **Lưu Cấu Hình Ngay** để lưu trữ và áp dụng thay đổi.

### 5.3. Quản Lý Đa Hồ Sơ (Profiles)
- Hệ thống hỗ trợ tạo nhiều hồ sơ cấu hình riêng biệt phục vụ cho các thể loại truyện hoặc nhà cung cấp khác nhau.
- Chọn **Thêm Mới** để khởi tạo hồ sơ và chuyển đổi qua menu lựa chọn.

---

## 6. Bảng Phím Tắt Thao Tác

| Phím tắt | Thao tác | Mô tả chi tiết |
| :---: | :--- | :--- |
| <kbd>T</kbd> | Bật / Tắt bản dịch | Ẩn lớp phủ tiếng Việt để hiển thị chữ gốc và tranh vẽ scan |
| <kbd>A</kbd> hoặc <kbd>←</kbd> | Trang trước | Lùi về trang trước trong chế độ lật trang |
| <kbd>D</kbd> hoặc <kbd>→</kbd> | Trang sau | Tiến tới trang kế tiếp trong chế độ lật trang |
| <kbd>F</kbd> | Toàn màn hình | Chuyển đổi qua lại chế độ toàn màn hình |
| <kbd>Esc</kbd> | Đóng hộp thoại | Tắt các cửa sổ popover và hộp thoại modal |

---

## 7. Giải Đáp Các Vấn Đề Thường Gặp (FAQ)

### Hệ thống có hoạt động khi không có card đồ họa rời hay không?
Có. Thư viện `onnxruntime-directml` hỗ trợ tăng tốc trên cả GPU tích hợp (Intel UHD, Iris Xe, AMD Radeon 680M/780M) và card đồ họa rời. Trong trường hợp phần cứng không hỗ trợ DirectX 12, hệ thống tự động sử dụng CPU để xử lý.

### Tại sao giao diện MangaDex không kết nối được tới máy chủ?
Cần đảm bảo tiến trình `start_server.bat` đang chạy tại địa chỉ `http://127.0.0.1:8765` và tiện ích Tampermonkey đang ở trạng thái kích hoạt đối với domain `mangadex.org`.

### Dữ liệu tạm thời được lưu trữ ở đâu?
Dữ liệu được tổ chức tại hai thư mục trong thư mục gốc dự án:
- `cache_chapters/`: Chứa file ảnh tải tạm từ MangaDex.
- `output_translations/`: Chứa dữ liệu tọa độ bong bóng thoại định dạng JSON.
Người dùng có thể xóa các thư mục này định kỳ để giải phóng dung lượng ổ cứng.
