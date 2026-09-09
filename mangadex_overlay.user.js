// ==UserScript==
// @name         MangaDex AI Translator Overlay (Tiếng Việt)
// @namespace    https://github.com/vide-coding/mangadex-translator
// @version      2.5.0
// @description  Hiển thị bản dịch tiếng Việt đè lên bong bóng thoại MangaDex. Hỗ trợ 2 Pipeline linh hoạt, Multi-Profile API Key & Custom Models không giới hạn, chống nghẽn đơ tab 100%, tự co giãn theo tranh vẽ.
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
        selectedOcrEngine: localStorage.getItem('md_selected_ocr_engine') || 'manga_ocr',
        autoDetectLang: localStorage.getItem('md_auto_detect_lang') !== 'false',
        isManualOverride: false, // Cờ khóa thủ công: loại trừ khi nhãn ngôn ngữ bị sai
        detectedLang: null,
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
    // THƯ VIỆN VECTOR SVG HAND-DRAWN LINE ICONS (NÉT CHÌ PHÁC THẢO THUẦN TÚY)
    // =========================================================================
    const SKETCH_ICONS = {
        lightning: `<svg class="sketch-icon" viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`,
        gear: `<svg class="sketch-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
        close: `<svg class="sketch-icon" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
        translate: `<svg class="sketch-icon" viewBox="0 0 24 24"><path d="M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6"></path></svg>`,
        refresh: `<svg class="sketch-icon" viewBox="0 0 24 24"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l6.73-1.19"></path></svg>`,
        eye: `<svg class="sketch-icon" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`,
        eyeOff: `<svg class="sketch-icon" viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`,
        save: `<svg class="sketch-icon" viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>`,
        flask: `<svg class="sketch-icon" viewBox="0 0 24 24"><path d="M10 2v7.31L4.14 20.37A2 2 0 0 0 5.86 23h12.28a2 2 0 0 0 1.72-2.63L14 9.31V2"></path><line x1="8.5" y1="2" x2="15.5" y2="2"></line><line x1="7" y1="16" x2="17" y2="16"></line></svg>`,
        key: `<svg class="sketch-icon" viewBox="0 0 24 24"><circle cx="7.5" cy="15.5" r="4.5"></circle><path d="m21 3-9.5 9.5M15.5 7.5l3 3M18.5 4.5l3 3"></path></svg>`,
        image: `<svg class="sketch-icon" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`,
        book: `<svg class="sketch-icon" viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>`,
        arrowLeft: `<svg class="sketch-icon" viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>`,
    };

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
                    @import url('https://fonts.googleapis.com/css2?family=Kalam:wght@400;700&family=Patrick+Hand&display=swap');

                    :host {
                        all: initial;
                        font-family: 'Patrick Hand', 'Comic Neue', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, cursive, sans-serif;
                        z-index: 999999;
                        position: fixed;
                        bottom: 24px;
                        right: 24px;
                        pointer-events: none;
                        user-select: none;
                        --border-pencil: #2d2d2d;
                        --bg-paper: #fdfbf7;
                        --marker-red: #ff4d4d;
                        --pen-blue: #2d5da1;
                        --postit-yellow: #fff9c4;
                    }

                    * {
                        box-sizing: border-box;
                    }

                    /* Hand-Drawn Sketch SVG Line Icons */
                    .sketch-icon {
                        width: 16px;
                        height: 16px;
                        stroke: var(--border-pencil);
                        stroke-width: 2.2;
                        stroke-linecap: round;
                        stroke-linejoin: round;
                        fill: none;
                        vertical-align: -2px;
                        display: inline-block;
                        flex-shrink: 0;
                        transition: stroke 0.15s ease, transform 0.15s ease;
                    }

                    .sketch-icon.lg {
                        width: 24px;
                        height: 24px;
                    }

                    .widget-container {
                        position: relative;
                        display: flex;
                        flex-direction: column;
                        align-items: flex-end;
                        pointer-events: auto;
                    }

                    /* 1. NÚT NỔI THU NHỎ (FLOATING ACTION BUTTON) - HAND-DRAWN STAMP */
                    .fab-button {
                        width: 52px;
                        height: 52px;
                        border-radius: 50%;
                        background: #fff9c4;
                        border: 2.5px solid var(--border-pencil);
                        box-shadow: 3px 3px 0px var(--border-pencil);
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        cursor: pointer;
                        transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
                        position: relative;
                    }

                    .fab-button:hover {
                        transform: translate(-2px, -2px);
                        box-shadow: 5px 5px 0px var(--border-pencil);
                        background: #fff3a8;
                    }

                    .fab-button:active {
                        transform: translate(2px, 2px);
                        box-shadow: 1px 1px 0px var(--border-pencil);
                    }

                    .fab-button .sketch-icon {
                        width: 26px;
                        height: 26px;
                        stroke: var(--border-pencil);
                        stroke-width: 2.4;
                        transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
                    }

                    .fab-button.open .sketch-icon {
                        transform: rotate(45deg);
                    }

                    /* Đèn trạng thái server */
                    .status-dot {
                        position: absolute;
                        top: -1px;
                        right: -1px;
                        width: 14px;
                        height: 14px;
                        border-radius: 50%;
                        border: 2px solid var(--border-pencil);
                        background: #94a3b8;
                        transition: background 0.3s ease;
                    }

                    .status-dot.connected { background: #22c55e; }
                    .status-dot.translating {
                        background: #f59e0b;
                        animation: pulse-ring 1.2s infinite;
                    }
                    .status-dot.ready { background: #38bdf8; }
                    .status-dot.disconnected { background: #ef4444; }

                    @keyframes pulse-ring {
                        0% { transform: scale(0.9); }
                        50% { transform: scale(1.25); }
                        100% { transform: scale(0.9); }
                    }

                    /* 2. BẢNG ĐIỀU KHIỂN POPOVER - SỔ TAY MANGA NOTEBOOK */
                    .popover-panel {
                        position: absolute;
                        bottom: 66px;
                        right: 0;
                        width: 320px;
                        background: var(--bg-paper);
                        background-image: radial-gradient(#e5e0d8 1.2px, transparent 1.2px);
                        background-size: 16px 16px;
                        border: 2.5px solid var(--border-pencil);
                        border-radius: 14px;
                        box-shadow: 5px 5px 0px var(--border-pencil);
                        color: var(--border-pencil);
                        overflow: hidden;
                        opacity: 0;
                        transform: translateY(12px) scale(0.95);
                        transform-origin: bottom right;
                        pointer-events: none;
                        transition: all 0.22s cubic-bezier(0.16, 1, 0.3, 1);
                    }

                    .popover-panel.open {
                        opacity: 1;
                        transform: translateY(0) scale(1);
                        pointer-events: auto;
                    }

                    /* Băng dính Washi Tape trang trí */
                    .tape-strip {
                        position: absolute;
                        top: -8px;
                        left: 50%;
                        transform: translateX(-50%) rotate(-1deg);
                        width: 80px;
                        height: 18px;
                        background: rgba(229, 224, 216, 0.85);
                        border: 1px dashed rgba(45, 45, 45, 0.4);
                        pointer-events: none;
                        z-index: 2;
                    }

                    .panel-header {
                        padding: 12px 14px;
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        border-bottom: 2px solid var(--border-pencil);
                        background: #ffffff;
                    }

                    .panel-title {
                        font-family: 'Kalam', cursive, sans-serif;
                        font-size: 15px;
                        font-weight: 700;
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        color: var(--border-pencil);
                    }

                    .header-actions {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                    }

                    .gear-btn, .close-btn {
                        background: #ffffff;
                        border: 1.5px solid var(--border-pencil);
                        color: var(--border-pencil);
                        cursor: pointer;
                        line-height: 1;
                        padding: 5px;
                        border-radius: 6px;
                        box-shadow: 1.5px 1.5px 0px var(--border-pencil);
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        transition: all 0.15s ease;
                    }

                    .gear-btn:hover, .close-btn:hover {
                        background: #fff9c4;
                        transform: translate(-1px, -1px);
                        box-shadow: 2.5px 2.5px 0px var(--border-pencil);
                    }

                    .gear-btn:active, .close-btn:active {
                        transform: translate(1px, 1px);
                        box-shadow: 0px 0px 0px var(--border-pencil);
                    }

                    .gear-btn.active {
                        background: #2d5da1;
                        color: #ffffff;
                    }
                    .gear-btn.active .sketch-icon {
                        stroke: #ffffff;
                    }

                    .panel-body {
                        padding: 12px 14px;
                        display: flex;
                        flex-direction: column;
                        gap: 10px;
                        max-height: 480px;
                        overflow-y: auto;
                    }

                    .view-container {
                        display: flex;
                        flex-direction: column;
                        gap: 10px;
                        width: 100%;
                    }

                    .view-container.hidden {
                        display: none;
                    }

                    /* Post-It Status Card */
                    .status-card {
                        background: #fff9c4;
                        border: 1.5px dashed var(--border-pencil);
                        border-radius: 8px;
                        padding: 8px 10px;
                        font-size: 13px;
                        display: flex;
                        flex-direction: column;
                        gap: 4px;
                        box-shadow: 2px 2px 0px var(--border-pencil);
                        transform: rotate(-0.5deg);
                    }

                    .status-line {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                    }

                    .status-label {
                        color: #555555;
                        font-weight: 600;
                    }

                    .status-value {
                        font-weight: 700;
                        color: var(--border-pencil);
                    }

                    /* Thanh tiến trình phác thảo */
                    .progress-bar-container {
                        width: 100%;
                        height: 7px;
                        background: #ffffff;
                        border: 1.5px solid var(--border-pencil);
                        border-radius: 4px;
                        overflow: hidden;
                        margin-top: 4px;
                        display: none;
                    }

                    .progress-bar-fill {
                        height: 100%;
                        background: #ff4d4d;
                        width: 0%;
                        transition: width 0.3s ease;
                    }

                    /* Mode Switcher Notebook Tabs */
                    .mode-switcher-container {
                        display: flex;
                        flex-direction: column;
                        gap: 6px;
                        background: #ffffff;
                        border: 2px solid var(--border-pencil);
                        border-radius: 8px;
                        padding: 8px;
                        box-shadow: 2px 2px 0px var(--border-pencil);
                    }

                    .mode-tabs {
                        display: flex;
                        gap: 4px;
                        background: #f1ede4;
                        border: 1.5px solid var(--border-pencil);
                        border-radius: 6px;
                        padding: 2px;
                    }

                    .mode-tab {
                        flex: 1;
                        padding: 5px 8px;
                        font-family: 'Kalam', cursive, sans-serif;
                        font-size: 12px;
                        font-weight: 700;
                        border-radius: 4px;
                        border: none;
                        background: transparent;
                        color: #555555;
                        cursor: pointer;
                        transition: all 0.15s ease;
                        text-align: center;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        gap: 4px;
                    }

                    .mode-tab:hover {
                        color: var(--border-pencil);
                    }

                    .mode-tab.active {
                        background: var(--border-pencil);
                        color: #ffffff;
                    }
                    .mode-tab.active .sketch-icon {
                        stroke: #ffffff;
                    }

                    /* Sub-pills (OCR engine & Translation provider) */
                    .sub-providers-row {
                        display: flex;
                        gap: 4px;
                        justify-content: space-between;
                    }

                    .sub-pill {
                        flex: 1;
                        font-family: 'Patrick Hand', cursive, sans-serif;
                        font-size: 12px;
                        font-weight: 600;
                        padding: 3px 4px;
                        border-radius: 5px;
                        border: 1.5px solid var(--border-pencil);
                        background: #ffffff;
                        color: var(--border-pencil);
                        cursor: pointer;
                        text-align: center;
                        transition: all 0.12s ease;
                        white-space: nowrap;
                    }

                    .sub-pill:hover {
                        background: #fff9c4;
                        transform: translateY(-1px);
                    }

                    .sub-pill.active {
                        background: #2d5da1;
                        color: #ffffff;
                        box-shadow: 1.5px 1.5px 0px var(--border-pencil);
                    }

                    /* Auto detect bar */
                    #ocrAutoDetectBar {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        font-size: 12px;
                        padding: 4px 8px;
                        background: #fdfbf7;
                        border-radius: 6px;
                        border: 1.5px dashed var(--border-pencil);
                    }

                    #btnToggleAutoLang {
                        background: #ffffff;
                        border: 1.5px solid var(--border-pencil);
                        color: var(--border-pencil);
                        border-radius: 4px;
                        font-size: 11px;
                        cursor: pointer;
                        padding: 1px 8px;
                        box-shadow: 1px 1px 0px var(--border-pencil);
                        font-family: 'Patrick Hand', cursive, sans-serif;
                        font-weight: 700;
                        transition: all 0.12s ease;
                    }

                    #btnToggleAutoLang:hover {
                        background: #fff9c4;
                    }

                    /* Nút bấm hành động (Action buttons) */
                    .btn-action {
                        width: 100%;
                        padding: 9px 12px;
                        border-radius: 8px;
                        border: 2px solid var(--border-pencil);
                        font-family: 'Kalam', cursive, sans-serif;
                        font-size: 14px;
                        font-weight: 700;
                        cursor: pointer;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        gap: 6px;
                        transition: all 0.15s ease;
                        box-shadow: 3px 3px 0px var(--border-pencil);
                    }

                    .btn-action:hover:not(:disabled) {
                        transform: translate(-1.5px, -1.5px);
                        box-shadow: 4.5px 4.5px 0px var(--border-pencil);
                    }

                    .btn-action:active:not(:disabled) {
                        transform: translate(1.5px, 1.5px);
                        box-shadow: 1px 1px 0px var(--border-pencil);
                    }

                    .btn-action:disabled {
                        opacity: 0.6;
                        cursor: not-allowed;
                        box-shadow: 1px 1px 0px var(--border-pencil);
                        transform: none;
                    }

                    .btn-translate {
                        background: #ff4d4d;
                        color: #ffffff;
                    }
                    .btn-translate .sketch-icon {
                        stroke: #ffffff;
                    }

                    .btn-toggle {
                        background: #ffffff;
                        color: var(--border-pencil);
                    }

                    .btn-toggle.active {
                        background: #fff9c4;
                        border-color: var(--border-pencil);
                    }

                    /* Thanh trượt tùy chỉnh (Sliders) */
                    .control-group {
                        display: flex;
                        flex-direction: column;
                        gap: 4px;
                    }

                    .control-header {
                        display: flex;
                        justify-content: space-between;
                        font-size: 13px;
                        font-weight: 600;
                        color: #555555;
                    }

                    .range-slider {
                        width: 100%;
                        height: 6px;
                        border-radius: 4px;
                        background: #e5e0d8;
                        border: 1.5px solid var(--border-pencil);
                        outline: none;
                        -webkit-appearance: none;
                        cursor: pointer;
                    }

                    .range-slider::-webkit-slider-thumb {
                        -webkit-appearance: none;
                        width: 16px;
                        height: 16px;
                        border-radius: 50%;
                        background: #ff4d4d;
                        border: 2px solid var(--border-pencil);
                        cursor: pointer;
                        box-shadow: 1px 1px 0px var(--border-pencil);
                    }

                    /* SETTINGS VIEW */
                    .presets-pills {
                        display: flex;
                        gap: 5px;
                        overflow-x: auto;
                        padding-bottom: 2px;
                    }

                    .preset-pill {
                        background: #ffffff;
                        border: 1.5px solid var(--border-pencil);
                        color: var(--border-pencil);
                        font-family: 'Patrick Hand', cursive, sans-serif;
                        font-size: 12px;
                        font-weight: 600;
                        padding: 3px 8px;
                        border-radius: 6px;
                        cursor: pointer;
                        white-space: nowrap;
                        box-shadow: 1.5px 1.5px 0px var(--border-pencil);
                        transition: all 0.12s ease;
                    }

                    .preset-pill:hover {
                        background: #fff9c4;
                        transform: translateY(-1px);
                    }

                    .preset-pill.active {
                        background: #2d5da1;
                        color: #ffffff;
                    }

                    .form-input-group {
                        display: flex;
                        flex-direction: column;
                        gap: 3px;
                    }

                    .form-input-label {
                        font-size: 12px;
                        color: #444444;
                        font-weight: 700;
                        display: flex;
                        justify-content: space-between;
                    }

                    .form-input-field {
                        width: 100%;
                        background: #ffffff;
                        border: 2px solid var(--border-pencil);
                        border-radius: 6px;
                        padding: 6px 8px;
                        color: var(--border-pencil);
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                        font-size: 12px;
                        outline: none;
                        box-sizing: border-box;
                        box-shadow: 2px 2px 0px rgba(45, 45, 45, 0.12);
                    }

                    .form-input-field:focus {
                        border-color: #2d5da1;
                        background: #fdfdfd;
                    }

                    .input-password-row {
                        position: relative;
                        display: flex;
                        align-items: center;
                    }

                    .btn-eye {
                        position: absolute;
                        right: 6px;
                        background: none;
                        border: none;
                        color: var(--border-pencil);
                        cursor: pointer;
                        padding: 2px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    }

                    .btn-test-cfg {
                        background: #2d5da1;
                        color: #ffffff;
                    }
                    .btn-test-cfg .sketch-icon {
                        stroke: #ffffff;
                    }

                    .btn-save-cfg {
                        background: #15803d;
                        color: #ffffff;
                    }
                    .btn-save-cfg .sketch-icon {
                        stroke: #ffffff;
                    }

                    .status-msg-badge {
                        font-size: 12px;
                        padding: 6px 8px;
                        border-radius: 6px;
                        display: none;
                        line-height: 1.3;
                        font-weight: 600;
                        border: 1.5px solid var(--border-pencil);
                    }

                    .status-msg-badge.success {
                        display: block;
                        background: #dcfce7;
                        color: #15803d;
                    }

                    .status-msg-badge.error {
                        display: block;
                        background: #fee2e2;
                        color: #b91c1c;
                    }

                    .status-msg-badge.info {
                        display: block;
                        background: #e0f2fe;
                        color: #0369a1;
                    }

                    .panel-footer {
                        padding: 8px 14px;
                        border-top: 2px dashed var(--border-pencil);
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        font-size: 12px;
                        background: #ffffff;
                    }

                    .link-btn {
                        color: var(--border-pencil);
                        text-decoration: none;
                        font-weight: 700;
                        display: flex;
                        align-items: center;
                        gap: 4px;
                        transition: color 0.15s;
                    }

                    .link-btn:hover {
                        color: #ff4d4d;
                    }

                    .link-btn:hover .sketch-icon {
                        stroke: #ff4d4d;
                    }

                    /* Spinner nét chì */
                    .spinner {
                        width: 14px;
                        height: 14px;
                        border: 2px solid rgba(45, 45, 45, 0.25);
                        border-top-color: currentColor;
                        border-radius: 50%;
                        animation: spin 0.8s linear infinite;
                        display: inline-block;
                    }

                    @keyframes spin {
                        to { transform: rotate(360deg); }
                    }
                </style>

                <div class="widget-container">
                    <!-- Popover Panel -->
                    <div class="popover-panel" id="panel">
                        <div class="tape-strip"></div>
                        <div class="panel-header">
                            <div class="panel-title">
                                <span id="panelTitleIcon">${SKETCH_ICONS.lightning}</span>
                                <span id="panelTitleText">MangaStream AI</span>
                            </div>
                            <div class="header-actions">
                                <button type="button" class="gear-btn" id="gearBtn" title="Cài đặt API">${SKETCH_ICONS.gear}</button>
                                <button type="button" class="close-btn" id="closeBtn" title="Thu nhỏ">${SKETCH_ICONS.close}</button>
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
                                        <button type="button" class="mode-tab active" id="tabOcrTrans" title="Bóc chữ bằng Manga-OCR/RapidOCR trước rồi dịch">
                                            ${SKETCH_ICONS.lightning}
                                            <span>OCR & Dịch</span>
                                        </button>
                                        <button type="button" class="mode-tab" id="tabImageTrans" title="Gửi toàn ảnh kèm đánh số Set-of-Mark">
                                            ${SKETCH_ICONS.image}
                                            <span>Ảnh & Vision</span>
                                        </button>
                                    </div>
                                    <!-- OCR ENGINE SELECTOR (CHO OCR_TRANS) -->
                                    <div class="sub-providers-row" id="ocrEngineRow" style="margin-top: 4px;">
                                        <button type="button" class="sub-pill active" data-ocr="manga_ocr" title="Manga-OCR: Chuyên bóc Manga tiếng Nhật">Nhật [JA]</button>
                                        <button type="button" class="sub-pill" data-ocr="rapid_ocr_en" title="RapidOCR: Chuyên Comic tiếng Anh & Latinh">Anh [EN]</button>
                                        <button type="button" class="sub-pill" data-ocr="rapid_ocr_ch" title="RapidOCR: Chuyên Manhua tiếng Trung">Trung [ZH]</button>
                                    </div>
                                    <!-- AUTO DETECT STATUS & MANUAL OVERRIDE BAR -->
                                    <div id="ocrAutoDetectBar" style="margin-top: 2px;">
                                        <span id="ocrAutoDetectText" style="color: #444444; font-weight: 600;">Auto: BẬT</span>
                                        <button type="button" id="btnToggleAutoLang">Tắt</button>
                                    </div>
                                    <div class="sub-providers-row" id="subProvidersRow" style="margin-top: 4px;">
                                        <button type="button" class="sub-pill active" data-prov="google" title="Google Translate (Miễn phí)">Google</button>
                                        <button type="button" class="sub-pill" data-prov="llm_text" title="Gửi text thuần lên LLM">LLM Text</button>
                                        <button type="button" class="sub-pill" data-prov="raw" title="Giữ nguyên chữ gốc">Raw Gốc</button>
                                    </div>
                                </div>

                                <button type="button" class="btn-action btn-translate" id="btnTranslate">
                                    <span id="btnTranslateIcon">${SKETCH_ICONS.translate}</span>
                                    <span id="btnTranslateText">Dịch Chapter Này</span>
                                </button>

                                <button type="button" class="btn-action btn-toggle active" id="btnToggleOverlay">
                                    <span id="btnToggleIcon">${SKETCH_ICONS.eye}</span>
                                    <span id="btnToggleText">Hiển thị bản dịch (Phím T)</span>
                                </button>

                                <div class="control-group">
                                    <div class="control-header">
                                        <span>Độ mờ bong bóng</span>
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
                                        <span>Hồ sơ & Model AI (Profiles):</span>
                                    </div>
                                    <div class="presets-pills" id="presetsPills">
                                        <!-- Render động từ config.profiles -->
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
                                        <button type="button" class="btn-eye" id="btnEyeKey" title="Hiện/ẩn key">${SKETCH_ICONS.eye}</button>
                                    </div>
                                </div>

                                <div class="status-msg-badge" id="cfgBadge"></div>

                                <button type="button" class="btn-action btn-test-cfg" id="btnTestCfg">
                                    <span id="testCfgIcon">${SKETCH_ICONS.flask}</span>
                                    <span id="testCfgText">Kiểm Tra API</span>
                                </button>

                                <button type="button" class="btn-action btn-save-cfg" id="btnSaveCfg">
                                    <span id="saveCfgIcon">${SKETCH_ICONS.save}</span>
                                    <span id="saveCfgText">Lưu & Đồng Bộ</span>
                                </button>

                                <button type="button" class="btn-action btn-toggle" id="btnBackToMain">
                                    <span>${SKETCH_ICONS.arrowLeft}</span>
                                    <span>Quay Lại Bảng Điều Khiển</span>
                                </button>
                            </div>
                        </div>

                        <div class="panel-footer">
                            <a href="http://127.0.0.1:8765/" target="_blank" class="link-btn" id="linkWebReader">
                                ${SKETCH_ICONS.book}
                                <span>Web Reader</span>
                            </a>
                            <a href="http://127.0.0.1:8765/settings" target="_blank" class="link-btn" id="linkWebSettings">
                                ${SKETCH_ICONS.gear}
                                <span>Server Web</span>
                            </a>
                        </div>
                    </div>

                    <!-- Floating Action Button -->
                    <div class="fab-button" id="fabButton" title="MangaStream AI Menu">
                        ${SKETCH_ICONS.lightning}
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

            // 1.5. Chuyển đổi Pipeline, OCR Engine và Provider Dịch Thuật
            const tabOcrTrans = root.getElementById('tabOcrTrans');
            const tabImageTrans = root.getElementById('tabImageTrans');
            const ocrEngineRow = root.getElementById('ocrEngineRow');
            const ocrAutoDetectBar = root.getElementById('ocrAutoDetectBar');
            const ocrAutoDetectText = root.getElementById('ocrAutoDetectText');
            const btnToggleAutoLang = root.getElementById('btnToggleAutoLang');
            const subProvidersRow = root.getElementById('subProvidersRow');
            const ocrPills = root.querySelectorAll('#ocrEngineRow .sub-pill');
            const subPills = root.querySelectorAll('#subProvidersRow .sub-pill');

            const renderModeSwitcher = () => {
                const isOcr = State.selectedPipeline === 'ocr_trans';
                if (tabOcrTrans) tabOcrTrans.classList.toggle('active', isOcr);
                if (tabImageTrans) tabImageTrans.classList.toggle('active', !isOcr);
                if (ocrEngineRow) ocrEngineRow.style.display = isOcr ? 'flex' : 'none';
                if (ocrAutoDetectBar) ocrAutoDetectBar.style.display = isOcr ? 'flex' : 'none';
                if (subProvidersRow) subProvidersRow.style.display = isOcr ? 'flex' : 'none';

                ocrPills.forEach(p => {
                    p.classList.toggle('active', p.getAttribute('data-ocr') === State.selectedOcrEngine);
                });

                subPills.forEach(p => {
                    p.classList.toggle('active', p.getAttribute('data-prov') === State.selectedProvider);
                });

                if (ocrAutoDetectText && btnToggleAutoLang) {
                    if (State.isManualOverride) {
                        ocrAutoDetectText.innerHTML = `<span style="color:#b45309; font-weight:700;">Khóa thủ công</span>`;
                        btnToggleAutoLang.textContent = '↺ Auto';
                        btnToggleAutoLang.title = 'Khôi phục tự động nhận diện theo MangaDex';
                    } else if (State.autoDetectLang) {
                        const langBadge = State.detectedLang ? `[${State.detectedLang.toUpperCase()}]` : '';
                        ocrAutoDetectText.innerHTML = `Auto: <span style="color:#15803d; font-weight:700;">BẬT ${langBadge}</span>`;
                        btnToggleAutoLang.textContent = 'Tắt';
                        btnToggleAutoLang.title = 'Tắt tự động nhận diện ngôn ngữ';
                    } else {
                        ocrAutoDetectText.innerHTML = `Auto: <span style="color:#71717a; font-weight:700;">TẮT</span>`;
                        btnToggleAutoLang.textContent = 'Bật';
                        btnToggleAutoLang.title = 'Bật tự động nhận diện ngôn ngữ';
                    }
                }
            };
            this.renderModeSwitcher = renderModeSwitcher;

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

            ocrPills.forEach(p => {
                p.addEventListener('click', (e) => {
                    e.stopPropagation();
                    State.selectedOcrEngine = p.getAttribute('data-ocr');
                    localStorage.setItem('md_selected_ocr_engine', State.selectedOcrEngine);
                    State.isManualOverride = true; // Khóa thủ công, loại trừ khi MangaDex tag nhầm nhãn
                    renderModeSwitcher();
                });
            });

            if (btnToggleAutoLang) {
                btnToggleAutoLang.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (State.isManualOverride) {
                        State.isManualOverride = false;
                        App.detectAndApplyChapterLanguage(State.currentChapterId);
                    } else {
                        State.autoDetectLang = !State.autoDetectLang;
                        localStorage.setItem('md_auto_detect_lang', State.autoDetectLang.toString());
                        if (State.autoDetectLang) {
                            App.detectAndApplyChapterLanguage(State.currentChapterId);
                        }
                    }
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
            const panelTitleIcon = root.getElementById('panelTitleIcon');
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

            const showView = (viewName) => {
                if (viewName === 'settings') {
                    State.isSettingsView = true;
                    mainView.classList.add('hidden');
                    settingsView.classList.remove('hidden');
                    gearBtn.classList.add('active');
                    setSafeHTML(panelTitleIcon, SKETCH_ICONS.gear);
                    panelTitleText.textContent = 'Cài Đặt API';
                    this.loadSettingsForm();
                } else {
                    State.isSettingsView = false;
                    settingsView.classList.add('hidden');
                    mainView.classList.remove('hidden');
                    gearBtn.classList.remove('active');
                    setSafeHTML(panelTitleIcon, SKETCH_ICONS.lightning);
                    panelTitleText.textContent = 'MangaStream AI';
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
                setSafeHTML(btnEyeKey, isPass ? SKETCH_ICONS.eyeOff : SKETCH_ICONS.eye);
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
                setSafeHTML(testCfgIcon, '<div class="spinner"></div>');
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
                        this.showSettingsBadge('success', `Kết nối thành công (${latency}ms)! Model phản hồi: "${testRes.reply || 'OK'}"`);
                    } else {
                        this.showSettingsBadge('error', `Kiểm tra thất bại: ${testRes.message || 'Lỗi API'}`);
                    }
                } catch (err) {
                    this.showSettingsBadge('error', `Lỗi kết nối máy chủ local: ${err.message}`);
                } finally {
                    btnTestCfg.disabled = false;
                    setSafeHTML(testCfgIcon, SKETCH_ICONS.flask);
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
                setSafeHTML(saveCfgIcon, '<div class="spinner"></div>');
                saveCfgText.textContent = 'Đang lưu...';
                this.hideSettingsBadge();

                try {
                    const saveRes = await apiRequest('/api/config', 'POST', {
                        base_url: baseUrl,
                        api_key: apiKey,
                        model: model,
                        return_full: true
                    });

                    if (saveRes.ok) {
                        this.showSettingsBadge('success', 'Đã lưu cấu hình và đồng bộ với Server thành công!');
                        this.loadSettingsForm();
                        setTimeout(() => {
                            showView('main');
                            this.hideSettingsBadge();
                        }, 1200);
                    } else {
                        this.showSettingsBadge('error', `Lỗi lưu cấu hình: ${saveRes.message || 'Lỗi server'}`);
                    }
                } catch (err) {
                    this.showSettingsBadge('info', 'Đã lưu URL server vào Extension. (Không gửi được lên Server backend)');
                } finally {
                    btnSaveCfg.disabled = false;
                    setSafeHTML(saveCfgIcon, SKETCH_ICONS.save);
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
            const presetsPills = root.getElementById('presetsPills');

            cfgServerUrl.value = CONFIG.SERVER_URL;

            try {
                const configData = await apiRequest('/api/config?full=1');
                if (configData) {
                    if (configData.base_url) cfgBaseUrl.value = configData.base_url;
                    if (configData.model) cfgModel.value = configData.model;
                    if (configData.api_key) cfgApiKey.value = configData.api_key;

                    // Render dynamic profile pills
                    if (presetsPills && configData.profiles) {
                        presetsPills.replaceChildren();
                        const activeId = configData.active_profile || 'xkiro_qwen';

                        for (const [pid, prof] of Object.entries(configData.profiles)) {
                            const pill = document.createElement('button');
                            pill.type = 'button';
                            pill.className = `preset-pill ${pid === activeId ? 'active' : ''}`;
                            pill.setAttribute('data-profile-id', pid);
                            const hasKeyLabel = (prof.has_key || Boolean(prof.api_key && prof.api_key.trim())) ? '[Key]' : '[Chưa có Key]';
                            pill.textContent = `${prof.name || pid} ${hasKeyLabel}`;
                            pill.title = `${prof.model || ''} (${prof.base_url || ''})`;

                            pill.addEventListener('click', async (e) => {
                                e.stopPropagation();
                                presetsPills.querySelectorAll('.preset-pill').forEach(p => p.classList.remove('active'));
                                pill.classList.add('active');

                                try {
                                    const switchRes = await apiRequest('/api/config', 'POST', {
                                        action: 'switch_profile',
                                        profile_id: pid,
                                        return_full: true
                                    });
                                    if (switchRes && switchRes.ok && switchRes.config) {
                                        const newProf = switchRes.config.profiles[pid];
                                        if (newProf) {
                                            cfgBaseUrl.value = newProf.base_url || '';
                                            cfgModel.value = newProf.model || '';
                                            cfgApiKey.value = newProf.api_key || '';
                                        }
                                        this.showSettingsBadge('success', `Đã chuyển sang: ${prof.name}`);
                                    }
                                } catch (err) {
                                    console.warn('[MangaOverlay] Lỗi chuyển profile:', err);
                                    cfgBaseUrl.value = prof.base_url || '';
                                    cfgModel.value = prof.model || '';
                                    cfgApiKey.value = prof.api_key || '';
                                }
                            });

                            presetsPills.appendChild(pill);
                        }
                    }
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
                setSafeHTML(btnIcon, '<div class="spinner"></div>');
                btnText.textContent = `Đang dịch (${info.completedPages || 0}/${info.totalPages || '?'})`;

                progressContainer.style.display = 'block';
                const pct = info.totalPages > 0 ? (info.completedPages / info.totalPages) * 100 : 30;
                progressBar.style.width = `${pct}%`;
                progressText.textContent = `Đang xử lý ${info.completedPages || 0}/${info.totalPages || '?'} trang`;
            } else if (info.hasTranslation) {
                this.updateStatus('ready', 'Đã có bản dịch');
                btnTranslate.disabled = false;
                setSafeHTML(btnIcon, SKETCH_ICONS.refresh);
                btnText.textContent = 'Dịch lại Chapter';

                progressContainer.style.display = 'none';
                progressText.textContent = `Đã có (${info.pageCount} trang)`;
            } else {
                this.updateStatus('connected', 'Chưa có bản dịch');
                btnTranslate.disabled = false;
                setSafeHTML(btnIcon, SKETCH_ICONS.translate);
                btnText.textContent = 'Dịch Chapter Này';

                progressContainer.style.display = 'none';
                progressText.textContent = 'Chưa dịch';
            }
        }

        updateToggleOverlayButton(isVisible) {
            const root = this.shadowRoot;
            if (!root) return;
            const btn = root.getElementById('btnToggleOverlay');
            const icon = root.getElementById('btnToggleIcon');
            const text = root.getElementById('btnToggleText');
            if (isVisible) {
                btn.classList.add('active');
                if (icon) setSafeHTML(icon, SKETCH_ICONS.eye);
                if (text) text.textContent = 'Hiển thị bản dịch (Phím T)';
            } else {
                btn.classList.remove('active');
                if (icon) setSafeHTML(icon, SKETCH_ICONS.eyeOff);
                if (text) text.textContent = 'Đã ẩn bản dịch (Phím T)';
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
                        img.__updateOverlayPos(true);
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
            if (!img.complete || img.naturalWidth === 0) {
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
            let lastFontScale = State.fontScale;

            const updatePositions = (forceRedraw = false) => {
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
                    requestAnimationFrame(() => updatePositions(forceRedraw));
                    return;
                }

                // Đảm bảo parent giữ position: relative
                if (parent && window.getComputedStyle(parent).position === 'static') {
                    parent.style.setProperty('position', 'relative', 'important');
                }

                // 1. TÍNH TOÁN KHUNG HÌNH VẼ THỰC TẾ (BÙ TRỪ OBJECT-FIT: CONTAIN / SCALE-DOWN CỦA MANGADEX)
                // MangaDex thường dùng object-fit: contain hoặc max-height: 100vh làm phát sinh dải đen/khoảng trống (letterbox/pillarbox)
                const compStyle = window.getComputedStyle(img);
                const objFit = compStyle.objectFit;
                const natW = img.naturalWidth || 1;
                const natH = img.naturalHeight || 1;

                let renderW = currentW;
                let renderH = currentH;
                let offsetX = 0;
                let offsetY = 0;

                if (objFit === 'contain' || objFit === 'scale-down') {
                    const imgRatio = natW / natH;
                    const elemRatio = currentW / currentH;
                    if (elemRatio > imgRatio) {
                        // Pillarbox: Thừa khoảng trống 2 bên trái/phải -> ảnh bị co hẹp vào giữa
                        renderH = currentH;
                        renderW = currentH * imgRatio;
                        offsetX = (currentW - renderW) / 2;
                    } else {
                        // Letterbox: Thừa khoảng trống trên/dưới -> ảnh bị co hẹp theo chiều dọc
                        renderW = currentW;
                        renderH = currentW / imgRatio;
                        offsetY = (currentH - renderH) / 2;
                    }
                }

                // 2. ĐỊNH VỊ CHÍNH XÁC TUYỆT ĐỐI (DETERMINISTIC ZERO-DRIFT POSITIONING)
                // Tính toán trực tiếp theo tọa độ viewport của img và parent, loại bỏ 100% hiện tượng trôi dạt do cộng dồn delta
                const pRect = parent.getBoundingClientRect();
                const exactLeft = (imgRect.left - pRect.left - (parent.clientLeft || 0) + parent.scrollLeft) + offsetX;
                const exactTop = (imgRect.top - pRect.top - (parent.clientTop || 0) + parent.scrollTop) + offsetY;

                container.style.left = `${exactLeft}px`;
                container.style.top = `${exactTop}px`;
                container.style.width = `${renderW}px`;
                container.style.height = `${renderH}px`;

                // Nếu kích thước và tỷ lệ font không thay đổi đáng kể và đã có bubbles, không cần dựng lại DOM
                if (!forceRedraw &&
                    Math.abs(renderW - lastRenderedW) < 2 &&
                    Math.abs(renderH - lastRenderedH) < 2 &&
                    Math.abs(State.fontScale - lastFontScale) < 0.01 &&
                    container.children.length > 0) {
                    return;
                }

                lastRenderedW = renderW;
                lastRenderedH = renderH;
                lastFontScale = State.fontScale;

                container.replaceChildren();

                // 3. TỈ LỆ CO GIÃN THEO TRANH VẼ GỐC
                const origW = pageData.resolution ? parseInt(pageData.resolution.split('x')[0], 10) : natW;
                const origH = pageData.resolution ? parseInt(pageData.resolution.split('x')[1], 10) : natH;

                const scaleX = renderW / origW;
                const scaleY = renderH / origH;

                pageData.bubbles.forEach((b) => {
                    if (!b.vi || b.vi.trim() === '') return;

                    const [bx, by, bw, bh] = b.box;
                    let bLeft = bx * scaleX;
                    let bTop = by * scaleY;
                    let bWidth = bw * scaleX;
                    let bHeight = bh * scaleY;

                    // Giới hạn bong bóng tuyệt đối nằm trong khung tranh
                    if (bLeft < 0) { bWidth += bLeft; bLeft = 0; }
                    if (bTop < 0) { bHeight += bTop; bTop = 0; }
                    if (bLeft + bWidth > renderW) { bWidth = Math.max(12, renderW - bLeft); }
                    if (bTop + bHeight > renderH) { bHeight = Math.max(12, renderH - bTop); }

                    const bubble = document.createElement('div');
                    bubble.className = 'md-speech-bubble';

                    Object.assign(bubble.style, {
                        position: 'absolute',
                        left: `${bLeft}px`,
                        top: `${bTop}px`,
                        width: `${bWidth}px`,
                        height: `${bHeight}px`,
                        backgroundColor: `rgba(253, 251, 247, ${State.bubbleOpacity})`,
                        color: '#2d2d2d',
                        borderRadius: '6px',
                        border: '1.5px solid #2d2d2d',
                        padding: '2px 4px',
                        boxSizing: 'border-box',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        textAlign: 'center',
                        fontFamily: "'Patrick Hand', 'Comic Neue', 'Kalam', cursive, sans-serif",
                        fontWeight: '600',
                        lineHeight: '1.15',
                        wordBreak: 'break-word',
                        overflowWrap: 'break-word',
                        overflow: 'hidden',
                        pointerEvents: State.isOverlayVisible ? 'auto' : 'none',
                        opacity: State.isOverlayVisible ? '1' : '0',
                        transition: 'opacity 0.2s ease, background-color 0.2s ease',
                        boxShadow: '2px 2px 0px rgba(45, 45, 45, 0.25)',
                        cursor: 'help',
                    });

                    // 4. TỰ ĐỘNG CĂN CHỈNH VÀ THU NHỎ FONT (DYNAMIC AUTO-FIT) ĐỂ TRÁNH TRÀN CHỮ RA NGOÀI BÓNG THOẠI
                    const usableArea = Math.max(10, bWidth - 4) * Math.max(10, bHeight - 4);
                    const textLen = Math.max(1, b.vi.length);
                    let fontSize = Math.max(8, Math.min(22, Math.sqrt(usableArea / (textLen * 1.5)) * State.fontScale));
                    bubble.style.fontSize = `${fontSize.toFixed(1)}px`;
                    bubble.textContent = b.vi;
                    bubble.title = `[Bản dịch #${b.id}]\n${b.vi}\n\n[Gốc]: ${b.raw || '(không có)'}\n(Click để sao chép bản dịch)`;

                    container.appendChild(bubble);

                    // Tự động thu nhỏ font nếu văn bản bị tràn box
                    let shrinkTries = 0;
                    while ((bubble.scrollHeight > bubble.clientHeight || bubble.scrollWidth > bubble.clientWidth) && fontSize > 7 && shrinkTries < 5) {
                        fontSize = Math.max(7, fontSize * 0.88);
                        bubble.style.fontSize = `${fontSize.toFixed(1)}px`;
                        shrinkTries++;
                    }

                    bubble.addEventListener('click', (e) => {
                        e.stopPropagation();
                        navigator.clipboard.writeText(b.vi);
                        bubble.style.backgroundColor = 'rgba(220, 252, 231, 0.95)';
                        setTimeout(() => {
                            bubble.style.backgroundColor = `rgba(253, 251, 247, ${State.bubbleOpacity})`;
                        }, 400);
                    });
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
                el.style.backgroundColor = `rgba(253, 251, 247, ${State.bubbleOpacity})`;
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
            State.isManualOverride = false; // Reset khóa thủ công khi sang chapter mới
            Engine.clearAll();

            UI.updateStatus('connected', `ID: ${chapterId.slice(0, 8)}...`);
            await this.detectAndApplyChapterLanguage(chapterId);
            await this.checkChapterStatus(chapterId);
        },

        async detectAndApplyChapterLanguage(chapterId) {
            if (!chapterId || !State.autoDetectLang || State.isManualOverride) return;
            try {
                let lang = null;
                // Ưu tiên truy vấn qua backend local (có cache & tránh CORS)
                try {
                    const info = await apiRequest(`/api/chapter-info?id=${chapterId}`);
                    if (info && info.ok && info.metadata && info.metadata.lang) {
                        lang = info.metadata.lang.toLowerCase();
                    }
                } catch (e) {}

                // Fallback nếu server chưa phản hồi: gọi thẳng MangaDex API
                if (!lang) {
                    try {
                        const mdRes = await fetch(`https://api.mangadex.org/chapter/${chapterId}`);
                        if (mdRes.ok) {
                            const mdData = await mdRes.json();
                            lang = (mdData.data?.attributes?.translatedLanguage || '').toLowerCase();
                        }
                    } catch (e) {}
                }

                if (lang) {
                    State.detectedLang = lang;
                    if (lang === 'ja') {
                        State.selectedOcrEngine = 'manga_ocr';
                    } else if (lang.startsWith('zh')) {
                        State.selectedOcrEngine = 'rapid_ocr_ch';
                    } else {
                        State.selectedOcrEngine = 'rapid_ocr_en';
                    }
                    localStorage.setItem('md_selected_ocr_engine', State.selectedOcrEngine);
                    if (UI.renderModeSwitcher) UI.renderModeSwitcher();
                }
            } catch (err) {
                console.warn('[MangaOverlay] Không thể tự động nhận diện ngôn ngữ:', err);
            }
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
                    translation_provider: State.selectedPipeline === 'image_trans' ? 'vision_llm' : (State.selectedProvider || 'google'),
                    ocr_engine: State.selectedOcrEngine || 'manga_ocr'
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
            document.querySelectorAll('img').forEach((img) => {
                if (typeof img.__updateOverlayPos === 'function') {
                    img.__updateOverlayPos(true);
                }
            });
        },
    };

    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand('Dịch Chapter Hiện Tại', () => App.triggerManualTranslation());
        GM_registerMenuCommand('Bật/Tắt Lớp Phủ (Phím T)', () => App.toggleOverlay());
        GM_registerMenuCommand('Mở Local Web Reader', () => window.open(`${CONFIG.SERVER_URL}/`, '_blank'));
        GM_registerMenuCommand('Cài Đặt API & Máy Chủ', () => window.open(`${CONFIG.SERVER_URL}/settings`, '_blank'));
    }

    App.init();
})();
