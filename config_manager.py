"""
Quản lý cấu hình tập trung cho Manga Translator (config.json)
Hỗ trợ đọc, ghi động và ẩn API Key an toàn
"""

import os
import json
import threading

CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
config_lock = threading.Lock()

DEFAULT_CONFIG = {
    "api_key": "",
    "base_url": "https://api.xkiro.com/v1",
    "model": "qwen/qwen3.5-flash:free",
    "source_lang": "tiếng Anh (hoặc tiếng Nhật gốc)",
    "target_lang": "tiếng Việt",
    "server_port": 8765,
    "max_workers": 10,
    "pipeline_type": "ocr_trans",
    "translation_provider": "google"
}

def load_config() -> dict:
    """Đọc file config.json, nếu chưa có thì tự động tạo với giá trị mặc định."""
    with config_lock:
        if not os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                    json.dump(DEFAULT_CONFIG, f, ensure_ascii=False, indent=2)
            except Exception as e:
                print(f"⚠️ Không thể tạo config.json: {e}")
            return DEFAULT_CONFIG.copy()

        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                merged = DEFAULT_CONFIG.copy()
                merged.update(cfg)
                return merged
        except Exception as e:
            print(f"⚠️ Lỗi đọc config.json, dùng cấu hình mặc định: {e}")
            return DEFAULT_CONFIG.copy()

def normalize_base_url(url: str) -> str:
    """Tự động chuẩn hóa Base URL (đặc biệt hỗ trợ định dạng Google AI Studio)."""
    if not url:
        return ""
    clean = url.strip().rstrip("/")
    if "generativelanguage.googleapis.com" in clean:
        if not clean.endswith("/openai"):
            if "/v1beta" in clean:
                clean = clean + "/openai"
            else:
                clean = "https://generativelanguage.googleapis.com/v1beta/openai"
    return clean

def save_config(new_config: dict) -> dict:
    """Lưu cấu hình mới vào config.json."""
    with config_lock:
        current = DEFAULT_CONFIG.copy()
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    current.update(json.load(f))
            except Exception:
                pass

        # Cập nhật các trường hợp lệ
        valid_keys = [
            "api_key", "base_url", "model", "source_lang", "target_lang",
            "server_port", "max_workers", "pipeline_type", "translation_provider"
        ]
        for k in valid_keys:
            if k in new_config and new_config[k] is not None:
                val = new_config[k]
                if k == "base_url" and isinstance(val, str):
                    val = normalize_base_url(val)
                current[k] = val

        # Kiểm tra tính đồng nhất của pipeline_type và translation_provider
        if current.get("pipeline_type") == "image_trans":
            current["translation_provider"] = "vision_llm"
        elif current.get("pipeline_type") == "ocr_trans":
            if current.get("translation_provider") not in ["google", "llm_text", "raw"]:
                current["translation_provider"] = "google"

        tmp_file = CONFIG_FILE + ".tmp"
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(current, f, ensure_ascii=False, indent=2)
        os.replace(tmp_file, CONFIG_FILE)
        return current

def mask_api_key(key: str) -> str:
    """Che bớt ký tự của API Key để hiển thị an toàn trên UI."""
    if not key:
        return ""
    if len(key) <= 8:
        return "****"
    return f"{key[:6]}...{key[-4:]}"
