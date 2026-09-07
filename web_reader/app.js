/**
 * Manga Stream Reader — App Controller
 * Xử lý nạp dữ liệu từ Backend Server, Render ảnh & Tọa độ Bong bóng thoại,
 * Tải lên & Kéo thả file ảnh / thư mục truyện tranh cục bộ.
 */

(function () {
    'use strict';

    // State
    let currentChapterData = null;
    let currentChapterId = null;
    let readerMode = 'strip'; // 'strip' | 'single'
    let currentPageIndex = 0; // 0-based
    let isTranslationVisible = true;
    let bubbleOpacity = 0.96;
    let fontScaleFactor = 1.0;
    let statusPollTimer = null;
    let selectedFiles = []; // Danh sách file ảnh đang chờ upload

    // DOM Elements
    const chapterSelect = document.getElementById('chapter-select');
    const readerViewport = document.getElementById('reader-viewport');
    const modeStripBtn = document.getElementById('mode-strip');
    const modeSingleBtn = document.getElementById('mode-single');
    const singleNav = document.getElementById('single-page-nav');
    const pageCounter = document.getElementById('page-counter');
    const btnPrev = document.getElementById('btn-prev');
    const btnNext = document.getElementById('btn-next');
    const btnToggleTrans = document.getElementById('btn-toggle-trans');
    const transTextStatus = document.getElementById('trans-text-status');
    const btnSettings = document.getElementById('btn-settings');
    const settingsPanel = document.getElementById('settings-panel');
    const btnCloseSettings = document.getElementById('btn-close-settings');
    const sliderOpacity = document.getElementById('slider-opacity');
    const valOpacity = document.getElementById('val-opacity');
    const sliderScale = document.getElementById('slider-scale');
    const valScale = document.getElementById('val-scale');
    const btnFullscreen = document.getElementById('btn-fullscreen');

    // Upload Elements
    const btnOpenUpload = document.getElementById('btn-open-upload');
    const uploadModal = document.getElementById('upload-modal');
    const btnCloseUpload = document.getElementById('btn-close-upload');
    const btnCancelUpload = document.getElementById('btn-cancel-upload');
    const dragDropOverlay = document.getElementById('drag-drop-overlay');
    const modalDropzone = document.getElementById('modal-dropzone');
    const inputFiles = document.getElementById('input-files');
    const inputFolder = document.getElementById('input-folder');
    const inputChapterTitle = document.getElementById('input-chapter-title');
    const uploadPreviewContainer = document.getElementById('upload-preview-container');
    const previewCount = document.getElementById('preview-count');
    const previewList = document.getElementById('preview-list');
    const btnClearFiles = document.getElementById('btn-clear-files');
    const uploadProgressContainer = document.getElementById('upload-progress-container');
    const uploadProgressBar = document.getElementById('upload-progress-bar');
    const uploadStatusText = document.getElementById('upload-status-text');
    const uploadPercentage = document.getElementById('upload-percentage');
    const btnStartUpload = document.getElementById('btn-start-upload');
    const uploadSpinner = document.getElementById('upload-spinner');
    const btnStartUploadText = document.getElementById('btn-start-upload-text');

    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

    // =========================================================================
    // 1. KHỞI TẠO & NẠP DANH SÁCH CHAPTER
    // =========================================================================
    async function init() {
        setupEventListeners();
        setupUploadEvents();
        await loadChaptersList();
    }

    async function loadChaptersList(targetChapterId = null) {
        try {
            const res = await fetch('/api/chapters');
            const data = await res.json();
            chapterSelect.innerHTML = '';

            if (!data.chapters || data.chapters.length === 0) {
                chapterSelect.innerHTML = '<option value="">Chưa có tập nào trong máy</option>';
                readerViewport.innerHTML = `
                    <div class="loading-state">
                        <p style="font-size: 16px; margin-bottom: 8px;">📖 Chưa có tập truyện nào được nạp</p>
                        <p style="font-size: 13px; color: var(--text-muted);">Hãy nhấn nút <strong>"Thêm ảnh"</strong> ở thanh trên hoặc kéo thả ảnh vào đây để bắt đầu!</p>
                    </div>`;
                return;
            }

            data.chapters.forEach((chap) => {
                const opt = document.createElement('option');
                opt.value = chap.chapter_id;
                opt.textContent = `${chap.chapter_title} (${chap.translated_pages} trang)`;
                chapterSelect.appendChild(opt);
            });

            // Chọn chapter chỉ định hoặc chapter đầu tiên
            const selectedId = targetChapterId || (data.chapters[0] ? data.chapters[0].chapter_id : null);
            if (selectedId) {
                chapterSelect.value = selectedId;
                await loadChapter(selectedId);
            }
        } catch (e) {
            console.error('Lỗi nạp danh sách chapter:', e);
            readerViewport.innerHTML = '<div class="loading-state"><p style="color:#f87171;">Không kết nối được server (cổng 8765)</p></div>';
        }
    }

    async function loadChapter(chapterId, preserveScroll = false) {
        currentChapterId = chapterId;
        if (!preserveScroll) {
            readerViewport.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Đang nạp tranh và tọa độ bong bóng thoại...</p></div>';
        }

        try {
            const res = await fetch(`/api/chapter?id=${chapterId}`);
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            const data = await res.json();
            currentChapterData = data;
            if (!preserveScroll) {
                currentPageIndex = 0;
            }
            renderReader();

            // Nếu chapter này đang dịch ngầm hoặc chưa đủ trang, bật theo dõi tiến trình
            checkAndStartPolling(chapterId);
        } catch (e) {
            console.error('Lỗi nạp chapter:', e);
            if (!preserveScroll) {
                readerViewport.innerHTML = `
                    <div class="loading-state">
                        <div class="spinner"></div>
                        <p>Đang chuẩn bị trang truyện...</p>
                    </div>`;
            }
            checkAndStartPolling(chapterId);
        }
    }

    function checkAndStartPolling(chapterId) {
        if (statusPollTimer) clearInterval(statusPollTimer);

        statusPollTimer = setInterval(async () => {
            try {
                const sRes = await fetch(`/api/status?id=${chapterId}`);
                if (!sRes.ok) return;
                const sData = await sRes.json();

                if (sData.status === 'running') {
                    // Tự động làm mới dữ liệu đọc khi có trang mới
                    const cRes = await fetch(`/api/chapter?id=${chapterId}`);
                    if (cRes.ok) {
                        const cData = await cRes.json();
                        const prevPagesCount = currentChapterData ? (currentChapterData.pages ? currentChapterData.pages.length : 0) : 0;
                        const newPagesCount = cData.pages ? cData.pages.length : 0;
                        if (newPagesCount > prevPagesCount) {
                            currentChapterData = cData;
                            renderReader();
                        }
                    }
                } else if (sData.status === 'done') {
                    clearInterval(statusPollTimer);
                    statusPollTimer = null;
                    const cRes = await fetch(`/api/chapter?id=${chapterId}`);
                    if (cRes.ok) {
                        currentChapterData = await cRes.json();
                        renderReader();
                    }
                    // Cập nhật lại số trang trên dropdown
                    refreshChapterSelectText(chapterId);
                } else if (sData.status === 'error') {
                    clearInterval(statusPollTimer);
                    statusPollTimer = null;
                }
            } catch (err) {
                console.warn('Polling status error:', err);
            }
        }, 1500);
    }

    async function refreshChapterSelectText(chapterId) {
        try {
            const res = await fetch('/api/chapters');
            const data = await res.json();
            if (data.chapters) {
                const found = data.chapters.find((c) => c.chapter_id === chapterId);
                if (found) {
                    const opt = chapterSelect.querySelector(`option[value="${chapterId}"]`);
                    if (opt) {
                        opt.textContent = `${found.chapter_title} (${found.translated_pages} trang)`;
                    }
                }
            }
        } catch (e) {}
    }

    // =========================================================================
    // 2. RENDER TRUYỆN TRANH & OVERLAY
    // =========================================================================
    function renderReader() {
        if (!currentChapterData || !currentChapterData.pages || currentChapterData.pages.length === 0) {
            readerViewport.innerHTML = `
                <div class="loading-state">
                    <div class="spinner"></div>
                    <p>Đang tiến hành nhận diện bong bóng & dịch trang đầu tiên (~5-7s)...</p>
                </div>`;
            return;
        }

        readerViewport.innerHTML = '';
        readerViewport.className = `reader-container ${readerMode}-mode`;

        if (readerMode === 'strip') {
            singleNav.classList.add('hidden');
            currentChapterData.pages.forEach((pageData) => {
                const pageEl = createPageElement(pageData);
                readerViewport.appendChild(pageEl);
            });
        } else {
            singleNav.classList.remove('hidden');
            updateSinglePageNav();
            const pageData = currentChapterData.pages[currentPageIndex];
            if (pageData) {
                const pageEl = createPageElement(pageData);
                readerViewport.appendChild(pageEl);
            }
        }
    }

    function createPageElement(pageData) {
        const wrapper = document.createElement('div');
        wrapper.className = 'manga-page-wrapper';
        wrapper.setAttribute('data-page', pageData.page);

        const img = document.createElement('img');
        img.className = 'manga-page-img';
        img.alt = `Trang ${pageData.page}`;
        img.src = `/images/${currentChapterId}/${pageData.filename}`;

        const bubbleLayer = document.createElement('div');
        bubbleLayer.className = 'bubble-layer';

        wrapper.appendChild(img);
        wrapper.appendChild(bubbleLayer);

        // Khi ảnh nạp xong kích thước, render vị trí bong bóng
        img.onload = () => {
            renderBubbles(wrapper, img, bubbleLayer, pageData);
        };

        // Click ảnh trong single mode để sang trang tiếp theo
        if (readerMode === 'single') {
            img.style.cursor = 'pointer';
            img.onclick = (e) => {
                const rect = img.getBoundingClientRect();
                const clickX = e.clientX - rect.left;
                if (clickX < rect.width * 0.35) {
                    prevPage();
                } else {
                    nextPage();
                }
            };
        }

        return wrapper;
    }

    function renderBubbles(wrapper, img, layer, pageData) {
        layer.innerHTML = '';
        if (!pageData.bubbles || pageData.bubbles.length === 0) return;

        const origW = pageData.resolution ? parseInt(pageData.resolution.split('x')[0]) : img.naturalWidth;
        const origH = pageData.resolution ? parseInt(pageData.resolution.split('x')[1]) : img.naturalHeight;

        if (!origW || !origH) return;

        const scaleX = img.clientWidth / origW;
        const scaleY = img.clientHeight / origH;

        pageData.bubbles.forEach((b) => {
            if (!b.vi || b.vi.trim() === '') return;

            const [bx, by, bw, bh] = b.box;
            const bubble = document.createElement('div');
            bubble.className = 'speech-bubble';
            bubble.style.left = `${bx * scaleX}px`;
            bubble.style.top = `${by * scaleY}px`;
            bubble.style.width = `${bw * scaleX}px`;
            bubble.style.height = `${bh * scaleY}px`;
            bubble.style.background = `rgba(255, 255, 255, ${bubbleOpacity})`;
            bubble.style.opacity = isTranslationVisible ? '1' : '0';
            bubble.style.pointerEvents = isTranslationVisible ? 'auto' : 'none';

            // Tính cỡ font tự động thích ứng với diện tích bong bóng thoại
            const area = (bw * scaleX) * (bh * scaleY);
            const textLen = b.vi.length;
            let fontSize = Math.max(9, Math.min(22, Math.sqrt(area / (textLen * 1.35))));
            fontSize = Math.round(fontSize * fontScaleFactor);

            bubble.style.fontSize = `${fontSize}px`;
            bubble.textContent = b.vi;
            layer.appendChild(bubble);
        });
    }

    // =========================================================================
    // 3. ĐIỀU HƯỚNG SINGLE-PAGE & CÁC CHỨC NĂNG PHỤ
    // =========================================================================
    function updateSinglePageNav() {
        if (!currentChapterData || !currentChapterData.pages) return;
        const total = currentChapterData.pages.length;
        pageCounter.textContent = `Trang ${currentPageIndex + 1} / ${total}`;
        btnPrev.disabled = currentPageIndex === 0;
        btnNext.disabled = currentPageIndex === total - 1;
    }

    function prevPage() {
        if (currentPageIndex > 0) {
            currentPageIndex--;
            renderReader();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    }

    function nextPage() {
        if (currentChapterData && currentChapterData.pages && currentPageIndex < currentChapterData.pages.length - 1) {
            currentPageIndex++;
            renderReader();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    }

    function toggleTranslation() {
        isTranslationVisible = !isTranslationVisible;
        btnToggleTrans.classList.toggle('active', isTranslationVisible);
        transTextStatus.textContent = isTranslationVisible ? '🇻🇳 Tiếng Việt' : '🌐 Bản gốc';

        document.querySelectorAll('.speech-bubble').forEach((bubble) => {
            bubble.style.opacity = isTranslationVisible ? '1' : '0';
            bubble.style.pointerEvents = isTranslationVisible ? 'auto' : 'none';
        });
    }

    // =========================================================================
    // 4. HỆ THỐNG TẢI LÊN FILE ẢNH & DRAG-AND-DROP CỤC BỘ
    // =========================================================================
    function setupUploadEvents() {
        // Mở/Đóng Modal
        btnOpenUpload.addEventListener('click', openUploadModal);
        btnCloseUpload.addEventListener('click', closeUploadModal);
        btnCancelUpload.addEventListener('click', closeUploadModal);

        uploadModal.addEventListener('click', (e) => {
            if (e.target === uploadModal) closeUploadModal();
        });

        // Chọn file và thư mục
        inputFiles.addEventListener('change', (e) => {
            if (e.target.files) addFiles(e.target.files);
            inputFiles.value = '';
        });

        inputFolder.addEventListener('change', (e) => {
            if (e.target.files) addFiles(e.target.files);
            inputFolder.value = '';
        });

        btnClearFiles.addEventListener('click', () => {
            selectedFiles = [];
            renderPreviewList();
        });

        // Bắt đầu upload
        btnStartUpload.addEventListener('click', executeUpload);

        // Kéo thả toàn màn hình (Full-screen Drag & Drop)
        let dragCounter = 0;
        window.addEventListener('dragenter', (e) => {
            e.preventDefault();
            dragCounter++;
            dragDropOverlay.classList.remove('hidden');
        });

        window.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dragCounter--;
            if (dragCounter <= 0) {
                dragCounter = 0;
                dragDropOverlay.classList.add('hidden');
            }
        });

        window.addEventListener('dragover', (e) => {
            e.preventDefault();
        });

        window.addEventListener('drop', (e) => {
            e.preventDefault();
            dragCounter = 0;
            dragDropOverlay.classList.add('hidden');
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                openUploadModal();
                addFiles(e.dataTransfer.files);
            }
        });

        // Kéo thả trực tiếp vào vùng Dropzone trong modal
        modalDropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            modalDropzone.classList.add('drag-hover');
        });

        modalDropzone.addEventListener('dragleave', () => {
            modalDropzone.classList.remove('drag-hover');
        });

        modalDropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            modalDropzone.classList.remove('drag-hover');
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                addFiles(e.dataTransfer.files);
            }
        });
    }

    function openUploadModal() {
        uploadModal.classList.remove('hidden');
        uploadProgressContainer.classList.add('hidden');
        uploadProgressBar.style.width = '0%';
        btnStartUpload.disabled = selectedFiles.length === 0;
    }

    function closeUploadModal() {
        uploadModal.classList.add('hidden');
    }

    function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function addFiles(fileList) {
        const validExts = ['.jpg', '.jpeg', '.png', '.webp'];
        let detectedFolder = '';

        for (let i = 0; i < fileList.length; i++) {
            const f = fileList[i];
            const lowerName = f.name.toLowerCase();
            const isValid = validExts.some((ext) => lowerName.endsWith(ext));

            if (!isValid) continue;

            // Kiểm tra trùng lặp
            const exists = selectedFiles.some((item) => item.name === f.name && item.size === f.size);
            if (!exists) {
                selectedFiles.push(f);
            }

            // Gợi ý tên tập từ thư mục
            if (f.webkitRelativePath && !detectedFolder) {
                const parts = f.webkitRelativePath.split('/');
                if (parts.length > 1) {
                    detectedFolder = parts[0];
                }
            }
        }

        // Sắp xếp tự nhiên theo tên file (1, 2, ..., 9, 10)
        selectedFiles.sort((a, b) => collator.compare(a.name, b.name));

        if (detectedFolder && !inputChapterTitle.value.trim()) {
            inputChapterTitle.value = detectedFolder;
        } else if (!inputChapterTitle.value.trim() && selectedFiles.length > 0) {
            const firstBase = selectedFiles[0].name.replace(/\.[^/.]+$/, '').replace(/page_?|\d+/gi, '').trim();
            if (firstBase) {
                inputChapterTitle.value = `Tập truyện: ${firstBase}`;
            }
        }

        renderPreviewList();
    }

    function renderPreviewList() {
        if (selectedFiles.length === 0) {
            uploadPreviewContainer.classList.add('hidden');
            btnStartUpload.disabled = true;
            return;
        }

        uploadPreviewContainer.classList.remove('hidden');
        previewCount.textContent = `${selectedFiles.length} ảnh đã chọn`;
        previewList.innerHTML = '';
        btnStartUpload.disabled = false;

        selectedFiles.forEach((f, idx) => {
            const item = document.createElement('div');
            item.className = 'preview-item';

            const left = document.createElement('div');
            left.className = 'preview-item-left';

            const badge = document.createElement('span');
            badge.className = 'page-badge';
            badge.textContent = `#${idx + 1}`;

            const name = document.createElement('span');
            name.className = 'file-name';
            name.title = f.name;
            name.textContent = f.name;

            left.appendChild(badge);
            left.appendChild(name);

            const size = document.createElement('span');
            size.className = 'file-size';
            size.textContent = formatFileSize(f.size);

            item.appendChild(left);
            item.appendChild(size);
            previewList.appendChild(item);
        });
    }

    async function executeUpload() {
        if (selectedFiles.length === 0) return;

        const title = inputChapterTitle.value.trim() || `Tập truyện máy (${selectedFiles.length} trang)`;
        btnStartUpload.disabled = true;
        uploadSpinner.classList.remove('hidden');
        btnStartUploadText.textContent = 'Đang tải lên...';
        uploadProgressContainer.classList.remove('hidden');
        uploadProgressBar.style.width = '0%';
        uploadPercentage.textContent = '0%';
        uploadStatusText.textContent = 'Đang chuẩn bị dữ liệu ảnh...';

        const formData = new FormData();
        formData.append('title', title);

        selectedFiles.forEach((file) => {
            formData.append('files', file, file.name);
        });

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload-chapter', true);

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                const pct = Math.round((e.loaded / e.total) * 100);
                uploadProgressBar.style.width = `${pct}%`;
                uploadPercentage.textContent = `${pct}%`;
                uploadStatusText.textContent = `Đang tải lên server (${pct}%)...`;
            }
        };

        xhr.onload = async () => {
            uploadSpinner.classList.add('hidden');
            btnStartUploadText.textContent = '🚀 Bắt đầu dịch';
            btnStartUpload.disabled = false;

            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    const data = JSON.parse(xhr.responseText);
                    if (data.ok) {
                        uploadStatusText.textContent = '✅ Đã tải lên xong! Đang kích hoạt băng chuyền dịch...';
                        uploadProgressBar.style.width = '100%';
                        uploadPercentage.textContent = '100%';

                        setTimeout(async () => {
                            closeUploadModal();
                            selectedFiles = [];
                            renderPreviewList();
                            inputChapterTitle.value = '';
                            await loadChaptersList(data.chapter_id);
                        }, 600);
                        return;
                    }
                } catch (e) {}
            }

            alert(`Lỗi khi tải lên: ${xhr.responseText || 'Không thể kết nối server'}`);
            uploadStatusText.textContent = '❌ Tải lên thất bại';
        };

        xhr.onerror = () => {
            uploadSpinner.classList.add('hidden');
            btnStartUploadText.textContent = '🚀 Bắt đầu dịch';
            btnStartUpload.disabled = false;
            alert('Lỗi mạng: Không thể gửi dữ liệu lên server backend.');
            uploadStatusText.textContent = '❌ Lỗi kết nối mạng';
        };

        xhr.send(formData);
    }

    // =========================================================================
    // 5. GẮN CÁC SỰ KIỆN GIAO DIỆN CHÍNH
    // =========================================================================
    function setupEventListeners() {
        // Đổi chapter trên dropdown
        chapterSelect.addEventListener('change', (e) => {
            if (e.target.value) {
                loadChapter(e.target.value);
            }
        });

        // Mode toggles
        modeStripBtn.addEventListener('click', () => {
            readerMode = 'strip';
            modeStripBtn.classList.add('active');
            modeSingleBtn.classList.remove('active');
            renderReader();
        });

        modeSingleBtn.addEventListener('click', () => {
            readerMode = 'single';
            modeSingleBtn.classList.add('active');
            modeStripBtn.classList.remove('active');
            renderReader();
        });

        // Điều hướng từng trang
        btnPrev.addEventListener('click', prevPage);
        btnNext.addEventListener('click', nextPage);

        // Nút toggle bản dịch
        btnToggleTrans.addEventListener('click', toggleTranslation);

        // Bảng cài đặt
        btnSettings.addEventListener('click', () => {
            settingsPanel.classList.toggle('hidden');
        });
        btnCloseSettings.addEventListener('click', () => {
            settingsPanel.classList.add('hidden');
        });

        // Slider độ mờ
        sliderOpacity.addEventListener('input', (e) => {
            bubbleOpacity = e.target.value / 100;
            valOpacity.textContent = `${e.target.value}%`;
            document.querySelectorAll('.speech-bubble').forEach((b) => {
                b.style.background = `rgba(255, 255, 255, ${bubbleOpacity})`;
            });
        });

        // Slider cỡ chữ
        sliderScale.addEventListener('input', (e) => {
            fontScaleFactor = e.target.value / 100;
            valScale.textContent = `${e.target.value}%`;
            document.querySelectorAll('.manga-page-wrapper').forEach((wrapper) => {
                const img = wrapper.querySelector('.manga-page-img');
                const layer = wrapper.querySelector('.bubble-layer');
                const pNum = parseInt(wrapper.getAttribute('data-page'));
                const pageData = currentChapterData?.pages?.find((p) => p.page === pNum);
                if (img && layer && pageData) {
                    renderBubbles(wrapper, img, layer, pageData);
                }
            });
        });

        // Fullscreen
        btnFullscreen.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(() => {});
            } else {
                document.exitFullscreen().catch(() => {});
            }
        });

        // Phím tắt bàn phím
        window.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            const key = e.key.toLowerCase();
            if (key === 't') {
                toggleTranslation();
            } else if (key === 'f') {
                btnFullscreen.click();
            } else if (readerMode === 'single') {
                if (key === 'arrowleft' || key === 'a') {
                    prevPage();
                } else if (key === 'arrowright' || key === 'd') {
                    nextPage();
                }
            }
        });

        // Tự động căn chỉnh lại các bubble khi resize cửa sổ
        window.addEventListener('resize', () => {
            document.querySelectorAll('.manga-page-wrapper').forEach((wrapper) => {
                const img = wrapper.querySelector('.manga-page-img');
                const layer = wrapper.querySelector('.bubble-layer');
                const pNum = parseInt(wrapper.getAttribute('data-page'));
                const pageData = currentChapterData?.pages?.find((p) => p.page === pNum);
                if (img && layer && pageData && img.complete) {
                    renderBubbles(wrapper, img, layer, pageData);
                }
            });
        });
    }

    // Chạy app khi trang load xong
    document.addEventListener('DOMContentLoaded', init);
})();
