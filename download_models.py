"""
Script Tự Động Kiểm Tra & Tải Mô Hình AI Cho Manga Translator
- Model 1: Comic-Text-Detector ONNX (~94 MB) từ HuggingFace 'mayocream/comic-text-detector-onnx'
- Model 2: Manga-OCR ONNX (~870 MB) từ HuggingFace 'mayocream/manga-ocr-onnx'
Chạy độc lập để chuẩn bị môi trường cho máy mới mà không cần copy 1GB model qua USB hay Git.
"""

import os
import sys
import time

# Đảm bảo in UTF-8 trên Windows console
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(SCRIPT_DIR)

DETECTOR_PATH = os.path.join("models", "comic-text-detector.onnx")

def check_dependencies():
    """Kiểm tra các thư viện bắt buộc."""
    missing = []
    try:
        import huggingface_hub
    except ImportError:
        missing.append("huggingface_hub")
    try:
        import manga_ocr
    except ImportError:
        missing.append("manga-ocr-torchless")
    try:
        import onnxruntime
    except ImportError:
        missing.append("onnxruntime-directml")
    try:
        from PIL import Image
    except ImportError:
        missing.append("pillow")

    if missing:
        print("❌ Thiếu một số thư viện Python cần thiết:")
        for m in missing:
            print(f"   - {m}")
        print("\n👉 Vui lòng cài đặt trước bằng lệnh: pip install -r requirements.txt\n")
        return False
    return True

def download_comic_text_detector(check_only=False):
    """Kiểm tra và tải mô hình Comic-Text-Detector."""
    os.makedirs("models", exist_ok=True)
    if os.path.exists(DETECTOR_PATH) and os.path.getsize(DETECTOR_PATH) > 10 * 1024 * 1024:
        size_mb = os.path.getsize(DETECTOR_PATH) / (1024 * 1024)
        print(f"✓ [1/2] Comic-Text-Detector đã có sẵn tại '{DETECTOR_PATH}' ({size_mb:.1f} MB)")
        return True

    if check_only:
        print(f"❌ [1/2] Comic-Text-Detector chưa được tải về ('{DETECTOR_PATH}' không tồn tại).")
        return False

    print("📥 [1/2] Đang tải Comic-Text-Detector từ HuggingFace (mayocream/comic-text-detector-onnx)...")
    print("       (Dung lượng ~94 MB, vui lòng đợi một chút...)")
    try:
        from huggingface_hub import hf_hub_download
        t0 = time.perf_counter()
        hf_hub_download(
            repo_id="mayocream/comic-text-detector-onnx",
            filename="comic-text-detector.onnx",
            local_dir="models"
        )
        dt = time.perf_counter() - t0
        print(f"✓ [1/2] Tải thành công Comic-Text-Detector trong {dt:.1f}s!\n")
        return True
    except Exception as e:
        print(f"❌ Lỗi khi tải Comic-Text-Detector: {e}")
        return False

def download_manga_ocr(check_only=False):
    """Kiểm tra và tải mô hình Manga-OCR ONNX vào cache."""
    # Đảm bảo cho phép tải online nếu chưa có trong cache
    os.environ.pop("HF_HUB_OFFLINE", None)

    try:
        from manga_ocr import MangaOcr
        from PIL import Image

        if check_only:
            # Thử nạp offline xem đã có trong cache chưa
            os.environ["HF_HUB_OFFLINE"] = "1"
            try:
                _ = MangaOcr()
                print("✓ [2/2] Manga-OCR ONNX đã có sẵn trong bộ nhớ đệm (offline ready)")
                return True
            except Exception:
                print("❌ [2/2] Manga-OCR ONNX chưa được tải vào cache máy.")
                return False
            finally:
                os.environ.pop("HF_HUB_OFFLINE", None)

        print("📥 [2/2] Đang kiểm tra và tải Manga-OCR ONNX từ HuggingFace (mayocream/manga-ocr-onnx)...")
        print("       (Gồm encoder/decoder ONNX và tokenizer ~870 MB, tiến trình tải sẽ tự động thực hiện...)")
        t0 = time.perf_counter()
        mocr = MangaOcr()

        # Chạy kiểm thử giả lập 1 ảnh trắng để đảm bảo DirectML / ONNX chạy ổn định
        dummy_img = Image.new("RGB", (100, 30), color="white")
        _ = mocr(dummy_img)

        dt = time.perf_counter() - t0
        print(f"✓ [2/2] Manga-OCR đã sẵn sàng và kiểm thử thành công ({dt:.1f}s)!\n")
        return True
    except Exception as e:
        print(f"❌ Lỗi khi tải / khởi tạo Manga-OCR: {e}")
        return False

def main():
    print("=" * 80)
    print(" 🛠️  KIỂM TRA VÀ TẢI MÔ HÌNH AI CHO MANGA TRANSLATOR")
    print("=" * 80)

    check_only = "--check" in sys.argv or "--check-only" in sys.argv

    if not check_dependencies():
        sys.exit(1)

    ok1 = download_comic_text_detector(check_only=check_only)
    ok2 = download_manga_ocr(check_only=check_only)

    print("-" * 80)
    if ok1 and ok2:
        print("🎉 TẤT CẢ MÔ HÌNH AI ĐÃ SẴN SÀNG ĐỂ SỬ DỤNG!")
        print("👉 Bây giờ bạn có thể chạy: start_server.bat để khởi động ứng dụng.")
        print("=" * 80)
        sys.exit(0)
    else:
        print("⚠️ Một số mô hình chưa được tải thành công. Vui lòng kiểm tra kết nối mạng và thử lại.")
        print("=" * 80)
        sys.exit(1)

if __name__ == "__main__":
    main()
