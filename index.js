// 🪄전개지시M 확장 - direction / foresight(예언) 관리 (컴팩트 UI 전용)
import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, characters, this_chid } from "../../../../script.js";
import { Popup } from "../../../popup.js";

// 확장 설정
const extensionName = "Direction-Manager-DB";
const LOG_PREFIX = "[🪄전개지시M]";

// 기본 Direction 프롬프트 (전역/캐릭터/실행 공통 템플릿, 범위마다 개별 시스템 메시지로 주입됨)
const DEFAULT_DIRECTION_PROMPT = `<direction>
- Resume the story based on the director's instructions below.
- The director only provides drafts; refine them into natural prose instead of directly quoting the sentences.
- Creatively construct and fill in any parts lacking persuasive causality so that the narrative suggested by the director unfolds smoothly.

[Direction(If blank, develop the story as you see fit): {{direction}}]
</direction>`;

// 기본 예언(장면 후보) 프롬프트
const DEFAULT_FORESIGHT_SLOTS_PROMPT = `<foresight>
- 아래는 작가가 미리 잡아둔 다음 전개 후보입니다.
- 이번 턴에 등장시키지 말고, 자연스러운 복선이나 분위기로만 은은하게 반영하세요.
[다음 장면 후보1: {{slot1}}]
[다음 장면 후보2: {{slot2}}]
</foresight>`;

// 기본 예언(스토리) 프롬프트 - 장면 후보보다 더 큰 depth로 존재감을 낮춤
const DEFAULT_FORESIGHT_STORY_PROMPT = `<foresight_story>
- 아래는 작가가 미리 잡아둔 전체적인 줄거리 메모입니다. 배경 참고용일 뿐입니다.
- 직접 언급하거나 요약하지 말고, 지금 이 턴은 실행 지시에만 집중하세요.
[전체 줄거리: {{story}}]
</foresight_story>`;

function defaultPlaceholderState() {
    return {
        enabled: false,
        content: "",
        previousContent: "",
    };
}

// 범위별 프롬프트 라벨 (현재는 참고용, 각 범위는 개별 시스템 메시지로 주입되어 라벨 없이도 구분됨)
const SCOPE_LABELS = {
    global: "[Format Rules]",
    char: "[Character Notes]",
    chat: "[Director's Note]",
};

// "전개지시" 계열 (전역/캐릭터/실행) - {{direction}} 매크로와 프리셋을 공유
const SCOPE_ORDER = ["global", "char", "chat"];
const SCOPE_DISPLAY_NAMES = { global: "전역", char: "캐릭터", chat: "실행", foresight: "예언" };

// 팝업 상단 4개 탭의 순서
const MAIN_SCOPES = ["global", "char", "foresight", "chat"];
const FORESIGHT_SLOTS = ["slot1", "slot2", "story"];

function defaultScopeState() {
    return {
        direction: defaultPlaceholderState(),
    };
}

function defaultForesightState() {
    return {
        slot1: defaultPlaceholderState(),
        slot2: defaultPlaceholderState(),
        story: defaultPlaceholderState(),
    };
}

function defaultDepths() {
    return {
        global: 0,
        char: 1,
        chat: 1,
        foresightSlots: 1,
        foresightStory: 3,
    };
}

const defaultSettings = {
    global: defaultScopeState(),
    chars: {},
    chats: {},
    foresights: {},
    presets: {
        direction: { global: [], char: [], chat: [] },
    },
    // 확장 메뉴 설정
    extensionEnabled: true,
    directionPrompt: DEFAULT_DIRECTION_PROMPT,
    foresightSlotsPrompt: DEFAULT_FORESIGHT_SLOTS_PROMPT,
    foresightStoryPrompt: DEFAULT_FORESIGHT_STORY_PROMPT,
    depths: defaultDepths(),
    defaultScope: "chat",
    lastScope: "chat",
    lastForesightSlot: "slot1",
    _migratedV2: false,
    _migratedV3: false,
    _migratedV4: false,
};

let currentScope = "chat";
let currentForesightSlot = "slot1";
// 현재 보고 있는 값(범위 또는 예언 슬롯)을 팝업에 불러온 시점의 content (이전 내용 추적용)
let editSessionSnapshot = null;
// ST 네이티브 Popup(확인/입력창)이 떠 있는 동안 true. 이 동안에는
// "바깥 클릭시 팝업 닫기" 핸들러가 컴팩트 UI를 닫지 않도록 막는다.
let isNativePopupOpen = false;
// 타이핑 중 매 키 입력마다 매크로를 재등록하면(registerMacro) 버벅일 수 있어서,
// 입력이 잠시 멈췄을 때 한 번만 실제로 반영되도록 디바운스한다. (direction 계열, 매크로 갱신용)
let compactUIApplyDebounceTimer = null;

// 플레이스홀더 정의 ({{direction}} 매크로 - 전역/캐릭터/실행 통합 내용)
const placeholders = [
    { key: "direction", name: "🪄전개지시M", isCustom: true },
];

// 컴팩트 UI 관련 변수들
let compactUIButton = null;
let compactUIPopup = null;

function cloneSettings(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function getSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    return extension_settings[extensionName];
}

function sanitizePlaceholderValue(value) {
    return {
        enabled: Boolean(value?.enabled),
        content: typeof value?.content === "string" ? value.content : "",
        previousContent: typeof value?.previousContent === "string" ? value.previousContent : "",
    };
}

function sanitizeScopeState(scopeState) {
    const source = scopeState || {};
    return {
        direction: sanitizePlaceholderValue(source.direction),
    };
}

function sanitizeForesightState(state) {
    const source = state || {};
    return {
        slot1: sanitizePlaceholderValue(source.slot1),
        slot2: sanitizePlaceholderValue(source.slot2),
        story: sanitizePlaceholderValue(source.story),
    };
}

function sanitizeDepths(depths) {
    const src = depths || {};
    const defaults = defaultDepths();
    const result = {};

    Object.keys(defaults).forEach((key) => {
        result[key] = Number.isInteger(src[key]) ? src[key] : defaults[key];
    });

    return result;
}

function sanitizePresetList(arr) {
    return Array.isArray(arr)
        ? arr
            .filter(item => item && typeof item.content === "string")
            .map(item => ({
                id: typeof item.id === "string" && item.id ? item.id : `${Date.now()}-${Math.random()}`,
                name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "이름 없는 프리셋",
                content: item.content,
            }))
        : [];
}

// 프리셋을 전역/캐릭터/실행 범위별로 분리해서 저장
function sanitizeScopePresets(scopePresets) {
    const src = scopePresets || {};

    return {
        global: sanitizePresetList(src.global),
        char: sanitizePresetList(src.char),
        chat: sanitizePresetList(src.chat),
    };
}

function sanitizePresets(presets) {
    const src = presets || {};

    return {
        direction: sanitizeScopePresets(src.direction),
    };
}

function pruneRemovedPlaceholders() {
    const settings = getSettings();
    let changed = false;

    const pruneScope = (scopeState) => {
        if (!scopeState || typeof scopeState !== "object") return;

        if ("char" in scopeState) {
            delete scopeState.char;
            changed = true;
        }

        if ("user" in scopeState) {
            delete scopeState.user;
            changed = true;
        }
    };

    pruneScope(settings.global);

    Object.values(settings.chars || {}).forEach(pruneScope);
    Object.values(settings.chats || {}).forEach(pruneScope);

    if (settings.presets && typeof settings.presets === "object") {
        if ("char" in settings.presets) {
            delete settings.presets.char;
            changed = true;
        }

        if ("user" in settings.presets) {
            delete settings.presets.user;
            changed = true;
        }
    }

    if ("char" in settings) {
        delete settings.char;
        changed = true;
    }

    if ("user" in settings) {
        delete settings.user;
        changed = true;
    }

    return changed;
}

function isGroupContext(context) {
    return Boolean(context?.groupId ?? context?.selected_group ?? context?.group?.id ?? context?.is_group);
}

// 그룹이 아닌 채팅에서 채팅 키를 구성하기 위한 내부용 캐릭터 식별자.
// (더 이상 "캐릭터 범위" 자체의 저장 키로는 쓰이지 않는다 - 그럴 경우 같은 캐릭터의
// 서로 다른 채팅방끼리 내용이 공유되는 버그가 있었음. 지금은 채팅 키를 유일하게
// 만들기 위한 재료로만 쓰인다.)
function getCurrentCharAvatarKey() {
    const context = getContext();

    if (isGroupContext(context)) {
        return null;
    }

    if (this_chid != null && Array.isArray(characters) && characters[this_chid]) {
        return characters[this_chid].avatar || null;
    }

    return null;
}

function getCurrentChatName(context) {
    if (!context) return null;

    const candidates = [
        context.chatId,
        context.chatFileName,
        context.chatName,
        context.chat_id,
        context.chat_file,
        context.chat_file_name,
        context.chatMetadata?.file_name,
        context.metadata?.chat_file,
    ];

    for (const candidate of candidates) {
        if (candidate !== undefined && candidate !== null && String(candidate).trim() !== "") {
            return String(candidate);
        }
    }

    return null;
}

function getCurrentChatKey() {
    const context = getContext();
    const chatName = getCurrentChatName(context);

    if (!chatName) {
        return null;
    }

    const groupId = context?.groupId ?? context?.selected_group ?? context?.group?.id;

    if (groupId != null) {
        return `group::${groupId}::${chatName}`;
    }

    const charKey = getCurrentCharAvatarKey();

    if (!charKey) {
        return null;
    }

    return `${charKey}::${chatName}`;
}

function getScopeAvailability(scope) {
    if (scope === "global") {
        return { available: true, reason: "" };
    }

    // 캐릭터/예언/실행 범위는 전부 "현재 채팅방" 기준으로 저장되므로 요구사항이 동일하다
    if (!getCurrentChatKey()) {
        return { available: false, reason: "현재 채팅을 찾을 수 없습니다" };
    }

    return { available: true, reason: "" };
}

function normalizeSettings() {
    const settings = getSettings();

    settings.global = sanitizeScopeState(settings.global);
    settings.chars = settings.chars && typeof settings.chars === "object" ? settings.chars : {};
    settings.chats = settings.chats && typeof settings.chats === "object" ? settings.chats : {};
    settings.foresights = settings.foresights && typeof settings.foresights === "object" ? settings.foresights : {};
    settings.presets = sanitizePresets(settings.presets);
    settings.extensionEnabled = typeof settings.extensionEnabled === "boolean" ? settings.extensionEnabled : defaultSettings.extensionEnabled;
    settings.directionPrompt = typeof settings.directionPrompt === "string" ? settings.directionPrompt : defaultSettings.directionPrompt;
    settings.foresightSlotsPrompt = typeof settings.foresightSlotsPrompt === "string" ? settings.foresightSlotsPrompt : defaultSettings.foresightSlotsPrompt;
    settings.foresightStoryPrompt = typeof settings.foresightStoryPrompt === "string" ? settings.foresightStoryPrompt : defaultSettings.foresightStoryPrompt;
    settings.depths = sanitizeDepths(settings.depths);
    settings.defaultScope = MAIN_SCOPES.includes(settings.defaultScope) ? settings.defaultScope : defaultSettings.defaultScope;
    settings.lastScope = MAIN_SCOPES.includes(settings.lastScope) ? settings.lastScope : settings.defaultScope;
    settings.lastForesightSlot = FORESIGHT_SLOTS.includes(settings.lastForesightSlot) ? settings.lastForesightSlot : "slot1";
    settings._migratedV2 = Boolean(settings._migratedV2);
    settings._migratedV3 = Boolean(settings._migratedV3);
    settings._migratedV4 = Boolean(settings._migratedV4);

    Object.keys(settings.chars).forEach((key) => {
        settings.chars[key] = sanitizeScopeState(settings.chars[key]);
    });

    Object.keys(settings.chats).forEach((key) => {
        settings.chats[key] = sanitizeScopeState(settings.chats[key]);
    });

    Object.keys(settings.foresights).forEach((key) => {
        settings.foresights[key] = sanitizeForesightState(settings.foresights[key]);
    });
}

function migrateV1SettingsIfNeeded() {
    const settings = getSettings();

    if (settings._migratedV2) {
        return false;
    }

    const hasLegacy = ["direction", "char", "user"].some((key) => settings[key] !== undefined);

    if (!hasLegacy) {
        settings._migratedV2 = true;
        return true;
    }

    settings.global = sanitizeScopeState(settings.global);

    if (settings.direction !== undefined) {
        settings.global.direction = sanitizePlaceholderValue(settings.direction);
        delete settings.direction;
    }

    // v1에 있던 {{char}} / {{user}} 저장값은 더 이상 사용하지 않으므로 삭제
    if (settings.char !== undefined) {
        delete settings.char;
    }

    if (settings.user !== undefined) {
        delete settings.user;
    }

    settings._migratedV2 = true;
    console.log(`${LOG_PREFIX} v1 설정을 v2 global 스코프로 마이그레이션했습니다. {{char}}/{{user}} 값은 제거했습니다.`);
    return true;
}

// v2까지는 프리셋이 스코프 구분 없이 하나의 목록이었음 -> 전역/캐릭터/채팅 3분할로 이전
// (기존 프리셋을 잃지 않도록 세 범위 모두에 복사해 넣음)
function migrateV3PresetsIfNeeded() {
    const settings = getSettings();

    if (settings._migratedV3) {
        return false;
    }

    const legacyList = Array.isArray(settings.presets?.direction) ? settings.presets.direction : null;

    if (legacyList && legacyList.length > 0) {
        const cloneWithNewIds = () => legacyList.map((item) => ({
            id: `${Date.now()}-${Math.random()}`,
            name: typeof item?.name === "string" && item.name.trim() ? item.name.trim() : "이름 없는 프리셋",
            content: typeof item?.content === "string" ? item.content : "",
        }));

        settings.presets = {
            direction: {
                global: cloneWithNewIds(),
                char: cloneWithNewIds(),
                chat: cloneWithNewIds(),
            },
        };

        console.log(`${LOG_PREFIX} 기존 프리셋 ${legacyList.length}개를 전역/캐릭터/채팅 범위 각각에 복사했습니다.`);
    }

    settings._migratedV3 = true;
    return true;
}

// v4: "캐릭터" 범위의 저장 키를 캐릭터(아바타) 기준 -> 현재 채팅방 기준으로 변경.
// 같은 캐릭터 카드로 만든 채팅방이 여러 개면 내용이 전부 공유되던 버그를 고친다.
// 기존에 아바타 키로 저장돼 있던 데이터는 새 키 체계와 호환되지 않으므로 마이그레이션 없이 폐기한다.
// (합의된 조치: 유저가 명시적으로 확인함)
// 또한 기존 단일 promptDepth 값을 새 depths.{global,char,chat}의 초기값으로 이전한다.
function migrateV4IfNeeded() {
    const settings = getSettings();

    if (settings._migratedV4) {
        return false;
    }

    const hadLegacyChars = settings.chars && Object.keys(settings.chars).length > 0;
    settings.chars = {};

    if (Number.isInteger(settings.promptDepth)) {
        settings.depths = settings.depths && typeof settings.depths === "object" ? settings.depths : {};
        if (!Number.isInteger(settings.depths.global)) settings.depths.global = settings.promptDepth;
        if (!Number.isInteger(settings.depths.char)) settings.depths.char = settings.promptDepth;
        if (!Number.isInteger(settings.depths.chat)) settings.depths.chat = settings.promptDepth;
        delete settings.promptDepth;
    }

    settings._migratedV4 = true;

    if (hadLegacyChars) {
        console.log(`${LOG_PREFIX} v4 마이그레이션: 캐릭터 범위 저장 키를 채팅방 기준으로 변경하며, 기존 캐릭터 기준 데이터는 폐기했습니다.`);
    }

    return true;
}

// 설정 로드
async function loadSettings() {
    const settings = getSettings();

    if (Object.keys(settings).length === 0) {
        Object.assign(settings, cloneSettings(defaultSettings));
    }

    const migrated = migrateV1SettingsIfNeeded();
    const migratedV3 = migrateV3PresetsIfNeeded();
    const migratedV4 = migrateV4IfNeeded();
    const pruned = pruneRemovedPlaceholders();
    normalizeSettings();

    if (migrated || migratedV3 || migratedV4 || pruned) {
        saveSettingsDebounced();
    }
}

// scope: "global" | "char" | "chat" (실행) - direction 계열 전용
function ensureScopedSettings(scope) {
    const settings = getSettings();

    if (scope === "global") {
        settings.global = settings.global || defaultScopeState();
        settings.global = sanitizeScopeState(settings.global);
        return settings.global;
    }

    const key = getCurrentChatKey();
    if (!key) return null;

    if (scope === "char") {
        settings.chars[key] = sanitizeScopeState(settings.chars[key]);
        return settings.chars[key];
    }

    settings.chats[key] = sanitizeScopeState(settings.chats[key]);
    return settings.chats[key];
}

function getScopedSettings(scope) {
    const settings = getSettings();

    if (scope === "global") {
        return sanitizeScopeState(settings.global);
    }

    const key = getCurrentChatKey();
    if (!key) return null;

    if (scope === "char") {
        return sanitizeScopeState(settings.chars[key]);
    }

    return sanitizeScopeState(settings.chats[key]);
}

function getScopedPlaceholder(scope, placeholderKey) {
    const scoped = getScopedSettings(scope);
    if (!scoped) return null;
    return sanitizePlaceholderValue(scoped[placeholderKey]);
}

function isValidEnabledContent(value) {
    return Boolean(value?.enabled && typeof value?.content === "string" && value.content.trim() !== "");
}

// --- 예언(foresight) 저장소: 항상 "현재 채팅방" 기준으로 저장됨 ---

function ensureForesightState() {
    const key = getCurrentChatKey();
    if (!key) return null;

    const settings = getSettings();
    settings.foresights = settings.foresights || {};
    settings.foresights[key] = sanitizeForesightState(settings.foresights[key]);
    return settings.foresights[key];
}

function getForesightState() {
    const key = getCurrentChatKey();
    if (!key) return null;

    const settings = getSettings();
    return sanitizeForesightState(settings.foresights?.[key]);
}

function getForesightSlotState(slot) {
    const state = getForesightState();
    if (!state) return defaultPlaceholderState();
    return sanitizePlaceholderValue(state[slot]);
}

function setForesightSlotState(slot, value) {
    const state = ensureForesightState();
    if (!state) return false;
    state[slot] = sanitizePlaceholderValue(value);
    return true;
}

function isForesightActiveNow() {
    const state = getForesightState();
    if (!state) return false;

    return isValidEnabledContent(state.slot1) || isValidEnabledContent(state.slot2) || isValidEnabledContent(state.story);
}

// 전역/캐릭터/실행 중 활성화되어 있고 내용이 있는 범위를 전부 모아서
// 라벨을 붙여 하나의 문자열로 합친다. ({{direction}} 매크로 용도 - 개별 프롬프트 주입과는 별개)
function resolveCombinedContent(placeholderKey) {
    const parts = [];
    const activeScopes = [];

    SCOPE_ORDER.forEach((scope) => {
        const value = getScopedPlaceholder(scope, placeholderKey);

        if (isValidEnabledContent(value)) {
            parts.push(`${SCOPE_LABELS[scope]}\n${value.content.trim()}`);
            activeScopes.push(scope);
        }
    });

    return {
        content: parts.join("\n\n"),
        activeScopes,
    };
}

// 대기 중인 디바운스를 취소하고, 지금 즉시 시스템(매크로)에 반영 + 표시 갱신
function commitDirectionContentNow(placeholder) {
    clearTimeout(compactUIApplyDebounceTimer);
    compactUIApplyDebounceTimer = null;
    applyPlaceholderToSystem(placeholder);
    updateAppliedIndicator();
}

function applyPlaceholderToSystem(placeholder) {
    const combined = resolveCombinedContent(placeholder.key);

    if (activeScopesEmpty(combined)) {
        removePlaceholderFromSystem(placeholder.key);
        return;
    }

    registerCustomPlaceholder(placeholder.key, combined.content);
}

function activeScopesEmpty(combined) {
    return !combined || !combined.activeScopes || combined.activeScopes.length === 0;
}

// 커스텀 플레이스홀더 등록
function registerCustomPlaceholder(key, content) {
    try {
        const context = getContext();

        if (context && context.registerMacro) {
            // 기존 매크로가 있으면 먼저 제거
            if (context.unregisterMacro) {
                context.unregisterMacro(key);
            }

            context.registerMacro(key, content || "", `🪄전개지시M: ${key}`);
        }
    } catch (error) {
        console.warn(`${LOG_PREFIX} Failed to register custom placeholder:`, error);
    }
}

// 시스템에서 플레이스홀더 제거
function removePlaceholderFromSystem(key) {
    try {
        const context = getContext();

        if (context && context.unregisterMacro) {
            context.unregisterMacro(key);
        }
    } catch (error) {
        console.warn(`${LOG_PREFIX} Failed to remove placeholder from system:`, error);
    }
}

// 모든 플레이스홀더 적용
function applyAllPlaceholders() {
    placeholders.forEach((placeholder) => {
        applyPlaceholderToSystem(placeholder);
    });
}

// 모든 플레이스홀더 제거
function removeAllPlaceholders() {
    placeholders.forEach((placeholder) => {
        removePlaceholderFromSystem(placeholder.key);
    });
}

function getPopupCurrentPlaceholder() {
    return placeholders[0];
}

function getScopeButtonTitle(scope) {
    const availability = getScopeAvailability(scope);

    if (availability.available) {
        return "";
    }

    return availability.reason;
}

function getCurrentScopeState(placeholderKey) {
    const scoped = getScopedSettings(currentScope);

    if (!scoped) {
        return defaultPlaceholderState();
    }

    return sanitizePlaceholderValue(scoped[placeholderKey]);
}

function setCurrentScopeState(placeholderKey, value) {
    const scoped = ensureScopedSettings(currentScope);

    if (!scoped) {
        return false;
    }

    scoped[placeholderKey] = sanitizePlaceholderValue(value);
    return true;
}

// 지금 팝업에 보이는 값 (범위 탭에 따라 direction 상태이거나, 예언 탭이면 현재 서브탭 슬롯 상태)
function getActiveViewState() {
    if (currentScope === "foresight") {
        return getForesightSlotState(currentForesightSlot);
    }

    return getCurrentScopeState("direction");
}

function setActiveViewState(value) {
    if (currentScope === "foresight") {
        return setForesightSlotState(currentForesightSlot, value);
    }

    return setCurrentScopeState("direction", value);
}

function ensureUsableCurrentScope() {
    const availability = getScopeAvailability(currentScope);

    if (availability.available) {
        return;
    }

    const defaultScope = getSettings().defaultScope;
    const fallbackOrder = [defaultScope, "chat", "foresight", "char", "global"];

    for (const scope of fallbackOrder) {
        const available = getScopeAvailability(scope);

        if (available.available) {
            currentScope = scope;
            return;
        }
    }

    currentScope = "global";
}

function refreshScopeButtons() {
    if (!compactUIPopup) return;

    MAIN_SCOPES.forEach((scope) => {
        const btn = compactUIPopup.find(`.dm-compact--scope-btn[data-scope="${scope}"]`);
        const availability = getScopeAvailability(scope);
        btn.prop("disabled", !availability.available);
        btn.attr("title", getScopeButtonTitle(scope));
        btn.toggleClass("dm-compact--scope-btn--active", scope === currentScope);
    });
}

function refreshForesightTabs() {
    if (!compactUIPopup) return;

    FORESIGHT_SLOTS.forEach((slot) => {
        const btn = compactUIPopup.find(`.dm-compact--foresight-tab[data-slot="${slot}"]`);
        btn.toggleClass("dm-compact--foresight-tab--active", slot === currentForesightSlot);
    });
}

// 이전/현재 내용 토글 버튼: direction 계열(전역/캐릭터/실행)에만 있음. 예언 탭에는 없음.
// 이 범위에 "이전 내용"이 없으면 비활성화.
function refreshHistoryButtons() {
    if (!compactUIPopup) return;

    const buttons = compactUIPopup.find(".dm-compact--history-prev, .dm-compact--history-next");

    if (currentScope === "foresight") {
        buttons.prop("disabled", true);
        return;
    }

    const value = getActiveViewState();
    buttons.prop("disabled", !value.previousContent);
}

// 예언 슬롯 이동(신내림) 버튼: 예언 탭에서만 동작. 다른 탭에서는 흐리게(비활성) 표시하되 숨기지는 않음.
function refreshSlotShiftButtons() {
    if (!compactUIPopup) return;

    const buttons = compactUIPopup.find(".dm-compact--slot-prev, .dm-compact--slot-next");
    buttons.prop("disabled", currentScope !== "foresight");
}

function getPresetList(placeholderKey, scope) {
    const settings = getSettings();
    settings.presets = sanitizePresets(settings.presets);
    return settings.presets[placeholderKey]?.[scope] || [];
}

function renderPresetSelect() {
    if (!compactUIPopup) return;

    const placeholder = getPopupCurrentPlaceholder();
    const select = compactUIPopup.find(".dm-compact--preset-select");
    const presets = getPresetList(placeholder.key, currentScope);
    // 현재 범위에 적용되어 있는 내용과 똑같은 프리셋이 있으면
    // (재적용/재접속 시에도) 그 프리셋이 선택된 상태로 보여준다.
    const currentContent = getCurrentScopeState(placeholder.key).content;

    select.empty();
    select.append('<option value="">✨️ 어떤 지시를 내릴까?</option>');

    let matchedId = "";

    presets.forEach((preset) => {
        select.append(`<option value="${preset.id}">${escapeHtml(preset.name)}</option>`);

        if (!matchedId && currentContent && preset.content === currentContent) {
            matchedId = preset.id;
        }
    });

    select.val(matchedId);

    const hasSelection = Boolean(matchedId);
    compactUIPopup.find(".dm-compact--preset-rename").prop("disabled", !hasSelection);
    compactUIPopup.find(".dm-compact--preset-delete").prop("disabled", !hasSelection);
}

function updateAppliedIndicator() {
    if (!compactUIPopup) return;

    const placeholder = getPopupCurrentPlaceholder();
    const combined = resolveCombinedContent(placeholder.key);
    const activeNames = [];

    if (!activeScopesEmpty(combined)) {
        combined.activeScopes.forEach((scope) => activeNames.push(SCOPE_DISPLAY_NAMES[scope]));
    }

    if (isForesightActiveNow()) {
        activeNames.push(SCOPE_DISPLAY_NAMES.foresight);
    }

    const text = activeNames.length ? `🟢 활성: ${activeNames.join(", ")}` : "⚪ 모든 범위 비활성";

    compactUIPopup.find(".dm-compact--indicator").text(text);
    refreshHistoryButtons();
    refreshSlotShiftButtons();
}

// 탭 종류에 따라 프리셋 줄 / 예언 서브탭 줄 / 빈 공간 줄 중 하나만 보여준다.
// (팝업 전체 높이를 어떤 탭이든 동일하게 유지하기 위함)
function refreshSubRow() {
    if (!compactUIPopup) return;

    const isGlobalOrChar = currentScope === "global" || currentScope === "char";
    const isForesight = currentScope === "foresight";
    const isChat = currentScope === "chat";

    compactUIPopup.find(".dm-compact--preset-row").toggle(isGlobalOrChar);
    compactUIPopup.find(".dm-compact--foresight-tabs").toggle(isForesight);
    compactUIPopup.find(".dm-compact--spacer-row").toggle(isChat);
}

function syncPopupByCurrentState() {
    if (!compactUIPopup) return;

    ensureUsableCurrentScope();

    const value = getActiveViewState();
    editSessionSnapshot = value.content;

    compactUIPopup.find(".dm-compact--radio").prop("checked", value.enabled);
    compactUIPopup
        .find(".dm-compact--textarea")
        .val(value.content || "")
        .prop("disabled", !value.enabled);

    refreshScopeButtons();
    refreshForesightTabs();
    refreshSubRow();

    if (currentScope === "global" || currentScope === "char") {
        renderPresetSelect();
    }

    updateAppliedIndicator();
}

function generatePresetId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
        return globalThis.crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random()}`;
}

// ST 네이티브 확인창을 띄우는 동안 isNativePopupOpen을 true로 유지한다.
// (바깥 클릭시 컴팩트 UI가 같이 닫히는 문제 방지)
async function showNativeConfirm(header, text, popupOptions = {}) {
    isNativePopupOpen = true;

    try {
        return await Popup.show.confirm(header, text, popupOptions);
    } finally {
        isNativePopupOpen = false;
    }
}

async function showNativeInput(header, text, defaultValue = "", popupOptions = {}) {
    isNativePopupOpen = true;

    try {
        return await Popup.show.input(header, text, defaultValue, popupOptions);
    } finally {
        isNativePopupOpen = false;
    }
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// 컴팩트 UI 팝업 닫기
function closeCompactUIPopup() {
    // 팝업을 닫는 시점에 아직 반영 안 된(디바운스 대기중인) 입력이 있으면 지금 바로 반영
    if (compactUIApplyDebounceTimer) {
        commitDirectionContentNow(getPopupCurrentPlaceholder());
    }

    if (compactUIPopup) {
        compactUIPopup.removeClass("dm-compact--active");

        setTimeout(() => {
            if (compactUIPopup) {
                compactUIPopup.remove();
                compactUIPopup = null;
            }
        }, 200);
    }

    if (compactUIButton) {
        compactUIButton.removeClass("dm-compact--hasPopup");
    }

    $(document).off("click.compactUI");
}

// 컴팩트 UI 팝업 표시
function showCompactUIPopup() {
    if (compactUIPopup) {
        return closeCompactUIPopup();
    }

    const settings = getSettings();
    // 마지막으로 보고 있던 범위 탭 / 예언 서브탭을 그대로 복원 (없으면 기본 범위)
    currentScope = settings.lastScope || settings.defaultScope;
    currentForesightSlot = settings.lastForesightSlot || "slot1";
    ensureUsableCurrentScope();

    compactUIButton.addClass("dm-compact--hasPopup");

    const popupHtml = `
        <div class="dm-compact--popup">
            <div class="dm-compact--header">
                <input type="checkbox" class="dm-compact--radio">
                <div class="dm-compact--title">🪄전개지시M</div>
            </div>

            <div class="dm-compact--scope-row">
                <div class="dm-compact--scope-group">
                    <button class="dm-compact--scope-btn" data-scope="global" type="button">🌐 전역</button>
                    <button class="dm-compact--scope-btn" data-scope="char" type="button">🎭 캐릭터</button>
                </div>
                <div class="dm-compact--scope-divider"></div>
                <div class="dm-compact--scope-group">
                    <button class="dm-compact--scope-btn" data-scope="foresight" type="button">🔮 예언</button>
                    <button class="dm-compact--scope-btn" data-scope="chat" type="button">▶ 실행</button>
                </div>
            </div>

            <div class="dm-compact--subrow">
                <div class="dm-compact--preset-row">
                    <select class="dm-compact--preset-select" aria-label="프리셋 선택"></select>
                    <button class="dm-compact--preset-btn dm-compact--preset-save" type="button" title="현재 내용 프리셋 저장">
                        <i class="fa-solid fa-floppy-disk"></i>
                    </button>
                    <button class="dm-compact--preset-btn dm-compact--preset-rename" type="button" title="선택한 프리셋 이름 변경">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="dm-compact--preset-btn dm-compact--preset-delete" type="button" title="선택한 프리셋 삭제">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <div class="dm-compact--foresight-tabs">
                    <button class="dm-compact--foresight-tab" data-slot="slot1" type="button">1</button>
                    <button class="dm-compact--foresight-tab" data-slot="slot2" type="button">2</button>
                    <button class="dm-compact--foresight-tab" data-slot="story" type="button">스토리</button>
                </div>
                <div class="dm-compact--spacer-row"></div>
            </div>

            <div class="dm-compact--content">
                <textarea class="dm-compact--textarea" placeholder="내용을 입력하세요..."></textarea>
            </div>

            <div class="dm-compact--footer-row">
                <div class="dm-compact--footer-group dm-compact--footer-left">
                    <span class="dm-compact--foresight-icon" title="예언 슬롯 이동 (예언 탭 전용)">
                        <i class="fa-solid fa-hat-wizard"></i>
                    </span>
                    <button class="dm-compact--nav dm-compact--slot-prev" type="button" title="예언 슬롯 되돌리기">
                        <i class="fa-solid fa-arrow-left"></i>
                    </button>
                    <button class="dm-compact--nav dm-compact--slot-next" type="button" title="예언 슬롯 밀어넣기 (신내림)">
                        <i class="fa-solid fa-arrow-right"></i>
                    </button>
                </div>
                <div class="dm-compact--footer-group dm-compact--footer-right">
                    <button class="dm-compact--nav dm-compact--history-prev" type="button" title="이전 내용 보기">
                        <i class="fa-solid fa-arrow-left"></i>
                    </button>
                    <button class="dm-compact--nav dm-compact--history-next" type="button" title="현재 내용 보기">
                        <i class="fa-solid fa-arrow-right"></i>
                    </button>
                    <button class="dm-compact--nav dm-compact--clear" type="button" title="내용 지우기">
                        <i class="fa-solid fa-eraser"></i>
                    </button>
                </div>
            </div>

            <div class="dm-compact--indicator"></div>
        </div>
    `;

    compactUIPopup = $(popupHtml);
    $("#nonQRFormItems").append(compactUIPopup);

    // 애니메이션
    setTimeout(() => {
        if (compactUIPopup) {
            compactUIPopup.addClass("dm-compact--active");
        }
    }, 10);

    // 이벤트 핸들러 설정
    setupCompactUIEventListeners();
    syncPopupByCurrentState();
}

// 예언 1번 슬롯 -> 실행 칸으로 밀어넣기 ("신내림")
// - 기존 실행 칸 내용은 실행 범위의 "이전 내용"으로 보관 (오른쪽 ← → 로 복구 가능)
// - 예언 2번 슬롯 -> 1번 슬롯. 2번 슬롯은 빈칸이 됨. 빈 슬롯을 자동으로 채우지 않음.
// - "스토리" 슬롯은 관여하지 않음.
function shiftForesightForward() {
    const foresightState = ensureForesightState();
    const execState = ensureScopedSettings("chat");

    if (!foresightState || !execState) {
        toastr.warning("현재 채팅을 찾을 수 없습니다.");
        return;
    }

    const slot1 = sanitizePlaceholderValue(foresightState.slot1);
    const slot2 = sanitizePlaceholderValue(foresightState.slot2);
    const exec = sanitizePlaceholderValue(execState.direction);

    execState.direction = {
        enabled: slot1.content ? true : exec.enabled,
        content: slot1.content,
        previousContent: exec.content,
    };

    foresightState.slot1 = {
        enabled: slot2.enabled,
        content: slot2.content,
        previousContent: slot1.content,
    };

    foresightState.slot2 = defaultPlaceholderState();

    saveSettingsDebounced();
    applyPlaceholderToSystem(getPopupCurrentPlaceholder());
    syncPopupByCurrentState();
}

// shiftForesightForward()의 정확한 역방향 되돌리기
function shiftForesightBackward() {
    const foresightState = ensureForesightState();
    const execState = ensureScopedSettings("chat");

    if (!foresightState || !execState) {
        toastr.warning("현재 채팅을 찾을 수 없습니다.");
        return;
    }

    const slot1 = sanitizePlaceholderValue(foresightState.slot1);
    const exec = sanitizePlaceholderValue(execState.direction);

    foresightState.slot2 = {
        enabled: slot1.enabled,
        content: slot1.content,
        previousContent: foresightState.slot2?.previousContent || "",
    };

    foresightState.slot1 = {
        enabled: exec.enabled,
        content: exec.content,
        previousContent: slot1.previousContent || "",
    };

    execState.direction = {
        enabled: exec.enabled,
        content: exec.previousContent,
        previousContent: exec.content,
    };

    saveSettingsDebounced();
    applyPlaceholderToSystem(getPopupCurrentPlaceholder());
    syncPopupByCurrentState();
}

// 컴팩트 UI 이벤트 리스너 설정
function setupCompactUIEventListeners() {
    if (!compactUIPopup) return;

    compactUIPopup.find(".dm-compact--scope-btn").on("click", function () {
        const nextScope = $(this).data("scope");
        const availability = getScopeAvailability(nextScope);

        if (!availability.available) {
            return;
        }

        currentScope = nextScope;
        getSettings().lastScope = nextScope;
        saveSettingsDebounced();
        syncPopupByCurrentState();
    });

    compactUIPopup.find(".dm-compact--foresight-tab").on("click", function () {
        const slot = $(this).data("slot");

        if (!FORESIGHT_SLOTS.includes(slot)) {
            return;
        }

        currentForesightSlot = slot;
        getSettings().lastForesightSlot = slot;
        saveSettingsDebounced();
        syncPopupByCurrentState();
    });

    // 예언 슬롯 이동 (신내림 / 되돌리기) - 예언 탭에서만 동작
    compactUIPopup.find(".dm-compact--slot-next").on("click", () => {
        if (currentScope !== "foresight") return;
        shiftForesightForward();
    });

    compactUIPopup.find(".dm-compact--slot-prev").on("click", () => {
        if (currentScope !== "foresight") return;
        shiftForesightBackward();
    });

    // 이전 내용 <-> 현재 내용 토글 (direction 계열 전용, 두 버튼 모두 동일하게 내용을 맞바꿈)
    compactUIPopup.find(".dm-compact--history-prev, .dm-compact--history-next").on("click", () => {
        if (currentScope === "foresight") return;

        const value = getActiveViewState();

        if (!value.previousContent) {
            toastr.info("이 범위에 저장된 이전 내용이 없습니다.");
            return;
        }

        const swapped = {
            enabled: value.enabled,
            content: value.previousContent,
            previousContent: value.content,
        };

        if (!setActiveViewState(swapped)) {
            console.warn(`${LOG_PREFIX} 현재 범위에 값을 저장하지 못했습니다.`);
            return;
        }

        compactUIPopup.find(".dm-compact--textarea").val(swapped.content);
        editSessionSnapshot = swapped.content;

        applyPlaceholderToSystem(getPopupCurrentPlaceholder());
        saveSettingsDebounced();
        updateAppliedIndicator();
    });

    // 체크박스 변경 이벤트 (현재 보고 있는 범위/슬롯의 활성화 여부)
    compactUIPopup.find(".dm-compact--radio").on("change", function () {
        const isEnabled = $(this).is(":checked");
        const value = getActiveViewState();
        value.enabled = isEnabled;

        if (!setActiveViewState(value)) {
            console.warn(`${LOG_PREFIX} 현재 상태를 저장하지 못했습니다.`);
            return;
        }

        // 텍스트에어리어 활성화/비활성화
        const textarea = compactUIPopup.find(".dm-compact--textarea");
        textarea.prop("disabled", !isEnabled);

        applyPlaceholderToSystem(getPopupCurrentPlaceholder());
        saveSettingsDebounced();
        updateAppliedIndicator();
    });

    // 지우개 버튼: 확인창 없이 바로 삭제 (지우기 전 내용은 이전 내용으로 남아 direction 계열은 화살표로 복원 가능)
    compactUIPopup.find(".dm-compact--clear").on("click", function () {
        const value = getActiveViewState();

        if (value.content) {
            value.previousContent = value.content;
        }

        value.content = "";

        if (!setActiveViewState(value)) {
            console.warn(`${LOG_PREFIX} 현재 상태를 저장하지 못했습니다.`);
            return;
        }

        compactUIPopup.find(".dm-compact--textarea").val("");
        editSessionSnapshot = "";
        applyPlaceholderToSystem(getPopupCurrentPlaceholder());
        saveSettingsDebounced();
        updateAppliedIndicator();
    });

    // 텍스트에어리어 변경 이벤트
    compactUIPopup.find(".dm-compact--textarea").on("input", function () {
        const newContent = String($(this).val());
        const value = getActiveViewState();

        // 이 편집 세션에서 처음으로 내용이 바뀌는 순간의 "이전 내용"을 1회만 보존
        if (editSessionSnapshot !== null && editSessionSnapshot !== newContent) {
            value.previousContent = editSessionSnapshot;
            editSessionSnapshot = null;
        }

        value.content = newContent;

        if (!setActiveViewState(value)) {
            console.warn(`${LOG_PREFIX} 현재 상태를 저장하지 못했습니다.`);
            return;
        }

        if (currentScope === "foresight") {
            // 예언 슬롯은 매크로에 반영되지 않으므로 디바운스된 매크로 갱신이 필요 없다.
            saveSettingsDebounced();
            updateAppliedIndicator();
            return;
        }

        // registerMacro/unregisterMacro는 비용이 있는 작업이라 매 키 입력마다 실행하면
        // (특히 모바일에서) 타이핑이 버벅일 수 있다. 입력이 250ms 멈췄을 때만 반영한다.
        clearTimeout(compactUIApplyDebounceTimer);
        compactUIApplyDebounceTimer = setTimeout(() => {
            commitDirectionContentNow(getPopupCurrentPlaceholder());
        }, 250);

        saveSettingsDebounced();
    });

    compactUIPopup.find(".dm-compact--preset-select").on("change", function () {
        const presetId = String($(this).val() || "");
        const placeholder = getPopupCurrentPlaceholder();
        const presets = getPresetList(placeholder.key, currentScope);
        const selectedPreset = presets.find((preset) => preset.id === presetId);
        const hasSelection = Boolean(selectedPreset);

        compactUIPopup.find(".dm-compact--preset-rename").prop("disabled", !hasSelection);
        compactUIPopup.find(".dm-compact--preset-delete").prop("disabled", !hasSelection);

        if (!selectedPreset) {
            return;
        }

        compactUIPopup.find(".dm-compact--textarea").val(selectedPreset.content).trigger("input");
        // 프리셋 선택은 타이핑이 아니라 즉시 반영되어야 자연스러우므로 디바운스를 건너뛴다.
        commitDirectionContentNow(getPopupCurrentPlaceholder());
    });

    compactUIPopup.find(".dm-compact--preset-save").on("click", async () => {
        const placeholder = getPopupCurrentPlaceholder();
        const textareaValue = String(compactUIPopup.find(".dm-compact--textarea").val() || "");
        const select = compactUIPopup.find(".dm-compact--preset-select");
        const selectedPresetId = String(select.val() || "");

        const settings = getSettings();
        settings.presets = sanitizePresets(settings.presets);
        const presets = settings.presets[placeholder.key][currentScope];
        const selectedPreset = selectedPresetId ? presets.find((preset) => preset.id === selectedPresetId) : null;

        // 이미 선택된 프리셋이 있으면 새로 저장할지, 그 프리셋을 덮어쓸지 먼저 확인
        // (ST 자체 Popup 사용: 네이티브 confirm()은 모바일에서 키보드가 열렸다 닫히는 듯한 리플로우를 유발함)
        if (selectedPreset) {
            const overwrite = await showNativeConfirm(
                "프리셋 덮어쓰기",
                `선택된 프리셋 "${selectedPreset.name}"을(를) 지금 내용으로 덮어쓸까요?`,
                { okButton: "덮어쓰기", cancelButton: "새 프리셋 저장" }
            );

            if (overwrite) {
                selectedPreset.content = textareaValue;
                saveSettingsDebounced();
                renderPresetSelect();
                compactUIPopup.find(`.dm-compact--preset-select option[value="${selectedPreset.id}"]`).prop("selected", true);
                compactUIPopup.find(".dm-compact--preset-rename").prop("disabled", false);
                compactUIPopup.find(".dm-compact--preset-delete").prop("disabled", false);
                return;
            }
        }

        const name = await showNativeInput("새 프리셋", "새 프리셋 이름을 입력하세요:", "새 프리셋");

        if (!name || !name.trim()) {
            return;
        }

        presets.push({
            id: generatePresetId(),
            name: name.trim(),
            content: textareaValue,
        });

        saveSettingsDebounced();
        renderPresetSelect();
    });

    compactUIPopup.find(".dm-compact--preset-rename").on("click", async () => {
        const placeholder = getPopupCurrentPlaceholder();
        const select = compactUIPopup.find(".dm-compact--preset-select");
        const presetId = String(select.val() || "");

        if (!presetId) {
            return;
        }

        const presets = getPresetList(placeholder.key, currentScope);
        const target = presets.find((preset) => preset.id === presetId);

        if (!target) {
            return;
        }

        const newName = await showNativeInput("프리셋 이름 변경", "새 프리셋 이름을 입력하세요:", target.name);

        if (!newName || !newName.trim()) {
            return;
        }

        target.name = newName.trim();

        const settings = getSettings();
        settings.presets[placeholder.key][currentScope] = presets;
        saveSettingsDebounced();
        renderPresetSelect();
        compactUIPopup.find(`.dm-compact--preset-select option[value="${presetId}"]`).prop("selected", true);
        compactUIPopup.find(".dm-compact--preset-rename").prop("disabled", false);
        compactUIPopup.find(".dm-compact--preset-delete").prop("disabled", false);
    });

    compactUIPopup.find(".dm-compact--preset-delete").on("click", async () => {
        const placeholder = getPopupCurrentPlaceholder();
        const select = compactUIPopup.find(".dm-compact--preset-select");
        const presetId = String(select.val() || "");

        if (!presetId) {
            return;
        }

        const confirmed = await showNativeConfirm("프리셋 삭제", "선택한 프리셋을 삭제하시겠습니까?");

        if (!confirmed) {
            return;
        }

        const settings = getSettings();
        settings.presets = sanitizePresets(settings.presets);
        settings.presets[placeholder.key][currentScope] = settings.presets[placeholder.key][currentScope]
            .filter((preset) => preset.id !== presetId);
        saveSettingsDebounced();
        renderPresetSelect();
    });

    // 외부 클릭시 닫기 (단, ST 네이티브 확인/입력창이 떠 있는 동안은 무시)
    $(document).on("click.compactUI", (e) => {
        if (isNativePopupOpen) {
            return;
        }

        if (!$(e.target).closest(".dm-compact--popup, .dm-compact--button").length) {
            closeCompactUIPopup();
        }
    });
}

function refreshPopupIfOpened() {
    if (!compactUIPopup) {
        return;
    }

    syncPopupByCurrentState();
}

// 컴팩트 UI 버튼 추가
function addCompactUIButton() {
    const ta = document.querySelector("#send_textarea");

    if (!ta) {
        setTimeout(addCompactUIButton, 1000);
        return;
    }

    // 기존 버튼 제거
    if (compactUIButton) {
        compactUIButton.remove();
        compactUIButton = null;
    }

    const buttonHtml = `
        <div class="dm-compact--button menu_button" title="🪄전개지시M 빠른 편집">
            <i class="fa-solid fa-feather"></i>
        </div>
    `;

    compactUIButton = $(buttonHtml);
    $(ta).after(compactUIButton);

    // 확장 활성화 상태에 따라 버튼 표시/숨김
    const settings = getSettings();

    if (settings && settings.extensionEnabled) {
        compactUIButton.show();
    } else {
        compactUIButton.hide();
    }

    // 클릭 이벤트
    compactUIButton.on("click", showCompactUIPopup);
}

// 확장 메뉴 초기화
async function initializeExtensionMenu() {
    try {
        // HTML 로드 및 삽입
        const html = await $.get(`/scripts/extensions/third-party/${extensionName}/settings.html`);
        $("#extensions_settings").append(html);

        // UI 업데이트
        updateExtensionMenuUI();

        // 이벤트 핸들러 설정
        setupExtensionMenuEventHandlers();

        console.log(`${LOG_PREFIX} 확장 메뉴 초기화 완료`);
    } catch (error) {
        console.error(`${LOG_PREFIX} 확장 메뉴 초기화 실패:`, error);
    }
}

// 확장 메뉴 UI 업데이트
function updateExtensionMenuUI() {
    const settings = getSettings();

    // 활성화 체크박스 상태 설정
    $("#direction_manager_enabled").prop("checked", settings.extensionEnabled);

    // Direction 프롬프트 + 범위별 depth
    $("#direction_prompt_text").val(settings.directionPrompt || DEFAULT_DIRECTION_PROMPT);
    $("#direction_depth_global").val(settings.depths.global);
    $("#direction_depth_char").val(settings.depths.char);
    $("#direction_depth_chat").val(settings.depths.chat);

    // 예언 프롬프트 + depth
    $("#foresight_slots_prompt_text").val(settings.foresightSlotsPrompt || DEFAULT_FORESIGHT_SLOTS_PROMPT);
    $("#foresight_story_prompt_text").val(settings.foresightStoryPrompt || DEFAULT_FORESIGHT_STORY_PROMPT);
    $("#foresight_depth_slots").val(settings.depths.foresightSlots);
    $("#foresight_depth_story").val(settings.depths.foresightStory);

    // 기본 스코프 설정
    $("#direction_default_scope").val(settings.defaultScope || "chat");
}

async function clearCurrentCharScopeData() {
    const key = getCurrentChatKey();

    if (!key) {
        toastr.warning("현재 채팅을 찾을 수 없습니다.");
        return;
    }

    const confirmed = await showNativeConfirm("캐릭터 데이터 삭제", "현재 채팅방의 캐릭터 범위 저장 내용을 삭제하시겠습니까?");

    if (!confirmed) {
        return;
    }

    const settings = getSettings();
    delete settings.chars[key];
    applyAllPlaceholders();
    saveSettingsDebounced();
    refreshPopupIfOpened();
}

async function clearCurrentChatScopeData() {
    const key = getCurrentChatKey();

    if (!key) {
        toastr.warning("현재 채팅을 찾을 수 없습니다.");
        return;
    }

    const confirmed = await showNativeConfirm("채팅 데이터 삭제", "현재 채팅방의 실행 범위 저장 내용을 삭제하시겠습니까?");

    if (!confirmed) {
        return;
    }

    const settings = getSettings();
    delete settings.chats[key];
    applyAllPlaceholders();
    saveSettingsDebounced();
    refreshPopupIfOpened();
}

async function clearCurrentForesightData() {
    const key = getCurrentChatKey();

    if (!key) {
        toastr.warning("현재 채팅을 찾을 수 없습니다.");
        return;
    }

    const confirmed = await showNativeConfirm("예언 데이터 삭제", "현재 채팅방의 예언(1/2/스토리) 저장 내용을 삭제하시겠습니까?");

    if (!confirmed) {
        return;
    }

    const settings = getSettings();
    if (settings.foresights) {
        delete settings.foresights[key];
    }
    saveSettingsDebounced();
    refreshPopupIfOpened();
}

// 확장 메뉴 이벤트 핸들러 설정
function setupExtensionMenuEventHandlers() {
    // 활성화 체크박스 변경 이벤트 (전체 확장 기능 제어)
    $("#direction_manager_enabled").on("change", function () {
        const isEnabled = $(this).is(":checked");
        getSettings().extensionEnabled = isEnabled;

        if (isEnabled) {
            // 확장 활성화 시: 컴팩트 UI 버튼 표시 및 모든 플레이스홀더 적용
            if (compactUIButton) {
                compactUIButton.show();
            }

            applyAllPlaceholders();
        } else {
            // 확장 비활성화 시: 컴팩트 UI 버튼 숨김 및 모든 매크로 제거
            if (compactUIButton) {
                compactUIButton.hide();

                // 팝업이 열려있으면 닫기
                if (compactUIPopup) {
                    closeCompactUIPopup();
                }
            }

            removeAllPlaceholders();
        }

        saveSettingsDebounced();
    });

    // Direction 프롬프트 텍스트 변경 이벤트 (실시간 저장)
    $("#direction_prompt_text").on("input", function () {
        getSettings().directionPrompt = $(this).val();
        saveSettingsDebounced();
    });

    // 범위별 depth 변경 이벤트
    const bindDepthInput = (selector, key) => {
        $(selector).on("input", function () {
            const value = parseInt(String($(this).val()), 10);
            const settings = getSettings();
            settings.depths = sanitizeDepths(settings.depths);
            settings.depths[key] = Number.isNaN(value) ? settings.depths[key] : value;
            saveSettingsDebounced();
        });
    };

    bindDepthInput("#direction_depth_global", "global");
    bindDepthInput("#direction_depth_char", "char");
    bindDepthInput("#direction_depth_chat", "chat");
    bindDepthInput("#foresight_depth_slots", "foresightSlots");
    bindDepthInput("#foresight_depth_story", "foresightStory");

    // 예언 프롬프트 텍스트 변경 이벤트
    $("#foresight_slots_prompt_text").on("input", function () {
        getSettings().foresightSlotsPrompt = $(this).val();
        saveSettingsDebounced();
    });

    $("#foresight_story_prompt_text").on("input", function () {
        getSettings().foresightStoryPrompt = $(this).val();
        saveSettingsDebounced();
    });

    // 기본 스코프 설정 변경 이벤트
    $("#direction_default_scope").on("change", function () {
        const value = String($(this).val());

        if (MAIN_SCOPES.includes(value)) {
            getSettings().defaultScope = value;
            saveSettingsDebounced();
        }
    });

    // 기본값 초기화 버튼
    $("#direction_reset_prompt").on("click", function () {
        const settings = getSettings();

        settings.directionPrompt = DEFAULT_DIRECTION_PROMPT;
        settings.foresightSlotsPrompt = DEFAULT_FORESIGHT_SLOTS_PROMPT;
        settings.foresightStoryPrompt = DEFAULT_FORESIGHT_STORY_PROMPT;
        settings.depths = defaultDepths();
        settings.defaultScope = "chat";

        updateExtensionMenuUI();
        saveSettingsDebounced();
    });

    $("#direction_clear_char").on("click", clearCurrentCharScopeData);
    $("#direction_clear_chat").on("click", clearCurrentChatScopeData);
    $("#direction_clear_foresight").on("click", clearCurrentForesightData);
}

function handleContextChanged() {
    applyAllPlaceholders();
    refreshPopupIfOpened();
}

function insertSystemMessage(messages, content, depth) {
    const systemMessage = { role: "system", content };
    const d = Number.isInteger(depth) ? depth : 0;

    if (d <= 0) {
        messages.push(systemMessage);
    } else {
        const insertIndex = Math.max(messages.length - d, 0);
        messages.splice(insertIndex, 0, systemMessage);
    }
}

// 프롬프트 주입 함수
// 범위마다 따로 감싸서 각자 지정한 depth에 개별 시스템 메시지로 주입한다.
// (전역/캐릭터/실행 - direction 계열, 예언 장면 후보, 예언 스토리 - 총 최대 5개의 독립된 메시지)
function injectDirectionPrompt(eventData) {
    const settings = getSettings();

    // 확장이 비활성화되어 있으면 주입하지 않음
    if (!settings.extensionEnabled) {
        return;
    }

    // 참고 파일 방식: eventData.chat 또는 eventData.messages 확인
    const messages = eventData.chat || eventData.messages;

    if (!messages || !Array.isArray(messages)) {
        return;
    }

    // --- direction 계열: 전역 / 캐릭터 / 실행, 각자 own depth로 개별 주입 ---
    const template = settings.directionPrompt;

    if (template && template.trim() !== "") {
        SCOPE_ORDER.forEach((scope) => {
            const value = getScopedPlaceholder(scope, "direction");

            if (!isValidEnabledContent(value)) {
                return;
            }

            const content = template.replace(/\{\{direction\}\}/g, value.content.trim());
            insertSystemMessage(messages, content, settings.depths[scope]);
        });
    }

    // --- 예언 계열: 장면 후보(1·2)와 스토리를 서로 다른 depth로 개별 주입 ---
    const foresightState = getForesightState();

    if (foresightState) {
        const slot1Active = isValidEnabledContent(foresightState.slot1);
        const slot2Active = isValidEnabledContent(foresightState.slot2);

        if ((slot1Active || slot2Active) && settings.foresightSlotsPrompt && settings.foresightSlotsPrompt.trim() !== "") {
            const content = settings.foresightSlotsPrompt
                .replace(/\{\{slot1\}\}/g, slot1Active ? foresightState.slot1.content.trim() : "")
                .replace(/\{\{slot2\}\}/g, slot2Active ? foresightState.slot2.content.trim() : "");

            insertSystemMessage(messages, content, settings.depths.foresightSlots);
        }

        if (isValidEnabledContent(foresightState.story) && settings.foresightStoryPrompt && settings.foresightStoryPrompt.trim() !== "") {
            const content = settings.foresightStoryPrompt.replace(/\{\{story\}\}/g, foresightState.story.content.trim());
            insertSystemMessage(messages, content, settings.depths.foresightStory);
        }
    }
}

// 확장 초기화
jQuery(async () => {
    await loadSettings();
    applyAllPlaceholders();

    // 확장 메뉴 초기화
    await initializeExtensionMenu();

    // 컴팩트 UI 버튼 추가
    addCompactUIButton();

    // 프롬프트 주입 이벤트 리스너 등록
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, injectDirectionPrompt);
    eventSource.on(event_types.CHAT_CHANGED, handleContextChanged);

    if (event_types.APP_READY) {
        eventSource.on(event_types.APP_READY, handleContextChanged);
    }
});
