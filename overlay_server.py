"""
Local Backend Server phục vụ Overlay MangaDex (Hướng 1) & Local Web Reader (Hướng 2)
Cổng mặc định: 8765 (http://127.0.0.1:8765)
Hỗ trợ đầy đủ CORS cho Tampermonkey / Browser Extension
"""

import os
import sys
import json
import re
import mimetypes
import threading
from urllib.parse import urlparse, parse_qs
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

# Đảm bảo UTF-8 trên Windows console
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(SCRIPT_DIR)

# Import module dịch & config
import email
from email.policy import default
import datetime
import httpx
from config_manager import (
    load_config, save_config, mask_api_key, normalize_base_url,
    get_safe_config, switch_profile, add_or_update_profile, delete_profile
)

def extract_chapter_id(input_str: str) -> str:
    m = re.search(r"([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})", input_str, re.I)
    return m.group(1).lower() if m else input_str.strip()

try:
    from mangadex_batch_translator import (
        run_manga_chapter_pipeline, run_local_images_pipeline,
        natural_sort_key, CACHE_DIR, OUTPUT_DIR
    )
except ImportError:
    CACHE_DIR = "cache_chapters"
    OUTPUT_DIR = "output_translations"
    def natural_sort_key(s): return s

PORT = 8765
active_translations = {}  # {chapter_id: {"status": "running"|"done"|"error", "progress": "..."}}
translations_lock = threading.Lock()

class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

class MangaOverlayHandler(BaseHTTPRequestHandler):
    def end_headers(self):
        # Thiết lập CORS headers để Tampermonkey từ trang MangaDex có thể gọi vào
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        # 0. API: Lấy cấu hình hệ thống
        if path == "/api/config":
            show_full = query.get("full", ["0"])[0] in ("1", "true")
            resp_cfg = get_safe_config(full=show_full)
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(resp_cfg, ensure_ascii=False).encode("utf-8"))
            return

        # 1. API: Danh sách chapters đã dịch
        if path == "/api/chapters":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()

            chapters_list = []
            if os.path.exists(OUTPUT_DIR):
                for f in sorted(os.listdir(OUTPUT_DIR)):
                    if f.endswith("_translated.json"):
                        cid = f.replace("_translated.json", "")
                        fpath = os.path.join(OUTPUT_DIR, f)
                        try:
                            with open(fpath, "r", encoding="utf-8") as jf:
                                data = json.load(jf)
                                chapters_list.append({
                                    "chapter_id": cid,
                                    "chapter_title": data.get("chapter_title", "Không tiêu đề"),
                                    "total_pages": data.get("total_pages", len(data.get("pages", []))),
                                    "translated_pages": len(data.get("pages", [])),
                                    "total_elapsed_seconds": data.get("total_elapsed_seconds", 0),
                                    "source_lang": data.get("source_language", "en"),
                                })
                        except Exception:
                            chapters_list.append({"chapter_id": cid, "chapter_title": cid})

            self.wfile.write(json.dumps({"chapters": chapters_list}, ensure_ascii=False).encode("utf-8"))
            return

        # 2. API: Lấy chi tiết bản dịch JSON của 1 chapter
        if path == "/api/chapter":
            cid = query.get("id", [""])[0].strip()
            if not cid:
                self.send_error(400, "Missing id parameter")
                return

            fpath = os.path.join(OUTPUT_DIR, f"{cid}_translated.json")
            if not os.path.exists(fpath):
                self.send_response(404)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Chưa có bản dịch cho chapter này"}, ensure_ascii=False).encode("utf-8"))
                return

            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            with open(fpath, "rb") as jf:
                self.wfile.write(jf.read())
            return

        # 3. API: Kiểm tra trạng thái dịch ngầm
        if path == "/api/status":
            cid = query.get("id", [""])[0].strip()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()

            with translations_lock:
                status_info = active_translations.get(cid, {"status": "idle"})
            
            # Kiểm tra xem file json đã có chưa và bao nhiêu trang
            fpath = os.path.join(OUTPUT_DIR, f"{cid}_translated.json")
            completed_pages = 0
            total_pages = 0
            if os.path.exists(fpath):
                try:
                    with open(fpath, "r", encoding="utf-8") as jf:
                        d = json.load(jf)
                        completed_pages = len(d.get("pages", []))
                        total_pages = d.get("total_pages", 0)
                except Exception:
                    pass

            if not total_pages and "total_pages" in status_info:
                total_pages = status_info["total_pages"]

            resp_data = {
                "chapter_id": cid,
                "status": status_info.get("status", "idle"),
                "completed_pages": max(completed_pages, status_info.get("completed_pages", 0)),
                "total_pages": total_pages,
                "message": status_info.get("message", "")
            }
            self.wfile.write(json.dumps(resp_data, ensure_ascii=False).encode("utf-8"))
            return

        # 3.5. API: Lấy metadata chi tiết của chapter (ngôn ngữ, số trang, tiêu đề)
        if path == "/api/chapter-info":
            cid = params.get("id", [""])[0]
            if not cid:
                self.send_error(400, "Missing id parameter")
                return
            try:
                from mangadex_batch_translator import fetch_mangadex_chapter_info
                c_info = fetch_mangadex_chapter_info(cid)
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "ok": True,
                    "chapter_id": cid,
                    "metadata": c_info.get("metadata", {}),
                    "total_pages": c_info.get("total_pages", 0)
                }, ensure_ascii=False).encode("utf-8"))
            except Exception as e:
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "message": str(e)}, ensure_ascii=False).encode("utf-8"))
            return

        # 4. Stream ảnh từ thư mục cache cho Local Web Reader: /images/{chapter_id}/{filename}
        m_img = re.match(r"^/images/([^/]+)/([^/]+)$", path)
        if m_img:
            cid, fname = m_img.groups()
            img_full_path = os.path.join(CACHE_DIR, cid, fname)
            if not os.path.exists(img_full_path):
                self.send_error(404, "Image not found")
                return

            mime_type, _ = mimetypes.guess_type(img_full_path)
            if not mime_type:
                mime_type = "image/jpeg"

            self.send_response(200)
            self.send_header("Content-Type", mime_type)
            self.send_header("Content-Length", str(os.path.getsize(img_full_path)))
            self.end_headers()
            with open(img_full_path, "rb") as f:
                self.wfile.write(f.read())
            return

        # 5. Phục vụ Userscript trực tiếp cho Tampermonkey cài đặt / cập nhật 1-click
        if path == "/mangadex_overlay.user.js":
            userscript_path = os.path.join(SCRIPT_DIR, "mangadex_overlay.user.js")
            if os.path.exists(userscript_path):
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript; charset=utf-8")
                self.send_header("Content-Length", str(os.path.getsize(userscript_path)))
                self.end_headers()
                with open(userscript_path, "rb") as f:
                    self.wfile.write(f.read())
                return

        # 6. Phục vụ file tĩnh của Local Web Reader từ thư mục web_reader/
        static_path = path.lstrip("/")
        if not static_path or static_path == "reader":
            static_path = "index.html"
        elif static_path == "settings":
            static_path = "settings.html"
        elif static_path.startswith("web_reader/"):
            static_path = static_path[len("web_reader/"):]

        web_reader_dir = os.path.join(SCRIPT_DIR, "web_reader")
        file_to_serve = os.path.join(web_reader_dir, static_path)

        if os.path.exists(file_to_serve) and os.path.isfile(file_to_serve):
            mime_type, _ = mimetypes.guess_type(file_to_serve)
            if not mime_type:
                mime_type = "text/plain; charset=utf-8"
            elif mime_type.startswith("text/") or mime_type in ("application/javascript", "application/json"):
                mime_type += "; charset=utf-8"

            self.send_response(200)
            self.send_header("Content-Type", mime_type)
            self.send_header("Content-Length", str(os.path.getsize(file_to_serve)))
            self.end_headers()
            with open(file_to_serve, "rb") as f:
                self.wfile.write(f.read())
            return

        # Mặc định trả về 404
        self.send_error(404, "Endpoint not found")

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        # API: Cập nhật cấu hình hệ thống
        if path == "/api/config":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode("utf-8")
            try:
                payload = json.loads(body) if body else {}
                new_cfg = save_config(payload)
                safe_cfg = get_safe_config(full=True if payload.get("return_full") else False)
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "ok": True,
                    "message": "Đã cập nhật cấu hình thành công",
                    "config": safe_cfg,
                    "active_profile": safe_cfg.get("active_profile")
                }, ensure_ascii=False).encode("utf-8"))
            except Exception as e:
                import traceback
                traceback.print_exc()
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "message": str(e)}, ensure_ascii=False).encode("utf-8"))
            return

        # API: Kiểm tra kết nối API Key và Model
        if path == "/api/test-api":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode("utf-8")
            try:
                payload = json.loads(body) if body else {}
            except Exception:
                payload = {}
            
            cfg = load_config()
            profile_id = payload.get("profile_id")
            if profile_id and profile_id in cfg.get("profiles", {}):
                prof = cfg["profiles"][profile_id]
                api_key = payload.get("api_key") or prof.get("api_key")
                base_url = normalize_base_url(payload.get("base_url") or prof.get("base_url"))
                model = payload.get("model") or prof.get("model")
            else:
                api_key = payload.get("api_key") or cfg.get("api_key")
                base_url = normalize_base_url(payload.get("base_url") or cfg.get("base_url"))
                model = payload.get("model") or cfg.get("model")

            if not api_key or not base_url or not model:
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "message": "Thiếu API Key, Base URL hoặc Model. Vui lòng kiểm tra lại cấu hình!"}, ensure_ascii=False).encode("utf-8"))
                return

            try:
                test_payload = {
                    "model": model,
                    "messages": [{"role": "user", "content": "Hello, please reply exactly 'OK'"}],
                    "max_tokens": 15
                }
                test_headers = {
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json"
                }
                with httpx.Client(timeout=15.0) as client:
                    resp = client.post(f"{base_url.rstrip('/')}/chat/completions", json=test_payload, headers=test_headers)
                if resp.status_code == 200:
                    res_data = resp.json()
                    reply = res_data.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.end_headers()
                    self.wfile.write(json.dumps({"ok": True, "reply": reply, "message": "Kết nối thành công"}, ensure_ascii=False).encode("utf-8"))
                else:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.end_headers()
                    self.wfile.write(json.dumps({"ok": False, "message": f"HTTP {resp.status_code}: {resp.text[:200]}"}, ensure_ascii=False).encode("utf-8"))
            except Exception as e:
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "message": str(e)}, ensure_ascii=False).encode("utf-8"))
            return

        # API: Kích hoạt dịch chapter mới
        if path == "/api/translate":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode("utf-8")
            try:
                payload = json.loads(body)
            except Exception:
                payload = {}

            target_url = payload.get("url") or payload.get("chapter_id") or ""
            if not target_url:
                self.send_error(400, "Missing url or chapter_id")
                return

            cid = extract_chapter_id(target_url)
            override_key = payload.get("api_key")
            override_url = payload.get("base_url")
            override_model = payload.get("model")
            override_pipeline = payload.get("pipeline_type")
            override_provider = payload.get("translation_provider")
            override_ocr_engine = payload.get("ocr_engine")

            with translations_lock:
                if cid in active_translations and active_translations[cid]["status"] == "running":
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.end_headers()
                    self.wfile.write(json.dumps({"status": "running", "message": "Chapter đang được dịch"}, ensure_ascii=False).encode("utf-8"))
                    return

                active_translations[cid] = {"status": "running", "message": "Đang dịch..."}

            # Chạy pipeline dịch trong background thread
            def _bg_translate():
                try:
                    run_manga_chapter_pipeline(
                        target_url,
                        api_key=override_key,
                        base_url=override_url,
                        model=override_model,
                        pipeline_type=override_pipeline,
                        translation_provider=override_provider,
                        ocr_engine=override_ocr_engine
                    )
                    with translations_lock:
                        active_translations[cid] = {"status": "done", "message": "Hoàn tất"}
                except Exception as e:
                    with translations_lock:
                        active_translations[cid] = {"status": "error", "message": str(e)}

            t = threading.Thread(target=_bg_translate, daemon=True)
            t.start()

            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "started",
                "chapter_id": cid,
                "message": "Đã bắt đầu tiến trình dịch ngầm"
            }, ensure_ascii=False).encode("utf-8"))
            return

        # API: Tải lên danh sách file ảnh để dịch chapter mới từ máy tính (Local Manga Upload)
        if path == "/api/upload-chapter":
            content_type = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in content_type:
                self.send_response(400)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "message": "Content-Type phải là multipart/form-data"}, ensure_ascii=False).encode("utf-8"))
                return

            content_length = int(self.headers.get("Content-Length", 0))
            if content_length > 250 * 1024 * 1024:  # Giới hạn 250MB
                self.send_response(413)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "message": "Dung lượng tải lên vượt quá 250MB"}, ensure_ascii=False).encode("utf-8"))
                return

            body = self.rfile.read(content_length)

            # Phân tích multipart/form-data sử dụng thư viện chuẩn email của Python
            raw_msg = b"Content-Type: " + content_type.encode("latin-1") + b"\r\n\r\n" + body
            msg = email.message_from_bytes(raw_msg, policy=default)

            uploaded_files = []
            custom_title = ""
            custom_pipeline = ""
            custom_provider = ""
            custom_ocr_engine = ""

            for part in msg.iter_parts():
                disp_name = part.get_param("name", header="content-disposition")
                filename = part.get_filename()

                if filename:
                    file_data = part.get_payload(decode=True)
                    if file_data and len(file_data) > 0:
                        uploaded_files.append((filename, file_data))
                elif disp_name == "title":
                    raw_val = part.get_payload(decode=True)
                    if raw_val:
                        custom_title = raw_val.decode("utf-8", errors="replace").strip()
                elif disp_name == "pipeline_type":
                    raw_val = part.get_payload(decode=True)
                    if raw_val:
                        custom_pipeline = raw_val.decode("utf-8", errors="replace").strip()
                elif disp_name == "translation_provider":
                    raw_val = part.get_payload(decode=True)
                    if raw_val:
                        custom_provider = raw_val.decode("utf-8", errors="replace").strip()
                elif disp_name == "ocr_engine":
                    raw_val = part.get_payload(decode=True)
                    if raw_val:
                        custom_ocr_engine = raw_val.decode("utf-8", errors="replace").strip()

            if not uploaded_files:
                self.send_response(400)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "message": "Không tìm thấy file ảnh hợp lệ nào trong request"}, ensure_ascii=False).encode("utf-8"))
                return

            # Sắp xếp số tự nhiên theo tên file gốc (1, 2, ..., 9, 10)
            uploaded_files.sort(key=lambda item: natural_sort_key(item[0]))

            timestamp_str = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            cid = f"local_{timestamp_str}"
            chap_title = custom_title if custom_title else f"Tập truyện máy ({len(uploaded_files)} trang)"

            chap_cache_dir = os.path.join(CACHE_DIR, cid)
            os.makedirs(chap_cache_dir, exist_ok=True)

            local_image_items = []
            for idx, (orig_name, file_bytes) in enumerate(uploaded_files, 1):
                ext = os.path.splitext(orig_name)[1].lower() or ".jpg"
                if ext not in [".jpg", ".jpeg", ".png", ".webp"]:
                    ext = ".jpg"
                save_fname = f"page_{idx:03d}{ext}"
                save_fpath = os.path.join(chap_cache_dir, save_fname)
                with open(save_fpath, "wb") as f:
                    f.write(file_bytes)
                local_image_items.append({
                    "filename": save_fname,
                    "path": save_fpath
                })

            with translations_lock:
                active_translations[cid] = {
                    "status": "running",
                    "completed_pages": 0,
                    "total_pages": len(local_image_items),
                    "message": f"Đang dịch 0/{len(local_image_items)} trang..."
                }

            # Kích hoạt pipeline dịch trong background thread
            def _bg_translate():
                try:
                    def _on_prog(p, total, p_data):
                        with translations_lock:
                            active_translations[cid] = {
                                "status": "running",
                                "completed_pages": p,
                                "total_pages": total,
                                "message": f"Đang xử lý trang {p}/{total}"
                            }

                    run_local_images_pipeline(
                        chapter_id=cid,
                        title=chap_title,
                        image_items=local_image_items,
                        pipeline_type=custom_pipeline or None,
                        translation_provider=custom_provider or None,
                        ocr_engine=custom_ocr_engine or None,
                        progress_callback=_on_prog
                    )
                    with translations_lock:
                        active_translations[cid] = {"status": "done", "message": "Hoàn tất"}
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    with translations_lock:
                        active_translations[cid] = {"status": "error", "message": str(e)}

            t = threading.Thread(target=_bg_translate, daemon=True)
            t.start()

            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({
                "ok": True,
                "status": "started",
                "chapter_id": cid,
                "title": chap_title,
                "total_pages": len(local_image_items),
                "message": f"Đã nạp {len(local_image_items)} trang và đang tiến hành dịch ngầm"
            }, ensure_ascii=False).encode("utf-8"))
            return

        self.send_error(404, "Endpoint POST not found")

    def log_message(self, format, *args):
        # Giảm ồn console, chỉ log lỗi
        if len(args) > 1 and "200" not in str(args[1]):
            super().log_message(format, *args)

def run_server(port=PORT):
    server_address = ("127.0.0.1", port)
    httpd = ThreadingHTTPServer(server_address, MangaOverlayHandler)
    print("=" * 75)
    print(f" 🌐 MANGA OVERLAY & READER BACKEND SERVER")
    print(f" 🚀 Đang chạy tại: http://127.0.0.1:{port}")
    print(f" 📖 Local Web Reader: http://127.0.0.1:{port}/")
    print(f" ⚙️ Cài đặt API: http://127.0.0.1:{port}/settings")
    print(f" 🔌 API Chapters: http://127.0.0.1:{port}/api/chapters")
    print("=" * 75)
    print("💡 Server sẵn sàng nhận kết nối từ Userscript Tampermonkey và Web Reader!\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nĐang tắt server...")
        httpd.server_close()

if __name__ == "__main__":
    run_server()
