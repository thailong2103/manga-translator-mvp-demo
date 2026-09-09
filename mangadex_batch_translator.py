"""
Script Dịch MangaDex Siêu Tốc: Prefetch Toàn Bộ Chapter + Pipeline Xử Lý Bất Đồng Bộ
- Bước 1: Cào toàn bộ ảnh của chapter qua MangaDex API vào thư mục cache (ngầm trong nền)
- Bước 2: Ưu tiên xử lý ngay Trang 1 để người đọc có thể đọc ngay sau ~7s
- Bước 3: Xử lý song song tối đa 3 trang cùng lúc cho các trang còn lại
- Detector: Comic-Text-Detector trên GPU AMD (DirectML) với thread-safe lock
- Dịch thuật: Qwen 3.5 Flash qua xKiro API (tối ưu dịch lời thoại tiếng Anh/Nhật sang tiếng Việt)
- Output: File JSON chứa tọa độ bong bóng thoại + bản dịch tiếng Việt để phục vụ tool overlay
"""

import os
import sys
import time
import re
import json
import base64
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

# Đảm bảo hiển thị UTF-8 trên Windows console
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(SCRIPT_DIR)

import cv2
import numpy as np
import onnxruntime as ort
import httpx
from PIL import Image

# =====================================================================
# ⚙️ CẤU HÌNH HỆ THỐNG
# =====================================================================
from config_manager import load_config

# Đọc cấu hình từ config.json
_sys_config = load_config()
XKIRO_API_KEY = _sys_config.get("api_key", "")
XKIRO_BASE_URL = _sys_config.get("base_url", "https://api.xkiro.com/v1")
MODEL_NAME = _sys_config.get("model", "qwen/qwen3.5-flash:free")

# Cấu hình ngôn ngữ: MangaDex bản tiếng Anh -> Dịch sang tiếng Việt
SOURCE_LANG = _sys_config.get("source_lang", "tiếng Anh (hoặc tiếng Nhật gốc)")
TARGET_LANG = _sys_config.get("target_lang", "tiếng Việt")

# Tối đa luồng xử lý song song
MAX_PARALLEL_WORKERS = _sys_config.get("max_workers", 10)

# Thư mục mô hình & cache
DETECTOR_MODEL_PATH = "models/comic-text-detector.onnx"
CACHE_DIR = "cache_chapters"
OUTPUT_DIR = "output_translations"

os.makedirs(CACHE_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Lock GPU DirectML: detector chỉ mất ~170ms, dùng lock để bảo vệ an toàn 100% tài nguyên VRAM
gpu_lock = threading.Lock()

# =====================================================================
# 1. MANGADEX API: LẤY METADATA VÀ DANH SÁCH URL ẢNH
# =====================================================================
def extract_chapter_id_and_page(input_str: str):
    """Tách Chapter UUID và số trang bắt đầu (nếu có) từ URL MangaDex."""
    clean = input_str.strip()
    m_id = re.search(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", clean)
    chapter_id = m_id.group(0) if m_id else clean
    
    # Tách số trang ở đuôi URL nếu có (ví dụ .../chapter/UUID/1 hoặc .../chapter/UUID/5)
    m_page = re.search(r"/(\d+)(?:[?#]|$)", clean)
    start_page = int(m_page.group(1)) if m_page else 1
    return chapter_id, start_page

def extract_chapter_id(input_str: str) -> str:
    chap_id, _ = extract_chapter_id_and_page(input_str)
    return chap_id

def fetch_mangadex_chapter_info(chapter_id: str):
    """
    Lấy thông tin chapter và danh sách URL ảnh từ MangaDex@Home API.
    Chế độ data-saver được dùng mặc định để tối ưu tốc độ tải (nhẹ hơn ~60-70%).
    """
    headers = {"User-Agent": "MangaBatchTranslator/2.0"}
    
    chap_info = {}
    try:
        with httpx.Client(timeout=15.0) as client:
            resp = client.get(f"https://api.mangadex.org/chapter/{chapter_id}", headers=headers)
            if resp.status_code == 200:
                data = resp.json().get("data", {})
                attrs = data.get("attributes", {})
                chap_info = {
                    "title": attrs.get("title", ""),
                    "chapter": attrs.get("chapter", "1"),
                    "volume": attrs.get("volume", ""),
                    "lang": attrs.get("translatedLanguage", "en"),
                }
    except Exception as e:
        print(f"⚠️ Không lấy được chi tiết chapter: {e}")

    server_url = f"https://api.mangadex.org/at-home/server/{chapter_id}"
    with httpx.Client(timeout=20.0) as client:
        res = client.get(server_url, headers=headers)
        if res.status_code != 200:
            raise RuntimeError(f"MangaDex API lỗi ({res.status_code}): {res.text[:300]}")
        server_data = res.json()

    base_url = server_data["baseUrl"]
    chapter_hash = server_data["chapter"]["hash"]
    data_saver_files = server_data["chapter"].get("dataSaver", [])
    original_files = server_data["chapter"].get("data", [])

    use_saver = len(data_saver_files) > 0
    filenames = data_saver_files if use_saver else original_files
    mode_path = "data-saver" if use_saver else "data"

    page_urls = [
        f"{base_url}/{mode_path}/{chapter_hash}/{fn}"
        for fn in filenames
    ]

    return {
        "chapter_id": chapter_id,
        "metadata": chap_info,
        "mode": mode_path,
        "total_pages": len(page_urls),
        "page_urls": page_urls,
        "filenames": filenames
    }

# =====================================================================
# 2. TẢI TOÀN BỘ ẢNH VÀO CACHE TRƯỚC (PREFETCH)
# =====================================================================
def download_single_page(url: str, dest_path: str, page_num: int):
    """Tải 1 ảnh và lưu vào cache."""
    if os.path.exists(dest_path) and os.path.getsize(dest_path) > 1024:
        return page_num, dest_path, True
    
    headers = {"User-Agent": "MangaBatchTranslator/2.0"}
    for attempt in range(3):
        try:
            with httpx.Client(timeout=30.0) as client:
                r = client.get(url, headers=headers)
                if r.status_code == 200:
                    with open(dest_path, "wb") as f:
                        f.write(r.content)
                    return page_num, dest_path, False
        except Exception:
            time.sleep(1.0)
    raise RuntimeError(f"Không tải được ảnh trang {page_num}: {url}")

def prefetch_chapter_pages(chapter_id: str, page_urls: list, filenames: list, progress_callback=None, priority_page: int = 1):
    """
    Tải toàn bộ các trang của tập truyện.
    Trang ưu tiên (priority_page, ví dụ trang 2) được tải trước ngay lập tức.
    Các trang còn lại được tải song song bằng ThreadPoolExecutor trong nền.
    """
    chap_cache_dir = os.path.join(CACHE_DIR, chapter_id)
    os.makedirs(chap_cache_dir, exist_ok=True)
    
    page_paths = {}

    # Ưu tiên tải ngay trang được chỉ định (priority_page)
    p_idx = max(0, min(priority_page - 1, len(page_urls) - 1))
    actual_p_num = p_idx + 1
    p_ext = os.path.splitext(filenames[p_idx])[1] or ".jpg"
    p_path = os.path.join(chap_cache_dir, f"page_{actual_p_num:03d}{p_ext}")
    download_single_page(page_urls[p_idx], p_path, actual_p_num)
    page_paths[actual_p_num] = p_path
    if progress_callback:
        progress_callback(actual_p_num, len(page_urls), is_priority=True)

    # Tải song song tất cả các trang còn lại
    remaining = [p for p in range(1, len(page_urls) + 1) if p != actual_p_num]

    def _worker(i):
        ext = os.path.splitext(filenames[i - 1])[1] or ".jpg"
        target = os.path.join(chap_cache_dir, f"page_{i:03d}{ext}")
        _, saved_path, _ = download_single_page(page_urls[i - 1], target, i)
        return i, saved_path

    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {executor.submit(_worker, i): i for i in remaining}
        for future in as_completed(futures):
            i, path = future.result()
            page_paths[i] = path
            if progress_callback:
                progress_callback(i, len(page_urls), is_priority=False)

    return page_paths

# =====================================================================
# 3. DETECTOR LOCAL TRÊN GPU AMD (DIRECTML + LOCK)
# =====================================================================
def detect_all_bubbles(session, orig_img):
    """Quét bong bóng thoại bằng Comic-Text-Detector."""
    h, w = orig_img.shape[:2]
    target_size = 1024
    scale = target_size / max(h, w)
    nh, nw = int(h * scale), int(w * scale)
    resized = cv2.resize(orig_img, (nw, nh))

    pad_img = np.zeros((target_size, target_size, 3), dtype=np.uint8)
    pad_img[:nh, :nw] = resized
    blob = pad_img.astype(np.float32) / 255.0
    blob = np.transpose(blob, (2, 0, 1))[np.newaxis, ...]

    with gpu_lock:
        outputs = session.run(None, {'images': blob})
    blk = outputs[0][0]

    boxes, scores = [], []
    for row in blk:
        obj_conf = row[4]
        if obj_conf > 0.18:
            cls_id = int(np.argmax(row[5:]))
            score = float(obj_conf * row[5 + cls_id])
            if score > 0.14:
                cx, cy, bw, bh = row[0], row[1], row[2], row[3]
                x1 = int((cx - bw / 2) / scale)
                y1 = int((cy - bh / 2) / scale)
                box_w = int(bw / scale)
                box_h = int(bh / scale)
                boxes.append([x1, y1, box_w, box_h])
                scores.append(score)

    indices = cv2.dnn.NMSBoxes(boxes, scores, score_threshold=0.14, nms_threshold=0.35)

    bubble_list = []
    for idx in indices:
        i = int(idx)
        bx, by, bw, bh = boxes[i]
        if bw > 25 and bh > 20:
            bubble_list.append({
                "box": [bx, by, bw, bh],
                "cy": by + bh / 2,
                "cx": bx + bw / 2,
            })

    # Sắp xếp thứ tự đọc manga: từ trên xuống dưới, phải sang trái
    y_threshold = h * 0.10
    sorted_by_y = sorted(bubble_list, key=lambda b: b["cy"])
    tiers, current_tier = [], []
    for b in sorted_by_y:
        if not current_tier:
            current_tier.append(b)
        else:
            mean_y = sum(x["cy"] for x in current_tier) / len(current_tier)
            if abs(b["cy"] - mean_y) <= y_threshold:
                current_tier.append(b)
            else:
                current_tier = sorted(current_tier, key=lambda x: -x["cx"])
                tiers.append(current_tier)
                current_tier = [b]
    if current_tier:
        current_tier = sorted(current_tier, key=lambda x: -x["cx"])
        tiers.append(current_tier)

    ordered = []
    bid = 1
    for tier in tiers:
        for b in tier:
            b["id"] = bid
            ordered.append(b)
            bid += 1
    return ordered

# =====================================================================
# 4. SET-OF-MARK ĐÁNH SỐ BUBBLE TRÊN ẢNH
# =====================================================================
def create_marked_image(orig_img, bubbles):
    """Vẽ nhãn số [1], [2]... lên ảnh."""
    marked = orig_img.copy()
    h, w = orig_img.shape[:2]
    font_scale = max(0.8, w / 2000.0)
    thickness = 2

    for b in bubbles:
        bx, by, bw, bh = b["box"]
        bid = b["id"]

        cv2.rectangle(marked, (bx, by), (bx + bw, by + bh), (0, 220, 0), 3)

        tag = f"[{bid}]"
        (tw, th), _ = cv2.getTextSize(tag, cv2.FONT_HERSHEY_SIMPLEX, font_scale, thickness)
        bx1 = max(0, bx)
        by1 = max(0, by - th - 10)
        bx2 = bx1 + tw + 14
        by2 = by1 + th + 10
        cv2.rectangle(marked, (bx1, by1), (bx2, by2), (0, 0, 220), -1)
        cv2.rectangle(marked, (bx1, by1), (bx2, by2), (255, 255, 255), 2)
        cv2.putText(marked, tag, (bx1 + 7, by2 - 6), cv2.FONT_HERSHEY_SIMPLEX, font_scale, (255, 255, 255), thickness)

    return marked

# =====================================================================
# 5. VISION LLM: GỌI XKIRO (QWEN 3.5 FLASH) DỊCH LỜI THOẠI
# =====================================================================
def call_qwen_translator(api_key, base_url, model, marked_img, total_bubbles):
    """
    Gửi ảnh đánh dấu Set-of-Mark sang Qwen 3.5 Flash để dịch sang tiếng Việt.
    Hỗ trợ cả lời thoại manga tiếng Anh và tiếng Nhật.
    """
    # Nén ảnh 1024px, JPEG 72% để truyền mạng siêu tốc
    h, w = marked_img.shape[:2]
    max_dim = 1024
    scale = min(1.0, max_dim / max(h, w))
    send_img = cv2.resize(marked_img, (int(w * scale), int(h * scale)))
    _, buffer = cv2.imencode('.jpg', send_img, [cv2.IMWRITE_JPEG_QUALITY, 72])
    img_b64 = base64.b64encode(buffer).decode('utf-8')

    prompt = (
        f"Bạn là chuyên gia dịch truyện tranh. Hãy đọc toàn bộ lời thoại {SOURCE_LANG} "
        f"trong các khung thoại được đánh số từ [1] đến [{total_bubbles}] và dịch sang {TARGET_LANG} "
        f"tự nhiên, chuẩn văn phong manga. "
        f"Trả về đúng định dạng JSON: [ {{\"id\": 1, \"vi\": \"...\"}}, {{\"id\": 2, \"vi\": \"...\"}} ]"
    )

    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"}
                    }
                ]
            }
        ],
        "temperature": 0.1
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }

    for attempt in range(3):
        try:
            with httpx.Client(timeout=25.0) as client:
                resp = client.post(f"{base_url.rstrip('/')}/chat/completions", json=payload, headers=headers)
            if resp.status_code == 200:
                resp_json = resp.json()
                text = resp_json["choices"][0]["message"]["content"]
                clean_text = re.sub(r"^```(?:json)?\s*", "", text.strip())
                clean_text = re.sub(r"\s*```$", "", clean_text)
                parsed = json.loads(clean_text)

                if isinstance(parsed, dict):
                    for val in parsed.values():
                        if isinstance(val, list):
                            return val
                    return [parsed]
                return parsed
            elif resp.status_code in (429, 503):
                time.sleep(2.0 * (attempt + 1))
            else:
                raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")
        except json.JSONDecodeError:
            m = re.findall(r'\{\s*"id"\s*:\s*(\d+)\s*,\s*"vi"\s*:\s*"([^"]+)"\s*\}', text)
            if m:
                return [{"id": int(i), "vi": v} for i, v in m]
            return []
        except Exception as e:
            if attempt == 2:
                raise e
            time.sleep(1.5)

    return []

# =====================================================================
# 6. MANGA-OCR BÓC TÁCH CHỮ GỐC (PIPELINE OCR_TRANS)
# =====================================================================
_manga_ocr_instance = None
_manga_ocr_lock = threading.Lock()

class RobustMangaOcr:
    """Load MangaOcr trực tiếp từ snapshot cache nội bộ, tránh lỗi kết nối mạng Hugging Face bị treo."""
    def __init__(self, model_dir=None):
        import onnxruntime as ort
        from pathlib import Path
        from transformers import ViTImageProcessor, BertJapaneseTokenizer
        
        if not model_dir:
            cache_base = Path.home() / ".cache" / "huggingface" / "hub" / "models--mayocream--manga-ocr-onnx" / "snapshots"
            if cache_base.exists():
                for d in cache_base.iterdir():
                    if d.is_dir() and (d / "encoder_model.onnx").exists():
                        model_dir = str(d)
                        break
        if not model_dir or not os.path.exists(model_dir):
            raise FileNotFoundError("Không tìm thấy local cache Manga-OCR")
            
        self.processor = ViTImageProcessor.from_pretrained(model_dir, local_files_only=True)
        self.tokenizer = BertJapaneseTokenizer.from_pretrained(model_dir, local_files_only=True)
        self.eos_token_id = self.tokenizer.sep_token_id or self.tokenizer.eos_token_id
        self.bos_token_id = self.tokenizer.cls_token_id or self.tokenizer.bos_token_id
        
        providers = [p for p in ['DmlExecutionProvider', 'CPUExecutionProvider'] if p in ort.get_available_providers()]
        self.encoder_session = ort.InferenceSession(os.path.join(model_dir, 'encoder_model.onnx'), providers=providers)
        self.decoder_session = ort.InferenceSession(os.path.join(model_dir, 'decoder_model.onnx'), providers=providers)
    
    def __call__(self, img, max_length: int = 300) -> str:
        import jaconv
        img = img.convert('L').convert('RGB')
        pixel_values = self.processor(img, return_tensors='np').pixel_values
        encoder_outputs = self.encoder_session.run(None, {'pixel_values': pixel_values})
        last_hidden_state = encoder_outputs[0]
        input_ids = np.array([[self.bos_token_id]], dtype=np.int64)
        for _ in range(max_length):
            decoder_inputs = {'input_ids': input_ids, 'encoder_hidden_states': last_hidden_state}
            try:
                logits = self.decoder_session.run(None, decoder_inputs)[0]
            except Exception:
                break
            next_token = np.argmax(logits[:, -1, :], axis=-1)[0]
            input_ids = np.concatenate([input_ids, np.array([[next_token]], dtype=np.int64)], axis=-1)
            if next_token == self.eos_token_id:
                break
        text = self.tokenizer.decode(input_ids[0], skip_special_tokens=True)
        text = ''.join(text.split()).replace('…', '...')
        text = re.sub(r'[・.]{2,}', lambda x: (x.end() - x.start()) * '.', text)
        return jaconv.h2z(text, ascii=True, digit=True)

def get_manga_ocr():
    """Khởi tạo MangaOcr một lần duy nhất (Lazy Singleton), ưu tiên load local siêu tốc 1s."""
    global _manga_ocr_instance
    with _manga_ocr_lock:
        if _manga_ocr_instance is None:
            print("⚡ Đang nạp Manga-OCR ONNX...")
            try:
                # Ưu tiên load trực tiếp từ local snapshot (chỉ mất ~1s, không phụ thuộc mạng)
                _manga_ocr_instance = RobustMangaOcr()
            except Exception as local_err:
                try:
                    os.environ["HF_HUB_OFFLINE"] = "1"
                    from manga_ocr import MangaOcr
                    _manga_ocr_instance = MangaOcr()
                except Exception:
                    os.environ.pop("HF_HUB_OFFLINE", None)
                    from manga_ocr import MangaOcr
                    _manga_ocr_instance = MangaOcr()
            print("✓ Manga-OCR đã sẵn sàng!\n")
        return _manga_ocr_instance

def extract_bubbles_manga_ocr(orig_img, bubbles):
    """Cắt từng khung thoại và dùng Manga-OCR bóc tách chữ tiếng Nhật gốc."""
    if not bubbles:
        return bubbles
    mocr = get_manga_ocr()
    h, w = orig_img.shape[:2]
    for b in bubbles:
        bx, by, bw, bh = b["box"]
        pad_x = int(bw * 0.05)
        pad_y = int(bh * 0.05)
        x1 = max(0, bx - pad_x)
        y1 = max(0, by - pad_y)
        x2 = min(w, bx + bw + pad_x)
        y2 = min(h, by + bh + pad_y)
        crop = orig_img[y1:y2, x1:x2]
        if crop.size == 0:
            b["raw"] = ""
            continue
        try:
            crop_pil = Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
            with _manga_ocr_lock:
                raw_text = mocr(crop_pil)
            b["raw"] = raw_text.strip() if raw_text else ""
        except Exception as e:
            print(f"⚠️ Lỗi OCR bubble {b.get('id')}: {e}")
            b["raw"] = ""
    return bubbles

_rapid_ocr_instances = {}
_rapid_ocr_lock = threading.Lock()

def get_rapid_ocr(lang="en"):
    """Khởi tạo RapidOCR theo ngôn ngữ (Lazy Singleton).
    lang = 'en': Ưu tiên tách dòng, giữ nguyên space, chuẩn font comic.
    lang = 'ch': Chữ Hán giản thể/phồn thể, gom liền chuỗi.
    """
    global _rapid_ocr_instances
    with _rapid_ocr_lock:
        if lang not in _rapid_ocr_instances:
            print(f"⚡ Đang nạp RapidOCR ONNX (ngôn ngữ: {lang})...")
            try:
                from rapidocr_onnxruntime import RapidOCR
                _rapid_ocr_instances[lang] = RapidOCR()
                print(f"✓ RapidOCR ({lang}) đã sẵn sàng!\n")
            except Exception as e:
                print(f"❌ Không thể nạp RapidOCR: {e}")
                raise e
        return _rapid_ocr_instances[lang]

def extract_bubbles_rapid_ocr(orig_img, bubbles, lang="en"):
    """Cắt từng khung thoại và dùng RapidOCR bóc tách chữ Tiếng Anh hoặc Tiếng Trung."""
    if not bubbles:
        return bubbles
    try:
        engine = get_rapid_ocr(lang=lang)
    except Exception as e:
        print(f"⚠️ Không thể khởi tạo RapidOCR ({lang}), bỏ qua bóc chữ: {e}")
        for b in bubbles:
            b["raw"] = ""
        return bubbles

    h, w = orig_img.shape[:2]
    for b in bubbles:
        bx, by, bw, bh = b["box"]
        pad_x = int(bw * 0.05)
        pad_y = int(bh * 0.05)
        x1 = max(0, bx - pad_x)
        y1 = max(0, by - pad_y)
        x2 = min(w, bx + bw + pad_x)
        y2 = min(h, by + bh + pad_y)
        crop = orig_img[y1:y2, x1:x2]
        if crop.size == 0:
            b["raw"] = ""
            continue
        try:
            with _rapid_ocr_lock:
                result, _ = engine(crop)
            if not result:
                b["raw"] = ""
                continue

            # Sắp xếp các dòng thoại theo tọa độ y từ trên xuống dưới
            def _get_top_y(item):
                try:
                    return min(pt[1] for pt in item[0])
                except Exception:
                    return 0

            sorted_lines = sorted(result, key=_get_top_y)
            texts = [item[1].strip() for item in sorted_lines if item[1].strip()]

            if lang == "en":
                # Nối bằng dấu cách, bảo toàn khoảng trắng và dấu câu
                raw_text = " ".join(texts)
                raw_text = re.sub(r'\s+', ' ', raw_text).strip()
            else:  # "ch"
                # Nối liền chuỗi cho tiếng Trung
                raw_text = "".join(texts).strip()

            b["raw"] = raw_text
        except Exception as e:
            print(f"⚠️ Lỗi RapidOCR bubble {b.get('id')}: {e}")
            b["raw"] = ""
    return bubbles

def extract_bubbles_ocr(orig_img, bubbles, ocr_engine="manga_ocr"):
    """Điều phối bóc tách chữ theo Engine OCR được chọn."""
    if ocr_engine == "rapid_ocr_en":
        return extract_bubbles_rapid_ocr(orig_img, bubbles, lang="en")
    elif ocr_engine == "rapid_ocr_ch":
        return extract_bubbles_rapid_ocr(orig_img, bubbles, lang="ch")
    else:  # "manga_ocr" mặc định
        return extract_bubbles_manga_ocr(orig_img, bubbles)


# =====================================================================
# 7. GOOGLE TRANSLATE (DỊCH TEXT THUẦN SIÊU TỐC & MIỄN PHÍ)
# =====================================================================
def translate_with_google(text_list, target_lang="vi"):
    """
    Dịch danh sách các đoạn text qua Google Translate API (miễn phí, nhanh).
    Ưu tiên dùng endpoint clients5 (không bị lỗi 429 rate-limit) và fallback gtx.
    """
    if not text_list:
        return []

    if not any(t.strip() for t in text_list):
        return ["" for _ in text_list]

    combined = "\n".join([t.replace("\r", " ").replace("\n", " ").strip() if t.strip() else "..." for t in text_list])
    
    # 1. Thử endpoint clients5 (Endpoint của tiện ích Chrome, không bị 429)
    try:
        url_c5 = "https://clients5.google.com/translate_a/t"
        params_c5 = {
            "client": "dict-chrome-ex",
            "sl": "auto",
            "tl": target_lang,
            "q": combined
        }
        with httpx.Client(timeout=10.0) as client:
            resp = client.get(url_c5, params=params_c5)
            if resp.status_code == 200:
                data = resp.json()
                if isinstance(data, list) and len(data) > 0:
                    raw_res = data[0][0] if isinstance(data[0], list) else data[0]
                    lines = raw_res.split("\n")
                    if len(lines) == len(text_list):
                        return [l.strip() if l.strip() != "..." else "" for l in lines]
    except Exception as e:
        pass

    # 2. Thử endpoint gtx (Cũ)
    try:
        url_gtx = "https://translate.googleapis.com/translate_a/single"
        params_gtx = {
            "client": "gtx",
            "sl": "auto",
            "tl": target_lang,
            "dt": "t",
            "q": combined
        }
        with httpx.Client(timeout=10.0) as client:
            resp = client.get(url_gtx, params=params_gtx)
            if resp.status_code == 200:
                data = resp.json()
                full_translated = "".join([seg[0] for seg in data[0] if seg and seg[0]])
                lines = full_translated.split("\n")
                if len(lines) == len(text_list):
                    return [l.strip() if l.strip() != "..." else "" for l in lines]
    except Exception as e:
        pass

    # 3. Fallback dịch từng câu nếu batch thất bại
    results = []
    with httpx.Client(timeout=6.0) as client:
        for t in text_list:
            if not t.strip():
                results.append("")
                continue
            translated_ok = False
            # Thử qua clients5 trước
            try:
                r = client.get("https://clients5.google.com/translate_a/t", params={"client": "dict-chrome-ex", "sl": "auto", "tl": target_lang, "q": t.strip()})
                if r.status_code == 200:
                    d = r.json()
                    res_text = d[0][0] if isinstance(d[0], list) else d[0]
                    results.append(str(res_text).strip())
                    translated_ok = True
            except Exception:
                pass
            
            if not translated_ok:
                results.append(t.strip())
    return results

# =====================================================================
# 8. LLM TEXT-ONLY TRANSLATOR (DỊCH TEXT THUẦN QUA OPENAI/QWEN/GEMINI)
# =====================================================================
def call_llm_text_translator(api_key, base_url, model, bubble_items, source_lang=None, target_lang=None):
    """
    Gửi danh sách text thuần bóc tách từ OCR lên LLM để dịch sang tiếng Việt.
    Không gửi ảnh, tiết kiệm token tối đa, dịch tự nhiên theo ngữ cảnh toàn trang.
    Tự động fallback sang Google Translate nếu LLM API gặp lỗi (như HTTP 500 / Timeout).
    bubble_items: [{"id": 1, "text": "..."}, {"id": 2, "text": "..."}]
    """
    if not bubble_items:
        return []

    src_desc = source_lang or SOURCE_LANG
    tgt_desc = target_lang or TARGET_LANG

    prompt = (
        f"Bạn là chuyên gia dịch truyện tranh manga/comic chuyên nghiệp.\n"
        f"Hãy dịch toàn bộ lời thoại sau từ {src_desc} sang {tgt_desc} tự nhiên, chuẩn văn phong truyện tranh tiếng Việt:\n"
        f"{json.dumps(bubble_items, ensure_ascii=False, indent=2)}\n\n"
        f"Quy tắc quan trọng:\n"
        f"- Giữ nguyên chính xác trường \"id\" cho từng câu thoại tương ứng.\n"
        f"- Dịch thoát ý, mượt mà, phù hợp ngữ cảnh đối thoại manga/comic.\n"
        f"- Chỉ trả về duy nhất mảng JSON hợp lệ, không thêm bất kỳ văn bản giải thích nào:\n"
        f"[ {{\"id\": 1, \"vi\": \"...\"}}, {{\"id\": 2, \"vi\": \"...\"}} ]"
    )

    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": prompt
            }
        ],
        "temperature": 0.2
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }

    last_error = None
    if api_key and base_url and model:
        for attempt in range(3):
            try:
                with httpx.Client(timeout=25.0) as client:
                    resp = client.post(f"{base_url.rstrip('/')}/chat/completions", json=payload, headers=headers)
                if resp.status_code == 200:
                    resp_json = resp.json()
                    text = resp_json["choices"][0]["message"]["content"].strip()
                    
                    # Tìm mảng JSON [...] trong câu trả lời
                    m_arr = re.search(r'\[[\s\S]*\]', text)
                    json_str = m_arr.group(0) if m_arr else text
                    clean_str = re.sub(r"^```(?:json)?\s*", "", json_str.strip())
                    clean_str = re.sub(r"\s*```$", "", clean_str)
                    
                    try:
                        parsed = json.loads(clean_str)
                        if isinstance(parsed, list):
                            return parsed
                        elif isinstance(parsed, dict):
                            for val in parsed.values():
                                if isinstance(val, list):
                                    return val
                            return [parsed]
                    except Exception:
                        pass
                    
                    # Regex fallback bóc id và vi nếu JSON chứa ký tự thoát bất thường
                    m_items = []
                    for m in re.finditer(r'\{\s*["\']id["\']\s*:\s*(\d+)\s*,\s*["\']vi["\']\s*:\s*["\']([\s\S]*?)["\']\s*\}', text):
                        m_items.append({"id": int(m.group(1)), "vi": m.group(2).replace('\\"', '"').replace('\\n', ' ').strip()})
                    if m_items:
                        return m_items
                    
                    raise ValueError(f"Không thể phân tích mảng JSON từ phản hồi LLM: {text[:150]}")
                elif resp.status_code in (429, 503):
                    time.sleep(1.5 * (attempt + 1))
                else:
                    raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")
            except Exception as e:
                last_error = e
                if attempt < 2:
                    time.sleep(1.0)
    else:
        last_error = "Chưa cấu hình API Key hoặc Model"

    # FALLBACK TỰ ĐỘNG SANG GOOGLE TRANSLATE ĐỂ TRÁNH GIỮ NGUYÊN CHỮ GỐC
    print(f"⚠️ [LLM Text Fallback] Lỗi gọi API LLM ({last_error}), tự động chuyển sang Google Translate...")
    try:
        raw_texts = [b.get("text", "") for b in bubble_items]
        vi_texts = translate_with_google(raw_texts, target_lang="vi")
        fallback_res = []
        for idx, b in enumerate(bubble_items):
            fallback_res.append({
                "id": b.get("id"),
                "vi": vi_texts[idx] if idx < len(vi_texts) and vi_texts[idx] else b.get("text", "")
            })
        return fallback_res
    except Exception as g_err:
        print(f"❌ Fallback Google Translate cũng gặp lỗi: {g_err}")
        return []

# =====================================================================
# 9. XỬ LÝ 1 TRANG ĐỘC LẬP (DETECT -> MARK -> TRANSLATE)
# =====================================================================
def process_single_page(page_num: int, img_path: str, detector_session, api_key, base_url, model, pipeline_start_time: float = None):
    """Xử lý 1 trang truyện hoàn chỉnh và đo đạc thời gian chi tiết."""
    t0 = time.perf_counter()
    start_offset_s = round(t0 - pipeline_start_time, 2) if pipeline_start_time else 0.0

    orig_img = cv2.imread(img_path)
    if orig_img is None:
        raise ValueError(f"Không đọc được ảnh: {img_path}")
    h, w = orig_img.shape[:2]

    # Quét bong bóng thoại
    t_det = time.perf_counter()
    bubbles = detect_all_bubbles(detector_session, orig_img)
    det_ms = (time.perf_counter() - t_det) * 1000

    # Nếu trang không có lời thoại (trang bìa, tranh phong cảnh...)
    if not bubbles:
        t_end = time.perf_counter()
        duration_s = round(t_end - t0, 2)
        completion_offset_s = round(t_end - pipeline_start_time, 2) if pipeline_start_time else duration_s
        return {
            "page": page_num,
            "filename": os.path.basename(img_path),
            "resolution": f"{w}x{h}",
            "num_bubbles": 0,
            "start_offset_s": start_offset_s,
            "duration_s": duration_s,
            "completion_offset_s": completion_offset_s,
            "elapsed_seconds": duration_s,
            "detect_ms": round(det_ms, 1),
            "bubbles": []
        }

    # Đánh dấu Set-of-Mark
    marked_img = create_marked_image(orig_img, bubbles)

    # Dịch qua Qwen 3.5 Flash
    translations = call_qwen_translator(api_key, base_url, model, marked_img, len(bubbles))
    trans_map = {item.get("id"): item.get("vi", "") for item in translations if isinstance(item, dict)}

    # Ghép bản dịch vào từng bong bóng
    bubble_results = []
    for b in bubbles:
        bid = b["id"]
        vi_text = trans_map.get(bid, "")
        bubble_results.append({
            "id": bid,
            "box": b["box"],  # [x, y, w, h] - phục vụ cho tool overlay sau này
            "vi": vi_text
        })

    t_end = time.perf_counter()
    duration_s = round(t_end - t0, 2)
    completion_offset_s = round(t_end - pipeline_start_time, 2) if pipeline_start_time else duration_s

    return {
        "page": page_num,
        "filename": os.path.basename(img_path),
        "resolution": f"{w}x{h}",
        "num_bubbles": len(bubbles),
        "start_offset_s": start_offset_s,
        "duration_s": duration_s,
        "completion_offset_s": completion_offset_s,
        "elapsed_seconds": duration_s,
        "detect_ms": round(det_ms, 1),
        "bubbles": bubble_results
    }

# =====================================================================
# 7. QUẢN LÝ TIẾN TRÌNH PIPELINE TOÀN TẬP TRUYỆN (STREAMING ENGINE)
# =====================================================================
def natural_sort_key(s):
    """Hỗ trợ sắp xếp số tự nhiên cho tên file ảnh (1, 2, ..., 9, 10)."""
    return [int(text) if text.isdigit() else text.lower() for text in re.split(r'(\d+)', str(s))]

def save_json_safely(filepath: str, data: dict):
    """Ghi file JSON nguyên tử (atomic write) để chống xung đột đọc/ghi khi streaming."""
    tmp_path = filepath + f".tmp_{os.getpid()}_{time.time()}"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, filepath)
    except Exception as e:
        if os.path.exists(tmp_path):
            try: os.remove(tmp_path)
            except Exception: pass
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

def process_pages_stream(chapter_id: str, title_str: str, pages_tasks: list,
                         api_key: str = None, base_url: str = None, model: str = None,
                         max_api_workers: int = 10, pipeline_type: str = None,
                         translation_provider: str = None, ocr_engine: str = None,
                         t_start: float = None, progress_callback=None):
    """
    Băng chuyền Streaming cốt lõi:
    - Nhận danh sách các trang (MangaDex hoặc Local).
    - Detect GPU DirectML tuần tự siêu nhanh (~170ms/trang).
    - Hỗ trợ 2 Pipeline:
      1. ocr_trans: Dùng Manga-OCR hoặc RapidOCR bóc chữ -> Gửi LLM Text, Google Translate, hoặc giữ Raw
      2. image_trans: Đánh số nhãn Set-of-Mark -> Gửi Vision LLM (Qwen/Gemini)
    - Ghi file JSON ngay khi từng trang hoàn thành (Time-To-First-Read cực thấp).
    """
    cfg = load_config()
    api_key = api_key or cfg.get("api_key", XKIRO_API_KEY)
    base_url = base_url or cfg.get("base_url", XKIRO_BASE_URL)
    model = model or cfg.get("model", MODEL_NAME)
    pipeline_type = pipeline_type or cfg.get("pipeline_type", "ocr_trans")
    translation_provider = translation_provider or cfg.get("translation_provider", "google")
    ocr_engine = ocr_engine or cfg.get("ocr_engine", "manga_ocr")

    if pipeline_type == "image_trans":
        translation_provider = "vision_llm"
    elif pipeline_type == "ocr_trans" and translation_provider not in ["google", "llm_text", "raw"]:
        translation_provider = "google"

    if t_start is None:
        t_start = time.perf_counter()

    total_pages = len(pages_tasks)

    # Tự động tải model detector nếu chưa có
    if not os.path.exists(DETECTOR_MODEL_PATH):
        print("⚡ Không tìm thấy Comic-Text-Detector, đang tự động tải từ HuggingFace...")
        try:
            from huggingface_hub import hf_hub_download
            os.makedirs(os.path.dirname(DETECTOR_MODEL_PATH) or "models", exist_ok=True)
            hf_hub_download(
                repo_id="mayocream/comic-text-detector-onnx",
                filename="comic-text-detector.onnx",
                local_dir=os.path.dirname(DETECTOR_MODEL_PATH) or "models"
            )
            print("✓ Tải xong Comic-Text-Detector!\n")
        except Exception as e:
            print(f"❌ Không thể tải tự động Comic-Text-Detector: {e}")

    # Khởi tạo mô hình Detector trên GPU AMD / DirectML
    print("⚡ Đang nạp Comic-Text-Detector (DirectML / CPU)...")
    t_init = time.perf_counter()
    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    detector_session = ort.InferenceSession(
        DETECTOR_MODEL_PATH, sess_options=opts,
        providers=['DmlExecutionProvider', 'CPUExecutionProvider']
    )
    # Warm-up GPU
    dummy = np.zeros((1, 3, 1024, 1024), dtype=np.float32)
    detector_session.run(None, {'images': dummy})
    print(f"✓ Detector sẵn sàng trong {(time.perf_counter() - t_init)*1000:.0f} ms!\n")

    # Nếu dùng ocr_trans, warm-up engine OCR tương ứng
    if pipeline_type == "ocr_trans":
        try:
            if ocr_engine == "rapid_ocr_en":
                get_rapid_ocr(lang="en")
            elif ocr_engine == "rapid_ocr_ch":
                get_rapid_ocr(lang="ch")
            else:
                get_manga_ocr()
        except Exception as ocr_init_err:
            print(f"⚠️ Cảnh báo khởi tạo OCR engine ({ocr_engine}): {ocr_init_err}")

    output_file = os.path.join(OUTPUT_DIR, f"{chapter_id}_translated.json")

    results_lock = threading.Lock()
    all_pages_result = {
        "chapter_id": chapter_id,
        "chapter_title": title_str,
        "source_language": SOURCE_LANG,
        "target_language": TARGET_LANG,
        "total_pages": total_pages,
        "pipeline_mode": "streaming_instant_dispatch",
        "pipeline_type": pipeline_type,
        "translation_provider": translation_provider,
        "pages": []
    }

    api_executor = ThreadPoolExecutor(max_workers=max_api_workers)
    api_futures = []

    print(f"🚀 BẮT ĐẦU BĂNG CHUYỀN STREAMING [Pipeline: {pipeline_type} | Bộ dịch: {translation_provider}]...")
    print("-" * 80)

    for task in pages_tasks:
        p_num = task["page"]
        img_path = task["img_path"]
        dl_url = task.get("download_url")

        t_page_start = time.perf_counter()

        # 1. Tải ảnh nếu có URL và file chưa có trong cache
        dl_ms = 0
        if dl_url:
            t_dl = time.perf_counter()
            download_single_page(dl_url, img_path, p_num)
            dl_ms = (time.perf_counter() - t_dl) * 1000

        if not os.path.exists(img_path):
            print(f"❌ Không tìm thấy file ảnh trang {p_num}: {img_path}")
            continue

        # 2. Đọc ảnh và Detect ngay lập tức trên GPU AMD
        orig_img = cv2.imread(img_path)
        if orig_img is None:
            print(f"❌ Không thể đọc ảnh bằng OpenCV: {img_path}")
            continue

        h, w = orig_img.shape[:2]
        t_det = time.perf_counter()
        bubbles = detect_all_bubbles(detector_session, orig_img)
        det_ms = (time.perf_counter() - t_det) * 1000

        start_offset_s = round(t_page_start - t_start, 2)

        # Nếu trang không có bong bóng thoại (trang bìa hoặc tranh không chữ)
        if not bubbles:
            t_end = time.perf_counter()
            res = {
                "page": p_num,
                "filename": os.path.basename(img_path),
                "resolution": f"{w}x{h}",
                "num_bubbles": 0,
                "start_offset_s": start_offset_s,
                "duration_s": round(t_end - t_page_start, 2),
                "completion_offset_s": round(t_end - t_start, 2),
                "detect_ms": round(det_ms, 1),
                "bubbles": []
            }
            with results_lock:
                all_pages_result["pages"].append(res)
                all_pages_result["pages"].sort(key=lambda x: x["page"])
                save_json_safely(output_file, all_pages_result)
            if progress_callback:
                progress_callback(p_num, total_pages, res)
            print(f"⚡ [Trang {p_num:02d}/{total_pages:02d}] Detect ({det_ms:.0f}ms) ➔ 0 bubble (Xong tại t=+{res['completion_offset_s']}s)")
            continue

        # -----------------------------------------------------------------
        # NHÁNH 1: PIPELINE OCR + TRANS (Bóc text Manga-OCR)
        # -----------------------------------------------------------------
        if pipeline_type == "ocr_trans":
            t_ocr_start = time.perf_counter()
            extract_bubbles_ocr(orig_img, bubbles, ocr_engine=ocr_engine)
            ocr_ms = (time.perf_counter() - t_ocr_start) * 1000
            print(f"⚡ [Trang {p_num:02d}/{total_pages:02d}] Detect ({det_ms:.0f}ms) + OCR [{ocr_engine}] ({ocr_ms:.0f}ms, {len(bubbles):>2d} bubbles) ➔ Dịch [{translation_provider}]...")

            if translation_provider == "raw":
                # Chế độ Raw: Giữ nguyên tiếng Nhật, hoàn tất tức thì
                t_done = time.perf_counter()
                dur_s = round(t_done - t_page_start, 2)
                comp_s = round(t_done - t_start, 2)
                b_res = [{
                    "id": b["id"],
                    "box": b["box"],
                    "vi": b.get("raw", ""),
                    "raw": b.get("raw", "")
                } for b in bubbles]
                page_dict = {
                    "page": p_num,
                    "filename": os.path.basename(img_path),
                    "resolution": f"{w}x{h}",
                    "num_bubbles": len(bubbles),
                    "start_offset_s": round(t_page_start - t_start, 2),
                    "duration_s": dur_s,
                    "completion_offset_s": comp_s,
                    "detect_ms": round(det_ms, 1),
                    "ocr_ms": round(ocr_ms, 1),
                    "bubbles": b_res
                }
                with results_lock:
                    all_pages_result["pages"].append(page_dict)
                    all_pages_result["pages"].sort(key=lambda x: x["page"])
                    save_json_safely(output_file, all_pages_result)
                if progress_callback:
                    progress_callback(p_num, total_pages, page_dict)
                print(f"   ✅ [Trang {p_num:02d}/{total_pages:02d}] HOÀN THÀNH lúc t=+{comp_s:>5.2f}s (tổng mất {dur_s:>4.2f}s, {len(bubbles):>2d} bubbles) [Manga-OCR Raw]")
                continue

            elif translation_provider == "google":
                def _gtrans_task(p, b_list, t_p_start, w_img, h_img, p_path, d_ms, o_ms):
                    raw_texts = [b.get("raw", "") for b in b_list]
                    vi_texts = translate_with_google(raw_texts, target_lang="vi")
                    b_res = []
                    for idx, b in enumerate(b_list):
                        trans = vi_texts[idx] if idx < len(vi_texts) else b.get("raw", "")
                        b_res.append({
                            "id": b["id"],
                            "box": b["box"],
                            "vi": trans,
                            "raw": b.get("raw", "")
                        })
                    t_done = time.perf_counter()
                    dur_s = round(t_done - t_p_start, 2)
                    comp_s = round(t_done - t_start, 2)
                    page_dict = {
                        "page": p,
                        "filename": os.path.basename(p_path),
                        "resolution": f"{w_img}x{h_img}",
                        "num_bubbles": len(b_list),
                        "start_offset_s": round(t_p_start - t_start, 2),
                        "duration_s": dur_s,
                        "completion_offset_s": comp_s,
                        "detect_ms": round(d_ms, 1),
                        "ocr_ms": round(o_ms, 1),
                        "bubbles": b_res
                    }
                    with results_lock:
                        all_pages_result["pages"].append(page_dict)
                        all_pages_result["pages"].sort(key=lambda x: x["page"])
                        save_json_safely(output_file, all_pages_result)
                    if progress_callback:
                        progress_callback(p, total_pages, page_dict)
                    print(f"   ✅ [Trang {p:02d}/{total_pages:02d}] HOÀN THÀNH lúc t=+{comp_s:>5.2f}s (tổng mất {dur_s:>4.2f}s, {len(b_list):>2d} bubbles) [Google Translate]")
                    return page_dict

                fut = api_executor.submit(_gtrans_task, p_num, bubbles, t_page_start, w, h, img_path, det_ms, ocr_ms)
                api_futures.append(fut)

            elif translation_provider == "llm_text":
                def _llm_text_task(p, b_list, t_p_start, w_img, h_img, p_path, d_ms, o_ms):
                    bubble_items = [{"id": b["id"], "text": b.get("raw", "")} for b in b_list]
                    if ocr_engine == "rapid_ocr_en":
                        src_l = "tiếng Anh"
                    elif ocr_engine == "rapid_ocr_ch":
                        src_l = "tiếng Trung"
                    else:
                        src_l = "tiếng Nhật"
                    translations = call_llm_text_translator(api_key, base_url, model, bubble_items, source_lang=src_l)
                    trans_map = {item.get("id"): item.get("vi", "") for item in translations if isinstance(item, dict)}
                    b_res = []
                    for b in b_list:
                        bid = b["id"]
                        trans_text = trans_map.get(bid, "")
                        b_res.append({
                            "id": bid,
                            "box": b["box"],
                            "vi": trans_text if trans_text.strip() else b.get("raw", ""),
                            "raw": b.get("raw", "")
                        })
                    t_done = time.perf_counter()
                    dur_s = round(t_done - t_p_start, 2)
                    comp_s = round(t_done - t_start, 2)
                    page_dict = {
                        "page": p,
                        "filename": os.path.basename(p_path),
                        "resolution": f"{w_img}x{h_img}",
                        "num_bubbles": len(b_list),
                        "start_offset_s": round(t_p_start - t_start, 2),
                        "duration_s": dur_s,
                        "completion_offset_s": comp_s,
                        "detect_ms": round(d_ms, 1),
                        "ocr_ms": round(o_ms, 1),
                        "bubbles": b_res
                    }
                    with results_lock:
                        all_pages_result["pages"].append(page_dict)
                        all_pages_result["pages"].sort(key=lambda x: x["page"])
                        save_json_safely(output_file, all_pages_result)
                    if progress_callback:
                        progress_callback(p, total_pages, page_dict)
                    print(f"   ✅ [Trang {p:02d}/{total_pages:02d}] HOÀN THÀNH lúc t=+{comp_s:>5.2f}s (tổng mất {dur_s:>4.2f}s, {len(b_list):>2d} bubbles) [LLM Text-only]")
                    return page_dict

                fut = api_executor.submit(_llm_text_task, p_num, bubbles, t_page_start, w, h, img_path, det_ms, ocr_ms)
                api_futures.append(fut)

        # -----------------------------------------------------------------
        # NHÁNH 2: PIPELINE IMAGE + TRANS (Multimodal Vision LLM)
        # -----------------------------------------------------------------
        else:
            marked_img = create_marked_image(orig_img, bubbles)
            print(f"⚡ [Trang {p_num:02d}/{total_pages:02d}] Detect ({det_ms:.0f}ms, {len(bubbles):>2d} bubbles) ➔ 🚀 Bắn Vision API...")

            def _vision_task(p, m_img, b_list, t_p_start, w_img, h_img, p_path, d_ms):
                translations = call_qwen_translator(api_key, base_url, model, m_img, len(b_list))
                trans_map = {item.get("id"): item.get("vi", "") for item in translations if isinstance(item, dict)}
                b_res = []
                for b in b_list:
                    bid = b["id"]
                    b_res.append({
                        "id": bid,
                        "box": b["box"],
                        "vi": trans_map.get(bid, ""),
                        "raw": ""
                    })
                t_done = time.perf_counter()
                dur_s = round(t_done - t_p_start, 2)
                comp_s = round(t_done - t_start, 2)
                page_dict = {
                    "page": p,
                    "filename": os.path.basename(p_path),
                    "resolution": f"{w_img}x{h_img}",
                    "num_bubbles": len(b_list),
                    "start_offset_s": round(t_p_start - t_start, 2),
                    "duration_s": dur_s,
                    "completion_offset_s": comp_s,
                    "detect_ms": round(d_ms, 1),
                    "bubbles": b_res
                }
                with results_lock:
                    all_pages_result["pages"].append(page_dict)
                    all_pages_result["pages"].sort(key=lambda x: x["page"])
                    save_json_safely(output_file, all_pages_result)
                if progress_callback:
                    progress_callback(p, total_pages, page_dict)
                print(f"   ✅ [Trang {p:02d}/{total_pages:02d}] HOÀN THÀNH lúc t=+{comp_s:>5.2f}s (tổng mất {dur_s:>4.2f}s, {len(b_list):>2d} bubbles) [Vision LLM]")
                return page_dict

            fut = api_executor.submit(_vision_task, p_num, marked_img, bubbles, t_page_start, w, h, img_path, det_ms)
            api_futures.append(fut)

    # Đợi tất cả các API requests hoàn thành
    for fut in as_completed(api_futures):
        try:
            fut.result()
        except Exception as e:
            print(f"   ❌ Lỗi API: {e}")

    api_executor.shutdown(wait=True)

    total_pipeline_time = round(time.perf_counter() - t_start, 2)
    all_pages_result["total_elapsed_seconds"] = total_pipeline_time
    all_pages_result["avg_seconds_per_page"] = round(total_pipeline_time / total_pages, 2) if total_pages > 0 else 0

    save_json_safely(output_file, all_pages_result)

    # IN BẢNG BÁO CÁO THỜI GIAN TỐC ĐỘ TỪNG TRANG
    print("\n" + "=" * 80)
    print("                BẢNG BÁO CÁO THỜI GIAN VÀ TỐC ĐỘ TỪNG TRANG (STREAMING)")
    print("=" * 80)
    print(f"{'Trang':<8} {'Số Bubble':<12} {'Bắt đầu (+s)':<16} {'Thời gian (s)':<18} {'Hoàn thành (+s)':<16}")
    print("-" * 80)
    for p in all_pages_result["pages"]:
        print(f"Trang {p['page']:02d}   {p['num_bubbles']:<12} +{p['start_offset_s']:<14.2f} {p['duration_s']:>5.2f}s            +{p['completion_offset_s']:<14.2f}")
    print("-" * 80)
    p1 = next((p for p in all_pages_result["pages"] if p["page"] == 1), None)
    if p1:
        print(f"🎯 Thời gian hoàn thành Trang 1 (Time-To-First-Read): {p1['completion_offset_s']:.2f} giây")
    print(f"⏱️  Tổng thời gian toàn bộ {total_pages} trang: {total_pipeline_time:.2f} giây")
    if total_pages > 0:
        print(f"⚡ Tốc độ trung bình: {total_pipeline_time / total_pages:.2f} giây / trang")
    print(f"💾 File JSON lưu tại: {os.path.abspath(output_file)}")
    print("=" * 80)
    return output_file, all_pages_result

def run_manga_chapter_pipeline(chapter_input: str, max_pages: int = None, max_api_workers: int = None,
                               api_key: str = None, base_url: str = None, model: str = None,
                               pipeline_type: str = None, translation_provider: str = None,
                               ocr_engine: str = None, progress_callback=None):
    """Pipeline tải và dịch chapter từ MangaDex URL / Chapter ID."""
    cfg = load_config()
    api_key = api_key or cfg.get("api_key", XKIRO_API_KEY)
    base_url = base_url or cfg.get("base_url", XKIRO_BASE_URL)
    model = model or cfg.get("model", MODEL_NAME)
    pipeline_type = pipeline_type or cfg.get("pipeline_type", "ocr_trans")
    translation_provider = translation_provider or cfg.get("translation_provider", "google")
    if max_api_workers is None:
        max_api_workers = int(cfg.get("max_workers", 10))

    chapter_id, url_page = extract_chapter_id_and_page(chapter_input)
    print(f"🔎 Đang truy vấn thông tin Chapter ID: {chapter_id} từ MangaDex...")

    t_start = time.perf_counter()
    chap_data = fetch_mangadex_chapter_info(chapter_id)
    if max_pages and max_pages < chap_data["total_pages"]:
        chap_data["total_pages"] = max_pages
        chap_data["page_urls"] = chap_data["page_urls"][:max_pages]
        chap_data["filenames"] = chap_data["filenames"][:max_pages]

    total_pages = chap_data["total_pages"]
    meta = chap_data["metadata"]

    # Xử lý tự động nhận diện ngôn ngữ vs ghi đè thủ công
    if not ocr_engine:
        if cfg.get("auto_detect_lang", True):
            md_lang = (meta.get("lang") or "en").lower()
            if md_lang == "ja":
                ocr_engine = "manga_ocr"
            elif md_lang.startswith("zh"):
                ocr_engine = "rapid_ocr_ch"
            else:
                ocr_engine = "rapid_ocr_en"
            print(f"🤖 Tự động chọn OCR engine theo nhãn MangaDex [{md_lang}]: {ocr_engine}")
        else:
            ocr_engine = cfg.get("ocr_engine", "manga_ocr")
    else:
        print(f"🔒 Sử dụng OCR engine được chỉ định thủ công (bỏ qua nhãn MangaDex): {ocr_engine}")

    title_str = f"Chương {meta.get('chapter', '?')} - {meta.get('title', 'Không tiêu đề')}"
    print("=" * 80)
    print(" 🚀 PIPELINE DỊCH MANGADEX STREAMING: TẢI ĐẾN ĐÂU ➔ DETECT & DỊCH NGAY ĐẾN ĐÓ")
    print(f" ⚙️ Pipeline: {pipeline_type} | Bộ dịch: {translation_provider} | OCR: {ocr_engine}")
    print(f" 🎯 Model: {model} (Base URL: {base_url})")
    print(f" 🌐 Ngôn ngữ: {SOURCE_LANG} ➔ {TARGET_LANG}")
    print(f" ⚡ Chế độ: Bắn API song song ngay lập tức khi có ảnh, tối đa {max_api_workers} luồng API!")
    print(f" ✓ Tìm thấy: {title_str}")
    print(f" ✓ Tổng số trang: {total_pages} trang ({chap_data['mode']} mode)")
    print(f" ✓ Ngôn ngữ gốc trên MangaDex: {meta.get('lang', 'en')}")
    print("=" * 80, "\n")

    chap_cache_dir = os.path.join(CACHE_DIR, chapter_id)
    os.makedirs(chap_cache_dir, exist_ok=True)

    pages_tasks = []
    for p_num in range(1, total_pages + 1):
        ext = os.path.splitext(chap_data["filenames"][p_num - 1])[1] or ".jpg"
        img_path = os.path.join(chap_cache_dir, f"page_{p_num:03d}{ext}")
        pages_tasks.append({
            "page": p_num,
            "filename": f"page_{p_num:03d}{ext}",
            "img_path": img_path,
            "download_url": chap_data["page_urls"][p_num - 1]
        })

    return process_pages_stream(
        chapter_id=chapter_id,
        title_str=title_str,
        pages_tasks=pages_tasks,
        api_key=api_key,
        base_url=base_url,
        model=model,
        max_api_workers=max_api_workers,
        pipeline_type=pipeline_type,
        translation_provider=translation_provider,
        ocr_engine=ocr_engine,
        t_start=t_start,
        progress_callback=progress_callback
    )

def run_local_images_pipeline(chapter_id: str, title: str, image_items: list,
                              max_pages: int = None, max_api_workers: int = None,
                              api_key: str = None, base_url: str = None, model: str = None,
                              pipeline_type: str = None, translation_provider: str = None,
                              ocr_engine: str = None, progress_callback=None):
    """
    Pipeline dịch trực tiếp từ danh sách file ảnh cục bộ (Local Images).
    image_items có thể là:
      - Danh sách đường dẫn file ảnh trên ổ cứng (list of str paths)
      - Danh sách tuple/dict: [{"filename": "...", "source_path": "..."}, ...]
    """
    cfg = load_config()
    api_key = api_key or cfg.get("api_key", XKIRO_API_KEY)
    base_url = base_url or cfg.get("base_url", XKIRO_BASE_URL)
    model = model or cfg.get("model", MODEL_NAME)
    pipeline_type = pipeline_type or cfg.get("pipeline_type", "ocr_trans")
    translation_provider = translation_provider or cfg.get("translation_provider", "google")
    ocr_engine = ocr_engine or cfg.get("ocr_engine", "manga_ocr")
    if max_api_workers is None:
        max_api_workers = int(cfg.get("max_workers", 10))

    t_start = time.perf_counter()

    chap_cache_dir = os.path.join(CACHE_DIR, chapter_id)
    os.makedirs(chap_cache_dir, exist_ok=True)

    # Chuẩn hóa danh sách file
    import shutil
    pages_tasks = []

    # Sắp xếp tự nhiên theo tên file gốc
    def _extract_name(item):
        if isinstance(item, dict):
            return item.get("filename") or item.get("name") or str(item)
        return os.path.basename(str(item))

    sorted_items = sorted(image_items, key=_extract_name)
    if max_pages and max_pages < len(sorted_items):
        sorted_items = sorted_items[:max_pages]

    for idx, item in enumerate(sorted_items, 1):
        if isinstance(item, dict):
            src_path = item.get("path") or item.get("source_path")
            orig_name = item.get("filename") or os.path.basename(src_path)
        else:
            src_path = str(item)
            orig_name = os.path.basename(src_path)

        ext = os.path.splitext(orig_name)[1].lower() or ".jpg"
        if ext not in [".jpg", ".jpeg", ".png", ".webp"]:
            ext = ".jpg"

        dest_filename = f"page_{idx:03d}{ext}"
        dest_path = os.path.join(chap_cache_dir, dest_filename)

        # Nếu file nguồn khác file đích, copy vào thư mục cache
        if src_path and os.path.abspath(src_path) != os.path.abspath(dest_path):
            shutil.copy2(src_path, dest_path)

        pages_tasks.append({
            "page": idx,
            "filename": dest_filename,
            "img_path": dest_path,
            "download_url": None
        })

    print("=" * 80)
    print(f" 🚀 PIPELINE DỊCH LOCAL MANGA IMAGES: {title}")
    print(f" 📁 Chapter ID: {chapter_id} | Tổng số trang: {len(pages_tasks)}")
    print(f" ⚙️ Pipeline: {pipeline_type} | Bộ dịch: {translation_provider} | OCR: {ocr_engine}")
    print(f" 🎯 Model: {model} (Base URL: {base_url})")
    print("=" * 80, "\n")

    return process_pages_stream(
        chapter_id=chapter_id,
        title_str=title,
        pages_tasks=pages_tasks,
        api_key=api_key,
        base_url=base_url,
        model=model,
        max_api_workers=max_api_workers,
        pipeline_type=pipeline_type,
        translation_provider=translation_provider,
        ocr_engine=ocr_engine,
        t_start=t_start,
        progress_callback=progress_callback
    )

if __name__ == "__main__":
    demo_url = "https://mangadex.org/chapter/0d1617ea-5f2b-4112-928e-4d57e39bafdd"
    max_p = None

    if len(sys.argv) > 1:
        target_input = sys.argv[1].strip("\"'")
        if len(sys.argv) > 2:
            try:
                max_p = int(sys.argv[2])
            except ValueError:
                pass
    else:
        print("💡 Nhập URL MangaDex HOẶC đường dẫn thư mục ảnh trong máy")
        print(f"   (Nhấn Enter để dùng chapter mẫu MangaDex: {demo_url})")
        user_input = input("👉 Nhập URL MangaDex hoặc Đường dẫn thư mục ảnh: ").strip()
        target_input = user_input.strip("\"'") if user_input else demo_url

    # Kiểm tra nếu là thư mục ảnh trong máy tính
    if os.path.isdir(target_input):
        valid_exts = {".jpg", ".jpeg", ".png", ".webp"}
        files = [
            os.path.join(target_input, f) for f in os.listdir(target_input)
            if os.path.splitext(f)[1].lower() in valid_exts
        ]
        files.sort(key=lambda p: natural_sort_key(os.path.basename(p)))
        if not files:
            print(f"❌ Không tìm thấy file ảnh (.jpg, .png, .webp) nào trong thư mục: {target_input}")
            sys.exit(1)

        folder_name = os.path.basename(os.path.abspath(target_input))
        import datetime
        timestamp_str = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        local_cid = f"local_{timestamp_str}"
        run_local_images_pipeline(
            chapter_id=local_cid,
            title=f"Truyện cục bộ: {folder_name}",
            image_items=files,
            max_pages=max_p
        )
    else:
        run_manga_chapter_pipeline(target_input, max_pages=max_p)

