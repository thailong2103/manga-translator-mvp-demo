# 🚀 MangaDex AI Translator Overlay (Tiếng Việt)

> **Hệ thống dịch truyện tranh AI siêu tốc, đè bản dịch tiếng Việt trực tiếp lên bong bóng thoại MangaDex & Local Web Reader.**  
> Hỗ trợ đa ngôn ngữ (**Tiếng Nhật, Tiếng Anh, Tiếng Trung**), tăng tốc phần cứng GPU DirectX 12 qua DirectML, kiến trúc hoàn toàn **Torchless** nhẹ nhàng và an toàn.

---

## 🌟 Điểm Nổi Bật

- ⚡ **Băng chuyền Streaming Siêu Tốc (Time-to-First-Read ~1.5s)**: Tải đến đâu, nhận diện bong bóng thoại và hiển thị bản dịch ngay đến đó — không cần đợi tải toàn bộ chương truyện.
- 🔍 **Đa Dạng Mô Hình Bóc Chữ (Multi-Engine OCR Torchless)**:
  - 🇯🇵 **Manga-OCR (Tiếng Nhật)**: Chuyên biệt giải mã Kanji, Furigana (dọc & ngang), Hiragana, Katakana trong Manga gốc.
  - 🇬🇧 **RapidOCR (Tiếng Anh / Latinh)**: Bóc chuẩn xác các font Comic nghệ thuật, bảo toàn dấu cách và dấu câu tiếng Anh cho các bản scanlation.
  - 🇨🇳 **RapidOCR (Tiếng Trung)**: Chuyên dụng bóc chữ Hán Giản thể & Phồn thể trong Manhua Trung Quốc.
- 🤖 **Tự Động Nhận Diện & Khóa Thủ Công (Auto-detect & Manual Override)**:
  - Tự động nhận diện ngôn ngữ chương truyện trên MangaDex để chuyển đổi model OCR phù hợp.
  - **Tính năng ghi đè thủ công**: Cho phép chọn cứng một model OCR để loại trừ trường hợp uploader trên MangaDex gắn nhầm nhãn cờ ngôn ngữ.
- 🎨 **2 Phương Pháp Xử Lý Linh Hoạt (Dual-Pipeline Architecture)**:
  - **Pipeline 1: OCR + Trans**: Bóc chữ trước ➔ Dịch qua **Google Translate** (miễn phí 100%, không cần API Key, ~150ms/trang) hoặc **LLM Text-only** (siêu rẻ token).
  - **Pipeline 2: Image + Vision LLM**: Đánh số Set-of-Mark `[1]`, `[2]` lên tranh ➔ Gửi Vision AI (**Gemini 2.5 Flash / Qwen 3.5 VL**) dịch theo biểu cảm nhân vật.
- 🛡️ **Bảo Mật API Key & Multi-Profile**: Lưu riêng từng profile độc lập, che mờ API Key an toàn trên UI, chặn commit nhầm lên Git 100%.
- 🖥️ **Độc Lập Client-Server Cục Bộ**: Chạy backend Python trên máy, Frontend là Userscript Tampermonkey trên MangaDex hoặc Local Web Reader — mượt mà, không đơ lag tab trình duyệt.

---

## 🏗️ Sơ Đồ Kiến Trúc Hệ Thống

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                               FRONTEND CLIENTS                                        │
│  [MangaDex Web + Userscript Overlay]                 [Local Web Reader (Browser)]       │
│  - Theo dõi DOM ảnh truyện MangaDex                 - Kéo thả thư mục ảnh cục bộ      │
│  - Tự nhận diện nhãn ngôn ngữ chapter                - Chế độ cuộn Webtoon / Single Page│
│  - Hiển thị bản dịch đè khít lên bong bóng           - Tùy chỉnh Font / Màu / Độ mờ     │
└───────────────────────────┬───────────────────────────────────┬────────────────────────┘
                            │ (HTTP REST / Polling)             │
                            ▼                                   ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                       LOCAL BACKEND SERVER (overlay_server.py)                         │
│  Cổng: 8765 | Xử lý request, quản lý file tĩnh, điều phối pipeline dịch               │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                  PIPELINE DỊCH STREAMING (mangadex_batch_translator.py)               │
│                                                                                        │
│  ┌─────────────────────────┐     ┌──────────────────────────────────────────────────┐  │
│  │ 1. MangaDex Fetcher     │ ──► │ 2. Comic-Text-Detector ONNX                      │  │
│  │ - Cào metadata & URLs   │     │    - DirectML GPU AMD / NVIDIA / Intel / CPU     │  │
│  │ - Async Prefetch trang  │     │    - Định vị bounding box [x, y, w, h]           │  │
│  └─────────────────────────┘     └────────────────────────┬─────────────────────────┘  │
│                                                           │                            │
│                 ┌─────────────────────────────────────────┴───────────────────────┐   │
│                 ▼                                                                 ▼   │
│  ┌───────────────────────────────┐                             ┌───────────────────┐  │
│  │ PIPELINE A: OCR + DỊCH        │                             │ PIPELINE B: VISION│  │
│  │ (Tiết kiệm token, siêu tốc)   │                             │ (Multimodal LLM)  │  │
│  │                               │                             │                   │  │
│  │ 3. Bộ OCR Lựa Chọn:           │                             │ 3. Set-of-Mark    │  │
│  │    ├─► Manga-OCR (Tiếng Nhật) │                             │    - Đánh số [1], │  │
│  │    ├─► RapidOCR (Tiếng Anh)   │                             │      [2] lên ảnh  │  │
│  │    └─► RapidOCR (Tiếng Trung) │                             │                   │  │
│  │                               │                             │ 4. Vision API     │  │
│  │ 4. Bộ Dịch:                   │                             │    - Qwen 3.5 /   │  │
│  │    ├─► Google Dịch (~150ms)   │                             │      Gemini Flash │  │
│  │    ├─► LLM Text-only          │                             │    - Dịch theo ảnh│  │
│  │    └─► Raw (Giữ chữ gốc)      │                             └─────────┬─────────┘  │
│  └──────────────┬────────────────┘                                       │            │
│                 │                                                        │            │
│                 └─────────────────────────┬──────────────────────────────┘            │
│                                           ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│  │ 5. Ghi Đĩa & Bắn Dữ Liệu Tức Thì (Real-Time Dispatch)                            │ │
│  │    - Ghi JSON từng trang ngay khi xong (không đợi cả chương)                     │ │
│  │    - Frontend nhận và render ngay lập tức (Time-To-First-Read ~1.5s)              │ │
│  └──────────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Hướng Dẫn Cài Đặt 1-Click (Dành Cho Windows)

### Bước 1: Chuẩn Bị
- Cài đặt [Python 3.10+](https://www.python.org/downloads/) (Nhớ tích chọn **Add python.exe to PATH** khi cài).
- Cài tiện ích [Tampermonkey](https://www.tampermonkey.net/) trên trình duyệt (Chrome, Edge, Brave, Firefox).

### Bước 2: Tải Dự Án & Cài Đặt Thư Viện Tự Động
1. Clone hoặc tải mã nguồn về máy:
   ```bash
   git clone https://github.com/vide-coding/Manga-Translator-Share.git
   cd Manga-Translator-Share
   ```
2. Nhấp đúp vào file **`install_requirements.bat`**:
   - Tự động tạo môi trường ảo Python `.venv`.
   - Tự động cài đặt toàn bộ thư viện cần thiết (`onnxruntime-directml`, `manga-ocr-torchless`, `rapidocr-onnxruntime`, `opencv-python`, ...).
   - Tự động tải và kiểm thử các mô hình AI (`comic-text-detector.onnx`, `manga-ocr`, `rapidocr`).

### Bước 3: Khởi Động Server & Cài Đặt Userscript
1. Nhấp đúp vào file **`start_server.bat`**:
   - Server cục bộ sẽ lắng nghe tại cổng `http://127.0.0.1:8765`.
   - Trình duyệt sẽ tự động mở trang **Local Web Reader / Cài Đặt**.
2. Cài Userscript lên Tampermonkey:
   - Truy cập vào link: [http://127.0.0.1:8765/mangadex_overlay.user.js](http://127.0.0.1:8765/mangadex_overlay.user.js)
   - Tampermonkey sẽ mở giao diện xác nhận ➔ Nhấn **Cài đặt (Install)**.

### Bước 4: Thưởng Thức Truyện Tranh
- Truy cập bất kỳ chương truyện nào trên [MangaDex](https://mangadex.org/).
- Một nút điều khiển nổi (Floating Button) hình dịch thuật sẽ xuất hiện ở góc màn hình.
- Nhấn **🚀 Dịch Chapter Này** (hoặc dùng phím tắt `T` để ẩn/hiện bản dịch).
- Hệ thống sẽ tự động nhận diện tiếng Anh/Nhật/Trung để chọn engine phù hợp, hoặc bạn có thể chỉnh tay trên menu nổi.

---

## ⚙️ Cấu Hình Nâng Cao

Bạn có thể chỉnh sửa cấu hình qua giao diện web tại `http://127.0.0.1:8765/settings`:
- **Chuyển đổi Pipeline**: `ocr_trans` (nhanh, nhẹ, tiết kiệm) hoặc `image_trans` (Vision AI đa phương thức).
- **Chọn OCR Engine**: `manga_ocr` (tiếng Nhật), `rapid_ocr_en` (tiếng Anh), `rapid_ocr_ch` (tiếng Trung).
- **Auto-detect Language**: Bật/tắt tính năng tự động nhận diện ngôn ngữ chương MangaDex.
- **Profiles API Key**: Hỗ trợ Google AI Studio (Gemini 2.5 Flash), OpenRouter, xKiro, DeepSeek, OpenAI, Groq, hoặc Ollama cục bộ.

Chi tiết cách sử dụng xem tại: [HUONG_DAN_SU_DUNG.md](HUONG_DAN_SU_DUNG.md).  
Chi tiết nguyên lý giải thuật xem tại: [KIEN_TRUC_VA_NGUYEN_LY_HOAT_DONG.md](KIEN_TRUC_VA_NGUYEN_LY_HOAT_DONG.md).

---

## 📄 Giấy Phép (License)

Dự án được phát hành dưới giấy phép mã nguồn mở [MIT License](LICENSE).
Mọi đóng góp (Pull Request / Issue) từ cộng đồng đều được hoan nghênh!
