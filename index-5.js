/**
 * Quick-Persona-List
 * ⚠️ 원본 Extension-QuickPersona와 동시 사용 불가
 */

import { animation_duration, eventSource, event_types, getThumbnailUrl } from '../../../../script.js';
import { power_user } from '../../../power-user.js';
import { getUserAvatar, getUserAvatars, setUserAvatar, user_avatar } from '../../../personas.js';
import { Popper } from '../../../../lib.js';

const MODULE_NAME = 'Quick-Persona-List';
const supportsPersonaThumbnails = getThumbnailUrl('persona', 'test.png', true).includes('&t=');

/** @type {Popper.Instance|null} */
let popper = null;
let isOpen = false;
let _isOpening = false; // openMenu 중복 호출 방지용 [fix-8]

// ─── Settings ─────────────────────────────────────────────────────────────────
function getSettings() {
    const ctx = SillyTavern.getContext();
    if (!ctx.extensionSettings[MODULE_NAME]) {
        ctx.extensionSettings[MODULE_NAME] = { favorites: [], customOrder: null };
    }
    const s = ctx.extensionSettings[MODULE_NAME];
    if (!Array.isArray(s.favorites)) s.favorites = [];
    if (s.customOrder !== null && !Array.isArray(s.customOrder)) s.customOrder = null;
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
    $('#qplMenu .qpl-row[data-avatar]').each(function () {
        const avatarId = $(this).attr('data-avatar');
        const isLocked = locked === avatarId;
        const $btn = $(this).find('.qpl-pin-btn');
        if (!$btn.length) return;
        $btn.toggleClass('active', isLocked)
            .attr('title', isLocked ? '채팅방 고정 해제' : '현재 채팅방에 고정')
            .find('i').attr('class', `fa-${isLocked ? 'solid' : 'regular'} fa-thumbtack`);
    });
}

// ─── 이미지 URL ────────────────────────────────────────────────────────────────
function getImageUrl(avatarId) {
    if (supportsPersonaThumbnails) return getThumbnailUrl('persona', avatarId, true);
    return `${getUserAvatar(avatarId)}?t=${Date.now()}`;
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

// ─── 메뉴 ─────────────────────────────────────────────────────────────────────
async function toggleMenu() {
    if (isOpen) closeMenu(); else await openMenu();
}

async function openMenu() {
    // [fix-8] await 중 중복 호출 방지
    if (_isOpening) return;
    _isOpening = true;
    isOpen = true;

    try {
        const allAvatars = await getUserAvatars(false);
        const s = getSettings();
        const hasFavs = s.favorites.length > 0;
        const listIds = hasFavs ? getSortedFavorites(allAvatars) : allAvatars;

        const $menu = $(`
            <div id="qplMenu">
                <div class="qpl-header">
                    <span class="qpl-header-title">
                        <i class="fa-solid fa-user"></i>
                        페르소나${!hasFavs ? ' (전체)' : ''}
                    </span>
                    ${hasFavs ? `<button class="qpl-edit-btn" title="순서 편집">
                        <i class="fa-solid fa-pen-to-square"></i> 순서 편집
                    </button>` : ''}
                </div>
                <div class="qpl-list"></div>
                ${!hasFavs ? '<div class="qpl-hint"><i class="fa-regular fa-star"></i> 페르소나 패널에서 ⭐를 눌러 즐겨찾기를 추가하세요.</div>' : ''}
            </div>
        `);

        renderList($menu.find('.qpl-list'), listIds, false);

        $menu.find('.qpl-edit-btn').on('click', e => {
            e.stopPropagation();
            enterEditMode(allAvatars);
        });

        // [fix-1] Popper 위치 계산 후 fadeIn: visibility:hidden으로 DOM에 먼저 붙이고
        //         Popper.update() 완료 후 표시
        $menu.css({ visibility: 'hidden', display: 'block' });
        $(document.body).append($menu);

        popper = Popper.createPopper(
            document.getElementById('qplBtn'),
            document.getElementById('qplMenu'),
            { placement: 'top-start', modifiers: [{ name: 'offset', options: { offset: [0, 6] } }] },
        );
        await popper.update();

        $menu.css({ visibility: '', display: 'none' }).fadeIn(animation_duration);
    } finally {
        _isOpening = false;
    }
}

function closeMenu() {
    if (!isOpen) return;
    isOpen = false;

    // 드래그 중 메뉴가 닫히면 body에 남은 ghost 정리
    $(document.body).children('.qpl-dragging').remove();

    $('#qplMenu').fadeOut(animation_duration, () => $('#qplMenu').remove());
    if (popper) { popper.destroy(); popper = null; }
}

// ─── 일반 목록 렌더 ────────────────────────────────────────────────────────────
function renderList($list, listIds, editMode) {
    $list.empty();
    listIds.forEach(id => $list.append(createRow(id, editMode)));
}

// ─── 순서편집 모드 진입 ────────────────────────────────────────────────────────
function enterEditMode(allAvatars) {
    // [fix-5] getSettings() 중복 호출 제거 — getSortedFavorites 내부에서 이미 호출함
    const listIds = getSortedFavorites(allAvatars);

    const $header = $('#qplMenu .qpl-header');
    $header.html(`
        <span class="qpl-header-title">
            <i class="fa-solid fa-grip-lines"></i> 순서 편집
        </span>
        <button class="qpl-done-btn">
            <i class="fa-solid fa-check"></i> 편집 완료
        </button>
    `);

    const $list = $('#qplMenu .qpl-list');
    renderList($list, listIds, true);
    setupTouchDrag($list);

    $header.find('.qpl-done-btn').on('click', e => {
        e.stopPropagation();
        const newOrder = [];
        $list.find('.qpl-row[data-avatar]').each(function () {
            newOrder.push($(this).attr('data-avatar'));
        });
        saveCustomOrder(newOrder);
        exitEditMode(allAvatars);
    });

    if (popper) popper.update();
}

function exitEditMode(allAvatars) {
    const listIds = getSortedFavorites(allAvatars);

    const $header = $('#qplMenu .qpl-header');
    $header.html(`
        <span class="qpl-header-title">
            <i class="fa-solid fa-user"></i> 페르소나
        </span>
        <button class="qpl-edit-btn" title="순서 편집">
            <i class="fa-solid fa-pen-to-square"></i> 순서 편집
        </button>
    `);
    $header.find('.qpl-edit-btn').on('click', e => {
        e.stopPropagation();
        enterEditMode(allAvatars);
    });

    const $list = $('#qplMenu .qpl-list');
    renderList($list, listIds, false);

    if (popper) popper.update();
}

// ─── 터치/마우스 드래그 (Pointer Events API) ──────────────────────────────────
// dragging 행을 body로 꺼내지 않고 list 안에 그대로 유지.
// 대신 고스트(ghost) 복사본을 body에 fixed로 띄워 시각 피드백을 주고,
// list 안의 원본은 투명하게 처리해 자리를 유지함.
// → placeholder 이중생성 버그, 팝업 밖 삐져나옴 버그 동시 해결.
function setupTouchDrag($list) {
    const list = $list[0];

    let dragging  = null; // list 안의 원본 행 (투명하게 자리 유지)
    let ghost     = null; // body에 fixed로 띄운 시각 복사본
    let offsetY   = 0;
    let pendingY  = null;
    let rafId     = null;
    let pointerId = null;

    // list 안의 행 중 y좌표에 해당하는 행 반환 (dragging 자신 제외)
    function getRowAt(y) {
        for (const row of list.querySelectorAll('.qpl-row')) {
            if (row === dragging) continue;
            const rect = row.getBoundingClientRect();
            if (y >= rect.top && y <= rect.bottom) return row;
        }
        return null;
    }

    function onPointerDown(e) {
        if (dragging) return;
        const handle = e.target.closest('.qpl-drag-handle');
        if (!handle) return;
        const row = handle.closest('.qpl-row');
        if (!row || !list.contains(row)) return;

        e.preventDefault();
        pointerId = e.pointerId;
        // setPointerCapture는 list가 아닌 handle에 걸어야
        // 모바일에서 scroll과 충돌 안 함
        handle.setPointerCapture(e.pointerId);

        const rect = row.getBoundingClientRect();
        offsetY = e.clientY - rect.top;

        // 원본은 투명하게 자리만 유지
        dragging = row;
        dragging.style.opacity = '0.25';
        dragging.style.pointerEvents = 'none';

        // 시각 복사본을 body에 fixed
        ghost = row.cloneNode(true);
        ghost.classList.add('qpl-dragging');
        ghost.style.position = 'fixed';
        ghost.style.width    = rect.width  + 'px';
        ghost.style.left     = rect.left   + 'px';
        ghost.style.top      = rect.top    + 'px';
        ghost.style.margin   = '0';
        ghost.style.zIndex   = '99999';
        document.body.appendChild(ghost);

        pauseObserver();
    }

    function onPointerMove(e) {
        if (!dragging || e.pointerId !== pointerId) return;
        e.preventDefault();
        pendingY = e.clientY;

        if (rafId === null) {
            rafId = requestAnimationFrame(() => {
                rafId = null;
                if (!dragging || !ghost) return;

                // 고스트만 이동
                ghost.style.top = (pendingY - offsetY) + 'px';

                // list 안에서 dragging의 위치 재정렬
                const target = getRowAt(pendingY);
                if (target) {
                    const rect   = target.getBoundingClientRect();
                    const middle = rect.top + rect.height / 2;
                    if (pendingY < middle) {
                        list.insertBefore(dragging, target);
                    } else {
                        list.insertBefore(dragging, target.nextSibling);
                    }
                }
            });
        }
    }

    function onPointerUp() {
        if (!dragging) return;
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }

        // 원본 스타일 복원
        dragging.style.opacity       = '';
        dragging.style.pointerEvents = '';
        dragging = null;

        // 고스트 제거
        if (ghost) { ghost.remove(); ghost = null; }

        pendingY  = null;
        pointerId = null;

        resumeObserver();
        if (popper) popper.update();
    }

    // 이벤트는 list 전체에 걸되, capture는 handle에 넘겼으므로 충돌 없음
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
            <button class="qpl-pin-btn${locked ? ' active' : ''}"
                    title="${locked ? '채팅방 고정 해제' : '현재 채팅방에 고정'}">
                <i class="fa-${locked ? 'solid' : 'regular'} fa-thumbtack"></i>
            </button>` : ''}
        </div>
    `);

    if (!editMode) {
        $row.find('.qpl-avatar-wrap, .qpl-info').on('click', async () => {
            closeMenu();
            await setUserAvatar(avatarId);
            updateButtonState();
        });
        // [fix-9] toggleChatLock → refreshPinButtons()로 전체 갱신하므로 여기서 중복 수동 업데이트 제거
        $row.find('.qpl-pin-btn').on('click', async e => {
            e.stopPropagation();
            await toggleChatLock(avatarId);
        });
    }

    return $row;
}

// ─── 즐겨찾기 별 주입 ─────────────────────────────────────────────────────────
function injectFavoriteStars() {
    $('.avatar-container[data-avatar-id]').each(function () {
        const $item    = $(this);
        const avatarId = $item.attr('data-avatar-id');
        if (!avatarId || $item.find('.qpl-fav-star').length) return;

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
    // [fix-2] body 전체 대신 페르소나 패널만 감시 — 채팅 렌더링에 반응하지 않도록
    const target = document.getElementById('persona_management_panel')
                ?? document.getElementById('rm_characters_block')
                ?? document.body; // 패널 못 찾을 때만 fallback
    _observer.observe(target, { childList: true, subtree: true });
}

// ─── 초기화 ────────────────────────────────────────────────────────────────────
jQuery(async () => {
    try {
        getSettings();
        setupPanelObserver();
        eventSource.on(event_types.CHAT_CHANGED,     updateButtonState);
        eventSource.on(event_types.SETTINGS_UPDATED, updateButtonState);
        eventSource.on(event_types.APP_READY, () => { addQuickPersonaButton(); updateButtonState(); });
        addQuickPersonaButton();
        $(document.body).on('click.qpl', e => {
            if (isOpen && !e.target.closest('#qplMenu') && !e.target.closest('#qplBtn')) closeMenu();
        });
        updateButtonState();
        console.log(`[${MODULE_NAME}] ✅ 로드 완료`);
    } catch (err) {
        console.error(`[${MODULE_NAME}] ❌ 초기화 오류:`, err);
    }
});
