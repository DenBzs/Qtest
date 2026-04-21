/**
 * Quick-Persona-List
 * ⚠️ Extension-QuickPersona와 동시 사용 불가
 */

import { animation_duration, eventSource, event_types, getThumbnailUrl } from '../../../../script.js';
import { power_user } from '../../../power-user.js';
import { getUserAvatar, getUserAvatars, setUserAvatar, user_avatar } from '../../../personas.js';
import { Popper } from '../../../../lib.js';

const MODULE_NAME = 'Quick-Persona-List';
const supportsPersonaThumbnails = getThumbnailUrl('persona', 'test.png', true).includes('&t=');

// ─── 테마 ──────────────────────────────────────────────────────────────────────
const QPL_THEMES = {
    dark:     { label:'🖤', name:'다크',    bg:'#23233a', border:'#3a3a58', text:'#dcdaf0', sub:'#1a1a2e', accent:'#7a70c0', muted:'#9890c8' },
    white:    { label:'🤍', name:'화이트',  bg:'#ffffff', border:'#e0e0e0', text:'#222222', sub:'#f2f2f2', accent:'#7878c0', muted:'#aaaacc' },
    classic:  { label:'🤎', name:'클래식',  bg:'#f5f0e8', border:'#d8d0c4', text:'#2a2520', sub:'#ede7db', accent:'#8a7a60', muted:'#a09080' },
    pink:     { label:'🩷', name:'핑크',    bg:'#fff5f8', border:'#f0cfe0', text:'#3c1830', sub:'#fde8f2', accent:'#cc6890', muted:'#e0a0bc' },
    green:    { label:'💚', name:'그린',    bg:'#f4fbf6', border:'#c8e8d0', text:'#1a3022', sub:'#e4f5ea', accent:'#4a9060', muted:'#78b890' },
    sky:      { label:'🩵', name:'스카이',  bg:'#f8feff', border:'#c4e8f8', text:'#143450', sub:'#edf9ff', accent:'#4890c8', muted:'#78b0d8' },
    lavender: { label:'💜', name:'라벤더',  bg:'#f8f5ff', border:'#d8cef0', text:'#2c2448', sub:'#ede8f8', accent:'#8868c0', muted:'#b098d8' },
};

function getQplTheme() {
    try {
        const s = SillyTavern.getContext().extensionSettings[MODULE_NAME];
        return QPL_THEMES[s?.theme] ? s.theme : 'lavender';
    } catch { return 'lavender'; }
}

function setQplTheme(key) {
    try {
        SillyTavern.getContext().extensionSettings[MODULE_NAME].theme = key;
        saveSettings();
    } catch {}
    applyQplTheme(key);
}

function applyQplTheme(key) {
    const t = QPL_THEMES[key] || QPL_THEMES.lavender;
    const menu = document.getElementById('qplMenu');
    if (!menu) return;
    menu.style.background = t.bg;
    menu.style.borderColor = t.border;
    menu.style.color = t.text;
    // CSS 변수로 accent 설정 → .qpl-view-btn.active, .qpl-tag, .qpl-char-btn.has-data 등이 자동 적용
    menu.style.setProperty('--qpl-accent', t.accent);
    // header border + background
    const header = menu.querySelector('.qpl-header');
    if (header) {
        header.style.borderBottomColor = t.border;
        header.style.backgroundColor   = t.sub;
    }
    // 핀 버튼 active → accent 색 (CSS var 미지원 구형 방어)
    menu.querySelectorAll('.qpl-pin-btn.active').forEach(btn => {
        btn.style.color = t.accent;
    });
    // hint border
    const hint = menu.querySelector('.qpl-hint');
    if (hint) hint.style.borderTopColor = t.border;
    menu.dataset.theme = key;
    // done-btn
    const doneBtn = menu.querySelector('.qpl-done-btn');
    if (doneBtn) {
        doneBtn.style.background    = t.accent + '22';
        doneBtn.style.borderColor   = t.accent + '99';
        doneBtn.style.color         = t.accent;
    }
    // theme bar buttons
    menu.querySelectorAll('.qpl-theme-btn').forEach(btn => {
        const active = btn.dataset.theme === key;
        btn.style.opacity   = active ? '1' : '0.4';
        btn.style.transform = active ? 'scale(1.2)' : 'scale(1)';
    });
    // active row 배경 갱신
    menu.querySelectorAll('.qpl-row.qpl-active').forEach(row => {
        row.style.background = t.accent + '18';
        row.style.setProperty('--qpl-active-bar', t.accent);
    });
}

/** @type {Popper.Instance|null} */
let popper = null;
let isOpen = false;
let _isOpening = false; // openMenu 중복 호출 방지용 [fix-8]
let currentView = 'all'; // 'all' | 'fav' | 'char'
let _allAvatars  = [];    // openMenu에서 캐시, 뷰 전환 시 재사용

// ─── Settings ─────────────────────────────────────────────────────────────────
function getSettings() {
    const ctx = SillyTavern.getContext();
    if (!ctx.extensionSettings[MODULE_NAME]) {
        ctx.extensionSettings[MODULE_NAME] = { favorites: [], customOrder: null, charPersonas: {} };
    }
    const s = ctx.extensionSettings[MODULE_NAME];
    if (!Array.isArray(s.favorites)) s.favorites = [];
    if (s.customOrder !== null && !Array.isArray(s.customOrder)) s.customOrder = null;
    if (!s.charPersonas || typeof s.charPersonas !== 'object' || Array.isArray(s.charPersonas)) s.charPersonas = {};
    return s;
}

function saveSettings() { SillyTavern.getContext().saveSettingsDebounced(); }
function isFavorite(id) { return getSettings().favorites.includes(id); }

function toggleFavorite(avatarId) {
    const s = getSettings();
    const idx = s.favorites.indexOf(avatarId);
    if (idx >= 0) {
        s.favorites.splice(idx, 1);
        if (Array.isArray(s.customOrder)) s.customOrder = s.customOrder.filter(id => id !== avatarId);
    } else {
        s.favorites.push(avatarId);
        if (Array.isArray(s.customOrder)) s.customOrder.push(avatarId);
    }
    saveSettings();
}

// ─── 정렬 ─────────────────────────────────────────────────────────────────────
function getSortedFavorites(allAvatars) {
    const s = getSettings();
    const favSet = new Set(s.favorites);
    const favAvatars = allAvatars.filter(id => favSet.has(id));
    if (Array.isArray(s.customOrder)) {
        const order = s.customOrder;
        return [
            ...order.filter(id => favSet.has(id)),
            ...favAvatars.filter(id => !order.includes(id)),
        ];
    }
    // 기본: 이름순
    return favAvatars.sort((a, b) => {
        const na = (power_user.personas?.[a] || a).toLowerCase();
        const nb = (power_user.personas?.[b] || b).toLowerCase();
        return na.localeCompare(nb, 'ko');
    });
}

function saveCustomOrder(orderIds) {
    const s = getSettings();
    s.customOrder = [...orderIds];
    saveSettings();
}

// ─── 채팅 고정 ─────────────────────────────────────────────────────────────────
function getLockedPersona() {
    try { return SillyTavern.getContext().chatMetadata?.['persona'] ?? null; }
    catch { return null; }
}

async function toggleChatLock(avatarId) {
    try {
        const ctx = SillyTavern.getContext();
        const meta = ctx.chatMetadata;
        if (!meta) { toastr.warning('채팅이 열려있지 않습니다.'); return; }
        const isLocked = meta['persona'] === avatarId;
        if (isLocked) {
            delete meta['persona'];
            toastr.info('채팅방 페르소나 고정을 해제했습니다.');
        } else {
            meta['persona'] = avatarId;
            await setUserAvatar(avatarId);
            toastr.success(`"${power_user.personas?.[avatarId] || avatarId}"을(를) 이 채팅방에 고정했습니다.`);
        }
        if (typeof ctx.saveMetadata === 'function') await ctx.saveMetadata();
        updateButtonState();
        refreshPinButtons();
    } catch (err) {
        console.error('[Quick-Persona-List] 채팅 고정 오류:', err);
        toastr.error('채팅 고정에 실패했습니다.');
    }
}

// 메뉴 내 모든 핀 버튼 상태 갱신
function refreshPinButtons() {
    const locked = getLockedPersona();
    const t = QPL_THEMES[getQplTheme()] || QPL_THEMES.lavender;
    $('#qplMenu .qpl-row[data-avatar]').each(function () {
        const avatarId = $(this).attr('data-avatar');
        const isLocked = locked === avatarId;
        const $btn = $(this).find('.qpl-pin-btn');
        if (!$btn.length) return;
        $btn.toggleClass('active', isLocked)
            .css('color', isLocked ? t.accent : '')
            .attr('title', isLocked ? '채팅방 고정 해제' : '현재 채팅방에 고정')
            .find('i').attr('class', `fa-${isLocked ? 'solid' : 'regular'} fa-thumbtack`);
    });
    // 상세 패널 핀 버튼도 동기화
    const $detailPinBtn = $('#qplMenu .qpl-detail-inner .qpl-detail-pin-btn');
    if ($detailPinBtn.length) {
        const detailId = $('#qplMenu .qpl-detail-inner').attr('data-avatar');
        if (detailId) {
            const isLocked = locked === detailId;
            $detailPinBtn.toggleClass('active', isLocked)
                .attr('title', isLocked ? '채팅방 고정 해제' : '현재 채팅방에 고정')
                .find('i').attr('class', `fa-${isLocked ? 'solid' : 'regular'} fa-square-check`);
        }
    }
}

// ─── 캐릭터 × 페르소나 연결 ─────────────────────────────────────────────────────
function getCurrentCharId() {
    try {
        const ctx = SillyTavern.getContext();
        return ctx.characters?.[ctx.characterId]?.avatar ?? null;
    } catch { return null; }
}

function getCharPersonas(charId) {
    if (!charId) return [];
    const s = getSettings();
    return Array.isArray(s.charPersonas[charId]) ? [...s.charPersonas[charId]] : [];
}

function isCharPersona(charId, avatarId) {
    return getCharPersonas(charId).includes(avatarId);
}

function toggleCharPersona(charId, avatarId) {
    if (!charId) { toastr.warning('현재 캐릭터를 찾을 수 없습니다.'); return; }
    const s = getSettings();
    if (!Array.isArray(s.charPersonas[charId])) s.charPersonas[charId] = [];
    const arr = s.charPersonas[charId];
    const idx = arr.indexOf(avatarId);
    if (idx >= 0) arr.splice(idx, 1);
    else arr.push(avatarId);
    // 빈 배열이 되면 키 삭제
    if (arr.length === 0) delete s.charPersonas[charId];
    saveSettings();
}

// 캐릭터 뷰 버튼 활성 여부 갱신
function refreshCharViewBtn() {
    const charId = getCurrentCharId();
    const has = charId ? getCharPersonas(charId).length > 0 : false;
    $('#qplMenu .qpl-char-btn').toggleClass('has-data', has);
}


function getImageUrl(avatarId) {
    if (supportsPersonaThumbnails) return getThumbnailUrl('persona', avatarId, true);
    return getUserAvatar(avatarId);
}

// ─── 하단 버튼 ─────────────────────────────────────────────────────────────────
function addQuickPersonaButton() {
    if ($('#qplBtn').length) return;
    const $c = $('#leftSendForm').length ? $('#leftSendForm')
        : $('#send_form').length ? $('#send_form')
        : $('form#send_form, .sendForm, #form_sheld').first();
    if (!$c.length) { setTimeout(addQuickPersonaButton, 1000); return; }
    $c.append(`
        <div id="qplBtn" tabindex="0" title="페르소나 목록 열기">
            <img id="qplBtnImg" src="/img/ai4.png" alt="persona" />
        </div>
    `);
    $('#qplBtn').on('click', () => toggleMenu());
}

// [fix-7] setTimeout 중복 누적 방지: debounce 패턴으로 교체
let _updateButtonTimer = null;
function updateButtonState() {
    clearTimeout(_updateButtonTimer);
    _updateButtonTimer = setTimeout(() => {
        const name  = power_user.personas?.[user_avatar] || user_avatar;
        const title = power_user.persona_descriptions?.[user_avatar]?.title || '';
        const url   = getImageUrl(user_avatar);
        $('#qplBtnImg').attr('src', url).attr('title', title ? `${name} — ${title}` : name);
        const locked = getLockedPersona();
        $('#qplBtn').toggleClass('qpl-locked', !!locked && locked === user_avatar);
    }, 100);
}

async function toggleMenu() {
    if (isOpen) closeMenu(); else await openMenu();
}

async function openMenu() {
    if (_isOpening) return;
    _isOpening = true;
    isOpen = true;
    currentView = 'detail';

    $('#qplMenu').stop(true, true).remove();
    if (popper) { popper.destroy(); popper = null; }

    try {
        _allAvatars = await getUserAvatars(false);
        const s       = getSettings();
        const hasFavs = s.favorites.length > 0;
        const charId  = getCurrentCharId();
        const charPs  = getCharPersonas(charId);

        const curTheme = getQplTheme();
        const initT    = QPL_THEMES[curTheme] || QPL_THEMES.lavender;

        const $menu = $(`
            <div id="qplMenu" style="--qpl-accent:${initT.accent}">
                <div class="qpl-header">
                    <span class="qpl-header-title">🎭 페르소나Q</span>
                    <div class="qpl-header-actions">
                        <button class="qpl-view-btn qpl-detail-btn active" title="현재 페르소나 정보">
                            <i class="fa-solid fa-id-card"></i>
                        </button>
                        <button class="qpl-view-btn qpl-all-btn" title="전체 목록">
                            <i class="fa-solid fa-masks-theater"></i>
                        </button>
                        <button class="qpl-view-btn qpl-fav-btn" title="즐겨찾기 목록">
                            <i class="fa-solid fa-star"></i>
                        </button>
                        <button class="qpl-view-btn qpl-char-btn${charPs.length ? ' has-data' : ''}" title="캐릭터 전용 페르소나">
                            <i class="fa-solid fa-user"></i>
                        </button>
                        <button class="qpl-theme-toggle-btn" title="테마 선택">🤍</button>
                        ${hasFavs ? `<button class="qpl-edit-btn" title="순서 편집"><i class="fa-solid fa-sort"></i></button>` : ''}
                    </div>
                </div>
                <div class="qpl-theme-bar" style="display:none;"></div>
                <div class="qpl-list" style="display:none;"></div>
                <div class="qpl-detail"></div>
            </div>
        `);

        // 초기 상세 뷰 렌더 (현재 적용된 페르소나)
        renderDetailView($menu.find('.qpl-detail'), user_avatar);
        // 테마 바 구성
        const $bar = $menu.find('.qpl-theme-bar');
        Object.entries(QPL_THEMES).forEach(([key, t]) => {
            const $btn = $(`<button class="qpl-theme-btn" data-theme="${key}" title="${t.name}"
                style="border:none;background:none;cursor:pointer;font-size:20px;padding:4px 6px;border-radius:6px;transition:transform 0.1s,opacity 0.1s;opacity:${key===curTheme?'1':'0.4'};transform:${key===curTheme?'scale(1.2)':'scale(1)'};">${t.label}</button>`);
            $btn.on('click', e => { e.stopPropagation(); setQplTheme(key); if (popper) popper.update(); });
            $bar.append($btn);
        });

        // 테마 토글
        $menu.find('.qpl-theme-toggle-btn').on('click', e => {
            e.stopPropagation();
            $menu.find('.qpl-theme-bar').toggle();
            requestAnimationFrame(() => { if (popper) popper.update(); });
        });

        // 🪪 상세 정보 버튼
        $menu.find('.qpl-detail-btn').on('click', e => {
            e.stopPropagation();
            if (currentView === 'detail') return;
            switchToDetailView(user_avatar);
        });

        // 🎭 전체 목록 버튼
        $menu.find('.qpl-all-btn').on('click', e => {
            e.stopPropagation();
            if (currentView === 'all') return;
            currentView = 'all';
            $menu.find('.qpl-view-btn').removeClass('active');
            $menu.find('.qpl-all-btn').addClass('active');
            $menu.find('.qpl-edit-btn').hide();
            switchToListView($menu);
            renderList($menu.find('.qpl-list'), _allAvatars, false);
            requestAnimationFrame(() => { if (popper) popper.update(); });
        });

        // ⭐ 즐겨찾기 뷰 버튼
        $menu.find('.qpl-fav-btn').on('click', e => {
            e.stopPropagation();
            if (currentView === 'fav') return;
            currentView = 'fav';
            $menu.find('.qpl-view-btn').removeClass('active');
            $menu.find('.qpl-fav-btn').addClass('active');
            switchToListView($menu);
            applyQplTheme(getQplTheme());
            const curFavs = getSettings().favorites.length > 0;
            $menu.find('.qpl-edit-btn').toggle(curFavs);
            if (curFavs) {
                renderList($menu.find('.qpl-list'), getSortedFavorites(_allAvatars), false);
            } else {
                $menu.find('.qpl-list').html(`
                    <div class="qpl-hint" style="display:block;text-align:center;padding:16px 14px;">
                        <i class="fa-regular fa-star" style="display:block;font-size:1.6em;margin-bottom:8px;opacity:0.3;"></i>
                        즐겨찾기한 페르소나가 없어요.<br>
                        <span style="font-size:0.85em;opacity:0.7;">페르소나 패널에서 ⭐를 눌러 추가하세요.</span>
                    </div>
                `);
            }
        });

        // 👤 캐릭터 뷰 버튼
        $menu.find('.qpl-char-btn').on('click', e => {
            e.stopPropagation();
            if (currentView === 'char') return;
            currentView = 'char';
            $menu.find('.qpl-view-btn').removeClass('active');
            $menu.find('.qpl-char-btn').addClass('active');
            switchToListView($menu);
            const cid = getCurrentCharId();
            $menu.find('.qpl-edit-btn').toggle(getCharPersonas(cid).length > 0);
            renderCharView($menu.find('.qpl-list'), cid);
            requestAnimationFrame(() => { if (popper) popper.update(); });
        });

        // 순서 편집
        $menu.find('.qpl-edit-btn').on('click', e => {
            e.stopPropagation();
            enterEditMode(_allAvatars);
        });
        // 전체 탭이 기본이므로 편집 버튼 숨김
        $menu.find('.qpl-edit-btn').hide();

        $menu.css({ visibility: 'hidden', display: 'block' });
        $(document.body).append($menu);

        popper = Popper.createPopper(
            document.getElementById('qplBtn'),
            document.getElementById('qplMenu'),
            {
                placement: 'top',
                modifiers: [
                    { name: 'offset', options: { offset: [0, 6] } },
                    { name: 'preventOverflow', options: { padding: 8 } },
                    { name: 'flip', options: { fallbackPlacements: ['top-start', 'top-end'] } },
                ],
            },
        );
        await popper.update();

        $menu.css({ visibility: '', display: 'none' }).fadeIn(animation_duration);
        requestAnimationFrame(() => applyQplTheme(getQplTheme()));

        // [fix] 키보드 내릴 때 창 이동 방지 — visualViewport 크기 변화 시 Popper 재고정
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', _onViewportResize);
        }
    } finally {
        _isOpening = false;
    }
}

function _onViewportResize() {
    if (popper) {
        requestAnimationFrame(() => popper.update());
    }
}

function closeMenu() {
    if (!isOpen) return;
    isOpen = false;

    // 드래그 중 메뉴가 닫히면 body에 남은 ghost 정리
    $(document.body).children('.qpl-dragging').remove();

    $('#qplMenu').stop(true).fadeOut(animation_duration, () => $('#qplMenu').remove());
    if (popper) { popper.destroy(); popper = null; }

    // visualViewport 리스너 정리
    if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', _onViewportResize);
    }
}

// ─── 뷰 전환 헬퍼 ────────────────────────────────────────────────────────────
function switchToDetailView(avatarId) {
    currentView = 'detail';
    const $menu = $('#qplMenu');
    $menu.find('.qpl-view-btn').removeClass('active');
    $menu.find('.qpl-detail-btn').addClass('active');
    $menu.find('.qpl-edit-btn').hide();
    $menu.find('.qpl-list').hide();
    $menu.find('.qpl-detail').show();
    renderDetailView($menu.find('.qpl-detail'), avatarId);
    requestAnimationFrame(() => { if (popper) popper.update(); });
}

function switchToListView($menu) {
    $menu.find('.qpl-detail').hide();
    $menu.find('.qpl-list').show();
}

// ─── 일반 목록 렌더 ────────────────────────────────────────────────────────────
function renderList($list, listIds, editMode) {
    $list.empty();
    listIds.forEach(id => $list.append(createRow(id, editMode)));
}

// ─── 캐릭터 뷰 렌더 ────────────────────────────────────────────────────────────
function renderCharView($list, charId) {
    $list.empty();
    const personaIds = getCharPersonas(charId);
    if (!charId || personaIds.length === 0) {
        $list.html(`
            <div class="qpl-hint" style="display:block;text-align:center;padding:16px 14px;">
                <i class="fa-solid fa-user" style="display:block;font-size:1.6em;margin-bottom:8px;opacity:0.3;"></i>
                이 캐릭터에 연결된 페르소나가 없어요.<br>
                <span style="font-size:0.85em;opacity:0.7;">페르소나 패널에서 👤를 눌러 연결하세요.</span>
            </div>
        `);
        return;
    }
    personaIds.forEach(id => $list.append(createRow(id, false)));
}

// ─── 상세 정보 패널 렌더 ─────────────────────────────────────────────────────
function renderDetailView($container, avatarId) {
    if (!avatarId) {
        $container.html(`<div class="qpl-detail-empty">적용된 페르소나 없음</div>`);
        return;
    }
    const { DOMPurify } = SillyTavern.libs;
    const name      = power_user.personas?.[avatarId] || avatarId;
    const desc      = power_user.persona_descriptions?.[avatarId] || {};
    const tagText   = desc.title || '';
    const content   = desc.description || '';
    const imgUrl    = getImageUrl(avatarId);
    const isActive  = avatarId === user_avatar;
    const fav       = isFavorite(avatarId);
    const charId    = getCurrentCharId();
    const linked    = charId ? isCharPersona(charId, avatarId) : false;
    const locked    = getLockedPersona() === avatarId;
    const safeId    = DOMPurify.sanitize(avatarId);
    const safeName  = DOMPurify.sanitize(name);

    $container.html(`
        <div class="qpl-detail-inner" data-avatar="${safeId}">

            <!-- 상단: [저장] [프사] [⭐👤📍] 가로 배열, 프사 중앙 기준 -->
            <div class="qpl-detail-top">
                <div class="qpl-detail-left-col">
                    <button class="qpl-detail-icon-btn qpl-detail-save-btn" title="저장">
                        <i class="fa-solid fa-floppy-disk"></i>
                        <span>수정 저장</span>
                    </button>
                </div>
                <div class="qpl-detail-avatar-wrap${isActive ? ' qpl-detail-active' : ''}">
                    <img class="qpl-detail-avatar" src="${imgUrl}" alt="${safeName}" />
                </div>
                <div class="qpl-detail-right-col">
                    <button class="qpl-detail-icon-btn qpl-detail-fav-btn${fav ? ' active' : ''}" title="${fav ? '즐겨찾기 해제' : '즐겨찾기 추가'}">
                        <i class="fa-${fav ? 'solid' : 'regular'} fa-star"></i>
                    </button>
                    <button class="qpl-detail-icon-btn qpl-detail-char-btn${linked ? ' active' : ''}" title="${linked ? '캐릭터 고정 해제' : '현재 캐릭터에 고정'}">
                        <i class="fa-${linked ? 'solid' : 'regular'} fa-user"></i>
                    </button>
                    <button class="qpl-detail-icon-btn qpl-detail-pin-btn${locked ? ' active' : ''}" title="${locked ? '채팅방 고정 해제' : '현재 채팅방에 고정'}">
                        <i class="fa-${locked ? 'solid' : 'regular'} fa-thumbtack"></i>
                    </button>
                </div>
            </div>

            <!-- 편집 필드 (라벨 없음, placeholder로 구분) -->
            <div class="qpl-detail-fields">
                <input class="qpl-detail-name-input" type="text" value="${DOMPurify.sanitize(name)}" placeholder="이름" />
                <input class="qpl-detail-tag-input" type="text" value="${DOMPurify.sanitize(tagText)}" placeholder="태그 (선택)" />
                <textarea class="qpl-detail-textarea" placeholder="페르소나 내용">${DOMPurify.sanitize(content)}</textarea>
            </div>
        </div>
    `);

    const $inner = $container.find('.qpl-detail-inner');

    // 아바타 클릭 → 페르소나 적용
    $inner.find('.qpl-detail-avatar-wrap').on('click', async () => {
        await setUserAvatar(avatarId);
        updateButtonState();
        $inner.find('.qpl-detail-avatar-wrap').addClass('qpl-detail-active');
        const t = QPL_THEMES[getQplTheme()] || QPL_THEMES.lavender;
        $('#qplMenu .qpl-row').removeClass('qpl-active').css('background', '');
    });

    // 💾 저장
    $inner.find('.qpl-detail-save-btn').on('click', async e => {
        e.stopPropagation();
        const newName    = $inner.find('.qpl-detail-name-input').val().trim();
        const newTag     = $inner.find('.qpl-detail-tag-input').val().trim();
        const newContent = $inner.find('.qpl-detail-textarea').val();

        if (newName) {
            if (!power_user.personas) power_user.personas = {};
            power_user.personas[avatarId] = newName;
        }
        if (!power_user.persona_descriptions) power_user.persona_descriptions = {};
        if (!power_user.persona_descriptions[avatarId]) power_user.persona_descriptions[avatarId] = {};
        power_user.persona_descriptions[avatarId].title       = newTag;
        power_user.persona_descriptions[avatarId].description = newContent;
        // ST 전체 설정 저장 (power_user 포함)
        try { SillyTavern.getContext().saveSettingsDebounced(); } catch {}

        // QPL 목록 행 동기화
        const displayName = newName || name;
        const $row = $(`#qplMenu .qpl-row[data-avatar="${CSS.escape(avatarId)}"]`);
        $row.find('.qpl-name').text(displayName);
        if (newTag) {
            if ($row.find('.qpl-tag').length) $row.find('.qpl-tag').text(newTag).show();
            else $row.find('.qpl-info').append(`<span class="qpl-tag">${newTag}</span>`);
        } else {
            $row.find('.qpl-tag').hide();
        }

        // ST 페르소나 패널 DOM 동기화 (이름, 태그)
        const $panel = $(`.avatar-container[data-avatar-id="${CSS.escape(avatarId)}"]`);
        if ($panel.length) {
            $panel.find('.ch_name, .name_text, .persona_name').first().text(displayName);
            if (newTag) {
                $panel.find('.ch_additional_info, .persona_description').first().text(newTag);
            }
        }

        // ST 네이티브 페르소나 편집 패널 input/textarea에도 즉시 반영
        // (현재 열려있는 페르소나가 동일한 경우)
        try {
            const $nameInput = $('#persona_name_input, input[name="persona_name"]');
            const $descInput = $('#persona_description_text, textarea[name="persona_description"]');
            const $titleInput = $('#persona_description_title, input[name="persona_description_title"]');
            if ($nameInput.length && $nameInput.val() !== displayName) {
                $nameInput.val(displayName).trigger('input').trigger('change');
            }
            if ($descInput.length) {
                $descInput.val(newContent).trigger('input').trigger('change');
            }
            if ($titleInput.length) {
                $titleInput.val(newTag).trigger('input').trigger('change');
            }
        } catch (err) {
            console.warn('[QPL] ST 패널 동기화 실패:', err);
        }

        updateButtonState();

        // 저장 버튼 시각 피드백
        const $btn = $inner.find('.qpl-detail-save-btn');
        $btn.addClass('saved');
        setTimeout(() => {
            $btn.removeClass('saved');
            // saved 클래스 제거 후 Popper 위치 재고정 (레이아웃 변화 방지)
            if (popper) popper.update();
        }, 1200);
        // 저장 직후 위치 즉시 고정
        if (popper) popper.update();
    });

    // ✔ 즐겨찾기
    $inner.find('.qpl-detail-fav-btn').on('click', e => {
        e.stopPropagation();
        toggleFavorite(avatarId);
        const now = isFavorite(avatarId);
        $(e.currentTarget).toggleClass('active', now)
            .attr('title', now ? '즐겨찾기 해제' : '즐겨찾기 추가')
            .find('i').attr('class', `fa-${now ? 'solid' : 'regular'} fa-star`);
        $(`.avatar-container[data-avatar-id="${CSS.escape(avatarId)}"] .qpl-fav-star`)
            .toggleClass('active', now).find('i').attr('class', `fa-${now ? 'solid' : 'regular'} fa-star`);
        $(`#qplMenu .qpl-row[data-avatar="${CSS.escape(avatarId)}"] .qpl-row-fav-btn`)
            .toggleClass('active', now).find('i').attr('class', `fa-${now ? 'solid' : 'regular'} fa-star`);
    });

    // ✔ 캐릭터 고정
    $inner.find('.qpl-detail-char-btn').on('click', e => {
        e.stopPropagation();
        const cid = getCurrentCharId();
        if (!cid) { toastr.warning('현재 캐릭터를 찾을 수 없습니다.'); return; }
        toggleCharPersona(cid, avatarId);
        const now = isCharPersona(cid, avatarId);
        $(e.currentTarget).toggleClass('active', now)
            .attr('title', now ? '캐릭터 고정 해제' : '현재 캐릭터에 고정')
            .find('i').attr('class', `fa-${now ? 'solid' : 'regular'} fa-user`);
        refreshCharViewBtn();
        $(`#qplMenu .qpl-row[data-avatar="${CSS.escape(avatarId)}"] .qpl-row-char-btn`)
            .toggleClass('active', now).find('i').attr('class', `fa-${now ? 'solid' : 'regular'} fa-user`);
        $(`.avatar-container[data-avatar-id="${CSS.escape(avatarId)}"] .qpl-char-link-btn`)
            .toggleClass('active', now).find('i').attr('class', `fa-${now ? 'solid' : 'regular'} fa-user`);
    });

    // ✔ 채팅방 고정
    $inner.find('.qpl-detail-pin-btn').on('click', async e => {
        e.stopPropagation();
        await toggleChatLock(avatarId);
        const nowLocked = getLockedPersona() === avatarId;
        $(e.currentTarget).toggleClass('active', nowLocked)
            .attr('title', nowLocked ? '채팅방 고정 해제' : '현재 채팅방에 고정')
            .find('i').attr('class', `fa-${nowLocked ? 'solid' : 'regular'} fa-thumbtack`);
    });
}

// ─── 순서편집 모드 진입 ────────────────────────────────────────────────────────
function enterEditMode(allAvatars) {
    const charId  = getCurrentCharId();
    const isChar  = currentView === 'char';
    const listIds = isChar ? getCharPersonas(charId) : getSortedFavorites(allAvatars);

    const $menu   = $('#qplMenu');
    const $header = $menu.find('.qpl-header');
    $header.html(`
        <span class="qpl-header-title">
            <i class="fa-solid fa-grip-lines"></i> 순서 편집
        </span>
        <button class="qpl-done-btn">
            <i class="fa-solid fa-check"></i> 편집 완료
        </button>
    `);
    // done-btn에 테마 accent 색 즉시 적용
    requestAnimationFrame(() => applyQplTheme(getQplTheme()));

    const $list = $menu.find('.qpl-list');
    renderList($list, listIds, true);
    setupTouchDrag($list);

    $header.find('.qpl-done-btn').on('click', e => {
        e.stopPropagation();
        const newOrder = [];
        $list.find('.qpl-row[data-avatar]').each(function () {
            newOrder.push($(this).attr('data-avatar'));
        });
        if (isChar && charId) {
            // 캐릭터 탭 순서 저장
            const s = getSettings();
            s.charPersonas[charId] = newOrder;
            saveSettings();
        } else {
            saveCustomOrder(newOrder);
        }
        exitEditMode(allAvatars);
    });

    if (popper) popper.update();
}

function exitEditMode(allAvatars) {
    const listIds = getSortedFavorites(allAvatars);
    const charId  = getCurrentCharId();
    const charPs  = getCharPersonas(charId);
    const s       = getSettings();
    const hasFavs = s.favorites.length > 0;

    const $menu   = $('#qplMenu');
    const $header = $menu.find('.qpl-header');

    $header.html(`
        <span class="qpl-header-title">🎭 페르소나Q</span>
        <div class="qpl-header-actions">
            <button class="qpl-view-btn qpl-detail-btn${currentView === 'detail' ? ' active' : ''}" title="현재 페르소나 정보">
                <i class="fa-solid fa-id-card"></i>
            </button>
            <button class="qpl-view-btn qpl-all-btn${currentView === 'all' ? ' active' : ''}" title="전체 목록">
                <i class="fa-solid fa-masks-theater"></i>
            </button>
            <button class="qpl-view-btn qpl-fav-btn${currentView === 'fav' ? ' active' : ''}" title="즐겨찾기 목록">
                <i class="fa-solid fa-star"></i>
            </button>
            <button class="qpl-view-btn qpl-char-btn${charPs.length ? ' has-data' : ''}${currentView === 'char' ? ' active' : ''}" title="캐릭터 전용 페르소나">
                <i class="fa-solid fa-user"></i>
            </button>
            <button class="qpl-theme-toggle-btn" title="테마 선택">🤍</button>
            ${hasFavs || charPs.length ? `<button class="qpl-edit-btn" title="순서 편집"><i class="fa-solid fa-sort"></i></button>` : ''}
        </div>
    `);

    $header.find('.qpl-theme-toggle-btn').on('click', e => {
        e.stopPropagation();
        $menu.find('.qpl-theme-bar').toggle();
        requestAnimationFrame(() => { if (popper) popper.update(); });
    });
    $header.find('.qpl-detail-btn').on('click', e => {
        e.stopPropagation();
        if (currentView === 'detail') return;
        switchToDetailView(user_avatar);
    });
    $header.find('.qpl-all-btn').on('click', e => {
        e.stopPropagation();
        if (currentView === 'all') return;
        currentView = 'all';
        $menu.find('.qpl-view-btn').removeClass('active');
        $header.find('.qpl-all-btn').addClass('active');
        $menu.find('.qpl-edit-btn').hide();
        switchToListView($menu);
        renderList($menu.find('.qpl-list'), _allAvatars, false);
        requestAnimationFrame(() => { if (popper) popper.update(); });
    });
    $header.find('.qpl-fav-btn').on('click', e => {
        e.stopPropagation();
        if (currentView === 'fav') return;
        currentView = 'fav';
        $menu.find('.qpl-view-btn').removeClass('active');
        $header.find('.qpl-fav-btn').addClass('active');
        switchToListView($menu);
        applyQplTheme(getQplTheme());
        const curFavs = getSettings().favorites.length > 0;
        $menu.find('.qpl-edit-btn').toggle(curFavs);
        if (curFavs) {
            renderList($menu.find('.qpl-list'), getSortedFavorites(_allAvatars), false);
        } else {
            $menu.find('.qpl-list').html(`
                <div class="qpl-hint" style="display:block;text-align:center;padding:16px 14px;">
                    <i class="fa-regular fa-star" style="display:block;font-size:1.6em;margin-bottom:8px;opacity:0.3;"></i>
                    즐겨찾기한 페르소나가 없어요.<br>
                    <span style="font-size:0.85em;opacity:0.7;">페르소나 패널에서 ⭐를 눌러 추가하세요.</span>
                </div>
            `);
        }
    });
    $header.find('.qpl-char-btn').on('click', e => {
        e.stopPropagation();
        if (currentView === 'char') return;
        currentView = 'char';
        $menu.find('.qpl-view-btn').removeClass('active');
        $header.find('.qpl-char-btn').addClass('active');
        switchToListView($menu);
        const cid = getCurrentCharId();
        $menu.find('.qpl-edit-btn').toggle(getCharPersonas(cid).length > 0);
        renderCharView($menu.find('.qpl-list'), cid);
        requestAnimationFrame(() => { if (popper) popper.update(); });
    });
    $header.find('.qpl-edit-btn').on('click', e => {
        e.stopPropagation();
        enterEditMode(allAvatars);
    });

    applyQplTheme(getQplTheme());

    const $list = $menu.find('.qpl-list');
    const $editBtn = $menu.find('.qpl-edit-btn');
    if (currentView === 'detail') {
        switchToDetailView(user_avatar);
    } else if (currentView === 'all') {
        $editBtn.hide();
        switchToListView($menu);
        renderList($list, _allAvatars, false);
    } else if (currentView === 'char') {
        $editBtn.toggle(charPs.length > 0);
        switchToListView($menu);
        renderCharView($list, charId);
    } else {
        // fav
        $editBtn.toggle(hasFavs);
        switchToListView($menu);
        if (hasFavs) {
            renderList($list, listIds, false);
        } else {
            $list.html(`
                <div class="qpl-hint" style="display:block;text-align:center;padding:16px 14px;">
                    <i class="fa-regular fa-star" style="display:block;font-size:1.6em;margin-bottom:8px;opacity:0.3;"></i>
                    즐겨찾기한 페르소나가 없어요.<br>
                    <span style="font-size:0.85em;opacity:0.7;">페르소나 패널에서 ⭐를 눌러 추가하세요.</span>
                </div>
            `);
        }
    }

    if (popper) popper.update();
}

// ─── 터치/마우스 드래그 (QPM-style: in-container transform) ──────────────────
// 행이 컨테이너 안에서 translateY로 움직임. 고스트 없음, body 탈출 없음.
// handle에 setPointerCapture → 모바일 스크롤 충돌 방지.
function setupTouchDrag($list) {
    const list = $list[0];

    let drag = null; // { el, fromIdx, currentIdx, rows, rowH }

    function getRows() {
        return [...list.querySelectorAll('.qpl-row')];
    }

    function applyPositions(fromIdx, toIdx, rows, dragEl, rowH) {
        rows.forEach((r, i) => {
            if (r === dragEl) return;
            let shift = 0;
            if (fromIdx < toIdx) {
                if (i > fromIdx && i <= toIdx) shift = -rowH;
            } else {
                if (i >= toIdx && i < fromIdx) shift = rowH;
            }
            r.style.transition = 'transform 0.12s ease';
            r.style.transform  = shift ? `translateY(${shift}px)` : '';
        });
    }

    function resetStyles(rows) {
        rows.forEach(r => {
            r.style.transform  = '';
            r.style.transition = '';
            r.style.position   = '';
            r.style.zIndex     = '';
            r.style.opacity    = '';
            r.style.boxShadow  = '';
        });
    }

    function onPointerDown(e) {
        if (drag) return;
        const handle = e.target.closest('.qpl-drag-handle');
        if (!handle) return;
        const row = handle.closest('.qpl-row');
        if (!row || !list.contains(row)) return;

        e.preventDefault();
        const rows  = getRows();
        const idx   = rows.indexOf(row);
        const rowH  = row.offsetHeight;

        row.style.position  = 'relative';
        row.style.zIndex    = '10';
        row.style.opacity   = '0.88';
        row.style.boxShadow = '0 4px 12px rgba(0,0,0,0.28)';
        row.style.transition = 'none';

        drag = { el: row, fromIdx: idx, currentIdx: idx, rows, rowH, startY: e.clientY };
        handle.setPointerCapture(e.pointerId);
    }

    function onPointerMove(e) {
        if (!drag) return;
        e.preventDefault();
        const { el, fromIdx, currentIdx, rows, rowH, startY } = drag;
        const dy = e.clientY - startY;

        const maxUp   = -(fromIdx * rowH);
        const maxDown = (rows.length - 1 - fromIdx) * rowH;
        const clamped = Math.max(maxUp, Math.min(maxDown, dy));
        el.style.transform = `translateY(${clamped}px)`;

        const newIdx = Math.max(0, Math.min(rows.length - 1,
            fromIdx + Math.round(dy / rowH)));
        if (newIdx !== currentIdx) {
            drag.currentIdx = newIdx;
            applyPositions(fromIdx, newIdx, rows, el, rowH);
        }
    }

    function onPointerUp() {
        if (!drag) return;
        const { el, fromIdx, currentIdx, rows } = drag;
        drag = null;

        resetStyles(rows);

        if (currentIdx !== fromIdx) {
            // Re-order DOM to match new position
            const parent = el.parentElement;
            const siblings = [...parent.querySelectorAll('.qpl-row')];
            // Remove and re-insert at new index
            parent.removeChild(el);
            const ref = siblings[currentIdx] ?? null;
            // Adjust ref since el was removed
            const adjustedSiblings = [...parent.querySelectorAll('.qpl-row')];
            const insertBefore = adjustedSiblings[currentIdx] ?? null;
            parent.insertBefore(el, insertBefore);
        }

        resumeObserver();
        if (popper) popper.update();
    }

    list.addEventListener('pointerdown',   onPointerDown, { passive: false });
    list.addEventListener('pointermove',   onPointerMove, { passive: false });
    list.addEventListener('pointerup',     onPointerUp);
    list.addEventListener('pointercancel', onPointerUp);
}

// ─── 행 생성 ──────────────────────────────────────────────────────────────────
function createRow(avatarId, editMode = false) {
    const { DOMPurify } = SillyTavern.libs;
    const name      = power_user.personas?.[avatarId] || avatarId;
    const title     = power_user.persona_descriptions?.[avatarId]?.title || '';
    const imgUrl    = getImageUrl(avatarId);
    const isActive  = avatarId === user_avatar;
    const isDefault = avatarId === power_user.default_persona;
    const locked    = getLockedPersona() === avatarId;
    const charId    = getCurrentCharId();
    const fav       = isFavorite(avatarId);
    const linked    = charId ? isCharPersona(charId, avatarId) : false;
    const t         = QPL_THEMES[getQplTheme()] || QPL_THEMES.lavender;

    const safeId    = DOMPurify.sanitize(avatarId);
    const safeName  = DOMPurify.sanitize(name);
    const safeTitle = DOMPurify.sanitize(title);

    const $row = $(`
        <div class="qpl-row${isActive ? ' qpl-active' : ''}${editMode ? ' qpl-edit-mode' : ''}" data-avatar="${safeId}">
            ${editMode ? '<div class="qpl-drag-handle"><i class="fa-solid fa-grip-vertical"></i></div>' : ''}
            <div class="qpl-avatar-wrap">
                <img class="qpl-avatar${isDefault ? ' qpl-default' : ''}" src="${imgUrl}" alt="${safeName}" />
            </div>
            <div class="qpl-info">
                <span class="qpl-name">${safeName}</span>
                ${safeTitle ? `<span class="qpl-tag">${safeTitle}</span>` : ''}
            </div>
            ${!editMode ? `
            <div class="qpl-row-actions">
                <button class="qpl-row-fav-btn${fav ? ' active' : ''}" title="${fav ? '즐겨찾기 해제' : '즐겨찾기 추가'}">
                    <i class="fa-${fav ? 'solid' : 'regular'} fa-star"></i>
                </button>
                <button class="qpl-row-char-btn${linked ? ' active' : ''}" title="${linked ? '캐릭터 연결 해제' : '현재 캐릭터에 연결'}">
                    <i class="fa-${linked ? 'solid' : 'regular'} fa-user"></i>
                </button>
                <button class="qpl-pin-btn${locked ? ' active' : ''}" title="${locked ? '채팅방 고정 해제' : '현재 채팅방에 고정'}">
                    <i class="fa-${locked ? 'solid' : 'regular'} fa-thumbtack"></i>
                </button>
            </div>` : ''}
        </div>
    `);

    // active row: 테마 accent 배경 + left bar CSS var
    if (isActive) {
        $row.css('background', t.accent + '18');
        $row[0].style.setProperty('--qpl-active-bar', t.accent);
    }

    // active 색: 핀만 accent, 별/캐릭터는 CSS 고정색이 담당
    if (!editMode && locked) {
        $row.find('.qpl-pin-btn').css('color', t.accent);
    }

    if (!editMode) {
        $row.find('.qpl-avatar-wrap, .qpl-info').on('click', async () => {
            const accentColor = t.accent;
            $('#qplMenu .qpl-row').removeClass('qpl-active').css('background', '');
            $row.addClass('qpl-active').css('background', accentColor + '18');
            $row[0].style.setProperty('--qpl-active-bar', accentColor);
            await setUserAvatar(avatarId);
            updateButtonState();
            switchToDetailView(avatarId);
        });

        // ⭐ 즐겨찾기 토글
        $row.find('.qpl-row-fav-btn').on('click', e => {
            e.stopPropagation();
            toggleFavorite(avatarId);
            const now = isFavorite(avatarId);
            $(e.currentTarget).toggleClass('active', now)
                .attr('title', now ? '즐겨찾기 해제' : '즐겨찾기 추가')
                .find('i').attr('class', `fa-${now ? 'solid' : 'regular'} fa-star`);
            // 페르소나 패널 별 버튼 동기화
            $(`.avatar-container[data-avatar-id="${CSS.escape(avatarId)}"] .qpl-fav-star`)
                .toggleClass('active', now)
                .attr('title', now ? '즐겨찾기 해제' : '즐겨찾기 추가')
                .find('i').attr('class', `fa-${now ? 'solid' : 'regular'} fa-star`);
            // 즐겨찾기 탭에서 해제하면 즉시 행 제거
            if (currentView === 'fav' && !now) {
                $row.fadeOut(150, () => {
                    $row.remove();
                    const hasFavs = getSettings().favorites.length > 0;
                    $('#qplMenu .qpl-edit-btn').toggle(hasFavs);
                    if (!hasFavs) {
                        $('#qplMenu .qpl-list').html(`
                            <div class="qpl-hint" style="display:block;text-align:center;padding:16px 14px;">
                                <i class="fa-regular fa-star" style="display:block;font-size:1.6em;margin-bottom:8px;opacity:0.3;"></i>
                                즐겨찾기한 페르소나가 없어요.<br>
                                <span style="font-size:0.85em;opacity:0.7;">페르소나 패널에서 ⭐를 눌러 추가하세요.</span>
                            </div>
                        `);
                    }
                });
            } else {
                const hasFavs = getSettings().favorites.length > 0;
                if (currentView === 'fav') $('#qplMenu .qpl-edit-btn').toggle(hasFavs);
            }
        });

        // 👤 캐릭터 연결 토글
        $row.find('.qpl-row-char-btn').on('click', e => {
            e.stopPropagation();
            const cid = getCurrentCharId();
            if (!cid) { toastr.warning('현재 캐릭터를 찾을 수 없습니다.'); return; }
            toggleCharPersona(cid, avatarId);
            const now = isCharPersona(cid, avatarId);
            $(e.currentTarget).toggleClass('active', now)
                .attr('title', now ? '캐릭터 연결 해제' : '현재 캐릭터에 연결')
                .find('i').attr('class', `fa-${now ? 'solid' : 'regular'} fa-user`);
            // 페르소나 패널 👤 버튼 동기화
            $(`.avatar-container[data-avatar-id="${CSS.escape(avatarId)}"] .qpl-char-link-btn`)
                .toggleClass('active', now)
                .attr('title', now ? '이 캐릭터 연결 해제' : '현재 캐릭터에 연결')
                .find('i').attr('class', `fa-${now ? 'solid' : 'regular'} fa-user`);
            // 헤더 👤 버튼 갱신
            refreshCharViewBtn();
            // 캐릭터 탭에서 해제하면 즉시 행 제거
            if (currentView === 'char' && !now) {
                $row.fadeOut(150, () => {
                    $row.remove();
                    const remaining = getCharPersonas(cid).length;
                    $('#qplMenu .qpl-edit-btn').toggle(remaining > 0);
                    if (remaining === 0) renderCharView($('#qplMenu .qpl-list'), cid);
                });
            } else if (currentView === 'char') {
                $('#qplMenu .qpl-edit-btn').toggle(getCharPersonas(cid).length > 0);
            }
        });

        // 📌 채팅방 고정
        $row.find('.qpl-pin-btn').on('click', async e => {
            e.stopPropagation();
            const $btn = $(e.currentTarget);
            const willLock = !$btn.hasClass('active');
            $btn.toggleClass('active', willLock)
                .css('color', willLock ? t.accent : '')
                .find('i').attr('class', `fa-${willLock ? 'solid' : 'regular'} fa-thumbtack`);
            await toggleChatLock(avatarId);
        });
    }

    return $row;
}

// ─── 즐겨찾기 별 + 캐릭터 연결 버튼 주입 ────────────────────────────────────
function injectFavoriteStars() {
    const charId = getCurrentCharId();

    $('.avatar-container[data-avatar-id]').each(function () {
        const $item    = $(this);
        const avatarId = $item.attr('data-avatar-id');
        if (!avatarId) return;

        // ⭐ 즐겨찾기 버튼
        if (!$item.find('.qpl-fav-star').length) {
            const fav   = isFavorite(avatarId);
            const $star = $(`
                <button class="qpl-fav-star${fav ? ' active' : ''}" title="${fav ? '즐겨찾기 해제' : '즐겨찾기 추가'}">
                    <i class="fa-${fav ? 'solid' : 'regular'} fa-star"></i>
                </button>
            `);
            $star.on('click', function (e) {
                e.stopPropagation(); e.preventDefault();
                toggleFavorite(avatarId);
                const now = isFavorite(avatarId);
                $(this).toggleClass('active', now)
                       .attr('title', now ? '즐겨찾기 해제' : '즐겨찾기 추가')
                       .find('i').attr('class', `fa-${now ? 'solid' : 'regular'} fa-star`);
            });

            const $title = $item.find('.ch_additional_info').first();
            const $name  = $item.find('.ch_name').first();
            if ($title.length) $title.before($star);
            else if ($name.length) $name.after($star);
            else $item.append($star);
        }

        // 👤 캐릭터 연결 버튼
        if (!$item.find('.qpl-char-link-btn').length) {
            const linked = charId ? isCharPersona(charId, avatarId) : false;
            const $link  = $(`
                <button class="qpl-char-link-btn${linked ? ' active' : ''}"
                        title="${linked ? '이 캐릭터 연결 해제' : '현재 캐릭터에 연결'}">
                    <i class="fa-${linked ? 'solid' : 'regular'} fa-user"></i>
                </button>
            `);
            $link.on('click', function (e) {
                e.stopPropagation(); e.preventDefault();
                // 클릭 시점에 charId를 새로 가져옴 (클로저 stale 방지)
                const currentCharId = getCurrentCharId();
                if (!currentCharId) { toastr.warning('현재 캐릭터를 찾을 수 없습니다.'); return; }
                toggleCharPersona(currentCharId, avatarId);
                const now = isCharPersona(currentCharId, avatarId);
                $(this).toggleClass('active', now)
                       .attr('title', now ? '이 캐릭터 연결 해제' : '현재 캐릭터에 연결')
                       .find('i').attr('class', `fa-${now ? 'solid' : 'regular'} fa-user`);
                refreshCharViewBtn();
            });
            // 별 버튼 바로 뒤에 삽입, 별이 없으면 같은 위치 fallback
            const $star = $item.find('.qpl-fav-star');
            if ($star.length) $star.after($link);
            else {
                const $title = $item.find('.ch_additional_info').first();
                const $name  = $item.find('.ch_name').first();
                if ($title.length) $title.before($link);
                else if ($name.length) $name.after($link);
                else $item.append($link);
            }
        } else {
            // 이미 버튼이 있으면 현재 캐릭터 기준으로 상태만 갱신
            const fresh = getCurrentCharId();
            const now   = fresh ? isCharPersona(fresh, avatarId) : false;
            $item.find('.qpl-char-link-btn')
                 .toggleClass('active', now)
                 .attr('title', now ? '이 캐릭터 연결 해제' : '현재 캐릭터에 연결')
                 .find('i').attr('class', `fa-${now ? 'solid' : 'regular'} fa-user`);
        }
    });
}

let _observer = null;
let _observerPaused = false;

function pauseObserver()  { _observerPaused = true; }
function resumeObserver() { _observerPaused = false; }

function setupPanelObserver() {
    let timer = null;
    _observer = new MutationObserver(() => {
        if (_observerPaused) return;
        clearTimeout(timer);
        // [fix-2] debounce 200→600ms, 감시 범위는 observe() 쪽에서 좁힘
        timer = setTimeout(injectFavoriteStars, 600);
    });
    // 페르소나 패널 + body 양쪽 감시 — 패널이 동적으로 생성되는 경우 대비
    _observer.observe(document.body, { childList: true, subtree: true });
}

// ─── 초기화 ────────────────────────────────────────────────────────────────────
jQuery(async () => {
    try {
        getSettings();
        setupPanelObserver();

        // 캐릭터 전환 시: 연결된 페르소나가 여러 개이고 채팅 고정 없으면 선택 팝업
        eventSource.on(event_types.CHAT_CHANGED, () => {
            updateButtonState();
            setTimeout(injectFavoriteStars, 200);
            try {
                const charId  = getCurrentCharId();
                const charPs  = getCharPersonas(charId);
                const locked  = getLockedPersona();
                if (charPs.length === 1 && !locked) {
                    setUserAvatar(charPs[0]).then(() => updateButtonState());
                }
            } catch (err) {
                console.warn(`[${MODULE_NAME}] CHAT_CHANGED 페르소나 처리 오류:`, err);
            }
        });

        eventSource.on(event_types.SETTINGS_UPDATED, updateButtonState);
        eventSource.on(event_types.APP_READY, () => {
            addQuickPersonaButton();
            updateButtonState();
            setTimeout(injectFavoriteStars, 800);
        });
        addQuickPersonaButton();
        setTimeout(injectFavoriteStars, 1200); // 초기 주입
        $(document.body).on('click.qpl', e => {
            if (isOpen && !e.target.closest('#qplMenu') && !e.target.closest('#qplBtn')) closeMenu();
        });
        updateButtonState();
        console.log(`[${MODULE_NAME}] ✅ 로드 완료`);
    } catch (err) {
        console.error(`[${MODULE_NAME}] ❌ 초기화 오류:`, err);
    }
});
