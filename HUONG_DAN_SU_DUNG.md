# Hướng Dẫn Sử Dụng Manga Translator AI (Bản Chia Sẻ Độc Lập)

Chào mừng bạn đến với **Manga Translator AI** — Giải pháp dịch truyện manga tốc độ cao, hỗ trợ đọc trực tiếp trên MangaDex (đè bong bóng thoại) và đọc truyện offline từ máy tính qua Web Reader.

> [!NOTE]
> Để tìm hiểu sâu về kiến trúc kỹ thuật, giải thuật và cách thức hoạt động của từng engine AI (Comic-Text-Detector, Manga-OCR, Google Translate streaming, Vision LLM), vui lòng xem thêm file tài liệu: [KIEN_TRUC_VA_NGUYEN_LY_HOAT_DONG.md](KIEN_TRUC_VA_NGUYEN_LY_HOAT_DONG.md).

---

## 🌟 Các Tính Năng Nổi Bật

1. **⚡ Chế Độ Miễn Phí 100% (Không Cần API Key):**
   - Sử dụng **Comic-Text-Detector** định vị khung thoại trên GPU/CPU.
   - Hỗ trợ 3 Engine OCR: **Manga-OCR** (chuyên Manga Nhật), **RapidOCR EN** (chuyên Comic tiếng Anh / font scanlation), **RapidOCR CH** (chuyên Manhua tiếng Trung).
   - Tự động nhận diện ngôn ngữ chương truyện trên MangaDex kèm tính năng ghi đè thủ công khi nhãn bị sai.
   - Dịch qua **Google Translate API** hoàn toàn miễn phí, tốc độ ~0.2s - 0.5s / trang!
2. **🤖 Hỗ Trợ Mô Hình AI Ngôn Ngữ Lớn (LLM):**
   - Có thể cấu hình API Key để dịch bằng **Qwen 3.5**, **Gemini**, **OpenAI GPT-4o**, v.v. để câu văn mượt mà, chuẩn văn phong truyện tranh.
3. **📖 Đa Nền Tảng:**
   - **MangaDex Overlay (Userscript):** Đọc trực tiếp trên web MangaDex, dịch đè lên ảnh gốc mà không cần tải truyện về máy.
   - **Local Web Reader:** Đọc các thư mục ảnh truyện có sẵn trong máy tính với giao diện đọc Web hiện đại.

---

## 🚀 Hướng Dẫn Cài Đặt (Chỉ Cần 1 Click)

### Bước 1: Chuẩn bị Python
Đảm bảo máy tính đã cài **Python** (phiên bản 3.10, 3.11 hoặc 3.12) từ [python.org](https://www.python.org/downloads/).
> [!IMPORTANT]
> Trong quá trình cài đặt Python, **bắt buộc phải tích chọn ô: "Add python.exe to PATH"**.

### Bước 2: Tự động cài đặt thư viện & tải mô hình
- Nhấp đúp chuột vào file: **`install_requirements.bat`**
- File này sẽ tự động:
  1. Tạo môi trường ảo Python (`.venv`).
  2. Cài đặt các thư viện cần thiết (`requirements.txt`) bao gồm DirectML tăng tốc GPU AMD/NVIDIA/Intel.
  3. Tự động kiểm tra và tải 2 mô hình AI (`Comic-Text-Detector` và `Manga-OCR`) từ HuggingFace về máy.
- Chờ đến khi terminal báo: **🎉 CÀI ĐẶT HOÀN TẤT 100%!** là xong.

---

## 💻 Cách Khởi Động Server

- Nhấp đúp chuột vào file: **`start_server.bat`**
- Cửa sổ terminal server sẽ mở và trình duyệt sẽ tự động bật trang **Web Reader**: `http://127.0.0.1:8765`
- Giữ cửa sổ terminal này chạy trong lúc bạn đọc truyện. Khi nào không dùng nữa, chỉ cần nhấn `Ctrl + C` hoặc bấm nút `X` để đóng.

---

## 🌐 Hướng Dẫn Cài Đặt Đọc Trực Tiếp Trên MangaDex

Để bản dịch tự động hiện đè lên truyện trên trang web `mangadex.org`:

1. Cài đặt tiện ích mở rộng **Tampermonkey** (hoặc **Violentmonkey**) trên trình duyệt Chrome, Edge, Brave hoặc Firefox:
   - [Tampermonkey cho Chrome / Edge / Brave](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - [Tampermonkey cho Firefox](https://addons.mozilla.org/vi/firefox/addon/tampermonkey/)
2. Mở file **`mangadex_overlay.user.js`** trong thư mục này bằng Notepad (hoặc bất kỳ trình soạn thảo nào), sao chép toàn bộ nội dung (`Ctrl + A` -> `Ctrl + C`).
3. Mở tiện ích Tampermonkey trên trình duyệt -> Chọn **Create a new script (Tạo script mới)** -> Dán đè toàn bộ code vào -> Bấm **File -> Save (Ctrl + S)**.
4. Giờ đây, chỉ cần bật `start_server.bat`, sau đó vào bất kỳ chương truyện nào trên MangaDex (tiếng Anh hoặc tiếng Nhật), bạn sẽ thấy bảng điều khiển dịch xuất hiện ngay góc phải màn hình!

---

## 📁 Hướng Dẫn Đọc Truyện Có Sẵn Trong Máy Tính (Local Web Reader)

1. Mở trình duyệt vào địa chỉ: `http://127.0.0.1:8765` (được tự động mở khi chạy `start_server.bat`).
2. Chọn **"Chọn thư mục ảnh chapter"** hoặc kéo thả folder chứa các file ảnh (`.jpg`, `.png`, `.webp`) của tập truyện vào.
3. Ứng dụng sẽ tự động tải lên, nhận diện bóng thoại, bóc chữ tiếng Nhật và dịch ngay lập tức cho bạn đọc từng trang theo phong cách webtoon hoặc từng trang lật.

---

## ⚙️ Hướng Dẫn Cấu Hình Chế Độ Dịch & API Key (Tùy Chọn)

Mặc định dự án được cấu hình chạy chế độ **`⚡ OCR + Dịch [Google Translate]`** hoàn toàn miễn phí và không cần API Key.

Nếu bạn muốn chuyển sang dịch bằng LLM (như Qwen, Gemini, OpenAI):
1. Truy cập trang cài đặt trên Web Reader: `http://127.0.0.1:8765/settings.html`
2. Chọn tab dịch mong muốn:
   - **⚡ OCR + Dịch ➔ 🤖 LLM Text:** Manga-OCR bóc chữ rồi gửi văn bản thuần lên LLM dịch. (Tiết kiệm token 95%, tốc độ cao).
   - **🖼️ Ảnh + Vision ➔ 🚀 Vision LLM:** Cắt ảnh gửi thẳng lên Multimodal Vision AI.
3. Điền **API Key** và **Base URL** của bạn (ví dụ: xKiro API, OpenRouter, hoặc Google AI Studio).
4. Bấm **Lưu Cấu Hình**. Cấu hình sẽ được lưu vào file `config.json` trên máy bạn và áp dụng tức thì.

---

## 🛠️ Khắc Phục Sự Cố Thường Gặp

| Tình trạng | Cách xử lý |
| :--- | :--- |
| **Server báo lỗi thiếu model** | Chạy lại file `download_models.py` bằng lệnh: `.\.venv\Scripts\python.exe download_models.py` khi có kết nối mạng. |
| **Userscript trên MangaDex không hiện bảng dịch** | Kiểm tra xem `start_server.bat` đã bật chưa (phải thấy dòng `Server đang chạy tại http://127.0.0.1:8765`). Đảm bảo Tampermonkey đang bật script. |
| **Muốn chạy trên máy không có GPU rời** | Hệ thống sử dụng thư viện `onnxruntime-directml` tương thích với mọi card GPU onboard (Intel HD/Iris, AMD Radeon 680M/780M) lẫn card rời và tự động fallback về CPU nếu không có GPU. |
