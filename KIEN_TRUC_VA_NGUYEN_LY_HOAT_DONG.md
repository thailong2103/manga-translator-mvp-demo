# Kiến Trúc Hệ Thống & Nguyên Lý Hoạt Động (Manga Translator AI)

Tài liệu này trình bày chi tiết về cấu trúc kỹ thuật, logic giải thuật, luồng xử lý dữ liệu và cách hoạt động của từng **Engine** và **Chức năng** trong hệ thống **Manga Translator AI**.

---

## 📑 Mục Lục
1. [Tổng Quan Kiến Trúc Tổng Thể](#1-tổng-quan-kiến-trúc-tổng-thể)
2. [Chi Tiết Các Engine AI & Xử Lý Dữ Liệu](#2-chi-tiết-các-engine-ai--xử-lý-dữ-liệu)
   - [Engine 1: Comic-Text-Detector (Định vị khung thoại)](#engine-1-comic-text-detector-định-vị-khung-thoại)
   - [Engine 2: Manga-OCR ONNX (Bóc tách chữ tiếng Nhật)](#engine-2-manga-ocr-onnx-bóc-tách-chữ-tiếng-nhật)
   - [Engine 3: Google Translate Batch Stream (Dịch siêu tốc)](#engine-3-google-translate-batch-stream-dịch-siêu-tốc)
   - [Engine 4: LLM Text-Only Translator (Dịch ngữ cảnh đối thoại)](#engine-4-llm-text-only-translator-dịch-ngữ-cảnh-đối-thoại)
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
│  │ 3. Manga-OCR ONNX             │                             │ 3. Set-of-Mark    │  │
│  │    - Cắt box ảnh (PIL)        │                             │    - Đánh số [1], │  │
│  │    - Vision Transformer + BPE │                             │      [2] lên ảnh  │  │
│  │    - Trích xuất chữ Nhật gốc  │                             │                   │  │
│  │                               │                             │ 4. Vision API     │  │
│  │ 4. Bộ Dịch Lựa Chọn:          │                             │    - Qwen 3.5 /   │  │
│  │    ├─► Google Translate (~150ms)                            │      Gemini Flash │  │
│  │    ├─► LLM Text-only Prompt   │                             │    - Dịch theo ảnh│  │
│  │    └─► Raw (Giữ tiếng Nhật)   │                             └─────────┬─────────┘  │
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
  - Chạy trực tiếp trên GPU AMD Radeon 780M / 680M tích hợp, GPU rời NVIDIA GeForce / AMD Radeon hoặc Intel Iris Xe thông qua DirectX 12.
  - Tốc độ xử lý: **~120ms – 170ms** cho một trang truyện độ phân giải 2K.
* **Nguyên lý tiền xử lý (Preprocessing):**
  1. Giữ nguyên tỷ lệ khung hình (Aspect Ratio): Tính tỷ lệ scale = 1024 / max(h, w).
  2. Resize ảnh về kích thước chuẩn và đắp viền đen (Zero-padding) thành hình vuông chuẩn `1024 x 1024 x 3`.
  3. Chuẩn hóa ma trận điểm ảnh về dải `[0.0, 1.0]`.
* **Hậu xử lý (Postprocessing):**
  1. Lấy ma trận xác suất bóng thoại và văn bản từ output của ONNX.
  2. Áp dụng ngưỡng nhị phân (Thresholding) và thuật toán tìm đường bao `cv2.findContours`.
  3. Quy đổi ngược tọa độ từ ảnh vuông 1024x1024 về độ phân giải gốc của ảnh manga.
  4. Mở rộng biên (Padding Expansion) 5% về mỗi phía để tránh cắt cụt dấu câu hoặc mép chữ tiếng Nhật.

---

### Engine 2: Manga-OCR ONNX (Bóc tách chữ tiếng Nhật)
* **File mô hình:** `mayocream/manga-ocr-onnx` (~870 MB gồm `encoder_model.onnx` và `decoder_model.onnx`).
* **Kiến trúc:** Vision Transformer (ViT) làm Encoder kết hợp với RoBERTa/BERT làm Decoder tự hồi quy (Autoregressive).
* **Điểm đột phá của kiến trúc không dùng PyTorch (Torchless):**
  - Bản phân phối sử dụng `manga-ocr-torchless` kết hợp `transformers` và `onnxruntime`.
  - Không cần cài bộ thư viện PyTorch nặng hơn 2.5 GB.
  - Tự động chuyển đổi xử lý ảnh qua thư viện chuẩn `PIL.Image` và `ViTImageProcessorPil`.
* **Logic hoạt động:**
  1. Nhận danh sách các ô thoại `[x, y, w, h]` từ Engine 1.
  2. Cắt các mảnh ảnh nhỏ (Crop) tương ứng với từng bong bóng thoại.
  3. Đưa qua mô hình ONNX để giải mã trực tiếp chữ Hán (Kanji), Hiragana, Katakana và Furigana dọc/ngang.
  4. Chuẩn hóa chuỗi văn bản bằng `jaconv` để xử lý khoảng trắng, dấu ngoặc và dạng chữ nửa độ rộng (Half-width).

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

### Engine 4: LLM Text-Only Translator (Dịch ngữ cảnh đối thoại)
* **Mục đích:** Dành cho người đọc muốn chất lượng dịch văn học cao cấp, hiểu ngữ cảnh nhân vật và giữ được sự hài hước, văn phong kiếm hiệp, tình cảm của manga.
* **Tối ưu hóa Token:** Thay vì gửi ảnh lớn chiếm 1,000 – 3,000 token/trang, chế độ này chỉ gửi text thuần đã bóc tách từ Manga-OCR:
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

Điểm cốt lõi giúp hệ thống đạt danh hiệu **Siêu Tốc** là kiến trúc **Băng Chuyền Độc Lập (Pipelined Dispatch)**:

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

File: `mangadex_overlay.user.js` (Phiên bản v2.3.0)

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
- Đảm bảo bong bóng thoại dịch luôn nằm **khít 100%** đè lên bóng thoại gốc dù người dùng phóng to, thu nhỏ hay xoay màn hình.

### 3. Tự Động Điều Chỉnh Kích Thước Chữ (Auto Font Fitting)
- Dựa trên diện tích của hộp thoại `w * h` và độ dài của câu văn bản tiếng Việt.
- Thuật toán tự động tính toán cỡ chữ (`fontSize` từ `11px` đến `24px`) và căn giữa hoàn hảo để bản dịch vừa vặn bên trong quả bóng thoại trắng, không bị tràn hay mất chữ.

---

## 5. Giao Diện Local Web Reader & Quản Lý Cấu Hình

### Local Web Reader (`web_reader/`)
- Cung cấp giải pháp cho người dùng đọc các bộ truyện tải về máy tính (file `.zip`, `.cbz` giải nén hoặc folder ảnh).
- Hỗ trợ kéo thả cả thư mục vào trình duyệt qua HTML5 `webkitdirectory`.
- Tự động sắp xếp tên file theo thứ tự tự nhiên (Natural Sort: `page_1`, `page_2`, `page_10` thay vì `page_1`, `page_10`, `page_2`).
- 2 chế độ đọc:
  - **Cuộn dọc (Webtoon):** Đọc mượt mà từ trên xuống dưới, hỗ trợ lazy-load.
  - **Lật trang (Single Page):** Lật từng trang như sách với phím mũi tên `←` / `→`.

### Quản Lý Cấu Hình Tập Trung (`config_manager.py`)
- Cấu hình được lưu tại `config.json`.
- Tự động bảo vệ đa luồng qua `threading.Lock()`.
- Hỗ trợ chuẩn hóa URL tự động: Tự động bổ sung `/openai` nếu người dùng nhập link Google Gemini Studio.
- Che mờ API Key an toàn trên UI bằng hàm `mask_api_key` (`sk-xt-12****34`).

---

## 6. Bảo Mật & Cơ Chế Auto-Download Model

### 1. Nguyên Tắc Bảo Mật Bản Chia Sẻ (Zero-Leak Policy)
- Bản chia sẻ trong thư mục `Manga-Translator-Share/` đã được lọc bỏ toàn bộ các API Key thử nghiệm.
- `DEFAULT_CONFIG` và `config.json` chỉ chứa chuỗi rỗng `""`.
- Đi kèm file `.gitignore` để người dùng không bao giờ vô tình commit key cá nhân của họ lên kho lưu trữ công khai.

### 2. Logic Tự Động Tải Mô Hình AI (`download_models.py`)
- Khi người dùng mới nhận dự án (chỉ nặng ~260 KB), họ không cần phải tải thủ công từng file ONNX:
  1. Script kết nối tới HuggingFace Hub qua `huggingface_hub.hf_hub_download`.
  2. Kiểm tra mã băm (Hash) và dung lượng file trên máy.
  3. Nếu thiếu file `comic-text-detector.onnx`, script tự tải về thư mục `models/`.
  4. Nếu máy chưa có cache Manga-OCR, script tự động nạp `mayocream/manga-ocr-onnx` vào cache máy tính.
  5. Chạy 1 lượt kiểm thử giả lập (Dummy test) trên ảnh trắng để đảm bảo DirectML nạp thành công trước khi kết thúc.

---

*Tài liệu được biên soạn đồng bộ với phiên bản Manga Translator AI v2.3.*
