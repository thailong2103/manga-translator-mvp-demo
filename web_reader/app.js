/**
 * MangaStream AI — Unified Controller (Reader & Settings SPA)
 * Phong cách Sổ tay Manga Hand-Drawn Design System
 * Tích hợp liền mạch: Trình đọc Web Reader, Cài đặt Hệ thống, Tải truyện máy tính, Cài đặt Userscript MangaDex.
 */

(function () {
    'use strict';

    // =========================================================================
    // 0. GLOBAL STATE
    // =========================================================================
    let currentView = 'reader'; // 'reader' | 'settings'
    let appConfig = null;
    let currentChapterData = null;
    let currentChapterId = null;
    let readerMode = 'strip'; // 'strip' | 'single'
    let currentPageIndex = 0; // 0-based
    let isTranslationVisible = true;
    let bubbleOpacity = 0.96;
    let fontScaleFactor = 1.0;
    let statusPollTimer = null;
    let selectedFiles = [];

    // Settings State
    let activeProfileId = 'default';
    let currentPipeline = 'ocr_trans';
    let currentOcrEngine = 'manga_ocr';
    let currentProvider = 'google';
    let autoDetectLang = true;

    // Presets for AI Providers
    const PRESETS = {
        xkiro: {
            name: 'xKiro API',
            baseUrl: 'https://api.xkiro.com/v1',
            model: 'qwen/qwen3.5-flash:free'
        },
        gemini: {
            name: 'Google Gemini',
            baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
            model: 'gemini-2.0-flash'
        },
        openrouter: {
            name: 'OpenRouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            model: 'qwen/qwen-2.5-72b-instruct'
        },
        groq: {
            name: 'Groq Cloud',
            baseUrl: 'https://api.groq.com/openai/v1',
            model: 'llama-3.3-70b-versatile'
        },
        openai: {
            name: 'OpenAI',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-4o-mini'
        },
        ollama: {
            name: 'Ollama Local',
            baseUrl: 'http://localhost:11434/v1',
            model: 'llama3'
        }
    };

    // =========================================================================
    // 1. DOM ELEMENTS
    // =========================================================================
    // Views & Nav
    const viewReader = document.getElementById('view-reader');
    const viewSettings = document.getElementById('view-settings');
    const tabBtnReader = document.getElementById('tab-btn-reader');
    const tabBtnSettings = document.getElementById('tab-btn-settings');
    const brandLink = document.getElementById('brand-link');
    const readerControlsCenter = document.getElementById('reader-controls-center');
    const readerModeSwitchGroup = document.getElementById('reader-mode-switch-group');

    // Reader Elements
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
    const btnQuickSettings = document.getElementById('btn-quick-settings');
    const quickSettingsPanel = document.getElementById('quick-settings-panel');
    const btnCloseQuickSettings = document.getElementById('btn-close-quick-settings');
    const sliderOpacity = document.getElementById('slider-opacity');
    const valOpacity = document.getElementById('val-opacity');
    const sliderScale = document.getElementById('slider-scale');
    const valScale = document.getElementById('val-scale');
    const btnFullscreen = document.getElementById('btn-fullscreen');

    // Settings Elements
    const profileSelect = document.getElementById('profile-select');
    const btnNewProfile = document.getElementById('btn-new-profile');
    const btnDeleteProfile = document.getElementById('btn-delete-profile');
    const cardPipelineOcr = document.getElementById('card-pipeline-ocr');
    const cardPipelineVision = document.getElementById('card-pipeline-vision');
    const sectionOcrEngine = document.getElementById('section-ocr-engine');
    const cardOcrManga = document.getElementById('card-ocr-manga');
    const cardOcrRapidEn = document.getElementById('card-ocr-rapid-en');
    const cardOcrRapidCh = document.getElementById('card-ocr-rapid-ch');
    const switchAutoDetect = document.getElementById('switch-auto-detect');
    const sectionTranslationProvider = document.getElementById('section-translation-provider');
    const cardProviderGoogle = document.getElementById('card-provider-google');
    const cardProviderLlm = document.getElementById('card-provider-llm');
    const cardProviderRaw = document.getElementById('card-provider-raw');
    const sectionApiCredentials = document.getElementById('section-api-credentials');
    const selectProviderPreset = document.getElementById('select-provider-preset');
    const inputApiKey = document.getElementById('input-api-key');
    const btnToggleKey = document.getElementById('btn-toggle-key');
    const inputBaseUrl = document.getElementById('input-base-url');
    const inputModel = document.getElementById('input-model');
    const inputWorkers = document.getElementById('input-workers');
    const btnTestApi = document.getElementById('btn-test-api');
    const btnSaveSettings = document.getElementById('btn-save-settings');

    // Upload & Modals
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

    // Userscript Modal
    const btnOpenUserscript = document.getElementById('btn-open-userscript');
    const userscriptModal = document.getElementById('userscript-modal');
    const btnCloseUserscript = document.getElementById('btn-close-userscript');
    const btnDoneUserscript = document.getElementById('btn-done-userscript');

    // Toast
    const toastNotification = document.getElementById('toast-notification');

    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

    // =========================================================================
    // 2. UNIFIED SPA NAVIGATION
    // =========================================================================
    function switchView(targetView) {
        currentView = targetView;

        if (targetView === 'settings') {
            viewReader.classList.remove('active');
            viewSettings.classList.add('active');
            tabBtnReader.classList.remove('active');
            tabBtnSettings.classList.add('active');

            // Ẩn các nút điều khiển trang đọc truyện ở header
            if (readerControlsCenter) readerControlsCenter.style.visibility = 'hidden';
            if (readerModeSwitchGroup) readerModeSwitchGroup.style.display = 'none';
            if (btnToggleTrans) btnToggleTrans.style.display = 'none';
            if (btnQuickSettings) btnQuickSettings.style.display = 'none';
            if (quickSettingsPanel) quickSettingsPanel.classList.add('hidden');

            window.location.hash = '#settings';
            loadSettingsConfig();
        } else {
            viewSettings.classList.remove('active');
            viewReader.classList.add('active');
            tabBtnSettings.classList.remove('active');
            tabBtnReader.classList.add('active');

            // Hiện lại các nút điều khiển của trình đọc truyện
            if (readerControlsCenter) readerControlsCenter.style.visibility = 'visible';
            if (readerModeSwitchGroup) readerModeSwitchGroup.style.display = 'flex';
            if (btnToggleTrans) btnToggleTrans.style.display = 'flex';
            if (btnQuickSettings) btnQuickSettings.style.display = 'inline-flex';

            window.location.hash = '#reader';
        }
    }

    function handleRoute() {
        const hash = window.location.hash;
        const path = window.location.pathname;
        if (hash === '#settings' || path === '/settings') {
            switchView('settings');
        } else {
            switchView('reader');
        }
    }

    // =========================================================================
    // 3. TOAST NOTIFICATION
    // =========================================================================
    let toastTimer = null;
    function showToast(message, type = 'success') {
        if (!toastNotification) return;
        clearTimeout(toastTimer);
        toastNotification.className = `toast-msg show ${type}`;
        toastNotification.textContent = message;
        toastTimer = setTimeout(() => {
            toastNotification.classList.remove('show');
        }, 3200);
    }

    // =========================================================================
    // 4. READER CONTROLLER
    // =========================================================================
    async function loadChaptersList(targetChapterId = null) {
        try {
            const res = await fetch('/api/chapters');
            const data = await res.json();
            chapterSelect.innerHTML = '';

            if (!data.chapters || data.chapters.length === 0) {
                chapterSelect.innerHTML = '<option value="">Chưa có tập nào trong máy</option>';
                readerViewport.innerHTML = `
                    <div class="empty-state">
                        <div style="font-size: 44px; margin-bottom: 12px;">📖</div>
                        <h3 style="font-family: var(--font-marker); font-size: 22px; margin-bottom: 8px;">Chưa có tập truyện nào được nạp</h3>
                        <p style="font-size: 16px; color: #555; margin-bottom: 18px;">Hãy nhấn nút <strong>"Thêm Truyện"</strong> ở thanh trên hoặc kéo thả ảnh vào đây để bắt đầu!</p>
                        <button type="button" class="sketch-btn primary" onclick="document.getElementById('btn-open-upload').click()">
                            <span>📁</span> Thêm Ảnh Truyện Ngay
                        </button>
                    </div>`;
                return;
            }

            data.chapters.forEach((chap) => {
                const opt = document.createElement('option');
                opt.value = chap.chapter_id;
                opt.textContent = `${chap.chapter_title} (${chap.translated_pages} trang)`;
                chapterSelect.appendChild(opt);
            });

            const selectedId = targetChapterId || (data.chapters[0] ? data.chapters[0].chapter_id : null);
            if (selectedId) {
                chapterSelect.value = selectedId;
                loadChapter(selectedId);
            }
        } catch (err) {
            console.error('Lỗi khi nạp danh sách chapters:', err);
            showToast('Không thể kết nối với máy chủ cục bộ!', 'error');
        }
    }

    async function loadChapter(chapterId) {
        currentChapterId = chapterId;
        currentPageIndex = 0;
        if (statusPollTimer) clearInterval(statusPollTimer);

        readerViewport.innerHTML = `
            <div id="loading-spinner" class="loading-state">
                <div class="sketch-spinner"></div>
                <h3 style="font-family: var(--font-marker); margin-bottom: 6px;">Đang nạp truyện tranh...</h3>
                <p>Đang chuẩn bị trang và tọa độ bong bóng thoại.</p>
            </div>`;

        try {
            const res = await fetch(`/api/chapter?id=${encodeURIComponent(chapterId)}`);
            if (res.status === 404) {
                pollChapterStatus(chapterId);
                return;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            currentChapterData = await res.json();
            renderChapter();
            startPollingProgressIfNeeded(chapterId);
        } catch (err) {
            console.error('Lỗi nạp chapter:', err);
            readerViewport.innerHTML = `
                <div class="empty-state">
                    <h3 style="font-family: var(--font-marker); color: var(--marker-red); margin-bottom: 8px;">Không thể tải tập truyện này</h3>
                    <p style="color: #666;">${err.message}</p>
                </div>`;
        }
    }

    function renderChapter() {
        if (!currentChapterData || !currentChapterData.pages) return;
        const pages = currentChapterData.pages;
        readerViewport.innerHTML = '';

        if (readerMode === 'strip') {
            readerViewport.className = 'strip-mode';
            singleNav.classList.add('hidden');
            pages.forEach((page, idx) => {
                const pageEl = createPageElement(page, idx);
                readerViewport.appendChild(pageEl);
            });
        } else {
            readerViewport.className = 'single-mode';
            singleNav.classList.remove('hidden');
            updatePageCounter();
            const pageEl = createPageElement(pages[currentPageIndex], currentPageIndex);
            readerViewport.appendChild(pageEl);
        }

        applyBubbleVisibility();
    }

    function createPageElement(page, pageIndex) {
        const wrapper = document.createElement('div');
        wrapper.className = 'manga-page-wrapper';
        wrapper.id = `manga-page-${pageIndex}`;

        const img = document.createElement('img');
        img.className = 'manga-page-img';
        img.alt = `Trang ${pageIndex + 1}`;
        img.loading = 'lazy';

        const imgSrc = page.image_url || `/images/${currentChapterId}/${page.filename || 'page_' + (pageIndex + 1) + '.jpg'}`;
        img.src = imgSrc;

        wrapper.appendChild(img);

        const bubblesContainer = document.createElement('div');
        bubblesContainer.className = 'bubbles-container';

        img.onload = () => {
            renderBubblesForPage(page, bubblesContainer, img);
        };

        if (img.complete) {
            renderBubblesForPage(page, bubblesContainer, img);
        }

        wrapper.appendChild(bubblesContainer);
        return wrapper;
    }

    function renderBubblesForPage(page, container, img) {
        container.innerHTML = '';
        if (!page.bubbles || page.bubbles.length === 0) return;

        const naturalW = img.naturalWidth || page.width || 1000;
        const naturalH = img.naturalHeight || page.height || 1400;

        page.bubbles.forEach((b) => {
            const [x, y, w, h] = b.box;
            const text = b.vi || b.text || b.raw || '';
            if (!text.trim()) return;

            const bubble = document.createElement('div');
            bubble.className = 'bubble-overlay';

            const leftPct = (x / naturalW) * 100;
            const topPct = (y / naturalH) * 100;
            const widthPct = (w / naturalW) * 100;
            const heightPct = (h / naturalH) * 100;

            bubble.style.left = `${leftPct}%`;
            bubble.style.top = `${topPct}%`;
            bubble.style.width = `${widthPct}%`;
            bubble.style.height = `${heightPct}%`;
            bubble.style.backgroundColor = `rgba(255, 255, 255, ${bubbleOpacity})`;

            const inner = document.createElement('span');
            inner.className = 'bubble-text-inner';
            inner.textContent = text;

            const baseFontSize = Math.max(12, Math.min(22, Math.sqrt(w * h) / 10));
            inner.style.fontSize = `${baseFontSize * fontScaleFactor}px`;

            bubble.appendChild(inner);
            container.appendChild(bubble);
        });
    }

    function applyBubbleVisibility() {
        const bubbles = document.querySelectorAll('.bubble-overlay');
        bubbles.forEach((b) => {
            b.style.display = isTranslationVisible ? 'flex' : 'none';
            b.style.backgroundColor = `rgba(255, 255, 255, ${bubbleOpacity})`;
            const inner = b.querySelector('.bubble-text-inner');
            if (inner) {
                const currentPx = parseFloat(inner.style.fontSize) || 14;
                inner.style.fontSize = `${currentPx}px`;
            }
        });

        if (transTextStatus) {
            transTextStatus.textContent = isTranslationVisible ? 'Tiếng Việt' : 'Bản Scan Gốc';
        }
        if (btnToggleTrans) {
            btnToggleTrans.classList.toggle('active', isTranslationVisible);
        }
    }

    function updatePageCounter() {
        if (!currentChapterData || !currentChapterData.pages) return;
        const total = currentChapterData.pages.length;
        pageCounter.textContent = `Trang ${currentPageIndex + 1} / ${total}`;
    }

    function goToPage(index) {
        if (!currentChapterData || !currentChapterData.pages) return;
        const total = currentChapterData.pages.length;
        if (index < 0 || index >= total) return;
        currentPageIndex = index;
        renderChapter();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function pollChapterStatus(chapterId) {
        statusPollTimer = setInterval(async () => {
            try {
                const res = await fetch(`/api/status?id=${encodeURIComponent(chapterId)}`);
                const data = await res.json();
                if (data.status === 'done' || data.completed_pages > 0) {
                    clearInterval(statusPollTimer);
                    loadChapter(chapterId);
                }
            } catch (e) {
                console.warn('Lỗi kiểm tra tiến trình:', e);
            }
        }, 1500);
    }

    function startPollingProgressIfNeeded(chapterId) {
        if (!currentChapterData) return;
        const totalPages = currentChapterData.total_pages || 0;
        const currentPages = (currentChapterData.pages || []).length;
        if (totalPages > 0 && currentPages < totalPages) {
            statusPollTimer = setInterval(async () => {
                try {
                    const res = await fetch(`/api/status?id=${encodeURIComponent(chapterId)}`);
                    const data = await res.json();
                    if (data.completed_pages > currentPages) {
                        const r2 = await fetch(`/api/chapter?id=${encodeURIComponent(chapterId)}`);
                        if (r2.ok) {
                            currentChapterData = await r2.json();
                            renderChapter();
                        }
                    }
                    if (data.status === 'done' || data.completed_pages >= totalPages) {
                        clearInterval(statusPollTimer);
                    }
                } catch (e) {}
            }, 3000);
        }
    }

    // =========================================================================
    // 5. SETTINGS CONTROLLER (PROFILES, PIPELINE, OCR, API)
    // =========================================================================
    async function loadSettingsConfig() {
        try {
            const res = await fetch('/api/config?full=1');
            appConfig = await res.json();
            populateSettingsUI();
        } catch (err) {
            console.error('Lỗi khi nạp cấu hình hệ thống:', err);
            showToast('Không thể tải cấu hình từ máy chủ!', 'error');
        }
    }

    function populateSettingsUI() {
        if (!appConfig) return;

        // Active Profile
        activeProfileId = appConfig.active_profile || 'default';
        currentPipeline = appConfig.pipeline || 'ocr_trans';
        currentOcrEngine = appConfig.ocr_engine || 'manga_ocr';
        currentProvider = appConfig.provider || 'google';
        autoDetectLang = (appConfig.auto_detect_lang !== false);

        // Populate Profile dropdown
        profileSelect.innerHTML = '';
        const profiles = appConfig.profiles || {};
        for (const [pid, prof] of Object.entries(profiles)) {
            const opt = document.createElement('option');
            opt.value = pid;
            opt.textContent = `${prof.name || pid} (${prof.model || 'Google'})`;
            profileSelect.appendChild(opt);
        }
        if (!profiles[activeProfileId]) {
            const defOpt = document.createElement('option');
            defOpt.value = activeProfileId;
            defOpt.textContent = activeProfileId;
            profileSelect.appendChild(defOpt);
        }
        profileSelect.value = activeProfileId;

        // Current credentials
        inputApiKey.value = appConfig.api_key || '';
        inputBaseUrl.value = appConfig.base_url || 'https://api.xkiro.com/v1';
        inputModel.value = appConfig.model || 'qwen/qwen3.5-flash:free';
        inputWorkers.value = appConfig.max_workers || 10;
        switchAutoDetect.checked = autoDetectLang;

        updateSelectionCardsUI();
    }

    function updateSelectionCardsUI() {
        // Pipeline
        cardPipelineOcr.classList.toggle('active', currentPipeline === 'ocr_trans');
        cardPipelineVision.classList.toggle('active', currentPipeline === 'vision_llm');

        if (currentPipeline === 'vision_llm') {
            sectionOcrEngine.style.display = 'none';
            sectionTranslationProvider.style.display = 'none';
        } else {
            sectionOcrEngine.style.display = 'block';
            sectionTranslationProvider.style.display = 'block';

            // OCR Engine cards
            cardOcrManga.classList.toggle('active', currentOcrEngine === 'manga_ocr');
            cardOcrRapidEn.classList.toggle('active', currentOcrEngine === 'rapid_ocr_en');
            cardOcrRapidCh.classList.toggle('active', currentOcrEngine === 'rapid_ocr_ch');

            // Translation Provider cards
            cardProviderGoogle.classList.toggle('active', currentProvider === 'google');
            cardProviderLlm.classList.toggle('active', currentProvider === 'llm');
            cardProviderRaw.classList.toggle('active', currentProvider === 'raw');
        }
    }

    async function saveSettingsConfig() {
        const payload = {
            active_profile: activeProfileId,
            pipeline: currentPipeline,
            ocr_engine: currentOcrEngine,
            auto_detect_lang: switchAutoDetect.checked,
            provider: currentProvider,
            base_url: inputBaseUrl.value.trim(),
            api_key: inputApiKey.value.trim(),
            model: inputModel.value.trim(),
            max_workers: parseInt(inputWorkers.value, 10) || 10
        };

        btnSaveSettings.disabled = true;
        btnSaveSettings.textContent = 'Đang lưu...';

        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (data.ok) {
                showToast('Đã lưu cấu hình thành công!', 'success');
                loadSettingsConfig();
            } else {
                throw new Error(data.message || 'Lỗi lưu cấu hình');
            }
        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            btnSaveSettings.disabled = false;
            btnSaveSettings.innerHTML = `
                <svg class="sketch-icon sm" viewBox="0 0 24 24">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                    <polyline points="17 21 17 13 7 13 7 21"></polyline>
                    <polyline points="7 3 7 8 15 8"></polyline>
                </svg>
                <span>Lưu Cấu Hình Ngay</span>
            `;
        }
    }

    async function testApiConnection() {
        btnTestApi.disabled = true;
        btnTestApi.textContent = 'Đang kiểm tra...';

        try {
            const res = await fetch('/api/test-llm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    base_url: inputBaseUrl.value.trim(),
                    api_key: inputApiKey.value.trim(),
                    model: inputModel.value.trim()
                })
            });
            const data = await res.json();
            if (data.ok) {
                showToast(`Kết nối thành công! Độ trễ: ${data.latency_ms || 350}ms (${inputModel.value})`, 'success');
            } else {
                showToast(`Thử nghiệm thất bại: ${data.message || 'Lỗi xác thực'}`, 'error');
            }
        } catch (err) {
            showToast(`Lỗi kết nối: ${err.message}`, 'error');
        } finally {
            btnTestApi.disabled = false;
            btnTestApi.innerHTML = `
                <svg class="sketch-icon sm" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="16" x2="12" y2="12"></line>
                    <line x1="12" y1="8" x2="12.01" y2="8"></line>
                </svg>
                <span>Kiểm Tra Kết Nối</span>
            `;
        }
    }

    // =========================================================================
    // 6. UPLOAD CONTROLLER (DRAG & DROP LOCAL MANGA)
    // =========================================================================
    function setupUploadEvents() {
        btnOpenUpload.addEventListener('click', () => {
            uploadModal.classList.remove('hidden');
        });

        btnCloseUpload.addEventListener('click', () => {
            uploadModal.classList.add('hidden');
        });

        btnCancelUpload.addEventListener('click', () => {
            uploadModal.classList.add('hidden');
        });

        // Fullscreen drag & drop
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

        window.addEventListener('dragover', (e) => e.preventDefault());

        window.addEventListener('drop', async (e) => {
            e.preventDefault();
            dragCounter = 0;
            dragDropOverlay.classList.add('hidden');

            const items = e.dataTransfer.items;
            const files = e.dataTransfer.files;

            if (items && items.length > 0) {
                uploadModal.classList.remove('hidden');
                await handleDroppedItems(items);
            } else if (files && files.length > 0) {
                uploadModal.classList.remove('hidden');
                addFilesToSelection(Array.from(files));
            }
        });

        modalDropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            modalDropzone.classList.add('drag-over');
        });

        modalDropzone.addEventListener('dragleave', () => {
            modalDropzone.classList.remove('drag-over');
        });

        modalDropzone.addEventListener('drop', async (e) => {
            e.preventDefault();
            modalDropzone.classList.remove('drag-over');
            const items = e.dataTransfer.items;
            if (items && items.length > 0) {
                await handleDroppedItems(items);
            }
        });

        inputFiles.addEventListener('change', () => {
            if (inputFiles.files.length > 0) {
                addFilesToSelection(Array.from(inputFiles.files));
            }
        });

        inputFolder.addEventListener('change', () => {
            if (inputFolder.files.length > 0) {
                const flist = Array.from(inputFolder.files);
                addFilesToSelection(flist);
                if (flist[0] && flist[0].webkitRelativePath) {
                    const folderName = flist[0].webkitRelativePath.split('/')[0];
                    if (folderName && !inputChapterTitle.value) {
                        inputChapterTitle.value = folderName;
                    }
                }
            }
        });

        btnClearFiles.addEventListener('click', () => {
            selectedFiles = [];
            renderSelectedFilesList();
        });

        btnStartUpload.addEventListener('click', startUploadProcess);
    }

    async function handleDroppedItems(items) {
        const fileList = [];
        let autoTitle = '';

        for (let i = 0; i < items.length; i++) {
            const entry = items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
            if (entry) {
                if (entry.isDirectory && !autoTitle) autoTitle = entry.name;
                await scanFilesFromEntry(entry, fileList);
            } else {
                const f = items[i].getAsFile();
                if (f && isImageFile(f.name)) fileList.push(f);
            }
        }

        if (autoTitle && !inputChapterTitle.value) {
            inputChapterTitle.value = autoTitle;
        }

        addFilesToSelection(fileList);
    }

    async function scanFilesFromEntry(entry, fileList) {
        if (entry.isFile) {
            const file = await new Promise((resolve) => entry.file(resolve));
            if (isImageFile(file.name)) fileList.push(file);
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            const entries = await new Promise((resolve) => reader.readEntries(resolve));
            for (const child of entries) {
                await scanFilesFromEntry(child, fileList);
            }
        }
    }

    function isImageFile(name) {
        return /\.(jpg|jpeg|png|webp)$/i.test(name);
    }

    function addFilesToSelection(newFiles) {
        const valid = newFiles.filter((f) => isImageFile(f.name));
        selectedFiles = selectedFiles.concat(valid);
        selectedFiles.sort((a, b) => collator.compare(a.name, b.name));
        renderSelectedFilesList();
    }

    function renderSelectedFilesList() {
        if (selectedFiles.length === 0) {
            uploadPreviewContainer.classList.add('hidden');
            btnStartUpload.disabled = true;
            return;
        }

        uploadPreviewContainer.classList.remove('hidden');
        btnStartUpload.disabled = false;
        previewCount.textContent = `${selectedFiles.length} ảnh đã chọn`;
        previewList.innerHTML = '';

        selectedFiles.slice(0, 50).forEach((f, idx) => {
            const item = document.createElement('div');
            item.className = 'preview-item';
            item.innerHTML = `
                <span>${idx + 1}. ${f.name}</span>
                <span style="color: #666;">${(f.size / 1024).toFixed(0)} KB</span>
            `;
            previewList.appendChild(item);
        });

        if (selectedFiles.length > 50) {
            const more = document.createElement('div');
            more.style.padding = '4px 8px';
            more.style.color = '#666';
            more.textContent = `... và ${selectedFiles.length - 50} ảnh khác`;
            previewList.appendChild(more);
        }
    }

    async function startUploadProcess() {
        if (selectedFiles.length === 0) return;

        const title = inputChapterTitle.value.trim() || `Tập truyện ${new Date().toLocaleDateString('vi-VN')}`;
        const formData = new FormData();
        formData.append('title', title);
        formData.append('ocr_engine', currentOcrEngine);

        selectedFiles.forEach((f) => {
            formData.append('files', f);
        });

        uploadProgressContainer.classList.remove('hidden');
        uploadProgressBar.style.width = '0%';
        uploadPercentage.textContent = '0%';
        uploadStatusText.textContent = 'Đang tải ảnh lên server...';

        btnStartUpload.disabled = true;
        uploadSpinner.classList.remove('hidden');
        btnStartUploadText.textContent = 'Đang tải lên...';

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload-local', true);

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                const pct = Math.round((e.loaded / e.total) * 100);
                uploadProgressBar.style.width = `${pct}%`;
                uploadPercentage.textContent = `${pct}%`;
            }
        };

        xhr.onload = async () => {
            uploadSpinner.classList.add('hidden');
            btnStartUpload.disabled = false;
            btnStartUploadText.textContent = 'Bắt Đầu Dịch';

            if (xhr.status === 200) {
                const res = JSON.parse(xhr.responseText);
                uploadStatusText.textContent = 'Tải lên hoàn tất! Bắt đầu dịch...';
                showToast('Tải lên thành công! Đang tiến hành bóc chữ và dịch...', 'success');

                setTimeout(() => {
                    uploadModal.classList.add('hidden');
                    selectedFiles = [];
                    renderSelectedFilesList();
                    uploadProgressContainer.classList.add('hidden');
                    switchView('reader');
                    loadChaptersList(res.chapter_id);
                }, 800);
            } else {
                uploadStatusText.textContent = 'Lỗi tải lên!';
                showToast(`Tải lên thất bại: ${xhr.responseText}`, 'error');
            }
        };

        xhr.onerror = () => {
            uploadSpinner.classList.add('hidden');
            btnStartUpload.disabled = false;
            btnStartUploadText.textContent = 'Bắt Đầu Dịch';
            uploadStatusText.textContent = 'Lỗi mạng khi tải lên!';
            showToast('Lỗi kết nối khi tải lên!', 'error');
        };

        xhr.send(formData);
    }

    // =========================================================================
    // 7. EVENT LISTENERS
    // =========================================================================
    function setupEventListeners() {
        // Navigation Tabs
        tabBtnReader.addEventListener('click', () => switchView('reader'));
        tabBtnSettings.addEventListener('click', () => switchView('settings'));
        brandLink.addEventListener('click', (e) => {
            e.preventDefault();
            switchView('reader');
        });

        window.addEventListener('hashchange', handleRoute);

        // Reader Chapter Select
        chapterSelect.addEventListener('change', () => {
            if (chapterSelect.value) {
                loadChapter(chapterSelect.value);
            }
        });

        // Reader Mode Switch
        modeStripBtn.addEventListener('click', () => {
            readerMode = 'strip';
            modeStripBtn.classList.add('active');
            modeSingleBtn.classList.remove('active');
            renderChapter();
        });

        modeSingleBtn.addEventListener('click', () => {
            readerMode = 'single';
            modeSingleBtn.classList.add('active');
            modeStripBtn.classList.remove('active');
            renderChapter();
        });

        // Page Navigation
        btnPrev.addEventListener('click', () => goToPage(currentPageIndex - 1));
        btnNext.addEventListener('click', () => goToPage(currentPageIndex + 1));

        // Translation Toggle
        btnToggleTrans.addEventListener('click', () => {
            isTranslationVisible = !isTranslationVisible;
            applyBubbleVisibility();
        });

        // Quick Settings Popover
        btnQuickSettings.addEventListener('click', (e) => {
            e.stopPropagation();
            quickSettingsPanel.classList.toggle('hidden');
        });

        btnCloseQuickSettings.addEventListener('click', () => {
            quickSettingsPanel.classList.add('hidden');
        });

        document.addEventListener('click', (e) => {
            if (quickSettingsPanel && !quickSettingsPanel.contains(e.target) && e.target !== btnQuickSettings) {
                quickSettingsPanel.classList.add('hidden');
            }
        });

        // Sliders
        sliderOpacity.addEventListener('input', () => {
            bubbleOpacity = parseInt(sliderOpacity.value, 10) / 100;
            valOpacity.textContent = `${sliderOpacity.value}%`;
            applyBubbleVisibility();
        });

        sliderScale.addEventListener('input', () => {
            fontScaleFactor = parseInt(sliderScale.value, 10) / 100;
            valScale.textContent = `${sliderScale.value}%`;
            applyBubbleVisibility();
        });

        // Fullscreen
        btnFullscreen.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(() => {});
            } else {
                document.exitFullscreen().catch(() => {});
            }
        });

        // Userscript Modal
        btnOpenUserscript.addEventListener('click', () => {
            userscriptModal.classList.remove('hidden');
        });

        btnCloseUserscript.addEventListener('click', () => {
            userscriptModal.classList.add('hidden');
        });

        btnDoneUserscript.addEventListener('click', () => {
            userscriptModal.classList.add('hidden');
        });

        // Settings Selectable Cards
        cardPipelineOcr.addEventListener('click', () => {
            currentPipeline = 'ocr_trans';
            updateSelectionCardsUI();
        });

        cardPipelineVision.addEventListener('click', () => {
            currentPipeline = 'vision_llm';
            updateSelectionCardsUI();
        });

        cardOcrManga.addEventListener('click', () => {
            currentOcrEngine = 'manga_ocr';
            updateSelectionCardsUI();
        });

        cardOcrRapidEn.addEventListener('click', () => {
            currentOcrEngine = 'rapid_ocr_en';
            updateSelectionCardsUI();
        });

        cardOcrRapidCh.addEventListener('click', () => {
            currentOcrEngine = 'rapid_ocr_ch';
            updateSelectionCardsUI();
        });

        cardProviderGoogle.addEventListener('click', () => {
            currentProvider = 'google';
            updateSelectionCardsUI();
        });

        cardProviderLlm.addEventListener('click', () => {
            currentProvider = 'llm';
            updateSelectionCardsUI();
        });

        cardProviderRaw.addEventListener('click', () => {
            currentProvider = 'raw';
            updateSelectionCardsUI();
        });

        // Presets Dropdown
        selectProviderPreset.addEventListener('change', () => {
            const key = selectProviderPreset.value;
            if (PRESETS[key]) {
                inputBaseUrl.value = PRESETS[key].baseUrl;
                inputModel.value = PRESETS[key].model;
                showToast(`Đã áp dụng mẫu: ${PRESETS[key].name}`, 'success');
            }
        });

        // API Key Reveal
        btnToggleKey.addEventListener('click', () => {
            inputApiKey.type = inputApiKey.type === 'password' ? 'text' : 'password';
            btnToggleKey.textContent = inputApiKey.type === 'password' ? '👁️' : '🔒';
        });

        // Profile Selection
        profileSelect.addEventListener('change', async () => {
            const pid = profileSelect.value;
            try {
                const res = await fetch('/api/profile/switch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ profile_id: pid })
                });
                const data = await res.json();
                if (data.ok) {
                    showToast(`Đã chuyển sang hồ sơ: ${pid}`, 'success');
                    loadSettingsConfig();
                }
            } catch (err) {
                showToast('Lỗi khi đổi profile', 'error');
            }
        });

        btnNewProfile.addEventListener('click', async () => {
            const name = prompt('Nhập tên hồ sơ mới (vd: Gemini 2.0 Flash, DeepSeek):');
            if (!name || !name.trim()) return;
            const pid = name.trim().toLowerCase().replace(/[^a-z0-9]/g, '_');

            try {
                const res = await fetch('/api/profile/add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        profile_id: pid,
                        name: name.trim(),
                        base_url: inputBaseUrl.value,
                        model: inputModel.value,
                        api_key: inputApiKey.value
                    })
                });
                const data = await res.json();
                if (data.ok) {
                    showToast(`Đã tạo hồ sơ "${name}"!`, 'success');
                    loadSettingsConfig();
                }
            } catch (e) {
                showToast('Không thể tạo hồ sơ mới', 'error');
            }
        });

        btnDeleteProfile.addEventListener('click', async () => {
            const pid = profileSelect.value;
            if (pid === 'default') {
                showToast('Không thể xóa hồ sơ mặc định!', 'error');
                return;
            }
            if (!confirm(`Bạn có chắc chắn muốn xóa hồ sơ "${pid}"?`)) return;

            try {
                const res = await fetch('/api/profile/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ profile_id: pid })
                });
                const data = await res.json();
                if (data.ok) {
                    showToast('Đã xóa hồ sơ thành công!', 'success');
                    loadSettingsConfig();
                }
            } catch (e) {
                showToast('Lỗi khi xóa hồ sơ', 'error');
            }
        });

        btnTestApi.addEventListener('click', testApiConnection);
        btnSaveSettings.addEventListener('click', saveSettingsConfig);

        // Keyboard Shortcuts
        window.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

            if (e.key === 't' || e.key === 'T') {
                isTranslationVisible = !isTranslationVisible;
                applyBubbleVisibility();
            } else if (readerMode === 'single') {
                if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
                    goToPage(currentPageIndex - 1);
                } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
                    goToPage(currentPageIndex + 1);
                }
            }
            if (e.key === 'f' || e.key === 'F') {
                if (!document.fullscreenElement) {
                    document.documentElement.requestFullscreen().catch(() => {});
                } else {
                    document.exitFullscreen().catch(() => {});
                }
            }
        });
    }

    // =========================================================================
    // 8. INITIALIZATION
    // =========================================================================
    async function init() {
        setupEventListeners();
        setupUploadEvents();
        handleRoute();
        await loadChaptersList();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
