// ==UserScript==
// @name         MangaDex AI Translator Overlay (Tiếng Việt)
// @namespace    https://github.com/vide-coding/mangadex-translator
// @version      2.4.1
// @description  Hiển thị bản dịch tiếng Việt đè lên bong bóng thoại MangaDex. Hỗ trợ 2 Pipeline linh hoạt (Manga-OCR Text và Multimodal Vision AI), dịch qua Google Translate hoặc LLM, chống nghẽn đơ tab 100%, tự co giãn theo tranh vẽ.
// @author       Antigravity & User
// @match        https://mangadex.org/*
// @icon         https://mangadex.org/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // =========================================================================
    // CẤU HÌNH & TRẠNG THÁI TOÀN CỤC
    // =========================================================================
    const CONFIG = {
        SERVER_URL: localStorage.getItem('md_overlay_server_url') || 'http://127.0.0.1:8765',
        POLL_INTERVAL_MS: 1500,
        DEFAULT_OPACITY: 0.88,
        DEFAULT_FONT_SCALE: 1.0,
    };

    const State = {
        currentChapterId: null,
        chapterData: null,
        isTranslating: false,
        isOverlayVisible: true,
        isPanelOpen: false,
        isSettingsView: false,
        selectedPipeline: localStorage.getItem('md_selected_pipeline') || 'ocr_trans',
        selectedProvider: localStorage.getItem('md_selected_provider') || 'google',
        serverStatus: 'disconnected', // 'connected' | 'translating' | 'ready' | 'disconnected'
        bubbleOpacity: parseFloat(localStorage.getItem('md_overlay_opacity') || CONFIG.DEFAULT_OPACITY),
        fontScale: parseFloat(localStorage.getItem('md_overlay_font_scale') || CONFIG.DEFAULT_FONT_SCALE),
        pollTimer: null,
        isUpdatingDOM: false, // CỜ CHỐNG ĐỆ QUY MUTATIONOBSERVER
    };

    // =========================================================================
    // TIỆN ÍCH HỖ TRỢ (UTILITIES)
    // =========================================================================
    function extractChapterId(url = window.location.href) {
        const match = url.match(/\/chapter\/([a-f0-9\-]{36})/i);
        return match ? match[1] : null;
    }

    function extractCurrentPageNumber(url = window.location.href) {
        const match = url.match(/\/chapter\/[a-f0-9\-]{36}\/(\d+)/i);
        return match ? parseInt(match[1], 10) : null;
    }

    async function apiRequest(endpoint, method = 'GET', body = null) {
        const url = `${CONFIG.SERVER_URL}${endpoint}`;
        try {
            const options = {
                method,
                headers: { 'Content-Type': 'application/json' },
            };
            if (body) {
                options.body = JSON.stringify(body);
            }
            const res = await fetch(url, options);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            // Fallback GM_xmlhttpRequest nếu fetch bị chặn bởi CORS/Mixed Content
            return new Promise((resolve, reject) => {
                if (typeof GM_xmlhttpRequest === 'undefined') {
                    reject(err);
                    return;
                }
                GM_xmlhttpRequest({
                    method,
                    url,
                    headers: { 'Content-Type': 'application/json' },
                    data: body ? JSON.stringify(body) : null,
                    onload: (r) => {
                        if (r.status >= 200 && r.status < 300) {
                            try {
                                resolve(JSON.parse(r.responseText));
                            } catch (e) {
                                resolve(r.responseText);
                            }
                        } else {
                            reject(new Error(`GM_xmlhttpRequest status ${r.status}`));
                        }
                    },
                    onerror: (e) => reject(e),
                });
            });
        }
    }

    // =========================================================================
    // TRUSTED TYPES CSP COMPATIBILITY
    // =========================================================================
    let ttPolicy = null;
    try {
        if (typeof window.trustedTypes !== 'undefined' && window.trustedTypes.createPolicy) {
            try {
                window.trustedTypes.createPolicy('default', { createHTML: (s) => s });
            } catch (e) {}

            try {
                ttPolicy = window.trustedTypes.createPolicy('manga-overlay', { createHTML: (s) => s });
            } catch (e) {
                try {
                    ttPolicy = window.trustedTypes.createPolicy('manga-overlay-' + Date.now(), { createHTML: (s) => s });
                } catch (e2) {
                    if (window.trustedTypes.defaultPolicy) {
                        ttPolicy = window.trustedTypes.defaultPolicy;
                    }
                }
            }
        }
    } catch (err) {
        console.warn('[MangaOverlay] TrustedTypes note:', err);
    }

    function setSafeHTML(element, htmlContent) {
        if (!element) return;
        if (ttPolicy) {
            try {
                element.innerHTML = ttPolicy.createHTML(htmlContent);
                return;
            } catch (e) {}
        }
        if (typeof window.trustedTypes !== 'undefined' && window.trustedTypes.defaultPolicy) {
            try {
                element.innerHTML = window.trustedTypes.defaultPolicy.createHTML(htmlContent);
                return;
            } catch (e) {}
        }
        try {
            element.innerHTML = htmlContent;
        } catch (e) {
            console.error('[MangaOverlay] Error setting HTML content:', e);
        }
    }

    // =========================================================================
    // SHADOW DOM UI WIDGET (FLOATING ACTION BUTTON & POPOVER PANEL)
    // =========================================================================
    class MangaOverlayUI {
        constructor() {
            this.hostEl = null;
            this.shadowRoot = null;
            this.init();
        }

        init() {
            if (document.getElementById('manga-overlay-extension-root')) return;
            if (!document.body) {
                window.addEventListener('DOMContentLoaded', () => this.init(), { once: true });
                return;
            }

            this.hostEl = document.createElement('div');
            this.hostEl.id = 'manga-overlay-extension-root';
            document.body.appendChild(this.hostEl);

            this.shadowRoot = this.hostEl.attachShadow({ mode: 'open' });
            this.render();
            this.bindEvents();
        }

        render() {
            setSafeHTML(this.shadowRoot, `
                <style>
                    :host {
                        all: initial;
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                        z-index: 999999;
                        position: fixed;
                        bottom: 24px;
                        right: 24px;
                        pointer-events: none;
                        user-select: none;
                    }

                    * {
                        box-sizing: border-box;
                    }

                    .widget-container {
                        position: relative;
                        display: flex;
                        flex-direction: column;
                        align-items: flex-end;
                        pointer-events: auto;
                    }

                    /* 1. NÚT NỔI THU NHỎ (FLOATING ACTION BUTTON) */
                    .fab-button {
                        width: 50px;
                        height: 50px;
                        border-radius: 50%;
                        background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%);
                        box-shadow: 0 4px 20px rgba(99, 102, 241, 0.45), 0 2px 8px rgba(0, 0, 0, 0.2);
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        cursor: pointer;
                        border: 2px solid rgba(255, 255, 255, 0.2);
                        transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
                        position: relative;
                    }

                    .fab-button:hover {
                        transform: scale(1.08) translateY(-2px);
                        box-shadow: 0 8px 28px rgba(99, 102, 241, 0.6), 0 4px 12px rgba(0, 0, 0, 0.25);
                    }

                    .fab-button:active {
                        transform: scale(0.95);
                    }

                    .fab-icon {
                        width: 26px;
                        height: 26px;
                        fill: white;
                        transition: transform 0.3s ease;
                    }

                    .fab-button.open .fab-icon {
                        transform: rotate(90deg);
                    }

                    /* Đèn trạng thái server */
                    .status-dot {
                        position: absolute;
                        top: 2px;
                        right: 2px;
                        width: 12px;
                        height: 12px;
                        border-radius: 50%;
                        border: 2px solid #0f172a;
                        background: #94a3b8;
                        transition: background 0.3s ease;
                    }

                    .status-dot.connected { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
                    .status-dot.translating {
                        background: #f59e0b;
                        box-shadow: 0 0 10px #f59e0b;
                        animation: pulse-ring 1.2s infinite;
                    }
                    .status-dot.ready { background: #38bdf8; box-shadow: 0 0 8px #38bdf8; }
                    .status-dot.disconnected { background: #ef4444; }

                    @keyframes pulse-ring {
                        0% { transform: scale(0.9); opacity: 1; }
                        50% { transform: scale(1.3); opacity: 0.6; }
                        100% { transform: scale(0.9); opacity: 1; }
                    }

                    /* 2. BẢNG ĐIỀU KHIỂN POPOVER */
                    .popover-panel {
                        position: absolute;
                        bottom: 64px;
                        right: 0;
                        width: 310px;
                        background: rgba(15, 23, 42, 0.94);
                        backdrop-filter: blur(16px);
                        -webkit-backdrop-filter: blur(16px);
                        border: 1px solid rgba(255, 255, 255, 0.12);
                        border-radius: 16px;
                        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.05);
                        color: #f8fafc;
                        overflow: hidden;
                        opacity: 0;
                        transform: translateY(12px) scale(0.95);
                        transform-origin: bottom right;
                        pointer-events: none;
                        transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
                    }

                    .popover-panel.open {
                        opacity: 1;
                        transform: translateY(0) scale(1);
                        pointer-events: auto;
                    }

                    .panel-header {
                        padding: 14px 16px;
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                        background: rgba(255, 255, 255, 0.02);
                    }

                    .panel-title {
                        font-size: 14px;
                        font-weight: 700;
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        background: linear-gradient(135deg, #a5b4fc, #c084fc);
                        -webkit-background-clip: text;
                        -webkit-text-fill-color: transparent;
                    }

                    .header-actions {
                        display: flex;
                        align-items: center;
                        gap: 4px;
                    }

                    .gear-btn {
                        background: none;
                        border: none;
                        color: #94a3b8;
                        cursor: pointer;
                        font-size: 15px;
                        line-height: 1;
                        padding: 4px;
                        border-radius: 6px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        transition: all 0.2s ease;
                    }

                    .gear-btn:hover {
                        color: #818cf8;
                        background: rgba(99, 102, 241, 0.15);
                        transform: rotate(30deg);
                    }

                    .gear-btn.active {
                        color: #a5b4fc;
                        background: rgba(99, 102, 241, 0.25);
                    }

                    .close-btn {
                        background: none;
                        border: none;
                        color: #94a3b8;
                        cursor: pointer;
                        font-size: 18px;
                        line-height: 1;
                        padding: 4px;
                        border-radius: 6px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        transition: color 0.2s, background 0.2s;
                    }

                    .close-btn:hover {
                        color: #fff;
                        background: rgba(255, 255, 255, 0.1);
                    }

                    .panel-body {
                        padding: 14px 16px;
                        display: flex;
                        flex-direction: column;
                        gap: 12px;
                        max-height: 480px;
                        overflow-y: auto;
                    }

                    .view-container {
                        display: flex;
                        flex-direction: column;
                        gap: 12px;
                        width: 100%;
                    }

                    .view-container.hidden {
                        display: none;
                    }

                    /* Presets Pills */
                    .presets-pills {
                        display: flex;
                        gap: 6px;
                        overflow-x: auto;
                        padding-bottom: 2px;
                    }

                    .preset-pill {
                        background: rgba(255, 255, 255, 0.06);
                        border: 1px solid rgba(255, 255, 255, 0.1);
                        color: #cbd5e1;
                        font-size: 11px;
                        font-weight: 600;
                        padding: 4px 8px;
                        border-radius: 6px;
                        cursor: pointer;
                        white-space: nowrap;
                        transition: all 0.15s ease;
                    }

                    .preset-pill:hover {
                        background: rgba(99, 102, 241, 0.2);
                        border-color: #6366f1;
                        color: white;
                    }

                    .preset-pill.active {
                        background: #4f46e5;
                        border-color: #818cf8;
                        color: white;
                    }

                    /* Form Inputs */
                    .form-input-group {
                        display: flex;
                        flex-direction: column;
                        gap: 4px;
                    }

                    .form-input-label {
                        font-size: 11px;
                        color: #94a3b8;
                        font-weight: 600;
                        display: flex;
                        justify-content: space-between;
                    }

                    .form-input-field {
                        width: 100%;
                        background: rgba(0, 0, 0, 0.35);
                        border: 1px solid rgba(255, 255, 255, 0.12);
                        border-radius: 8px;
                        padding: 7px 10px;
                        color: #f8fafc;
                        font-size: 12px;
                        outline: none;
                        box-sizing: border-box;
                    }

                    .form-input-field:focus {
                        border-color: #6366f1;
                        background: rgba(0, 0, 0, 0.55);
                    }

                    .input-password-row {
                        position: relative;
                        display: flex;
                        align-items: center;
                    }

                    .btn-eye {
                        position: absolute;
                        right: 8px;
                        background: none;
                        border: none;
                        color: #94a3b8;
                        cursor: pointer;
                        font-size: 13px;
                        padding: 2px;
                    }

                    .btn-eye:hover {
                        color: #fff;
                    }

                    .btn-save-cfg {
                        background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                        color: white;
                        box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
                    }

                    .btn-save-cfg:hover:not(:disabled) {
                        filter: brightness(1.1);
                        transform: translateY(-1px);
                    }

                    .btn-test-cfg {
                        background: rgba(99, 102, 241, 0.2);
                        border: 1px solid rgba(99, 102, 241, 0.4);
                        color: #c7d2fe;
                    }

                    .btn-test-cfg:hover:not(:disabled) {
                        background: rgba(99, 102, 241, 0.35);
                    }

                    .status-msg-badge {
                        font-size: 11px;
                        padding: 6px 10px;
                        border-radius: 6px;
                        display: none;
                        line-height: 1.3;
                    }

                    .status-msg-badge.success {
                        display: block;
                        background: rgba(16, 185, 129, 0.2);
                        border: 1px solid rgba(16, 185, 129, 0.4);
                        color: #6ee7b7;
                    }

                    .status-msg-badge.error {
                        display: block;
                        background: rgba(239, 68, 68, 0.2);
                        border: 1px solid rgba(239, 68, 68, 0.4);
                        color: #fca5a5;
                    }

                    .status-msg-badge.info {
                        display: block;
                        background: rgba(99, 102, 241, 0.2);
                        border: 1px solid rgba(99, 102, 241, 0.4);
                        color: #c7d2fe;
                    }

                    .status-card {
                        background: rgba(255, 255, 255, 0.04);
                        border-radius: 10px;
                        padding: 10px 12px;
                        font-size: 12px;
                        display: flex;
                        flex-direction: column;
                        gap: 4px;
                        border: 1px solid rgba(255, 255, 255, 0.05);
                    }

                    .status-line {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                    }

                    .status-label {
                        color: #94a3b8;
                    }

                    .status-value {
                        font-weight: 600;
                        color: #e2e8f0;
                    }

                    /* Nút dịch chính */
                    .btn-action {
                        width: 100%;
                        padding: 10px 14px;
                        border-radius: 10px;
                        border: none;
                        font-size: 13px;
                        font-weight: 600;
                        cursor: pointer;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        gap: 8px;
                        transition: all 0.2s ease;
                    }

                    .btn-translate {
                        background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
                        color: white;
                        box-shadow: 0 4px 14px rgba(79, 70, 229, 0.35);
                    }

                    .btn-translate:hover:not(:disabled) {
                        filter: brightness(1.1);
                        transform: translateY(-1px);
                        box-shadow: 0 6px 18px rgba(79, 70, 229, 0.5);
                    }

                    .btn-translate:disabled {
                        opacity: 0.6;
                        cursor: not-allowed;
                    }

                    .btn-toggle {
                        background: rgba(255, 255, 255, 0.08);
                        color: #f1f5f9;
                        border: 1px solid rgba(255, 255, 255, 0.1);
                    }

                    .btn-toggle:hover {
                        background: rgba(255, 255, 255, 0.14);
                    }

                    .btn-toggle.active {
                        border-color: #6366f1;
                        background: rgba(99, 102, 241, 0.2);
                        color: #a5b4fc;
                    }

                    /* Thanh trượt tùy chỉnh */
                    .control-group {
                        display: flex;
                        flex-direction: column;
                        gap: 6px;
                    }

                    .control-header {
                        display: flex;
                        justify-content: space-between;
                        font-size: 11px;
                        color: #94a3b8;
                    }

                    .range-slider {
                        width: 100%;
                        height: 5px;
                        border-radius: 3px;
                        background: rgba(255, 255, 255, 0.15);
                        outline: none;
                        -webkit-appearance: none;
                        cursor: pointer;
                    }

                    .range-slider::-webkit-slider-thumb {
                        -webkit-appearance: none;
                        width: 14px;
                        height: 14px;
                        border-radius: 50%;
                        background: #818cf8;
                        cursor: pointer;
                        box-shadow: 0 0 6px rgba(129, 140, 248, 0.8);
                    }

                    .progress-bar-container {
                        width: 100%;
                        height: 6px;
                        background: rgba(255, 255, 255, 0.1);
                        border-radius: 3px;
                        overflow: hidden;
                        margin-top: 4px;
                        display: none;
                    }

                    .progress-bar-fill {
                        height: 100%;
                        background: linear-gradient(90deg, #6366f1, #38bdf8);
                        width: 0%;
                        transition: width 0.3s ease;
                    }

                    /* Mode Switcher Toolbar */
                    .mode-switcher-container {
                        display: flex;
                        flex-direction: column;
                        gap: 6px;
                        background: rgba(0, 0, 0, 0.28);
                        border: 1px solid rgba(255, 255, 255, 0.08);
                        border-radius: 10px;
                        padding: 6px;
                    }

                    .mode-tabs {
                        display: flex;
                        gap: 4px;
                        background: rgba(255, 255, 255, 0.04);
                        border-radius: 7px;
                        padding: 2px;
                    }

                    .mode-tab {
                        flex: 1;
                        padding: 5px 8px;
                        font-size: 11px;
                        font-weight: 700;
                        border-radius: 6px;
                        border: none;
                        background: transparent;
                        color: #94a3b8;
                        cursor: pointer;
                        transition: all 0.2s ease;
                        text-align: center;
                    }

                    .mode-tab:hover {
                        color: #e2e8f0;
                    }

                    .mode-tab.active {
                        background: #6366f1;
                        color: #ffffff;
                        box-shadow: 0 2px 8px rgba(99, 102, 241, 0.4);
                    }

                    .sub-providers-row {
                        display: flex;
                        gap: 4px;
                        justify-content: space-between;
                    }

                    .sub-pill {
                        flex: 1;
                        font-size: 10px;
                        font-weight: 600;
                        padding: 4px 4px;
                        border-radius: 5px;
                        border: 1px solid rgba(255, 255, 255, 0.1);
                        background: rgba(255, 255, 255, 0.04);
                        color: #cbd5e1;
                        cursor: pointer;
                        text-align: center;
                        transition: all 0.15s ease;
                        white-space: nowrap;
                    }

                    .sub-pill:hover {
                        background: rgba(99, 102, 241, 0.18);
                        border-color: #6366f1;
                        color: #fff;
                    }

                    .sub-pill.active {
                        background: rgba(99, 102, 241, 0.28);
                        border-color: #818cf8;
                        color: #a5b4fc;
                    }

                    .panel-footer {
                        padding: 10px 16px;
                        border-top: 1px solid rgba(255, 255, 255, 0.06);
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        font-size: 11px;
                        color: #64748b;
                        background: rgba(0, 0, 0, 0.2);
                    }

                    .link-btn {
                        color: #818cf8;
                        text-decoration: none;
                        font-weight: 500;
                        transition: color 0.2s;
                    }

                    .link-btn:hover {
                        color: #a5b4fc;
                        text-decoration: underline;
                    }

                    /* Spinner animation */
                    .spinner {
                        width: 14px;
                        height: 14px;
                        border: 2px solid rgba(255, 255, 255, 0.3);
                        border-top-color: white;
                        border-radius: 50%;
                        animation: spin 0.8s linear infinite;
                    }

                    @keyframes spin {
                        to { transform: rotate(360deg); }
                    }
                </style>

                <div class="widget-container">
                    <!-- Popover Panel -->
                    <div class="popover-panel" id="panel">
                        <div class="panel-header">
                            <div class="panel-title">
                                <span id="panelTitleText">🌐 Manga AI Translator</span>
                            </div>
                            <div class="header-actions">
                                <button class="gear-btn" id="gearBtn" title="Cài đặt API">⚙️</button>
                                <button class="close-btn" id="closeBtn" title="Thu nhỏ">✕</button>
                            </div>
                        </div>

                        <div class="panel-body">
                            <!-- VIEW 1: BẢNG ĐIỀU KHIỂN DỊCH CHÍNH -->
                            <div class="view-container" id="mainView">
                                <div class="status-card">
                                    <div class="status-line">
                                        <span class="status-label">Chapter:</span>
                                        <span class="status-value" id="chapterStatus">Đang quét...</span>
                                    </div>
                                    <div class="status-line">
                                        <span class="status-label">Bản dịch:</span>
                                        <span class="status-value" id="translationProgress">Chưa nạp</span>
                                    </div>
                                    <div class="progress-bar-container" id="progressContainer">
                                        <div class="progress-bar-fill" id="progressBar"></div>
                                    </div>
                                </div>

                                <!-- MODE SWITCHER TOOLBAR -->
                                <div class="mode-switcher-container">
                                    <div class="mode-tabs">
                                        <button type="button" class="mode-tab active" id="tabOcrTrans" title="Bóc chữ bằng Manga-OCR trước rồi dịch">⚡ OCR + Dịch</button>
                                        <button type="button" class="mode-tab" id="tabImageTrans" title="Gửi toàn ảnh kèm đánh số Set-of-Mark">🖼️ Ảnh + Vision</button>
                                    </div>
                                    <div class="sub-providers-row" id="subProvidersRow">
                                        <button type="button" class="sub-pill active" data-prov="google" title="Google Translate (Miễn phí)">🌐 Google</button>
                                        <button type="button" class="sub-pill" data-prov="llm_text" title="Gửi text thuần lên LLM">🤖 LLM Text</button>
                                        <button type="button" class="sub-pill" data-prov="raw" title="Giữ nguyên chữ tiếng Nhật gốc">📝 Raw Gốc</button>
                                    </div>
                                </div>

                                <button class="btn-action btn-translate" id="btnTranslate">
                                    <span id="btnTranslateIcon">🚀</span>
                                    <span id="btnTranslateText">Dịch Chapter Này</span>
                                </button>

                                <button class="btn-action btn-toggle active" id="btnToggleOverlay">
                                    <span>👁️ Hiển thị bản dịch (Phím T)</span>
                                </button>

                                <div class="control-group">
                                    <div class="control-header">
                                        <span>Độ mờ nền bong bóng</span>
                                        <span id="opacityValue">88%</span>
                                    </div>
                                    <input type="range" class="range-slider" id="opacitySlider" min="0" max="100" value="88">
                                </div>

                                <div class="control-group">
                                    <div class="control-header">
                                        <span>Tỉ lệ cỡ chữ</span>
                                        <span id="fontScaleValue">100%</span>
                                    </div>
                                    <input type="range" class="range-slider" id="fontScaleSlider" min="70" max="150" value="100">
                                </div>
                            </div>

                            <!-- VIEW 2: CẤU HÌNH API & MÁY CHỦ -->
                            <div class="view-container hidden" id="settingsView">
                                <div class="form-input-group">
                                    <div class="form-input-label">
                                        <span>⚡ Presets nhanh:</span>
                                    </div>
                                    <div class="presets-pills" id="presetsPills">
                                        <button type="button" class="preset-pill active" data-preset="xkiro_qwen">xKiro Qwen</button>
                                        <button type="button" class="preset-pill" data-preset="google_aistudio">Google AI Studio</button>
                                        <button type="button" class="preset-pill" data-preset="xkiro_gemini">xKiro Gemini</button>
                                        <button type="button" class="preset-pill" data-preset="openrouter">OpenRouter</button>
                                        <button type="button" class="preset-pill" data-preset="custom">Tùy chỉnh</button>
                                    </div>
                                </div>

                                <div class="form-input-group">
                                    <div class="form-input-label">
                                        <span>Backend Server URL:</span>
                                    </div>
                                    <input type="text" class="form-input-field" id="cfgServerUrl" placeholder="http://127.0.0.1:8765">
                                </div>

                                <div class="form-input-group">
                                    <div class="form-input-label">
                                        <span>API Base URL:</span>
                                    </div>
                                    <input type="text" class="form-input-field" id="cfgBaseUrl" placeholder="https://api.xkiro.com/v1">
                                </div>

                                <div class="form-input-group">
                                    <div class="form-input-label">
                                        <span>Model Name:</span>
                                    </div>
                                    <input type="text" class="form-input-field" id="cfgModel" placeholder="qwen/qwen3.5-flash:free">
                                </div>

                                <div class="form-input-group">
                                    <div class="form-input-label">
                                        <span>API Key:</span>
                                    </div>
                                    <div class="input-password-row">
                                        <input type="password" class="form-input-field" id="cfgApiKey" placeholder="sk-...">
                                        <button type="button" class="btn-eye" id="btnEyeKey" title="Hiện/ẩn key">👁️</button>
                                    </div>
                                </div>

                                <div class="status-msg-badge" id="cfgBadge"></div>

                                <button class="btn-action btn-test-cfg" id="btnTestCfg">
                                    <span id="testCfgIcon">🧪</span>
                                    <span id="testCfgText">Kiểm Tra API</span>
                                </button>

                                <button class="btn-action btn-save-cfg" id="btnSaveCfg">
                                    <span id="saveCfgIcon">💾</span>
                                    <span id="saveCfgText">Lưu & Đồng Bộ</span>
                                </button>

                                <button class="btn-action btn-toggle" id="btnBackToMain">
                                    <span>← Quay Lại Bảng Điều Khiển</span>
                                </button>
                            </div>
                        </div>

                        <div class="panel-footer">
                            <a href="http://127.0.0.1:8765/" target="_blank" class="link-btn" id="linkWebReader">📖 Web Reader</a>
                            <a href="http://127.0.0.1:8765/settings" target="_blank" class="link-btn" id="linkWebSettings">⚙️ Server Web</a>
                        </div>
                    </div>

                    <!-- Floating Action Button -->
                    <div class="fab-button" id="fabButton" title="Manga AI Translation Menu">
                        <svg class="fab-icon" viewBox="0 0 24 24">
                            <path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>
                        </svg>
                        <div class="status-dot disconnected" id="statusDot"></div>
                    </div>
                </div>
            `);
        }

        bindEvents() {
            const root = this.shadowRoot;
            const fab = root.getElementById('fabButton');
            const panel = root.getElementById('panel');
            const closeBtn = root.getElementById('closeBtn');
            const btnTranslate = root.getElementById('btnTranslate');
            const btnToggleOverlay = root.getElementById('btnToggleOverlay');
            const opacitySlider = root.getElementById('opacitySlider');
            const opacityValue = root.getElementById('opacityValue');
            const fontScaleSlider = root.getElementById('fontScaleSlider');
            const fontScaleValue = root.getElementById('fontScaleValue');

            // 1. Toggle mở/đóng Popover bằng Floating Icon
            fab.addEventListener('click', (e) => {
                e.stopPropagation();
                this.togglePanel();
            });

            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.closePanel();
            });

            // Đóng khi click ngoài panel
            document.addEventListener('click', (e) => {
                if (!this.hostEl.contains(e.target) && State.isPanelOpen) {
                    this.closePanel();
                }
            });

            // 1.5. Chuyển đổi Pipeline và Provider Dịch Thuật
            const tabOcrTrans = root.getElementById('tabOcrTrans');
            const tabImageTrans = root.getElementById('tabImageTrans');
            const subProvidersRow = root.getElementById('subProvidersRow');
            const subPills = root.querySelectorAll('.sub-pill');

            const renderModeSwitcher = () => {
                const isOcr = State.selectedPipeline === 'ocr_trans';
                if (tabOcrTrans) tabOcrTrans.classList.toggle('active', isOcr);
                if (tabImageTrans) tabImageTrans.classList.toggle('active', !isOcr);
                if (subProvidersRow) subProvidersRow.style.display = isOcr ? 'flex' : 'none';
                subPills.forEach(p => {
                    p.classList.toggle('active', p.getAttribute('data-prov') === State.selectedProvider);
                });
            };

            if (tabOcrTrans) {
                tabOcrTrans.addEventListener('click', (e) => {
                    e.stopPropagation();
                    State.selectedPipeline = 'ocr_trans';
                    localStorage.setItem('md_selected_pipeline', 'ocr_trans');
                    renderModeSwitcher();
                });
            }

            if (tabImageTrans) {
                tabImageTrans.addEventListener('click', (e) => {
                    e.stopPropagation();
                    State.selectedPipeline = 'image_trans';
                    localStorage.setItem('md_selected_pipeline', 'image_trans');
                    renderModeSwitcher();
                });
            }

            subPills.forEach(p => {
                p.addEventListener('click', (e) => {
                    e.stopPropagation();
                    State.selectedProvider = p.getAttribute('data-prov');
                    localStorage.setItem('md_selected_provider', State.selectedProvider);
                    renderModeSwitcher();
                });
            });

            renderModeSwitcher();

            // 2. Nút Bấm Dịch Thủ Công (Manual Trigger)
            btnTranslate.addEventListener('click', () => {
                App.triggerManualTranslation();
            });

            // 3. Nút Toggle Lớp Phủ
            btnToggleOverlay.addEventListener('click', () => {
                App.toggleOverlay();
            });

            // 4. Slider độ mờ
            opacitySlider.value = Math.round(State.bubbleOpacity * 100);
            opacityValue.textContent = `${opacitySlider.value}%`;
            opacitySlider.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value) / 100;
                State.bubbleOpacity = val;
                opacityValue.textContent = `${e.target.value}%`;
                localStorage.setItem('md_overlay_opacity', val.toString());
                App.updateBubbleStyles();
            });

            // 5. Slider cỡ chữ
            fontScaleSlider.value = Math.round(State.fontScale * 100);
            fontScaleValue.textContent = `${fontScaleSlider.value}%`;
            fontScaleSlider.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value) / 100;
                State.fontScale = val;
                fontScaleValue.textContent = `${e.target.value}%`;
                localStorage.setItem('md_overlay_font_scale', val.toString());
                App.recomputeBubbleFonts();
            });

            // 6. CẤU HÌNH & ĐỔI API (SETTINGS VIEW EVENTS)
            const gearBtn = root.getElementById('gearBtn');
            const btnBackToMain = root.getElementById('btnBackToMain');
            const mainView = root.getElementById('mainView');
            const settingsView = root.getElementById('settingsView');
            const panelTitleText = root.getElementById('panelTitleText');
            const cfgServerUrl = root.getElementById('cfgServerUrl');
            const cfgBaseUrl = root.getElementById('cfgBaseUrl');
            const cfgModel = root.getElementById('cfgModel');
            const cfgApiKey = root.getElementById('cfgApiKey');
            const btnEyeKey = root.getElementById('btnEyeKey');
            const btnTestCfg = root.getElementById('btnTestCfg');
            const testCfgIcon = root.getElementById('testCfgIcon');
            const testCfgText = root.getElementById('testCfgText');
            const btnSaveCfg = root.getElementById('btnSaveCfg');
            const saveCfgIcon = root.getElementById('saveCfgIcon');
            const saveCfgText = root.getElementById('saveCfgText');
            const cfgBadge = root.getElementById('cfgBadge');
            const presetPills = root.querySelectorAll('.preset-pill');

            const PRESETS = {
                xkiro_qwen: { baseUrl: 'https://api.xkiro.com/v1', model: 'qwen/qwen3.5-flash:free' },
                google_aistudio: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-2.0-flash' },
                xkiro_gemini: { baseUrl: 'https://api.xkiro.com/v1', model: 'google/gemini-2.5-flash' },
                openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.0-flash-001' },
                custom: {}
            };

            const showView = (viewName) => {
                if (viewName === 'settings') {
                    State.isSettingsView = true;
                    mainView.classList.add('hidden');
                    settingsView.classList.remove('hidden');
                    gearBtn.classList.add('active');
                    panelTitleText.textContent = '⚙️ Cài Đặt API';
                    this.loadSettingsForm();
                } else {
                    State.isSettingsView = false;
                    settingsView.classList.add('hidden');
                    mainView.classList.remove('hidden');
                    gearBtn.classList.remove('active');
                    panelTitleText.textContent = '🌐 Manga AI Translator';
                }
            };

            gearBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                showView(State.isSettingsView ? 'main' : 'settings');
            });

            btnBackToMain.addEventListener('click', (e) => {
                e.stopPropagation();
                showView('main');
            });

            // Toggle ẩn hiện mật khẩu API key
            btnEyeKey.addEventListener('click', (e) => {
                e.stopPropagation();
                const isPass = cfgApiKey.type === 'password';
                cfgApiKey.type = isPass ? 'text' : 'password';
                btnEyeKey.textContent = isPass ? '🔒' : '👁️';
            });

            // Preset click
            presetPills.forEach((pill) => {
                pill.addEventListener('click', (e) => {
                    e.stopPropagation();
                    presetPills.forEach((p) => p.classList.remove('active'));
                    pill.classList.add('active');
                    const key = pill.getAttribute('data-preset');
                    const p = PRESETS[key];
                    if (p && p.baseUrl) {
                        cfgBaseUrl.value = p.baseUrl;
                        cfgModel.value = p.model;
                    }
                });
            });

            // Nút Kiểm Tra API
            btnTestCfg.addEventListener('click', async (e) => {
                e.stopPropagation();
                const baseUrl = cfgBaseUrl.value.trim();
                const apiKey = cfgApiKey.value.trim();
                const model = cfgModel.value.trim();

                if (!baseUrl || !apiKey || !model) {
                    this.showSettingsBadge('error', 'Vui lòng nhập đủ Base URL, Model và API Key!');
                    return;
                }

                btnTestCfg.disabled = true;
                testCfgIcon.replaceChildren();
                const spinner = document.createElement('div');
                spinner.className = 'spinner';
                testCfgIcon.appendChild(spinner);
                testCfgText.textContent = 'Đang test...';
                this.hideSettingsBadge();

                const t0 = performance.now();
                try {
                    const testRes = await apiRequest('/api/test-api', 'POST', {
                        base_url: baseUrl,
                        api_key: apiKey,
                        model: model
                    });
                    const latency = Math.round(performance.now() - t0);

                    if (testRes.ok) {
                        this.showSettingsBadge('success', `✅ Kết nối thành công (${latency}ms)! Model phản hồi: "${testRes.reply || 'OK'}"`);
                    } else {
                        this.showSettingsBadge('error', `❌ Kiểm tra thất bại: ${testRes.message || 'Lỗi API'}`);
                    }
                } catch (err) {
                    this.showSettingsBadge('error', `❌ Lỗi kết nối máy chủ local: ${err.message}`);
                } finally {
                    btnTestCfg.disabled = false;
                    testCfgIcon.textContent = '🧪';
                    testCfgText.textContent = 'Kiểm Tra API';
                }
            });

            // Nút Lưu Cấu Hình
            btnSaveCfg.addEventListener('click', async (e) => {
                e.stopPropagation();
                const serverUrl = cfgServerUrl.value.trim() || 'http://127.0.0.1:8765';
                const baseUrl = cfgBaseUrl.value.trim();
                const apiKey = cfgApiKey.value.trim();
                const model = cfgModel.value.trim();

                CONFIG.SERVER_URL = serverUrl;
                localStorage.setItem('md_overlay_server_url', serverUrl);

                root.getElementById('linkWebReader').href = `${serverUrl}/`;
                root.getElementById('linkWebSettings').href = `${serverUrl}/settings`;

                btnSaveCfg.disabled = true;
                saveCfgIcon.replaceChildren();
                const spinner = document.createElement('div');
                spinner.className = 'spinner';
                saveCfgIcon.appendChild(spinner);
                saveCfgText.textContent = 'Đang lưu...';
                this.hideSettingsBadge();

                try {
                    const saveRes = await apiRequest('/api/config', 'POST', {
                        base_url: baseUrl,
                        api_key: apiKey,
                        model: model
                    });

                    if (saveRes.ok) {
                        this.showSettingsBadge('success', '✅ Đã lưu cấu hình và đồng bộ với Server thành công!');
                        setTimeout(() => {
                            showView('main');
                            this.hideSettingsBadge();
                        }, 1200);
                    } else {
                        this.showSettingsBadge('error', `❌ Lỗi lưu cấu hình: ${saveRes.message || 'Lỗi server'}`);
                    }
                } catch (err) {
                    this.showSettingsBadge('info', 'ℹ️ Đã lưu URL server vào Extension. (Không gửi được lên Server backend)');
                } finally {
                    btnSaveCfg.disabled = false;
                    saveCfgIcon.textContent = '💾';
                    saveCfgText.textContent = 'Lưu & Đồng Bộ';
                }
            });
        }

        async loadSettingsForm() {
            const root = this.shadowRoot;
            if (!root) return;

            const cfgServerUrl = root.getElementById('cfgServerUrl');
            const cfgBaseUrl = root.getElementById('cfgBaseUrl');
            const cfgModel = root.getElementById('cfgModel');
            const cfgApiKey = root.getElementById('cfgApiKey');
            const presetPills = root.querySelectorAll('.preset-pill');

            cfgServerUrl.value = CONFIG.SERVER_URL;

            try {
                const configData = await apiRequest('/api/config?full=1');
                if (configData) {
                    if (configData.base_url) cfgBaseUrl.value = configData.base_url;
                    if (configData.model) cfgModel.value = configData.model;
                    if (configData.api_key) cfgApiKey.value = configData.api_key;

                    const presets = {
                        xkiro_qwen: { baseUrl: 'https://api.xkiro.com/v1', model: 'qwen/qwen3.5-flash:free' },
                        google_aistudio: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-2.0-flash' },
                        xkiro_gemini: { baseUrl: 'https://api.xkiro.com/v1', model: 'google/gemini-2.5-flash' },
                        openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.0-flash-001' }
                    };
                    let matched = 'custom';
                    for (const [key, p] of Object.entries(presets)) {
                        if (p.baseUrl === configData.base_url && p.model === configData.model) {
                            matched = key;
                            break;
                        }
                    }
                    presetPills.forEach((p) => {
                        p.classList.toggle('active', p.getAttribute('data-preset') === matched);
                    });
                }
            } catch (err) {
                console.warn('[MangaOverlay] Không thể lấy config từ server backend:', err);
            }
        }

        showSettingsBadge(type, message) {
            const root = this.shadowRoot;
            if (!root) return;
            const badge = root.getElementById('cfgBadge');
            badge.className = `status-msg-badge ${type}`;
            badge.textContent = message;
        }

        hideSettingsBadge() {
            const root = this.shadowRoot;
            if (!root) return;
            const badge = root.getElementById('cfgBadge');
            badge.className = 'status-msg-badge';
            badge.style.display = 'none';
        }

        togglePanel() {
            State.isPanelOpen ? this.closePanel() : this.openPanel();
        }

        openPanel() {
            State.isPanelOpen = true;
            const root = this.shadowRoot;
            root.getElementById('panel').classList.add('open');
            root.getElementById('fabButton').classList.add('open');
        }

        closePanel() {
            State.isPanelOpen = false;
            const root = this.shadowRoot;
            root.getElementById('panel').classList.remove('open');
            root.getElementById('fabButton').classList.remove('open');
        }

        updateStatus(status, text) {
            State.serverStatus = status;
            const root = this.shadowRoot;
            if (!root) return;

            const dot = root.getElementById('statusDot');
            dot.className = `status-dot ${status}`;

            if (text) {
                const chapStatus = root.getElementById('chapterStatus');
                if (chapStatus) chapStatus.textContent = text;
            }
        }

        updateTranslationUI(info) {
            const root = this.shadowRoot;
            if (!root) return;

            const progressText = root.getElementById('translationProgress');
            const progressContainer = root.getElementById('progressContainer');
            const progressBar = root.getElementById('progressBar');
            const btnTranslate = root.getElementById('btnTranslate');
            const btnText = root.getElementById('btnTranslateText');
            const btnIcon = root.getElementById('btnTranslateIcon');

            if (info.isTranslating) {
                this.updateStatus('translating', 'Đang dịch...');
                btnTranslate.disabled = true;
                btnIcon.replaceChildren();
                const spinner = document.createElement('div');
                spinner.className = 'spinner';
                btnIcon.appendChild(spinner);
                btnText.textContent = `Đang dịch (${info.completedPages || 0}/${info.totalPages || '?'})`;

                progressContainer.style.display = 'block';
                const pct = info.totalPages > 0 ? (info.completedPages / info.totalPages) * 100 : 30;
                progressBar.style.width = `${pct}%`;
                progressText.textContent = `Đang xử lý ${info.completedPages || 0}/${info.totalPages || '?'} trang`;
            } else if (info.hasTranslation) {
                this.updateStatus('ready', 'Đã có bản dịch');
                btnTranslate.disabled = false;
                btnIcon.textContent = '🔄';
                btnText.textContent = 'Dịch lại Chapter';

                progressContainer.style.display = 'none';
                progressText.textContent = `✅ Đã có (${info.pageCount} trang)`;
            } else {
                this.updateStatus('connected', 'Chưa có bản dịch');
                btnTranslate.disabled = false;
                btnIcon.textContent = '🚀';
                btnText.textContent = 'Dịch Chapter Này';

                progressContainer.style.display = 'none';
                progressText.textContent = 'Chưa dịch';
            }
        }

        updateToggleOverlayButton(isVisible) {
            const root = this.shadowRoot;
            if (!root) return;
            const btn = root.getElementById('btnToggleOverlay');
            if (isVisible) {
                btn.classList.add('active');
                btn.textContent = '👁️ Hiển thị bản dịch (Phím T)';
            } else {
                btn.classList.remove('active');
                btn.textContent = '🚫 Đã ẩn bản dịch (Phím T)';
            }
        }
    }

    // =========================================================================
    // OVERLAY ENGINE (RESIZEOBSERVER & POSITION CALCULATOR)
    // =========================================================================
    class OverlayEngine {
        constructor() {
            this.sharedResizeObserver = null;
            this.initResizeObserver();
            this.initGlobalListeners();
        }

        initResizeObserver() {
            // Dùng 1 ResizeObserver duy nhất cho toàn bộ ảnh manga (hiệu năng cao, không rò rỉ bộ nhớ)
            this.sharedResizeObserver = new ResizeObserver((entries) => {
                window.requestAnimationFrame(() => {
                    for (const entry of entries) {
                        const target = entry.target;
                        if (target) {
                            if (typeof target.__updateOverlayPos === 'function') {
                                target.__updateOverlayPos();
                            }
                            // Nếu target là parent, tìm ảnh con để cập nhật vị trí
                            const childImg = target.querySelector ? target.querySelector('img') : null;
                            if (childImg && typeof childImg.__updateOverlayPos === 'function') {
                                childImg.__updateOverlayPos();
                            }
                        }
                    }
                });
            });
        }

        initGlobalListeners() {
            let rafId = null;
            const updateAll = () => {
                if (rafId) cancelAnimationFrame(rafId);
                rafId = requestAnimationFrame(() => {
                    document.querySelectorAll('img').forEach((img) => {
                        if (typeof img.__updateOverlayPos === 'function') {
                            img.__updateOverlayPos();
                        }
                    });
                });
            };

            window.addEventListener('resize', updateAll, { passive: true });
            // capture: true bắt buộc để bắt được sự kiện cuộn từ các container nội bộ của MangaDex reader
            window.addEventListener('scroll', updateAll, { capture: true, passive: true });
            window.addEventListener('orientationchange', updateAll, { passive: true });

            // Bắt sự kiện load của ảnh reader trong capture phase:
            // Khi bất kỳ ảnh nào trong reader tải xong ảnh mới (VD: chuyển sang trang 2), lập tức áp dụng bản dịch
            document.addEventListener('load', (e) => {
                const target = e.target;
                if (target && target.tagName === 'IMG') {
                    const isReaderImg = target.alt?.toLowerCase().startsWith('page ') ||
                                        target.classList?.contains('page-image') ||
                                        target.closest?.('.page-wrapper, .page-container, [class*="reader"], #reader');
                    if (isReaderImg) {
                        if (State.chapterData && State.currentChapterId) {
                            setTimeout(() => this.applyTranslation(State.chapterData), 30);
                        }
                    }
                }
            }, true);
        }

        clearAll() {
            State.isUpdatingDOM = true;
            try {
                if (this.sharedResizeObserver) {
                    this.sharedResizeObserver.disconnect();
                }
                document.querySelectorAll('.md-translator-overlay-container').forEach((el) => el.remove());
            } finally {
                setTimeout(() => { State.isUpdatingDOM = false; }, 50);
            }
        }

        applyTranslation(chapterData) {
            if (!chapterData || !chapterData.pages) return;

            const mangaImages = this.detectMangaImages();
            if (mangaImages.length === 0) return;

            mangaImages.forEach((img, idx) => {
                const pageNumber = this.resolvePageNumber(img, idx, chapterData);
                const pageData = chapterData.pages.find((p) => p.page === pageNumber);

                if (pageData && pageData.bubbles && pageData.bubbles.length > 0) {
                    this.attachOverlayToImage(img, pageData);
                }
            });
        }

        detectMangaImages() {
            // Ưu tiên các ảnh trong container reader của MangaDex
            const readerImages = Array.from(document.querySelectorAll(`
                .page-wrapper img,
                .page-container img,
                [class*="page-wrapper"] img,
                [class*="reader"] img,
                #reader img,
                img.page-image,
                img[alt^="Page "]
            `));
            if (readerImages.length > 0) {
                return readerImages.filter((img) => {
                    const src = img.currentSrc || img.src || img.getAttribute('src') || img.getAttribute('data-src') || '';
                    if (src.includes('avatar') || src.includes('icon') || src.includes('logo') || src.includes('banner')) return false;
                    if (img.closest('header, nav, footer, #manga-overlay-extension-root')) return false;
                    return true;
                });
            }

            return Array.from(document.querySelectorAll('img')).filter((img) => {
                const src = img.currentSrc || img.src || img.getAttribute('src') || img.getAttribute('data-src') || '';

                if (src.includes('avatar') || src.includes('icon') || src.includes('logo') || src.includes('banner')) return false;
                if (img.closest('header, nav, footer, #manga-overlay-extension-root')) return false;

                if (img.clientHeight > 0 && img.clientHeight < 100) return false;
                if (img.naturalHeight > 0 && img.naturalHeight < 100) return false;

                const isMdImage = src.includes('mangadex.') || src.includes('/data') || src.includes('blob:');
                const hasSize = (img.naturalWidth > 150 || img.clientWidth > 150 || img.width > 150 || img.naturalHeight > 150 || img.clientHeight > 150);

                return isMdImage || hasSize;
            });
        }

        resolvePageNumber(img, index, chapterData) {
            const pageFromUrl = extractCurrentPageNumber();
            
            const allImages = document.querySelectorAll('img');
            const readerImages = Array.from(allImages).filter(el => {
                const src = el.currentSrc || el.src || el.getAttribute('src') || '';
                if (src.includes('avatar') || src.includes('icon') || src.includes('logo')) return false;
                const rect = el.getBoundingClientRect();
                return (rect.width > 50 && rect.height > 50) || el.hasAttribute('loading');
            });
            
            const isSinglePageMode = readerImages.length <= 4;

            // 1. Chế độ Single Page: URL là nguồn chuẩn xác NHẤT cho ảnh đang nằm ở TRUNG TÂM màn hình
            if (isSinglePageMode && pageFromUrl !== null) {
                const viewportCenter = (window.innerWidth || document.documentElement.clientWidth) / 2;
                
                // Tìm ảnh gần trung tâm màn hình nhất (chính là trang hiện tại)
                let closestImg = null;
                let minDistance = Infinity;
                
                readerImages.forEach(el => {
                    const r = el.getBoundingClientRect();
                    const elCenter = r.left + r.width / 2;
                    const distance = Math.abs(elCenter - viewportCenter);
                    if (distance < minDistance) {
                        minDistance = distance;
                        closestImg = el;
                    }
                });

                if (closestImg) {
                    // Nếu là ảnh trung tâm, nó chắc chắn là trang hiện tại
                    if (img === closestImg) {
                        return pageFromUrl;
                    }
                    
                    // Với các ảnh preload (trái/phải), ta dùng vị trí tương đối để đoán
                    // Sắp xếp các ảnh theo tọa độ X từ trái sang phải
                    const sortedImages = [...readerImages].sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
                    const closestIdx = sortedImages.indexOf(closestImg);
                    const thisIdx = sortedImages.indexOf(img);
                    
                    if (thisIdx !== -1 && closestIdx !== -1) {
                        const isRTL = true; // Đa số truyện trên MangaDex đọc từ phải sang trái (RTL)
                        const offset = thisIdx - closestIdx; // >0 nếu nằm bên phải, <0 nếu nằm bên trái
                        
                        // RTL: Bên phải là trang CŨ HƠN (nhỏ hơn), bên trái là trang MỚI HƠN (lớn hơn)
                        if (isRTL) {
                            return Math.max(1, pageFromUrl - offset);
                        } else {
                            return Math.max(1, pageFromUrl + offset);
                        }
                    }
                }
            }

            // 2. Chế độ Long Strip hoặc fallback: Sử dụng thuộc tính alt
            // Trong Long Strip, các thẻ <img> không bị tái sử dụng nên alt luôn chuẩn xác.
            const alt = img.alt || '';
            const altMatch = alt.match(/page\s*(\d+)/i) || alt.match(/^(\d+)$/);
            if (altMatch) {
                const p = parseInt(altMatch[1], 10);
                if (!isNaN(p) && p > 0) return p;
            }

            // 4. Kiểm tra data attributes từ thẻ cha (Dành cho Local Web Reader)
            let parent = img.parentElement;
            for (let depth = 0; depth < 5 && parent; depth++) {
                const dataPage = parent.getAttribute('data-page') ||
                                 parent.getAttribute('data-index') ||
                                 parent.getAttribute('data-page-number');
                if (dataPage) {
                    const p = parseInt(dataPage, 10);
                    if (!isNaN(p) && p > 0) return p;
                }
                parent = parent.parentElement;
            }

            // 5. Trích xuất từ URL ảnh CDN (Hỗ trợ định dạng cũ)
            const sources = [img.currentSrc, img.src, img.getAttribute('src'), img.getAttribute('data-src')].filter(Boolean);
            for (const s of sources) {
                const matchCdn = s.match(/\/(?:data|data-saver)\/[a-f0-9\-]+\/(\d+)(?:-|\.)/i);
                if (matchCdn) {
                    const p = parseInt(matchCdn[1], 10);
                    if (!isNaN(p) && p > 0) return p;
                }
            }

            // 6. Khớp chính xác theo filename từ chapterData
            if (chapterData && Array.isArray(chapterData.pages)) {
                for (const p of chapterData.pages) {
                    if (p.filename && sources.some((s) => s.includes(p.filename))) {
                        return p.page;
                    }
                }
            }

            // 7. Fallback cuối cùng: chỉ mục trong mảng (Cực kì chính xác cho Long Strip Mode)
            return index + 1;
        }

        attachOverlayToImage(img, pageData) {
            let parent = img.parentElement;
            if (!parent) return;

            // Ghi nhận số trang mục tiêu vào element để ngăn chặn triệt để race-condition khi chuyển trang nhanh
            img.__targetPage = pageData.page;

            // 1. Dọn dẹp hoặc tái sử dụng container cũ NGAY LẬP TỨC
            let existing = img.__mdOverlayContainer;
            if (existing && existing.isConnected) {
                if (existing.getAttribute('data-page') === String(pageData.page)) {
                    if (typeof img.__updateOverlayPos === 'function') {
                        img.__updateOverlayPos();
                    }
                    return;
                }
                existing.remove();
            }

            // Xóa toàn bộ các container mồ côi (khi ảnh chủ đã bị MangaDex xóa khỏi DOM)
            const allContainers = parent.querySelectorAll(':scope > .md-translator-overlay-container');
            allContainers.forEach(c => {
                if (!c.__ownerImg || !c.__ownerImg.isConnected) {
                    c.remove();
                }
            });

            // 2. Nếu ảnh chưa tải xong (đang chờ fetch):
            if (!img.complete) {
                const targetPage = pageData.page;
                const onImgLoaded = () => {
                    img.removeEventListener('load', onImgLoaded);
                    if (img.__targetPage === targetPage) {
                        this.attachOverlayToImage(img, pageData);
                    }
                };
                img.addEventListener('load', onImgLoaded, { once: true });
                return;
            }

            // Đảm bảo khối cha luôn là context định vị
            const parentStyle = window.getComputedStyle(parent);
            if (parentStyle.position === 'static') {
                parent.style.setProperty('position', 'relative', 'important');
            }

            // Tạo container overlay mới
            const container = document.createElement('div');
            container.className = 'md-translator-overlay-container';
            container.setAttribute('data-page', pageData.page);
            container.__ownerImg = img; // Liên kết container với ảnh chủ để dễ dàng dọn dẹp
            img.__mdOverlayContainer = container;

            Object.assign(container.style, {
                position: 'absolute',
                pointerEvents: 'none',
                zIndex: '9999',
                top: '0px',
                left: '0px',
                width: '0px',
                height: '0px',
                overflow: 'visible',
                transition: 'opacity 0.2s ease',
            });

            parent.appendChild(container);

            let lastRenderedW = 0;
            let lastRenderedH = 0;

            const updatePositions = () => {
                if (!img.isConnected || !container.isConnected) return;
                // Kiểm tra nếu container này đã lạc hậu so với trang hiện tại của ảnh
                if (img.__targetPage && img.__targetPage !== pageData.page) {
                    container.remove();
                    return;
                }

                const imgRect = img.getBoundingClientRect();
                const currentW = imgRect.width;
                const currentH = imgRect.height;

                if (currentW < 10 || currentH < 10) {
                    requestAnimationFrame(updatePositions);
                    return;
                }

                // Đảm bảo parent giữ position: relative
                if (parent && window.getComputedStyle(parent).position === 'static') {
                    parent.style.setProperty('position', 'relative', 'important');
                }

                // VÒNG LẶP PHẢN HỒI KÍN (CLOSED-LOOP DELTA FEEDBACK CORRECTION):
                // Đo đạc tọa độ viewport thực tế giữa container và manga image.
                // Bất kể layout dùng flexbox justify-center, margin auto, padding hay lazy loading,
                // hiệu số (deltaX, deltaY) sẽ bù trừ chuẩn xác 100% tọa độ hiển thị!
                const cRect = container.getBoundingClientRect();
                const deltaX = imgRect.left - cRect.left;
                const deltaY = imgRect.top - cRect.top;

                if (Math.abs(deltaX) > 0.5 || Math.abs(deltaY) > 0.5) {
                    const curLeft = parseFloat(container.style.left) || 0;
                    const curTop = parseFloat(container.style.top) || 0;
                    container.style.left = `${curLeft + deltaX}px`;
                    container.style.top = `${curTop + deltaY}px`;
                }

                container.style.width = `${currentW}px`;
                container.style.height = `${currentH}px`;

                // Nếu kích thước bubble không đổi và đã render bubble rồi thì không cần re-create
                if (Math.abs(currentW - lastRenderedW) < 2 && Math.abs(currentH - lastRenderedH) < 2 && container.children.length > 0) {
                    return;
                }

                lastRenderedW = currentW;
                lastRenderedH = currentH;

                container.replaceChildren();

                const origW = pageData.resolution ? parseInt(pageData.resolution.split('x')[0], 10) : (img.naturalWidth || 1000);
                const origH = pageData.resolution ? parseInt(pageData.resolution.split('x')[1], 10) : (img.naturalHeight || 1400);

                const scaleX = currentW / origW;
                const scaleY = currentH / origH;

                pageData.bubbles.forEach((b) => {
                    if (!b.vi || b.vi.trim() === '') return;

                    const [bx, by, bw, bh] = b.box;
                    const bubble = document.createElement('div');
                    bubble.className = 'md-speech-bubble';

                    const bWidth = bw * scaleX;
                    const bHeight = bh * scaleY;

                    Object.assign(bubble.style, {
                        position: 'absolute',
                        left: `${bx * scaleX}px`,
                        top: `${by * scaleY}px`,
                        width: `${bWidth}px`,
                        height: `${bHeight}px`,
                        backgroundColor: `rgba(255, 255, 255, ${State.bubbleOpacity})`,
                        color: '#09090b',
                        borderRadius: '6px',
                        border: '1px solid rgba(0, 0, 0, 0.15)',
                        padding: '2px 4px',
                        boxSizing: 'border-box',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        textAlign: 'center',
                        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                        fontWeight: '600',
                        lineHeight: '1.2',
                        wordBreak: 'break-word',
                        pointerEvents: State.isOverlayVisible ? 'auto' : 'none',
                        opacity: State.isOverlayVisible ? '1' : '0',
                        transition: 'opacity 0.2s ease, background-color 0.2s ease',
                        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.12)',
                        cursor: 'help',
                    });

                    const area = bWidth * bHeight;
                    const textLen = b.vi.length;
                    const baseFont = Math.max(9, Math.min(22, Math.sqrt(area / (textLen * 1.5)) * State.fontScale));
                    bubble.style.fontSize = `${baseFont.toFixed(1)}px`;
                    bubble.textContent = b.vi;
                    bubble.title = `[ID #${b.id}] Click để sao chép bản dịch`;

                    bubble.addEventListener('click', (e) => {
                        e.stopPropagation();
                        navigator.clipboard.writeText(b.vi);
                        bubble.style.backgroundColor = 'rgba(187, 247, 208, 0.95)';
                        setTimeout(() => {
                            bubble.style.backgroundColor = `rgba(255, 255, 255, ${State.bubbleOpacity})`;
                        }, 400);
                    });

                    container.appendChild(bubble);
                });
            };

            img.__updateOverlayPos = updatePositions;
            updatePositions();

            // Cập nhật vị trí nhiều nhịp để thích ứng hoàn hảo với lazy loading của trình duyệt Edge/Chrome
            requestAnimationFrame(() => updatePositions());
            setTimeout(updatePositions, 50);
            setTimeout(updatePositions, 150);
            setTimeout(updatePositions, 300);
            setTimeout(updatePositions, 600);
            setTimeout(updatePositions, 1200);

            // Đăng ký vào observer dùng chung cho cả ảnh và khối cha (khi flex cha co giãn thì ảnh di chuyển)
            if (this.sharedResizeObserver) {
                this.sharedResizeObserver.observe(img);
                if (parent) {
                    this.sharedResizeObserver.observe(parent);
                }
            }
        }

        setVisibility(isVisible) {
            document.querySelectorAll('.md-speech-bubble').forEach((el) => {
                el.style.opacity = isVisible ? '1' : '0';
                el.style.pointerEvents = isVisible ? 'auto' : 'none';
            });
        }

        updateStyles() {
            document.querySelectorAll('.md-speech-bubble').forEach((el) => {
                el.style.backgroundColor = `rgba(255, 255, 255, ${State.bubbleOpacity})`;
            });
        }
    }

    // =========================================================================
    // BỘ ĐIỀU PHỐI CHÍNH (MAIN APPLICATION CONTROLLER)
    // =========================================================================
    const UI = new MangaOverlayUI();
    const Engine = new OverlayEngine();

    const App = {
        init() {
            console.log('[MangaOverlay] Userscript v2.4.1 đã khởi động an toàn.');
            this.registerShortcuts();
            this.startHeartbeat();
            this.startSafeDomObserver();
            this.onRouteChanged();
        },

        // Heartbeat Watchdog & History API Hook tự động phục hồi mỗi 200ms
        startHeartbeat() {
            let lastHref = window.location.href;

            const onLocationChanged = () => {
                if (window.location.href !== lastHref) {
                    lastHref = window.location.href;
                    this.onRouteChanged();
                }
            };

            // Hook HTML5 History API (hỗ trợ cả unsafeWindow của Tampermonkey)
            const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            if (win && win.history) {
                const origPush = win.history.pushState;
                win.history.pushState = function (...args) {
                    const res = origPush.apply(this, args);
                    onLocationChanged();
                    return res;
                };

                const origReplace = win.history.replaceState;
                win.history.replaceState = function (...args) {
                    const res = origReplace.apply(this, args);
                    onLocationChanged();
                    return res;
                };
            }

            window.addEventListener('popstate', onLocationChanged);

            // Vòng lặp Heartbeat 200ms tự phục hồi: đảm bảo mọi trang khi mở ra đều có overlay
            setInterval(() => {
                onLocationChanged();

                if (State.chapterData && State.currentChapterId && State.isOverlayVisible) {
                    const mangaImages = Engine.detectMangaImages();

                    for (let idx = 0; idx < mangaImages.length; idx++) {
                        const img = mangaImages[idx];
                        // Nếu ảnh chưa tải xong kích thước thì để sự kiện load lo, không trigger đè
                        if (!img.complete || (img.naturalWidth === 0 && img.clientWidth === 0)) {
                            continue;
                        }

                        const pNum = Engine.resolvePageNumber(img, idx, State.chapterData);
                        const parent = img.parentElement;
                        if (!parent) continue;

                        const existing = parent.querySelector(':scope > .md-translator-overlay-container');
                        if (!existing || existing.getAttribute('data-page') !== String(pNum)) {
                            Engine.applyTranslation(State.chapterData);
                            break;
                        }
                    }
                }
            }, 200);
        },

        // QUAN SÁT DOM AN TOÀN (DEBOUNCED & RECURSION-SAFE)
        startSafeDomObserver() {
            let debounceTimer = null;

            const observer = new MutationObserver((mutations) => {
                let hasRelevantMutation = false;

                for (const m of mutations) {
                    const t = m.target;
                    if (t && t.nodeType === 1) {
                        if (t.id === 'manga-overlay-extension-root' || 
                            t.classList?.contains('md-translator-overlay-container') || 
                            t.classList?.contains('md-speech-bubble') ||
                            t.closest?.('.md-translator-overlay-container') || 
                            t.closest?.('#manga-overlay-extension-root')) {
                            continue;
                        }
                    }

                    // Phát hiện khi MangaDex đổi src hoặc alt của ảnh reader
                    if (m.type === 'attributes' && (m.attributeName === 'src' || m.attributeName === 'alt')) {
                        if (m.target.tagName === 'IMG') {
                            hasRelevantMutation = true;
                            break;
                        }
                    }

                    // Kiểm tra các node được thêm vào / gỡ bỏ
                    if (m.type === 'childList') {
                        for (let i = 0; i < m.addedNodes.length; i++) {
                            const node = m.addedNodes[i];
                            if (node.nodeType === 1 && 
                                !node.classList?.contains('md-translator-overlay-container') && 
                                !node.classList?.contains('md-speech-bubble')) {
                                hasRelevantMutation = true;
                                break;
                            }
                        }
                        if (hasRelevantMutation) break;
                    }
                }

                if (!hasRelevantMutation) return;

                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    if (State.chapterData && State.currentChapterId) {
                        Engine.applyTranslation(State.chapterData);
                    }
                }, 150);
            });

            observer.observe(document.body, { 
                childList: true, 
                subtree: true, 
                attributes: true, 
                attributeFilter: ['src', 'alt'] 
            });
        },

        registerShortcuts() {
            window.addEventListener('keydown', (e) => {
                if ((e.key === 't' || e.key === 'T') && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
                    this.toggleOverlay();
                }
            });
        },

        async onRouteChanged() {
            const chapterId = extractChapterId();
            if (!chapterId) {
                UI.updateStatus('disconnected', 'Không ở trang đọc truyện');
                return;
            }

            if (chapterId === State.currentChapterId) {
                if (State.chapterData) {
                    Engine.applyTranslation(State.chapterData);
                }
                return;
            }

            State.currentChapterId = chapterId;
            State.chapterData = null;
            Engine.clearAll();

            UI.updateStatus('connected', `ID: ${chapterId.slice(0, 8)}...`);
            await this.checkChapterStatus(chapterId);
        },

        async checkChapterStatus(chapterId) {
            try {
                const statusRes = await apiRequest(`/api/status?id=${chapterId}`);
                if (statusRes.status === 'running') {
                    State.isTranslating = true;
                    UI.updateTranslationUI({
                        isTranslating: true,
                        completedPages: statusRes.completed_pages,
                        totalPages: statusRes.total_pages,
                    });
                    this.startPolling(chapterId);
                } else {
                    try {
                        const chapterRes = await apiRequest(`/api/chapter?id=${chapterId}`);
                        if (chapterRes && chapterRes.pages && chapterRes.pages.length > 0) {
                            State.chapterData = chapterRes;
                            UI.updateTranslationUI({
                                hasTranslation: true,
                                pageCount: chapterRes.pages.length,
                            });
                            Engine.applyTranslation(chapterRes);
                            return;
                        }
                    } catch (e) {}

                    UI.updateTranslationUI({ hasTranslation: false });
                }
            } catch (err) {
                console.warn('[MangaOverlay] Không thể kết nối tới server:', err);
                UI.updateStatus('disconnected', 'Server chưa kết nối');
            }
        },

        async triggerManualTranslation() {
            const chapterId = State.currentChapterId || extractChapterId();
            if (!chapterId) {
                alert('Vui lòng mở một chapter trên MangaDex trước khi bấm dịch!');
                return;
            }

            try {
                UI.updateTranslationUI({ isTranslating: true, completedPages: 0, totalPages: 0 });
                const res = await apiRequest('/api/translate', 'POST', {
                    chapter_id: chapterId,
                    url: window.location.href,
                    pipeline_type: State.selectedPipeline || 'ocr_trans',
                    translation_provider: State.selectedPipeline === 'image_trans' ? 'vision_llm' : (State.selectedProvider || 'google')
                });

                console.log('[MangaOverlay] Bắt đầu tiến trình dịch:', res);
                this.startPolling(chapterId);
            } catch (err) {
                alert(`Không thể kích hoạt dịch: ${err.message}\nHãy đảm bảo server local đã được bật!`);
                UI.updateStatus('disconnected', 'Lỗi gọi API');
            }
        },

        startPolling(chapterId) {
            if (State.pollTimer) clearInterval(State.pollTimer);

            State.pollTimer = setInterval(async () => {
                try {
                    const statusRes = await apiRequest(`/api/status?id=${chapterId}`);

                    if (statusRes.status === 'running') {
                        UI.updateTranslationUI({
                            isTranslating: true,
                            completedPages: statusRes.completed_pages,
                            totalPages: statusRes.total_pages,
                        });

                        if (statusRes.completed_pages > 0) {
                            try {
                                const partial = await apiRequest(`/api/chapter?id=${chapterId}`);
                                if (partial && partial.pages) {
                                    State.chapterData = partial;
                                    Engine.applyTranslation(partial);
                                }
                            } catch (e) {}
                        }
                    } else if (statusRes.status === 'done' || statusRes.completed_pages > 0) {
                        clearInterval(State.pollTimer);
                        State.isTranslating = false;

                        const finalData = await apiRequest(`/api/chapter?id=${chapterId}`);
                        State.chapterData = finalData;
                        UI.updateTranslationUI({
                            hasTranslation: true,
                            pageCount: finalData.pages ? finalData.pages.length : 0,
                        });
                        Engine.applyTranslation(finalData);
                    } else if (statusRes.status === 'error') {
                        clearInterval(State.pollTimer);
                        State.isTranslating = false;
                        alert(`Dịch thất bại: ${statusRes.message || 'Lỗi không xác định'}`);
                        UI.updateTranslationUI({ hasTranslation: false });
                    }
                } catch (e) {
                    console.error('[MangaOverlay] Lỗi polling:', e);
                }
            }, CONFIG.POLL_INTERVAL_MS);
        },

        toggleOverlay() {
            State.isOverlayVisible = !State.isOverlayVisible;
            Engine.setVisibility(State.isOverlayVisible);
            UI.updateToggleOverlayButton(State.isOverlayVisible);
        },

        updateBubbleStyles() {
            Engine.updateStyles();
        },

        recomputeBubbleFonts() {
            if (State.chapterData) {
                Engine.applyTranslation(State.chapterData);
            }
        },
    };

    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand('🚀 Dịch Chapter Hiện Tại', () => App.triggerManualTranslation());
        GM_registerMenuCommand('👁️ Bật/Tắt Lớp Phủ (Phím T)', () => App.toggleOverlay());
        GM_registerMenuCommand('📖 Mở Local Web Reader', () => window.open(`${CONFIG.SERVER_URL}/`, '_blank'));
        GM_registerMenuCommand('⚙️ Cài Đặt API & Máy Chủ', () => window.open(`${CONFIG.SERVER_URL}/settings`, '_blank'));
    }

    App.init();
})();
