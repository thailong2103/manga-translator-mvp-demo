# Kiến Trúc Hệ Thống & Nguyên Lý Hoạt Động

> **Tài liệu kỹ thuật trình bày cấu trúc kiến trúc, giải thuật, luồng dữ liệu và nguyên lý vận hành của từng thành phần trong hệ thống MangaStream AI.**

---

## Mục Lục
1. [Tổng Quan Kiến Trúc Tổng Thể](#1-tổng-quan-kiến-trúc-tổng-thể)
2. [Chi Tiết Các Engine AI & Xử Lý Dữ Liệu](#2-chi-tiết-các-engine-ai--xử-lý-dữ-liệu)
   - [Engine 1: Comic-Text-Detector (Định vị khung thoại)](#engine-1-comic-text-detector-định-vị-khung-thoại)
   - [Engine 2: Multi-Engine OCR Torchless (Nhận diện chữ Nhật - Anh - Trung)](#engine-2-multi-engine-ocr-torchless-nhận-diện-chữ-nhật---anh---trung)
   - [Engine 3: Google Translate Batch Stream (Dịch siêu tốc)](#engine-3-google-translate-batch-stream-dịch-siêu-tốc)
   - [Engine 4: LLM Text-Only Translator (Dịch theo ngữ cảnh hội thoại)](#engine-4-llm-text-only-translator-dịch-theo-ngữ-cảnh-hội-thoại)
   - [Engine 5: Multimodal Vision LLM Translator (Dịch theo ngữ cảnh tranh)](#engine-5-multimodal-vision-llm-translator-dịch-theo-ngữ-cảnh-tranh)
3. [Luồng Xử Lý Băng Chuyền Streaming (Pipeline Logic)](#3-luồng-xử-lý-băng-chuyền-streaming-pipeline-logic)
4. [Engine Hiển Thị: MangaDex Overlay Userscript](#4-engine-hiển-thị-mangadex-overlay-userscript)
5. [Giao Diện Local Web Reader & Quản Lý Cấu Hình](#5-giao-diện-local-web-reader--quản-lý-cấu-hình)
6. [Bảo Mật & Cơ Chế Auto-Download Model](#6-bảo-mật--cơ-chế-auto-download-model)

---

## 1. Tổng Quan Kiến Trúc Tổng Thể

Hệ thống hoạt động theo mô hình **Client-Server cục bộ (Local Decoupled Architecture)**:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                               FRONTEND CLIENTS                                        │
│  [MangaDex Web + Userscript Overlay]                 [Local Web Reader (Browser)]       │
│  - Theo dõi DOM ảnh truyện MangaDex                 - Kéo thả thư mục ảnh cục bộ      │
│  - Bắt Chapter UUID / Link ảnh                       - Chế độ cuộn Webtoon / Single Page│
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
│  │ - Cào metadata & URLs   │     │    - DirectML GPU AMD / NVIDIA / CPU             │  │
│  │ - Async Prefetch trang  │     │    - Tìm tọa độ bounding box [x, y, w, h]        │  │
│  └─────────────────────────┘     └────────────────────────┬─────────────────────────┘  │
│                                                           │                            │
│                 ┌─────────────────────────────────────────┴───────────────────────┐   │
│                 ▼                                                                 ▼   │
│  ┌───────────────────────────────┐                             ┌───────────────────┐  │
│  │ PIPELINE A: OCR + DỊCH        │                             │ PIPELINE B: VISION│  │
│  │ (Tiết kiệm token, siêu tốc)   │                             │ (Multimodal LLM)  │  │
│  │                               │                             │                   │  │
│  │ 3. Multi-Engine OCR Torchless │                             │ 3. Set-of-Mark    │  │
│  │    ├─ Manga-OCR (Tiếng Nhật)  │                             │    - Đánh số [1], │  │
│  │    ├─ RapidOCR (Tiếng Anh)    │                             │      [2] lên ảnh  │  │
│  │    └─ RapidOCR (Tiếng Trung)  │                             │                   │  │
│  │                               │                             │ 4. Vision API     │  │
│  │ 4. Bộ Dịch Lựa Chọn:          │                             │    - Qwen 3.5 /   │  │
│  │    ├─ Google Translate        │                             │      Gemini Flash │  │
│  │    ├─ LLM Text-only Prompt    │                             │    - Dịch theo ảnh│  │
│  │    └─ Raw (Giữ nguyên gốc)    │                             └─────────┬─────────┘  │
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

## 2. Chi Tiết Các Engine AI & Xử Lý Dữ Liệu

### Engine 1: Comic-Text-Detector (Định vị khung thoại)
* **File mô hình:** `models/comic-text-detector.onnx` (~94 MB).
* **Nguồn gốc:** Mô hình mạng nơ-ron tích chập (CNN) được huấn luyện chuyên biệt trên hàng chục nghìn trang manga/comic để phát hiện chính xác mọi hình dạng bóng thoại (tròn, bầu dục, chữ nhật, gai nhọn, thoại không viền).
* **Tăng tốc phần cứng (Hardware Acceleration):**
  - Sử dụng `onnxruntime-directml` với ưu tiên `['DmlExecutionProvider', 'CPUExecutionProvider']`.
  - Chạy trực tiếp trên GPU AMD Radeon, NVIDIA GeForce hoặc Intel Iris Xe thông qua DirectX 12.
  - Thời gian xử lý: **~120ms – 170ms** cho một trang truyện độ phân giải 2K.
* **Nguyên lý tiền xử lý (Preprocessing):**
  1. Giữ nguyên tỷ lệ khung hình (Aspect Ratio): Tính tỷ lệ scale = 1024 / max(h, w).
  2. Resize ảnh về kích thước chuẩn và đắp viền đen (Zero-padding) thành hình vuông chuẩn `1024 x 1024 x 3`.
  3. Chuẩn hóa ma trận điểm ảnh về dải `[0.0, 1.0]`.
* **Hậu xử lý (Postprocessing):**
  1. Lấy ma trận xác suất bóng thoại và văn bản từ output của ONNX.
  2. Áp dụng ngưỡng nhị phân (Thresholding) và thuật toán tìm đường bao `cv2.findContours`.
  3. Quy đổi ngược tọa độ từ ảnh vuông 1024x1024 về độ phân giải gốc của ảnh manga.
  4. Mở rộng biên (Padding Expansion) 5% về mỗi phía để tránh cắt cụt dấu câu hoặc mép chữ.

---

### Engine 2: Multi-Engine OCR Torchless (Nhận diện chữ Nhật - Anh - Trung)

Hệ thống hỗ trợ 3 mô hình OCR cục bộ chạy hoàn toàn không cần PyTorch (Torchless), sử dụng trực tiếp `onnxruntime-directml`:

1. **Manga-OCR ONNX (`manga_ocr`) - Chuyên Tiếng Nhật**:
   * **File mô hình:** `mayocream/manga-ocr-onnx` (~870 MB).
   * **Kiến trúc:** Vision Transformer (ViT) Encoder + RoBERTa/BERT Decoder tự hồi quy (`cl-tohoku/bert-base-japanese-char`).
   * **Thế mạnh:** Bóc tách tuyệt đối chuẩn xác Kanji phức tạp, Hiragana, Katakana, Furigana dọc/ngang và chữ viết tay trong Manga gốc.
   * **Chuẩn hóa:** Dùng `jaconv` để xử lý khoảng trắng, dấu ngoặc và dạng chữ nửa độ rộng (Half-width).

2. **RapidOCR ONNX (`rapid_ocr_en`) - Chuyên Tiếng Anh / Ký tự Latinh**:
   * **Nền tảng:** PaddleOCR ONNX siêu nhẹ (~15 MB).
   * **Thế mạnh:** Nhận diện xuất sắc các font chữ Comic hoa/thường, chữ nghệ thuật trong bản dịch scanlation tiếng Anh.
   * **Bảo toàn khoảng trắng:** Tự động sắp xếp các dòng thoại theo tọa độ y từ trên xuống dưới và nối bằng dấu cách chuẩn xác (`" ".join(...)`), không bị lỗi dính chữ như Manga-OCR.

3. **RapidOCR ONNX (`rapid_ocr_ch`) - Chuyên Tiếng Trung**:
   * **Nền tảng:** PaddleOCR ONNX hỗ trợ chữ Hán Giản thể (Simplified) và Phồn thể (Traditional).
   * **Thế mạnh:** Bóc tách trọn vẹn câu thoại trong Manhua Trung Quốc, loại bỏ khoảng cách thừa.

* **Cơ chế Tự Động Nhận Diện & Ghi Đè Thủ Công (Auto-detect & Manual Override):**
  - **Tự động nhận diện (Auto-detect)**: Khi người dùng mở một chapter trên MangaDex, frontend đọc thuộc tính `translatedLanguage` (`ja`, `en`, `zh`, ...). Hệ thống tự động kích hoạt Engine OCR tương ứng (`ja` sang Manga-OCR, `zh` sang RapidOCR Trung, `en`/khác sang RapidOCR Anh).
  - **Tính năng loại trừ nhãn sai (Manual Override)**: Khi người dùng bấm chọn thủ công một Engine OCR trên thanh menu, hệ thống sẽ **khóa cứng (Lock)** lựa chọn đó cho chapter hiện tại, ngăn thuật toán tự động can thiệp (hữu ích khi uploader trên MangaDex gắn nhầm cờ ngôn ngữ). Người dùng có thể nhấn `Auto` để khôi phục bất kỳ lúc nào.

---

### Engine 3: Google Translate Batch Stream (Dịch siêu tốc)
* **Cơ chế:** Gọi trực tiếp qua cổng Google Translate Web API.
* **Tối ưu hóa Gom Cụm (Batching Optimization):**
  - Thông thường nếu một trang có 10 bóng thoại, việc gửi 10 HTTP requests tuần tự sẽ mất ~1.5 giây và dễ bị giới hạn tần suất (Rate-limit).
  - Hệ thống sử dụng thuật toán **Ghép văn bản bằng ký tự xuống dòng (`\n`)**: Toàn bộ 8 - 15 câu thoại của một trang được nối thành một chuỗi duy nhất gửi đi trong **chỉ 1 HTTP POST/GET request**.
  - Sau khi Google trả về, server tách ngược lại thành từng câu tương ứng với ID của từng bóng thoại.
* **Thời gian đáp ứng:** Chỉ **~150ms – 250ms** cho toàn bộ một trang truyện.
* **Chi phí:** Hoàn toàn miễn phí, không yêu cầu API Key.

---

### Engine 4: LLM Text-Only Translator (Dịch theo ngữ cảnh hội thoại)
* **Mục đích:** Dành cho người đọc muốn chất lượng dịch văn học cao cấp, hiểu ngữ cảnh nhân vật và giữ được sự tự nhiên của câu thoại.
* **Tối ưu hóa Token:** Thay vì gửi ảnh lớn chiếm 1,000 – 3,000 token/trang, chế độ này chỉ gửi text thuần đã bóc tách từ Manga-OCR / RapidOCR:
  ```json
  [
    {"id": 1, "text": "お前… 本当にそれでいいのか？"},
    {"id": 2, "text": "ああ、後悔はない。行くぞ！"}
  ]
  ```
* **Prompt thiết kế chuyên biệt:** Yêu cầu mô hình giữ nguyên ID, dịch tự nhiên chuẩn văn phong truyện tranh Việt Nam, không thêm lời bình luận.
* **Tiết kiệm:** Giảm hơn **90% chi phí token** so với Vision AI, tốc độ xử lý nhanh gấp 3 lần.

---

### Engine 5: Multimodal Vision LLM Translator (Dịch theo ngữ cảnh tranh)
* **Phương pháp Set-of-Mark (SoM):**
  1. Vẽ các khung viền màu nổi bật và đánh nhãn số to rõ ràng `[1]`, `[2]`, `[3]` trực tiếp lên ảnh gốc trước khi gửi đến AI.
  2. Gửi ảnh kèm câu lệnh: *"Hãy nhìn vào các nhãn số [1], [2] trong tranh và dịch nội dung tương ứng sang tiếng Việt"*.
* **Ưu điểm:** AI có thể nhìn thấy biểu cảm khuôn mặt của nhân vật (giận dữ, ngại ngùng, vui vẻ) để chọn đại từ xưng hô phù hợp (cậu - tớ, anh - em, mày - tao) mà phương pháp đọc text thuần không thể nắm bắt được.

---

## 3. Luồng Xử Lý Băng Chuyền Streaming (Pipeline Logic)

Điểm cốt lõi giúp hệ thống đạt hiệu năng cao là kiến trúc **Băng Chuyền Độc Lập (Pipelined Dispatch)**:

```
Thời gian ──►  0s           1s           2s           3s           4s           5s
Trang 1:      [Tải ảnh] ──► [Detect] ──► [OCR/Dịch] ──► [ĐỌC ĐƯỢC NGAY! (t=1.5s)]
Trang 2:                    [Tải ảnh] ──► [Detect] ─► [OCR/Dịch] ─► [Xong t=2.2s]
Trang 3:                                 [Tải ảnh] ──► [Detect] ─► [OCR/Dịch] ─► [Xong t=2.9s]
```

### Nguyên lý hoạt động:
1. **Ưu tiên số 1 (Time-To-First-Read):** Trang đầu tiên (Trang 1 hoặc trang người dùng đang mở) luôn được tải và xử lý trước với độ ưu tiên cao nhất. Người đọc có thể bắt đầu đọc truyện ngay sau **1.5 – 2 giây**, không bao giờ phải chờ tải xong toàn bộ chương.
2. **Xử lý đa luồng ngầm (Background Worker Threads):** Các trang tiếp theo được tải song song bằng `ThreadPoolExecutor` trong khi người dùng đang đọc trang trước.
3. **Cập nhật lũy tiến (Incremental Saving):** Sau mỗi trang hoàn thành, file JSON được ghi ra đĩa ngay lập tức dưới khóa bảo vệ `threading.Lock()`. Bất kỳ yêu cầu thăm dò nào từ giao diện đọc cũng sẽ nhận được dữ liệu mới nhất mà không gặp xung đột ghi file.

---

## 4. Engine Hiển Thị: MangaDex Overlay Userscript

File: `mangadex_overlay.user.js`

### 1. Cơ Chế Bắt DOM Động & Không Nghẽn Tab (Non-blocking MutationObserver)
- MangaDex là ứng dụng đơn trang (SPA) xây dựng bằng Vue/Nuxt, các phần tử ảnh liên tục được tải động (Lazy loading) khi cuộn trang.
- Userscript dùng `MutationObserver` lắng nghe sự xuất hiện của các thẻ `<img src="...">` trong khung đọc truyện `.reader--page`.
- Tự động tách `chapter_uuid` từ URL đường dẫn (ví dụ: `mangadex.org/chapter/7f134bf1-6a3d-4945-8409-fedc3c786ae2`).

### 2. Thuật Toán Biến Đổi Hệ Tọa Độ (Coordinate Projection)
- Tọa độ trong file JSON là tọa độ pixel tĩnh trên ảnh gốc (ví dụ: `1600 x 2400`).
- Khi hiển thị trên trình duyệt, ảnh bị co giãn theo màn hình (Responsive width, zoom).
- Userscript tính toán tỷ lệ co giãn động theo thời gian thực:
  - `scale_x = img.clientWidth / original_width`
  - `scale_y = img.clientHeight / original_height`
  - `left = orig_x * scale_x + img.offsetLeft`
  - `top = orig_y * scale_y + img.offsetTop`
- Đảm bảo bong bóng thoại dịch luôn nằm khít đè lên bóng thoại gốc dù người dùng phóng to, thu nhỏ hay xoay màn hình.

### 3. Tự Động Điều Chỉnh Kích Thước Chữ (Auto Font Fitting)
- Dựa trên diện tích của hộp thoại `w * h` và độ dài của câu văn bản tiếng Việt.
- Thuật toán tự động tính toán cỡ chữ (`fontSize` từ `11px` đến `24px`) và căn giữa hoàn hảo để bản dịch vừa vặn bên trong quả bóng thoại trắng, không bị tràn hay mất chữ.

---

## 5. Giao Diện Local Web Reader & Quản Lý Cấu Hình

### 1. Kiến Trúc SPA Hợp Nhất (Unified Single-Page Application)
- Thay vì tách rời thành 2 trang độc lập gây mất trạng thái đọc, hệ thống tích hợp **Trình Đọc (Reader)** và **Cài Đặt Hệ Thống (Settings)** vào chung một ứng dụng SPA duy nhất (`web_reader/index.html` + `app.js`):
  - **Điều hướng không tải lại (Zero-Reload Navigation)**: Thanh header Sổ Tay cho phép chuyển đổi tức thì giữa các tab `#reader` và `#settings`. Khi người dùng đang đọc ở Trang 15 và chuyển sang tab Cài Đặt để chỉnh API Key, bấm quay lại Trình Đọc vẫn giữ nguyên 100% tiến độ và tọa độ trang đang đọc.
  - **Hỗ trợ URL động**: `overlay_server.py` tự động định tuyến các đường dẫn `/`, `/reader` và `/settings` về cùng ứng dụng SPA, tự động kích hoạt tab tương ứng dựa trên hash và pathname.

### 2. Ngôn Ngữ Thiết Kế Sổ Tay Manga (Hand-Drawn Notebook Design System)
- Giao diện được xây dựng từ triết lý thẩm mỹ thủ công, tôn vinh nét vẽ phác thảo truyện tranh truyền thống:
  - **Nền giấy ấm & Hạt vân giấy (Paper Texture)**: Màu nền `#fdfbf7` kết hợp hoa văn chấm bi giấy ghi chú (`radial-gradient` 24px) mang lại cảm giác dễ chịu cho mắt khi đọc truyện lâu.
  - **Đường viền Wobbly (Không đường thẳng tuyệt đối)**: Sử dụng các giá trị `border-radius` hữu cơ bất đối xứng kết hợp nét viền chì mềm `#2d2d2d` dày 2.5px - 3px.
  - **Bóng đổ cứng (Hard Offset Shadows)**: Hiệu ứng cắt giấy nổi (cut-paper collage) 4px/6px không làm mờ viền (zero blur). Khi click chuột, nút bấm lún phẳng vào mặt giấy (`translate(4px, 4px)` với shadow 0px).
  - **Hệ thống Vector SVG Nét Chì**: Toàn bộ icon được vẽ bằng đường nét vector stroke 2.5px thuần chì `#2d2d2d`, không dùng icon màu emoji hệ điều hành.
  - **Typography viết tay chuẩn mực**: Tiêu đề và nút bấm sử dụng font bút dạ lông `Kalam` (wght 700), nội dung mô tả và thông số sử dụng font chữ viết tay tự nhiên `Patrick Hand` (wght 400).

### 3. Quản Lý Cấu Hình Tập Trung & Multi-Profile (`config_manager.py`)
- Cấu hình được lưu tại `config.json`.
- Tự động bảo vệ đa luồng qua `threading.Lock()`.
- Hỗ trợ đa hồ sơ (Multi-Profile): Cho phép tạo, chuyển đổi, xóa các hồ sơ dịch thuật riêng biệt (Google Free, Gemini 2.0 Flash, Qwen 3.5, DeepSeek, Ollama Local).
- Che mờ API Key an toàn trên UI bằng hàm `mask_api_key` (`sk-xt-12****34`).
- Thử nghiệm kết nối thời gian thực qua endpoint `/api/test-llm` đo độ trễ mạng (latency ms).

---

## 6. Bảo Mật & Cơ Chế Auto-Download Model

### 1. Nguyên Tắc Bảo Mật Bản Chia Sẻ (Zero-Leak Policy)
- Bản chia sẻ trong kho lưu trữ đã được lọc bỏ toàn bộ các API Key cá nhân.
- `DEFAULT_CONFIG` và `config.json` chỉ chứa chuỗi rỗng `""`.
- Đi kèm file `.gitignore` để người dùng không bao giờ vô tình commit key cá nhân của họ lên kho lưu trữ công khai.

### 2. Logic Tự Động Tải Mô Hình AI (`download_models.py`)
- Khi người dùng mới nhận dự án (chỉ nặng ~260 KB), họ không cần phải tải thủ công từng file ONNX:
  1. Script kết nối tới HuggingFace Hub qua `huggingface_hub.hf_hub_download` và `snapshot_download`.
  2. Kiểm tra mã băm (Hash) và dung lượng file trên máy.
  3. Nếu thiếu file `comic-text-detector.onnx`, script tự tải về thư mục `models/`.
  4. Nếu máy chưa có cache Manga-OCR, script tự động nạp `mayocream/manga-ocr-onnx` vào cache máy tính bằng `RobustMangaOcr`.
  5. Chạy 1 lượt kiểm thử giả lập (Dummy test) trên ảnh trắng để đảm bảo DirectML nạp thành công trước khi kết thúc.
