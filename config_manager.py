"""
Quản lý cấu hình tập trung cho Manga Translator (config.json)
Hỗ trợ Multi-Profile API Key, Custom Models và ẩn API Key an toàn
"""

import os
import json
import copy
import time
import threading

CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
config_lock = threading.Lock()

DEFAULT_PROFILES = {
    "xkiro_qwen": {
        "id": "xkiro_qwen",
        "name": "xKiro Qwen 3.5 Flash",
        "base_url": "https://api.xkiro.com/v1",
        "model": "qwen/qwen3.5-flash:free",
        "api_key": "",
        "is_builtin": True
    },
    "google_aistudio": {
        "id": "google_aistudio",
        "name": "Google AI Studio",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "model": "gemini-2.0-flash",
        "api_key": "",
        "is_builtin": True
    },
    "xkiro_gemini": {
        "id": "xkiro_gemini",
        "name": "xKiro Gemini 2.5 Flash",
        "base_url": "https://api.xkiro.com/v1",
        "model": "google/gemini-2.5-flash",
        "api_key": "",
        "is_builtin": True
    },
    "openrouter_gemini": {
        "id": "openrouter_gemini",
        "name": "OpenRouter Gemini 2.0",
        "base_url": "https://openrouter.ai/api/v1",
        "model": "google/gemini-2.0-flash-001",
        "api_key": "",
        "is_builtin": True
    }
}

DEFAULT_CONFIG = {
    "active_profile": "xkiro_qwen",
    "profiles": DEFAULT_PROFILES,
    "api_key": "",
    "base_url": "https://api.xkiro.com/v1",
    "model": "qwen/qwen3.5-flash:free",
    "source_lang": "tiếng Anh (hoặc tiếng Nhật gốc)",
    "target_lang": "tiếng Việt",
    "server_port": 8765,
    "max_workers": 10,
    "pipeline_type": "ocr_trans",
    "translation_provider": "google",
    "ocr_engine": "manga_ocr",
    "auto_detect_lang": True
}

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

def mask_api_key(key: str) -> str:
    """Che bớt ký tự của API Key để hiển thị an toàn trên UI."""
    if not key:
        return ""
    if len(key) <= 8:
        return "****"
    return f"{key[:6]}...{key[-4:]}"

def _ensure_profiles_structure(cfg: dict, is_new_or_legacy: bool = False) -> dict:
    """Đảm bảo dictionary config có cấu trúc profiles hợp lệ và tương thích ngược."""
    existing_key = cfg.get("api_key", "").strip()
    existing_url = cfg.get("base_url", "").strip()
    existing_model = cfg.get("model", "").strip()

    if "profiles" not in cfg or not isinstance(cfg["profiles"], dict) or not cfg["profiles"] or is_new_or_legacy:
        if "profiles" not in cfg or not isinstance(cfg["profiles"], dict) or not cfg["profiles"]:
            cfg["profiles"] = copy.deepcopy(DEFAULT_PROFILES)
        
        # Di chuyển API key hiện có vào profile tương ứng nếu có
        if existing_key:
            matched = False
            for pid, prof in cfg["profiles"].items():
                # So sánh base_url tương đối
                p_url = prof.get("base_url", "").strip().rstrip("/")
                e_url = existing_url.rstrip("/")
                if (p_url == e_url or ("xkiro" in p_url and "xkiro" in e_url)) and prof.get("model") == existing_model:
                    prof["api_key"] = existing_key
                    cfg["active_profile"] = pid
                    matched = True
                    break
            if not matched:
                # Nếu không khớp preset mặc định nào
                if existing_key and not cfg["profiles"].get("xkiro_qwen", {}).get("api_key"):
                    cfg["profiles"]["xkiro_qwen"]["api_key"] = existing_key
                else:
                    custom_id = "custom_saved"
                    cfg["profiles"][custom_id] = {
                        "id": custom_id,
                        "name": f"Tùy chỉnh ({existing_model or 'Custom'})",
                        "base_url": existing_url or "https://api.xkiro.com/v1",
                        "model": existing_model or "qwen/qwen3.5-flash:free",
                        "api_key": existing_key,
                        "is_builtin": False
                    }
                    cfg["active_profile"] = custom_id

    # Đảm bảo các profile mặc định luôn tồn tại
    for pid, d_prof in DEFAULT_PROFILES.items():
        if pid not in cfg["profiles"]:
            cfg["profiles"][pid] = copy.deepcopy(d_prof)
        else:
            for field in ["id", "name", "base_url", "model", "is_builtin"]:
                if field not in cfg["profiles"][pid]:
                    cfg["profiles"][pid][field] = d_prof[field]
            if "api_key" not in cfg["profiles"][pid]:
                cfg["profiles"][pid]["api_key"] = ""

    # Kiểm tra active_profile hợp lệ
    if "active_profile" not in cfg or cfg["active_profile"] not in cfg["profiles"]:
        cfg["active_profile"] = "xkiro_qwen"

    # Đồng bộ top-level api_key, base_url, model từ active_profile
    active = cfg["profiles"][cfg["active_profile"]]
    cfg["base_url"] = active.get("base_url", cfg.get("base_url", ""))
    cfg["model"] = active.get("model", cfg.get("model", ""))
    
    # Nếu active_profile chưa có key mà top-level có key (legacy migrate)
    if not active.get("api_key") and existing_key:
        active["api_key"] = existing_key
    cfg["api_key"] = active.get("api_key", "")

    return cfg

def load_config() -> dict:
    """Đọc file config.json, nếu chưa có thì tự động tạo với giá trị mặc định."""
    with config_lock:
        if not os.path.exists(CONFIG_FILE):
            cfg = copy.deepcopy(DEFAULT_CONFIG)
            try:
                with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                    json.dump(cfg, f, ensure_ascii=False, indent=2)
            except Exception as e:
                print(f"⚠️ Không thể tạo config.json: {e}")
            return cfg

        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            
            is_legacy = "profiles" not in loaded
            merged = copy.deepcopy(DEFAULT_CONFIG)
            merged.update(loaded)
            _ensure_profiles_structure(merged, is_new_or_legacy=is_legacy)
            return merged
        except Exception as e:
            print(f"⚠️ Lỗi đọc config.json, dùng cấu hình mặc định: {e}")
            return copy.deepcopy(DEFAULT_CONFIG)

def get_safe_config(full: bool = False) -> dict:
    """Lấy cấu hình an toàn để trả về cho UI/API (hỗ trợ che API Key)."""
    cfg = load_config()
    safe_cfg = copy.deepcopy(cfg)

    # Thêm cờ has_key cho từng profile để UI dễ hiển thị badge
    for pid, prof in safe_cfg.get("profiles", {}).items():
        prof_key = prof.get("api_key", "").strip()
        prof["has_key"] = bool(prof_key)
        if not full:
            prof["api_key"] = mask_api_key(prof_key)

    top_key = safe_cfg.get("api_key", "").strip()
    safe_cfg["has_key"] = bool(top_key)
    if not full:
        safe_cfg["api_key"] = mask_api_key(top_key)

    return safe_cfg

def switch_profile(profile_id: str) -> dict:
    """Kích hoạt một profile được chọn, đồng bộ ra top-level và lưu file."""
    with config_lock:
        current = copy.deepcopy(DEFAULT_CONFIG)
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    current.update(json.load(f))
            except Exception:
                pass
        _ensure_profiles_structure(current)

        if profile_id in current["profiles"]:
            current["active_profile"] = profile_id
            active = current["profiles"][profile_id]
            current["base_url"] = active.get("base_url", "")
            current["model"] = active.get("model", "")
            current["api_key"] = active.get("api_key", "")

        tmp_file = CONFIG_FILE + ".tmp"
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(current, f, ensure_ascii=False, indent=2)
        os.replace(tmp_file, CONFIG_FILE)
        return current

def add_or_update_profile(prof_data: dict, make_active: bool = True) -> dict:
    """Thêm mới hoặc cập nhật một profile (hỗ trợ custom models)."""
    with config_lock:
        current = copy.deepcopy(DEFAULT_CONFIG)
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    current.update(json.load(f))
            except Exception:
                pass
        _ensure_profiles_structure(current)

        pid = prof_data.get("id")
        if not pid:
            # Tạo ID duy nhất từ tên model hoặc timestamp
            clean_name = "".join(c for c in prof_data.get("model", "custom") if c.isalnum()).lower()
            pid = f"custom_{clean_name}_{int(time.time() % 10000)}"

        base_url = normalize_base_url(prof_data.get("base_url", "").strip())
        name = prof_data.get("name", "").strip() or prof_data.get("model", "Custom Model")
        model = prof_data.get("model", "").strip()
        api_key = prof_data.get("api_key", "").strip()

        # Nếu đang update profile đã có mà người dùng để trống api_key, giữ lại key cũ
        if pid in current["profiles"] and not api_key:
            api_key = current["profiles"][pid].get("api_key", "")

        is_builtin = current["profiles"][pid].get("is_builtin", False) if pid in current["profiles"] else False

        current["profiles"][pid] = {
            "id": pid,
            "name": name,
            "base_url": base_url,
            "model": model,
            "api_key": api_key,
            "is_builtin": is_builtin
        }

        if make_active:
            current["active_profile"] = pid
            current["base_url"] = base_url
            current["model"] = model
            current["api_key"] = api_key

        tmp_file = CONFIG_FILE + ".tmp"
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(current, f, ensure_ascii=False, indent=2)
        os.replace(tmp_file, CONFIG_FILE)
        return current

def delete_profile(profile_id: str) -> dict:
    """Xóa một profile tùy chỉnh (không cho phép xóa profile mặc định)."""
    with config_lock:
        current = copy.deepcopy(DEFAULT_CONFIG)
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    current.update(json.load(f))
            except Exception:
                pass
        _ensure_profiles_structure(current)

        if profile_id in current["profiles"]:
            if current["profiles"][profile_id].get("is_builtin", False):
                raise ValueError(f"Không thể xóa profile mặc định: {profile_id}")
            del current["profiles"][profile_id]

            # Nếu profile vừa xóa đang là active, chuyển về xkiro_qwen
            if current.get("active_profile") == profile_id:
                current["active_profile"] = "xkiro_qwen"
                active = current["profiles"]["xkiro_qwen"]
                current["base_url"] = active.get("base_url", "")
                current["model"] = active.get("model", "")
                current["api_key"] = active.get("api_key", "")

        tmp_file = CONFIG_FILE + ".tmp"
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(current, f, ensure_ascii=False, indent=2)
        os.replace(tmp_file, CONFIG_FILE)
        return current

def save_config(new_config: dict) -> dict:
    """Lưu cấu hình mới vào config.json với đồng bộ 2 chiều Multi-Profile."""
    # Xử lý các action đặc thù nếu có
    action = new_config.get("action")
    if action == "switch_profile":
        return switch_profile(new_config.get("profile_id", "xkiro_qwen"))
    elif action in ("add_profile", "save_profile"):
        return add_or_update_profile(new_config.get("profile", {}), new_config.get("make_active", True))
    elif action == "delete_profile":
        return delete_profile(new_config.get("profile_id", ""))

    with config_lock:
        current = copy.deepcopy(DEFAULT_CONFIG)
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    current.update(json.load(f))
            except Exception:
                pass
        _ensure_profiles_structure(current)

        # Cập nhật active_profile nếu có chỉ định
        if "active_profile" in new_config and new_config["active_profile"] in current["profiles"]:
            current["active_profile"] = new_config["active_profile"]

        active_id = current["active_profile"]

        # Cập nhật các trường hợp lệ
        valid_keys = [
            "api_key", "base_url", "model", "source_lang", "target_lang",
            "server_port", "max_workers", "pipeline_type", "translation_provider",
            "ocr_engine", "auto_detect_lang"
        ]
        for k in valid_keys:
            if k in new_config and new_config[k] is not None:
                val = new_config[k]
                if k == "base_url" and isinstance(val, str):
                    val = normalize_base_url(val)
                current[k] = val

        # Đồng bộ ngược: cập nhật vào active profile
        if active_id in current["profiles"]:
            act_prof = current["profiles"][active_id]
            if "base_url" in new_config and new_config["base_url"]:
                act_prof["base_url"] = current["base_url"]
            if "model" in new_config and new_config["model"]:
                act_prof["model"] = current["model"]
            if "api_key" in new_config and new_config["api_key"] is not None:
                # Nếu chuỗi không rỗng hoặc người dùng cố tình cập nhật key
                act_prof["api_key"] = current["api_key"]

        # Cập nhật danh sách profiles nếu payload gửi danh sách profiles
        if "profiles" in new_config and isinstance(new_config["profiles"], dict):
            for pid, pdata in new_config["profiles"].items():
                if pid in current["profiles"]:
                    current["profiles"][pid].update(pdata)
                else:
                    current["profiles"][pid] = pdata

        # Kiểm tra tính đồng nhất của pipeline_type và translation_provider
        if current.get("pipeline_type") == "image_trans":
            current["translation_provider"] = "vision_llm"
        elif current.get("pipeline_type") == "ocr_trans":
            if current.get("translation_provider") not in ["google", "llm_text", "raw"]:
                current["translation_provider"] = "google"

        # Kiểm tra ocr_engine và auto_detect_lang
        if current.get("ocr_engine") not in ["manga_ocr", "rapid_ocr_en", "rapid_ocr_ch"]:
            current["ocr_engine"] = "manga_ocr"
        if not isinstance(current.get("auto_detect_lang"), bool):
            current["auto_detect_lang"] = True

        tmp_file = CONFIG_FILE + ".tmp"
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(current, f, ensure_ascii=False, indent=2)
        os.replace(tmp_file, CONFIG_FILE)
        return current

