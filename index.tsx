/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findByProps } from "@webpack";
import { RestAPI, UserStore } from "@webpack/common";

const Native = VencordNative.pluginHelpers["Quest Auto Completer"] as PluginNative<typeof import("./native")>;

// ────────────────────────────────────────────────────────────────────────────
//  Quest Auto Completer  —  "Rain" design language (matches Sail Launcher /
//  Rain Explorer): violet accent, near-black glass surfaces, soft orb glows.
// ────────────────────────────────────────────────────────────────────────────

const STYLE_ID = "qc-styles";
const ROOT_ID = "qc-root";

const settings = definePluginSettings({
    // ── Automation ──────────────────────────────────────────────────────────
    autoAccept: {
        type: OptionType.BOOLEAN,
        description: "Accept (enroll in) available quests automatically",
        default: false
    },
    autoClaim: {
        type: OptionType.BOOLEAN,
        description: "Automatically claim the reward the moment a quest finishes",
        default: true
    },
    captchaVerification: {
        type: OptionType.BOOLEAN,
        description:
            "When Discord asks for a captcha during claim/enroll, pause and let you solve the real captcha (the plugin never auto-solves captchas)",
        default: true
    },
    autoStart: {
        type: OptionType.BOOLEAN,
        description: "Start completing automatically when you open the Quests page",
        default: false
    },

    // ── UI elements ─────────────────────────────────────────────────────────
    showButton: {
        type: OptionType.BOOLEAN,
        description: "Show the floating launcher button on the Quests page",
        default: true
    },
    titleBarButton: {
        type: OptionType.BOOLEAN,
        description: "Show the quests button in the title bar (channel header toolbar)",
        default: true
    },
    settingsBarButton: {
        type: OptionType.BOOLEAN,
        description: "Show the quests button in the settings bar (bottom-left account panel)",
        default: false
    },
    showBadges: {
        type: OptionType.BOOLEAN,
        description: "Show badges (eligible-quest count) on the quests buttons",
        default: true
    },
    showEverywhere: {
        type: OptionType.BOOLEAN,
        description: "Show the progress HUD and title bar button on every screen (otherwise only on the Quests page)",
        default: false
    },

    // ── Quest type filters ──────────────────────────────────────────────────
    farmVideo: {
        type: OptionType.BOOLEAN,
        description: "Farm video quests automatically",
        default: true
    },
    farmDesktop: {
        type: OptionType.BOOLEAN,
        description: "Farm desktop game quests automatically",
        default: true
    },
    farmStreaming: {
        type: OptionType.BOOLEAN,
        description: "Farm streaming quests automatically",
        default: true
    },
    farmActivities: {
        type: OptionType.BOOLEAN,
        description: "Farm activity quests automatically",
        default: true
    },
    achievementBypass: {
        type: OptionType.BOOLEAN,
        description:
            "Complete activity-achievement quests by temporarily authorizing the quest app, reporting its achievement, then revoking the new authorization. This can put your Discord account at risk under quest-automation enforcement.",
        default: false
    },

    // ── Quest reward filters ────────────────────────────────────────────────
    farmRewardCodes: {
        type: OptionType.BOOLEAN,
        description: "Farm reward-code quests automatically",
        default: true
    },
    farmInGame: {
        type: OptionType.BOOLEAN,
        description: "Farm in-game reward quests automatically",
        default: true
    },
    farmDecorations: {
        type: OptionType.BOOLEAN,
        description: "Farm avatar/profile decoration quests automatically",
        default: true
    },
    farmOrbs: {
        type: OptionType.BOOLEAN,
        description: "Farm Orb (virtual currency) quests automatically",
        default: true
    },
    farmFractionalPremium: {
        type: OptionType.BOOLEAN,
        description: "Farm fractional-premium (Nitro) quests automatically",
        default: true
    },

    // ── Quest menu ──────────────────────────────────────────────────────────
    menuFilter: {
        type: OptionType.SELECT,
        description: "Order quests are processed / shown in the quest menu",
        options: [
            { label: "Suggested", value: "suggested", default: true },
            { label: "Most Recent", value: "recent" },
            { label: "Expiring Soon", value: "expiring" },
            { label: "Started", value: "started" }
        ]
    }
});

// ── Design tokens ───────────────────────────────────────────────────────────
const T = {
    bg: "#0A0A0F",
    chrome: "#12121B",
    card: "#16161F",
    line: "rgba(255,255,255,0.10)",
    line2: "rgba(255,255,255,0.18)",
    text: "#F5F4FB",
    dim: "#9B9AAC",
    accent: "#A855F7",
    accentBright: "#C084FC",
    accentDeep: "#9333EA",
    ok: "#4ADE80",
    warn: "#FBBF24",
    danger: "#FB5D6A",
    font: "'Outfit','Inter','Segoe UI',system-ui,sans-serif"
};

// ── State ───────────────────────────────────────────────────────────────────
let cleanup: (() => void) | null = null;
let isRunning = false;
const log = (...a: any[]) => console.log("%c[QuestCompleter]", "color:#C084FC;font-weight:bold", ...a);

// ── Tiny DOM helper ─────────────────────────────────────────────────────────
function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Partial<HTMLElementTagNameMap[K]> & { css?: string } = {},
    ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    const { css, ...rest } = props as any;
    Object.assign(node, rest);
    if (css) node.style.cssText = css;
    for (const c of children) node.append(c as any);
    return node;
}

// ── Toast stack ─────────────────────────────────────────────────────────────
let toastHost: HTMLDivElement | null = null;
type ToastType = "info" | "success" | "error" | "warn";
const TOAST_COLOR: Record<ToastType, string> = {
    info: T.accent,
    success: T.ok,
    error: T.danger,
    warn: T.warn
};
const TOAST_ICON: Record<ToastType, string> = { info: "✦", success: "✓", error: "✕", warn: "!" };

function toast(message: string, type: ToastType = "info", ttl = 4200) {
    if (!toastHost) return;
    const accent = TOAST_COLOR[type];
    const card = el("div", {
        className: "qc-toast",
        css: `--qc-tc:${accent};`
    });
    const icon = el("div", { className: "qc-toast-icon", textContent: TOAST_ICON[type] });
    const text = el("div", { className: "qc-toast-text", textContent: message });
    card.append(icon, text);
    toastHost.appendChild(card);
    // force reflow then animate in
    void card.offsetWidth;
    card.classList.add("qc-in");
    const close = () => {
        card.classList.remove("qc-in");
        card.classList.add("qc-out");
        setTimeout(() => card.remove(), 320);
    };
    card.onclick = close;
    setTimeout(close, ttl);
}

// ── HUD (progress panel) ────────────────────────────────────────────────────
let hud: { root: HTMLDivElement; title: HTMLDivElement; sub: HTMLDivElement; bar: HTMLDivElement; pct: HTMLDivElement } | null = null;

// Are we currently on the Quests screen? Discord's Quests panel is usually a
// popout/overlay rather than a real route, so the pathname rarely changes —
// the reliable signal is the panel's own text content (proven in the original
// plugin), not guessed CSS class names.
function isOnQuests(): boolean {
    return (
        location.pathname.includes("/quests") ||
        location.pathname.includes("/discovery") ||
        document.body.innerText.includes("Active Quests") ||
        document.body.innerText.includes("Available Quests")
    );
}

// The engine "wants" the HUD shown, but it only actually appears on the Quests
// screen unless the user opts into showing it everywhere.
let hudActive = false;
function applyHudVisibility() {
    if (!hud) return;
    const visible = hudActive && (isOnQuests() || settings.store.showEverywhere);
    hud.root.classList.toggle("qc-show", visible);
}
function showHud() {
    hudActive = true;
    applyHudVisibility();
}
function hideHud() {
    hudActive = false;
    applyHudVisibility();
}
function setHud(title: string, sub: string, fraction: number | null) {
    if (!hud) return;
    hud.title.textContent = title;
    hud.sub.textContent = sub;
    if (fraction == null) {
        hud.root.classList.add("qc-indeterminate");
        hud.pct.textContent = "";
    } else {
        hud.root.classList.remove("qc-indeterminate");
        const clamped = Math.max(0, Math.min(1, fraction));
        hud.bar.style.width = `${(clamped * 100).toFixed(1)}%`;
        hud.pct.textContent = `${Math.round(clamped * 100)}%`;
    }
}

// ────────────────────────────────────────────────────────────────────────────
//  Quest engine
// ────────────────────────────────────────────────────────────────────────────

// Playtime / time-gated tasks we can drive by spoofing progress heartbeats.
const TIME_TASKS = [
    "WATCH_VIDEO",
    "WATCH_VIDEO_ON_MOBILE",
    "PLAY_ON_DESKTOP",
    "STREAM_ON_DESKTOP",
    "PLAY_ACTIVITY"
];
const ACHIEVEMENT_TASKS = ["ACHIEVEMENT_IN_ACTIVITY", "ACHIEVEMENT_IN_GAME"];
// Tasks that require real hardware we can't fake.
const HARDWARE_TASKS = ["PLAY_ON_MOBILE", "PLAY_ON_XBOX", "PLAY_ON_PLAYSTATION"];
const ALL_TASKS = [...TIME_TASKS, ...ACHIEVEMENT_TASKS, ...HARDWARE_TASKS];

// Discord QuestRewardType values (per docs.discord.food/resources/quests).
// Unknown types are NEVER filtered out, so a wrong value here can't silently skip a real quest.
const REWARD = {
    CODE: 1,
    IN_GAME: 2,
    COLLECTIBLE: 3, // avatar / profile decorations
    ORB: 4, // virtual currency
    FRACTIONAL_PREMIUM: 5
} as const;

// Discord QuestContentType — "where the action was initiated" (analytics field
// required on enroll/claim). 1 = QUEST_BAR, the bar shown above the quest list.
const QUEST_LOCATION = 1;
// Discord QuestPlatformType — 0 = CROSS_PLATFORM.
const QUEST_PLATFORM = 0;

class CaptchaRequired extends Error {
    constructor(public readonly raw: any) {
        super("Captcha required");
    }
}

class AchievementCompletionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AchievementCompletionError";
    }
}

function taskCfg(q: any): any {
    const v1 = q?.config?.taskConfig;
    // Some transition-era quests include an empty legacy config alongside the
    // populated V2 one. Prefer whichever config actually contains tasks.
    return Object.keys(v1?.tasks ?? {}).length ? v1 : q?.config?.taskConfigV2 ?? v1;
}

/**
 * Quest payloads are not entirely consistent: older quests use taskConfig and
 * newer ones use taskConfigV2. Keep the lookup in one place so a malformed or
 * partially loaded quest cannot stop the entire queue.
 */
function getQuestTask(q: any): { name: string; config: any } | undefined {
    const tasks = taskCfg(q)?.tasks;
    if (!tasks) return;

    const name = ALL_TASKS.find(task => tasks[task] != null);
    return name ? { name, config: tasks[name] } : undefined;
}

// Newer quest configs keep the application ID on the task itself and may omit
// the top-level application's display name. Keep both payload shapes working.
function getQuestApplication(quest: any, taskConfig: any): { id?: string; name?: string } {
    const app = quest?.config?.application ?? quest?.application;
    const taskApp = taskConfig?.applications?.[0] ?? taskConfig?.application;
    const messages = quest?.config?.messages ?? {};

    return {
        id: taskApp?.id ?? app?.id,
        name: app?.name ?? messages.gameTitle ?? messages.game_title ?? taskConfig?.messages?.gameTitle
    };
}

// Discord encodes the current user as the stream owner. Recent activity quests
// reject the old `:1` placeholder, and guild channels use a different prefix
// from private calls.
function getActivityStreamKey(ChannelStore: any, GuildChannelStore: any): string | undefined {
    const ownerId = UserStore?.getCurrentUser?.()?.id;
    if (!ownerId) return;

    const privateChannelId = ChannelStore?.getSortedPrivateChannels?.()?.[0]?.id;
    if (privateChannelId) return `call:${privateChannelId}:${ownerId}`;

    const guilds: any[] = Object.values(GuildChannelStore?.getAllGuilds?.() ?? {});
    for (const guild of guilds) {
        const voiceChannel = guild?.VOCAL?.[0]?.channel;
        const guildId = voiceChannel?.guild_id ?? voiceChannel?.guildId ?? guild?.id;
        if (guildId && voiceChannel?.id) return `guild:${guildId}:${voiceChannel.id}:${ownerId}`;
    }
}

const primaryTask = (q: any): string | undefined => getQuestTask(q)?.name;

// Is this quest's task type enabled by the type filters?
function taskTypeAllowed(taskName: string | undefined): boolean {
    switch (taskName) {
        case "WATCH_VIDEO":
        case "WATCH_VIDEO_ON_MOBILE":
            return settings.store.farmVideo;
        case "PLAY_ON_DESKTOP":
            return settings.store.farmDesktop;
        case "STREAM_ON_DESKTOP":
            return settings.store.farmStreaming;
        case "PLAY_ACTIVITY":
            return settings.store.farmActivities;
        case "ACHIEVEMENT_IN_ACTIVITY":
            return settings.store.achievementBypass;
        case "ACHIEVEMENT_IN_GAME":
            return settings.store.farmDesktop;
        default:
            return true; // hardware / unknown — handled (and skipped) later
    }
}

// Keep the quest if at least one of its rewards is an enabled (or unknown) type.
function rewardAllowed(quest: any): boolean {
    const rewards: any[] = quest.config.rewardsConfig?.rewards ?? quest.config.rewards ?? [];
    if (!rewards.length) return true; // unknown rewards → never filter out
    const enabled: Record<number, () => boolean> = {
        [REWARD.CODE]: () => settings.store.farmRewardCodes,
        [REWARD.IN_GAME]: () => settings.store.farmInGame,
        [REWARD.COLLECTIBLE]: () => settings.store.farmDecorations,
        [REWARD.FRACTIONAL_PREMIUM]: () => settings.store.farmFractionalPremium,
        [REWARD.ORB]: () => settings.store.farmOrbs
    };
    return rewards.some(r => {
        const check = enabled[r?.type];
        return check ? check() : true; // unknown reward type → allowed
    });
}

// Shared eligibility filter used by both the engine and the badge counter.
function getEligibleQuests(QuestsStore: any): any[] {
    const now = Date.now();
    const list = [...QuestsStore.quests.values()].filter((x: any) => {
        if (x.userStatus?.completedAt) return false;
        if (!(new Date(x.config.expiresAt).getTime() > now)) return false;
        if (!settings.store.autoAccept && !x.userStatus?.enrolledAt) return false;
        const task = primaryTask(x);
        if (!task) return false;
        return taskTypeAllowed(task) && rewardAllowed(x);
    });
    return sortByMenu(list);
}

function sortByMenu(arr: any[]): any[] {
    const expiry = (q: any) => new Date(q.config.expiresAt).getTime();
    const started = (q: any) => new Date(q.config.startsAt ?? q.config.startedAt ?? 0).getTime();
    switch (settings.store.menuFilter) {
        case "expiring":
            return arr.sort((a, b) => expiry(a) - expiry(b));
        case "recent":
            return arr.sort((a, b) => started(b) - started(a));
        case "started":
            return arr.sort((a, b) => (b.userStatus?.enrolledAt ? 1 : 0) - (a.userStatus?.enrolledAt ? 1 : 0));
        default:
            return arr; // "suggested" — keep store order
    }
}

// Memoised QuestsStore lookup for the lightweight badge counter.
let _questsStore: any = null;
function questsStore(): any {
    if (!_questsStore) _questsStore = findByProps("getQuest");
    return _questsStore;
}
function eligibleCount(): number {
    try {
        const store = questsStore();
        return store ? getEligibleQuests(store).length : 0;
    } catch {
        return 0;
    }
}

async function runEngine(button?: HTMLButtonElement) {
    if (isRunning) {
        toast("Quest Completer is already running.", "info");
        return;
    }

    const QuestsStore: any = findByProps("getQuest");
    const ChannelStore: any = findByProps("getAllThreadsForParent");
    const GuildChannelStore: any = findByProps("getSFWDefaultChannel");
    const RunningGameStore: any = findByProps("getRunningGames");
    const FluxDispatcher: any = findByProps("flushWaitQueue") || findByProps("dispatch", "subscribe");

    if (!QuestsStore) {
        toast("Couldn't find Discord's quest modules.", "error");
        return;
    }

    // Real Discord internal HTTP client — same headers/fingerprint the actual
    // client sends, so requests aren't rejected for looking hand-rolled.
    const isCaptchaBody = (body: any) => !!(body?.captcha_key || body?.captcha_sitekey || body?.captcha_service);

    const api = async (endpoint: string, payload: any) => {
        try {
            const res = await RestAPI.post({ url: endpoint, body: payload });
            return res?.body ?? res;
        } catch (err: any) {
            const body = err?.body ?? err?.response?.body;
            if (isCaptchaBody(body)) throw new CaptchaRequired(body);
            throw new Error(body?.message || err?.message || `Request to ${endpoint} failed`);
        }
    };

    // Detect captcha → let the human solve Discord's real captcha, then retry.
    const withCaptcha = async <T,>(action: () => Promise<T>, label: string): Promise<T> => {
        try {
            return await action();
        } catch (e) {
            if (e instanceof CaptchaRequired) {
                if (!settings.store.captchaVerification) {
                    toast(`Captcha required for ${label} — enable Captcha verification in settings.`, "warn", 6000);
                    throw e;
                }
                await promptHumanCaptcha(label);
                // After the user confirms they solved it in Discord's UI, retry once.
                return await action();
            }
            throw e;
        }
    };

    const currentAccountId = (): string | null => UserStore?.getCurrentUser?.()?.id ?? null;
    const ensureSameAccount = (accountId: string) => {
        if (currentAccountId() !== accountId) {
            throw new AchievementCompletionError("your Discord account changed while the quest was running");
        }
    };

    const listOAuthGrants = async (): Promise<any[]> => {
        const response = await RestAPI.get({ url: "/oauth2/tokens" });
        const grants = response?.body ?? response;
        if (!Array.isArray(grants)) {
            throw new AchievementCompletionError("Discord returned an invalid Authorized Apps list");
        }
        return grants;
    };

    const cleanupAchievementGrants = async (
        accountId: string,
        applicationId: string,
        previousGrantIds: Set<string>
    ): Promise<"cleaned" | "account-changed"> => {
        const sameAccount = () => currentAccountId() === accountId;
        if (!sameAccount()) return "account-changed";

        const grants = await listOAuthGrants();
        if (!sameAccount()) return "account-changed";

        const createdGrants = grants.filter(grant => {
            const grantId = grant?.id;
            return grant?.application?.id === applicationId
                && typeof grantId === "string"
                && /^\d+$/.test(grantId)
                && !previousGrantIds.has(grantId);
        });

        for (const grant of createdGrants) {
            if (!sameAccount()) return "account-changed";
            await RestAPI.del({ url: `/oauth2/tokens/${grant.id}` });
        }
        return "cleaned";
    };

    const completeActivityAchievement = async (
        quest: any,
        taskName: string,
        taskConfig: any,
        target: number
    ): Promise<string> => {
        const applicationId = String(getQuestApplication(quest, taskConfig).id ?? "");
        const questId = String(quest?.id ?? "");
        if (!/^\d+$/.test(applicationId) || !/^\d+$/.test(questId)) {
            throw new AchievementCompletionError("Discord did not provide valid activity information");
        }

        const accountId = currentAccountId();
        if (!accountId) throw new AchievementCompletionError("Discord did not provide the current account");

        // Some activity achievements accept an ordinary quest heartbeat. Try
        // that harmless path first and only authorize the activity if needed.
        const streamKey = getActivityStreamKey(ChannelStore, GuildChannelStore);
        if (streamKey) {
            try {
                const response = await api(`/quests/${questId}/heartbeat`, {
                    stream_key: streamKey,
                    application_id: applicationId,
                    terminal: false
                });
                ensureSameAccount(accountId);
                const progress = response?.progress?.[taskName]?.value;
                const completed = response?.completedAt != null || response?.completed_at != null;
                if ((typeof progress === "number" && progress >= target) || completed) {
                    await api(`/quests/${questId}/heartbeat`, {
                        stream_key: streamKey,
                        application_id: applicationId,
                        terminal: true
                    }).catch(() => {});
                    ensureSameAccount(accountId);
                    return accountId;
                }
            } catch (error) {
                if (error instanceof AchievementCompletionError) throw error;
                // A rejected/no-progress heartbeat is expected for app-tracked
                // achievements, so continue with the explicit activity flow.
            }
        }

        let previousGrantIds: Set<string> | undefined;
        try {
            ensureSameAccount(accountId);
            const grants = await listOAuthGrants();
            ensureSameAccount(accountId);
            previousGrantIds = new Set(
                grants
                    .filter(grant => grant?.application?.id === applicationId && typeof grant?.id === "string")
                    .map(grant => grant.id)
            );

            const authorizeResponse = await RestAPI.post({
                url: "/oauth2/authorize",
                query: {
                    response_type: "code",
                    client_id: applicationId,
                    scope: "identify applications.commands applications.entitlements"
                },
                body: {
                    permissions: "0",
                    authorize: true,
                    integration_type: 1,
                    location_context: { guild_id: "10000", channel_id: "10000", channel_type: 10000 }
                }
            });
            ensureSameAccount(accountId);

            const location = authorizeResponse?.body?.location;
            const authCode = typeof location === "string"
                ? new URL(location, "https://discord.com").searchParams.get("code")
                : null;
            if (!authCode) throw new AchievementCompletionError("Discord did not return an activity authorization code");

            const ticketResponse = await RestAPI.post({
                url: `/applications/${applicationId}/proxy-tickets`,
                body: {}
            });
            ensureSameAccount(accountId);
            const proxyTicket = ticketResponse?.body?.ticket;
            if (typeof proxyTicket !== "string" || !proxyTicket) {
                throw new AchievementCompletionError("Discord did not return an activity proxy ticket");
            }

            if (
                typeof Native?.authorizeActivityAchievement !== "function"
                || typeof Native?.reportActivityAchievement !== "function"
            ) {
                throw new AchievementCompletionError("the desktop activity helper is unavailable");
            }

            const referrer = `https://${applicationId}.discordsays.com/?instance_id=quest-completer&platform=desktop&discord_proxy_ticket=${encodeURIComponent(proxyTicket)}`;
            const activityAuthorization = await Native.authorizeActivityAchievement({
                appId: applicationId,
                questId,
                authCode,
                referrer
            });
            ensureSameAccount(accountId);
            if (!activityAuthorization.ok) {
                const status = activityAuthorization.status || "network error";
                throw new AchievementCompletionError(`the activity authorization failed (${status})`);
            }

            let activityToken: string | undefined;
            try {
                const parsed = JSON.parse(activityAuthorization.body);
                if (typeof parsed?.token === "string" && parsed.token) activityToken = parsed.token;
            } catch {
                throw new AchievementCompletionError("the activity returned an invalid authorization response");
            }
            if (!activityToken) throw new AchievementCompletionError("the activity did not return an authorization token");

            const progressResponse = await Native.reportActivityAchievement({
                appId: applicationId,
                questId,
                token: activityToken,
                target,
                referrer
            });
            ensureSameAccount(accountId);
            if (!progressResponse.ok) {
                const status = progressResponse.status || "network error";
                throw new AchievementCompletionError(`the activity rejected the achievement (${status})`);
            }

            return accountId;
        } catch (error: any) {
            if (error instanceof AchievementCompletionError) throw error;
            const code = error?.body?.code ?? error?.response?.body?.code;
            if (code === 50165) {
                throw new AchievementCompletionError("the activity is age-gated or unavailable for this account");
            }
            throw new AchievementCompletionError("Discord rejected the activity-achievement request");
        } finally {
            if (previousGrantIds) {
                try {
                    const cleanupStatus = await cleanupAchievementGrants(accountId, applicationId, previousGrantIds);
                    if (cleanupStatus === "account-changed") {
                        toast(
                            "Your account changed before the temporary app authorization could be checked. Review Discord Settings → Authorized Apps.",
                            "warn",
                            10_000
                        );
                    }
                } catch (error: any) {
                    log("Temporary activity authorization cleanup failed", error?.message ?? "unknown error");
                    toast(
                        "Couldn't verify removal of the temporary app authorization. Review Discord Settings → Authorized Apps.",
                        "warn",
                        10_000
                    );
                }
            }
        }
    };

    const claim = async (quest: any, questName: string) => {
        if (!settings.store.autoClaim) return;
        try {
            await withCaptcha(
                () =>
                    api(`/quests/${quest.id}/claim-reward`, {
                        location: QUEST_LOCATION,
                        platform: QUEST_PLATFORM,
                        is_targeted: false,
                        metadata_raw: null,
                        metadata_sealed: null,
                        traffic_metadata_raw: null,
                        traffic_metadata_sealed: null
                    }),
                `claiming ${questName}`
            );
            toast(`🎁 Reward claimed: ${questName}`, "success");
        } catch (e: any) {
            if (e instanceof CaptchaRequired) {
                toast(`Captcha not solved — ${questName} completed but not claimed. Claim it manually.`, "warn", 6000);
            } else {
                log("Claim failed", e);
                toast(`Couldn't auto-claim ${questName} (${e?.message ?? "unknown error"}) — claim it manually.`, "warn", 6000);
            }
        }
    };

    // ── Gather eligible quests (honours type / reward / menu-order filters) ──
    const quests: any[] = getEligibleQuests(QuestsStore);

    // Vencord's build target is more reliable than probing window.DiscordNative,
    // which is not exposed in every desktop renderer context.
    const isApp = IS_DISCORD_DESKTOP || IS_VESKTOP;

    if (quests.length === 0) {
        toast(
            settings.store.autoAccept
                ? "No quests match your current filters."
                : "No accepted quests to complete (enable Auto-accept to enroll new ones).",
            "warn"
        );
        return;
    }

    isRunning = true;
    button?.classList.replace("qc-idle", "qc-working");
    showHud();
    setHud("Scanning quests…", `${quests.length} eligible`, null);

    const finishAll = () => {
        isRunning = false;
        button?.classList.replace("qc-working", "qc-idle");
        setHud("All done", "Every eligible quest processed", 1);
        toast("All eligible quests processed.", "success");
        setTimeout(hideHud, 3500);
    };

    const total = quests.length;
    let index = 0;

    const doJob = async () => {
        const quest = quests.shift();
        if (!quest) return finishAll();
        index++;

        const questName = quest.config.messages?.questName ?? "Unnamed quest";
        const task = getQuestTask(quest);
        if (!task) return doJob();

        const { name: taskName, config: taskConfig } = task;
        const secondsNeeded = Number(taskConfig?.target);
        if (!Number.isFinite(secondsNeeded) || secondsNeeded <= 0) {
            toast(`⚠️ Skipped ${questName}: Discord did not provide a valid quest target.`, "warn", 6000);
            return doJob();
        }
        const secondsDone = quest.userStatus?.progress?.[taskName]?.value ?? 0;
        const counter = `Quest ${index}/${total}`;

        // Make sure we're enrolled (ignore failure — usually already enrolled).
        await withCaptcha(() => api(`/quests/${quest.id}/enroll`, { location: QUEST_LOCATION }), `enrolling ${questName}`).catch(() => {});

        // ── Hardware-gated ──────────────────────────────────────────────────
        if (HARDWARE_TASKS.includes(taskName)) {
            const dev = taskName.split("_").pop();
            toast(`⚠️ Skipped ${questName}: needs a real ${dev}.`, "warn", 6000);
            return doJob();
        }

        if (taskName === "ACHIEVEMENT_IN_GAME") {
            toast(
                `🎮 Skipped ${questName}: its achievement is reported by the game's own servers, so the real in-game objective is required.`,
                "warn",
                9000
            );
            return doJob();
        }

        // ── In-Discord activity achievement ────────────────────────────────
        if (taskName === "ACHIEVEMENT_IN_ACTIVITY") {
            if (!isApp) {
                toast(`⚠️ Skipped ${questName}: activity achievements need the desktop app.`, "warn", 6000);
                return doJob();
            }
            setHud(questName, `${counter} · completing activity achievement`, secondsDone / secondsNeeded);
            try {
                const accountId = await completeActivityAchievement(quest, taskName, taskConfig, secondsNeeded);
                ensureSameAccount(accountId);
                setHud(questName, `${counter} · activity achievement complete`, 1);
                toast(`✅ Completed: ${questName}`, "success");
                await claim(quest, questName);
            } catch (e: any) {
                reportError(e, questName);
            }
            return doJob();
        }

        // ── Video ───────────────────────────────────────────────────────────
        if (taskName === "WATCH_VIDEO" || taskName === "WATCH_VIDEO_ON_MOBILE") {
            setHud(questName, `${counter} · watching video`, secondsDone / secondsNeeded);
            try {
                let progress = secondsDone;
                while (progress < secondsNeeded) {
                    progress = Math.min(progress + 10, secondsNeeded);
                    await withCaptcha(() => api(`/quests/${quest.id}/video-progress`, { timestamp: progress }), questName);
                    setHud(questName, `${counter} · watching video`, progress / secondsNeeded);
                    if (progress >= secondsNeeded) break;
                    await sleep(10_000);
                }
                toast(`✅ Completed: ${questName}`, "success");
                await claim(quest, questName);
            } catch (e: any) {
                reportError(e, questName);
            }
            return doJob();
        }

        // ── Desktop game playtime (incl. game quests with a playtime target) ─
        if (taskName === "PLAY_ON_DESKTOP") {
            if (!isApp) {
                toast(`⚠️ Skipped ${questName}: needs the desktop app.`, "warn", 6000);
                return doJob();
            }
            if (!RunningGameStore || !FluxDispatcher) {
                toast(`⚠️ Skipped ${questName}: Discord's game-detection module is unavailable.`, "warn", 6000);
                return doJob();
            }
            const app = getQuestApplication(quest, taskConfig);
            const applicationId = app.id;
            const applicationName = app.name;
            if (!applicationId || !applicationName) {
                toast(`⚠️ Skipped ${questName}: Discord did not provide game information.`, "warn", 6000);
                return doJob();
            }
            // Game quests that gate on in-game OBJECTIVES (not just playtime) are
            // validated by the game's own servers and can't be spoofed — be honest.
            const hasObjectives =
                taskConfig?.objectives?.length > 0 ||
                /objective|complete .* in/i.test(quest.config.messages?.questName ?? "");
            if (hasObjectives) {
                toast(
                    `🎮 ${questName} needs real in-game objectives — playtime spoofed, but launch the game to finish objectives.`,
                    "warn",
                    7000
                );
            }

            const exeName = applicationName.replace(/[/\\:*?"<>|]/g, "").replace(/\s/g, "") + ".exe";
            const pid = Math.floor(Math.random() * 30000) + 1000;
            const fakeGame = {
                cmdLine: `C:\\Program Files\\${applicationName}\\${exeName}`,
                exeName,
                exePath: `c:/program files/${applicationName.toLowerCase()}/${exeName}`,
                hidden: false,
                isLauncher: false,
                id: applicationId,
                name: applicationName,
                pid,
                pidPath: [pid],
                processName: applicationName,
                start: Date.now()
            };
            const realGames = RunningGameStore.getRunningGames?.() ?? [];
            // Preserve games Discord is already tracking. Replacing the full
            // list made a running real game disappear until this quest ended.
            const fakeGames = [...realGames, fakeGame];
            const realGetRunningGames = RunningGameStore.getRunningGames;
            const realGetGameForPID = RunningGameStore.getGameForPID;
            const fakeGetRunningGames = () => fakeGames;
            const fakeGetGameForPID = (p: any) => fakeGames.find((x: any) => x.pid === p);
            RunningGameStore.getRunningGames = fakeGetRunningGames;
            RunningGameStore.getGameForPID = fakeGetGameForPID;
            FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [], added: [fakeGame], games: fakeGames });
            const forceLoop = setInterval(() => {
                FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [], added: [fakeGame], games: fakeGames });
            }, 1000);

            setHud(questName, `${counter} · spoofing ${applicationName}`, secondsDone / secondsNeeded);
            try {
                let progress = secondsDone;
                while (progress < secondsNeeded) {
                    const res = await withCaptcha(
                        () => api(`/quests/${quest.id}/heartbeat`, { application_id: applicationId, terminal: false }),
                        questName
                    );
                    progress = res?.progress?.[taskName]?.value ?? progress + 30;
                    setHud(questName, `${counter} · spoofing ${applicationName}`, progress / secondsNeeded);
                    if (progress >= secondsNeeded) break;
                    await sleep(30_000);
                }
                await api(`/quests/${quest.id}/heartbeat`, { application_id: applicationId, terminal: true });
                toast(`✅ Completed: ${questName}`, "success");
                await claim(quest, questName);
            } catch (e: any) {
                reportError(e, questName);
            } finally {
                clearInterval(forceLoop);
                // Do not clobber another plugin if it replaced either method
                // while this quest was running.
                if (RunningGameStore.getRunningGames === fakeGetRunningGames) RunningGameStore.getRunningGames = realGetRunningGames;
                if (RunningGameStore.getGameForPID === fakeGetGameForPID) RunningGameStore.getGameForPID = realGetGameForPID;
                FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fakeGame], added: [], games: realGames });
            }
            return doJob();
        }

        // ── In-Discord activity / Stream ───────────────────────────────────
        if (taskName === "PLAY_ACTIVITY" || taskName === "STREAM_ON_DESKTOP") {
            const applicationId = getQuestApplication(quest, taskConfig).id;
            if (!applicationId) {
                toast(`⚠️ Skipped ${questName}: Discord did not provide activity information.`, "warn", 6000);
                return doJob();
            }
            const streamKey = getActivityStreamKey(ChannelStore, GuildChannelStore);
            if (!streamKey) {
                toast(`⚠️ Skipped ${questName}: couldn't build an activity session.`, "warn", 6000);
                return doJob();
            }
            setHud(questName, `${counter} · simulating ${taskName === "PLAY_ACTIVITY" ? "activity" : "stream"}`, secondsDone / secondsNeeded);
            try {
                let progress = secondsDone;
                while (progress < secondsNeeded) {
                    const payload = { stream_key: streamKey, application_id: applicationId, terminal: false };
                    const res = await withCaptcha(() => api(`/quests/${quest.id}/heartbeat`, payload), questName);
                    const reportedProgress = res?.progress?.[taskName]?.value;
                    const completed = res?.completedAt != null || res?.completed_at != null;
                    if (typeof reportedProgress === "number") progress = reportedProgress;
                    else if (completed) progress = secondsNeeded;
                    else throw new Error("Discord returned no activity progress");
                    setHud(questName, `${counter} · simulating ${taskName === "PLAY_ACTIVITY" ? "activity" : "stream"}`, progress / secondsNeeded);
                    if (progress >= secondsNeeded) break;
                    await sleep(taskName === "PLAY_ACTIVITY" ? 20_000 : 30_000);
                }
                const final = { stream_key: streamKey, application_id: applicationId, terminal: true };
                await api(`/quests/${quest.id}/heartbeat`, final);
                toast(`✅ Completed: ${questName}`, "success");
                await claim(quest, questName);
            } catch (e: any) {
                reportError(e, questName);
            }
            return doJob();
        }

        return doJob();
    };

    try {
        await doJob();
    } catch (e: any) {
        log("Engine crashed", e);
        toast(`Error: ${e?.message ?? e}`, "error");
        isRunning = false;
        button?.classList.replace("qc-working", "qc-idle");
        hideHud();
    }
}

function reportError(e: any, questName: string) {
    log(`Failed: ${questName}`, e);
    if (e instanceof CaptchaRequired) {
        toast(`Captcha not solved — skipped ${questName}.`, "warn");
    } else if (e instanceof AchievementCompletionError) {
        toast(`⚠️ Skipped ${questName}: ${e.message}.`, "warn", 9000);
    } else if (String(e?.message).includes("404")) {
        toast(`❌ Quest expired: ${questName}`, "error");
    } else {
        toast(`❌ API error: ${questName}`, "error");
    }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Human-in-the-loop captcha: we never solve it — we ask the user to.
function promptHumanCaptcha(label: string): Promise<void> {
    return new Promise(resolve => {
        const overlay = el("div", { className: "qc-modal-overlay" });
        const modal = el("div", { className: "qc-modal" });
        modal.append(
            el("div", { className: "qc-modal-badge", textContent: "🔒" }),
            el("div", { className: "qc-modal-title", textContent: "Captcha required" }),
            el("div", {
                className: "qc-modal-body",
                textContent: `Discord wants a captcha before ${label}. Solve the captcha that Discord shows (open the quest and click the action once), then press Continue. The plugin does not auto-solve captchas.`
            })
        );
        const row = el("div", { className: "qc-modal-row" });
        const skip = el("button", { className: "qc-btn-ghost", textContent: "Skip this quest" });
        const cont = el("button", { className: "qc-btn-primary", textContent: "I solved it · Continue" });
        skip.onclick = () => { overlay.remove(); resolve(); };
        cont.onclick = () => { overlay.remove(); resolve(); };
        row.append(skip, cont);
        modal.append(row);
        overlay.append(modal);
        document.getElementById(ROOT_ID)?.appendChild(overlay);
        void modal.offsetWidth;
        overlay.classList.add("qc-in");
    });
}

// ────────────────────────────────────────────────────────────────────────────
//  Settings panel (themed, in-app)
// ────────────────────────────────────────────────────────────────────────────
function buildSettingsPanel(): HTMLDivElement {
    const overlay = el("div", { className: "qc-modal-overlay" });
    const panel = el("div", { className: "qc-settings" });

    const header = el("div", { className: "qc-settings-head" });
    header.append(
        el("div", { className: "qc-logo" }, "QC"),
        el("div", {}, el("div", { className: "qc-settings-title", textContent: "Quest Completer" }), el("div", { className: "qc-settings-sub", textContent: "Settings" }))
    );
    const close = el("button", { className: "qc-x", textContent: "✕" });
    close.onclick = () => { overlay.classList.remove("qc-in"); setTimeout(() => overlay.remove(), 260); };
    header.append(close);
    panel.append(header);

    const body = el("div", { className: "qc-settings-body" });

    const toggleRow = (key: keyof typeof settings.store, title: string, desc: string) => {
        const row = el("div", { className: "qc-row" });
        const txt = el("div", { className: "qc-row-text" });
        txt.append(el("div", { className: "qc-row-title", textContent: title }), el("div", { className: "qc-row-desc", textContent: desc }));
        const sw = el("button", { className: "qc-switch" });
        const knob = el("div", { className: "qc-knob" });
        sw.append(knob);
        const sync = () => sw.classList.toggle("on", !!settings.store[key]);
        sync();
        sw.onclick = () => { (settings.store as any)[key] = !settings.store[key]; sync(); };
        row.append(txt, sw);
        return row;
    };

    const section = (label: string, ...rows: Node[]) => {
        const sec = el("div", { className: "qc-section" });
        sec.append(el("div", { className: "qc-section-title", textContent: label }), ...rows);
        return sec;
    };

    const selectRow = (key: keyof typeof settings.store, title: string, desc: string, opts: { label: string; value: string; }[]) => {
        const row = el("div", { className: "qc-row" });
        const txt = el("div", { className: "qc-row-text" });
        txt.append(el("div", { className: "qc-row-title", textContent: title }), el("div", { className: "qc-row-desc", textContent: desc }));
        const seg = el("div", { className: "qc-seg" });
        const sync = () => seg.querySelectorAll(".qc-seg-opt").forEach(o =>
            o.classList.toggle("on", (o as HTMLElement).dataset.v === String(settings.store[key])));
        for (const o of opts) {
            const chip = el("button", { className: "qc-seg-opt", textContent: o.label });
            chip.dataset.v = o.value;
            chip.onclick = () => { (settings.store as any)[key] = o.value; sync(); };
            seg.append(chip);
        }
        sync();
        const wrap = el("div", { className: "qc-row-stack" });
        wrap.append(txt, seg);
        row.append(wrap);
        return row;
    };

    body.append(
        section("Automation",
            toggleRow("autoAccept", "Accept quests automatically", "Enroll in available quests automatically."),
            toggleRow("autoClaim", "Auto-claim rewards", "Claim the reward instantly when a quest completes."),
            toggleRow("captchaVerification", "Captcha verification", "Pause for you to solve Discord's real captcha (never auto-solved)."),
            toggleRow("autoStart", "Auto-start on Quests page", "Begin completing as soon as you open Quests.")),
        section("UI Elements",
            toggleRow("showButton", "Floating button", "Show the launcher orb on the Quests page."),
            toggleRow("titleBarButton", "Title bar button", "Show the quests button in the channel header toolbar (Quests page only, unless Show everywhere is on)."),
            toggleRow("settingsBarButton", "Settings bar button", "Show the quests button in the bottom-left account panel (always visible)."),
            toggleRow("showBadges", "Show badges", "Show the eligible-quest count on the buttons."),
            toggleRow("showEverywhere", "Show everywhere", "Show the HUD and title bar button on every screen, not just Quests.")),
        section("Quest Type Filters",
            toggleRow("farmVideo", "Video quests", "Farm watch-video quests."),
            toggleRow("farmDesktop", "Desktop game quests", "Farm desktop play-time quests."),
            toggleRow("farmStreaming", "Streaming quests", "Farm stream-on-desktop quests."),
            toggleRow("farmActivities", "Activity quests", "Farm play-activity quests."),
            toggleRow(
                "achievementBypass",
                "Activity achievements",
                "Temporarily authorize the quest app, report its achievement, then revoke the new authorization. Account-risk feature."
            )),
        section("Quest Reward Filters",
            toggleRow("farmRewardCodes", "Reward codes", "Farm quests that reward codes."),
            toggleRow("farmInGame", "In-game rewards", "Farm quests with in-game rewards."),
            toggleRow("farmDecorations", "Avatar decorations", "Farm quests rewarding profile/avatar decorations."),
            toggleRow("farmOrbs", "Orbs", "Farm quests rewarding Orbs (virtual currency)."),
            toggleRow("farmFractionalPremium", "Fractional premium", "Farm quests rewarding fractional Nitro.")),
        section("Quest Menu",
            selectRow("menuFilter", "Menu filter", "Order quests are processed / shown.", [
                { label: "Suggested", value: "suggested" },
                { label: "Recent", value: "recent" },
                { label: "Expiring", value: "expiring" },
                { label: "Started", value: "started" }
            ]))
    );
    panel.append(body);

    const foot = el("div", { className: "qc-settings-foot" });
    const run = el("button", { className: "qc-btn-primary", textContent: "▶ Run now" });
    run.onclick = () => { overlay.classList.remove("qc-in"); setTimeout(() => overlay.remove(), 200); runEngine(getButton()); };
    foot.append(el("div", { className: "qc-foot-note", textContent: "A Sail Solutions App ✦" }), run);
    panel.append(foot);

    overlay.append(panel);
    return overlay;
}

function getButton() {
    return document.getElementById("qc-fab") as HTMLButtonElement | null ?? undefined;
}

function openSettings() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    const p = buildSettingsPanel();
    root.appendChild(p);
    void (p as HTMLElement).offsetWidth;
    p.classList.add("qc-in");
}

// ────────────────────────────────────────────────────────────────────────────
//  Chrome buttons (title bar + settings bar) — DOM-injected, defensive.
//  Selectors are class-contains / aria based; if Discord changes them the
//  buttons simply don't mount (the floating orb + Vencord settings still work).
// ────────────────────────────────────────────────────────────────────────────
const TITLEBAR_BTN = "qc-titlebar-btn";
const SETTINGSBAR_BTN = "qc-settingsbar-btn";

function firstEl(selectors: string[]): HTMLElement | null {
    for (const sel of selectors) {
        const found = document.querySelector(sel) as HTMLElement | null;
        if (found) return found;
    }
    return null;
}

function makeChromeButton(id: string): HTMLButtonElement {
    const btn = el("button", { id, className: "qc-chrome-btn", type: "button" as any });
    btn.title = "Quest Completer — click to run, right-click for settings";
    btn.append(
        el("span", { className: "qc-chrome-mark", textContent: "QC" }),
        el("span", { className: "qc-badge", textContent: "0" })
    );
    btn.onclick = e => { e.stopPropagation(); runEngine(getButton()); };
    btn.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); openSettings(); };
    return btn;
}

function syncBadge(btn: HTMLElement | null, count: number) {
    if (!btn) return;
    const badge = btn.querySelector(".qc-badge") as HTMLElement | null;
    if (!badge) return;
    const show = settings.store.showBadges && count > 0;
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.style.display = show ? "flex" : "none";
}

function mountChromeButtons() {
    const count = eligibleCount();

    // ── Title bar (channel header toolbar) — Quests page only, unless the
    //    "Show everywhere" setting is on. React re-renders this toolbar on
    //    every channel switch, wiping our injected button, so we also need
    //    to actively remove it when the page condition stops holding.
    const wantTitleBtn = settings.store.titleBarButton && (isOnQuests() || settings.store.showEverywhere);
    if (wantTitleBtn) {
        let btn = document.getElementById(TITLEBAR_BTN);
        if (!btn) {
            const host = firstEl([
                'section[aria-label*="header" i] [class*="toolbar_"]',
                '[class*="title_"] [class*="toolbar_"]',
                '[class*="toolbar_"]'
            ]);
            if (host) {
                btn = makeChromeButton(TITLEBAR_BTN);
                host.prepend(btn);
            }
        }
        syncBadge(btn, count);
    } else {
        document.getElementById(TITLEBAR_BTN)?.remove();
    }

    // ── Settings bar (bottom-left account panel) ────────────────────────────
    if (settings.store.settingsBarButton) {
        let btn = document.getElementById(SETTINGSBAR_BTN);
        if (!btn) {
            const cog = firstEl([
                'button[aria-label="User Settings"]',
                '[class*="panels_"] button[aria-label*="Settings" i]'
            ]);
            if (cog?.parentElement) {
                btn = makeChromeButton(SETTINGSBAR_BTN);
                btn.classList.add("qc-chrome-sm");
                cog.parentElement.insertBefore(btn, cog);
            }
        }
        syncBadge(btn, count);
    } else {
        document.getElementById(SETTINGSBAR_BTN)?.remove();
    }
}

function removeChromeButtons() {
    document.getElementById(TITLEBAR_BTN)?.remove();
    document.getElementById(SETTINGSBAR_BTN)?.remove();
}

// ────────────────────────────────────────────────────────────────────────────
//  CSS
// ────────────────────────────────────────────────────────────────────────────
function injectCss() {
    const s = el("style", { id: STYLE_ID });
    s.textContent = `
@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap');

#${ROOT_ID}, #${ROOT_ID} * { box-sizing: border-box; font-family: ${T.font}; }
#${ROOT_ID} { position: fixed; inset: 0; z-index: 10000; pointer-events: none; }
#${ROOT_ID} button { font-family: ${T.font}; }

/* ── Floating orb button ────────────────────────────────────────────── */
@keyframes qc-orb { 0%,100% { box-shadow: 0 8px 30px rgba(168,85,247,.45), 0 0 0 0 rgba(168,85,247,.45);} 50% { box-shadow: 0 12px 40px rgba(168,85,247,.65), 0 0 0 14px rgba(168,85,247,0);} }
@keyframes qc-pop { 0% { transform: scale(0) rotate(-25deg); opacity:0;} 70% { transform: scale(1.12) rotate(4deg); opacity:1;} 100% { transform: scale(1) rotate(0);} }
@keyframes qc-spin { to { transform: rotate(360deg);} }

#qc-fab {
    position: fixed; bottom: 26px; right: 26px; width: 58px; height: 58px;
    border-radius: 20px; border: 1px solid rgba(255,255,255,.18);
    background: linear-gradient(135deg, ${T.accentBright}, ${T.accent} 55%, ${T.accentDeep});
    color: #fff; font-weight: 700; font-size: 17px; letter-spacing:.5px;
    cursor: pointer; pointer-events: auto; display: none;
    align-items: center; justify-content: center;
    backdrop-filter: blur(8px);
    transition: transform .22s cubic-bezier(.34,1.56,.64,1), filter .2s, border-radius .3s;
    animation: qc-pop .5s cubic-bezier(.34,1.56,.64,1) both, qc-orb 3.2s ease-in-out infinite 1s;
}
#qc-fab:hover { transform: translateY(-4px) scale(1.06); filter: brightness(1.08); border-radius: 26px; }
#qc-fab:active { transform: translateY(-1px) scale(.94); }
#qc-fab.qc-working { background: linear-gradient(135deg, #34d399, ${T.ok} 60%, #16a34a); }
#qc-fab.qc-working::after {
    content:""; position:absolute; inset:-1px; border-radius:inherit;
    border:2px solid transparent; border-top-color: rgba(255,255,255,.9);
    animation: qc-spin .8s linear infinite;
}
#qc-fab .qc-fab-cog {
    position:absolute; top:-6px; right:-6px; width:22px; height:22px; border-radius:50%;
    background:${T.chrome}; border:1px solid ${T.line2}; color:${T.dim};
    font-size:11px; display:flex; align-items:center; justify-content:center;
    transition: transform .3s, color .2s; opacity:0;
}
#qc-fab:hover .qc-fab-cog { opacity:1; }
#qc-fab .qc-fab-cog:hover { color:${T.accentBright}; transform: rotate(90deg); }

/* ── Toasts ─────────────────────────────────────────────────────────── */
#qc-toasts { position: fixed; bottom: 200px; right: 26px; display:flex; flex-direction:column; gap:10px; align-items:flex-end; pointer-events:none; }
.qc-toast {
    pointer-events:auto; cursor:pointer; min-width:220px; max-width:340px;
    display:flex; align-items:center; gap:12px; padding:12px 16px;
    background: rgba(18,18,27,.82); backdrop-filter: blur(16px) saturate(1.3);
    border:1px solid ${T.line}; border-left:3px solid var(--qc-tc);
    border-radius:14px; color:${T.text}; font-size:13.5px; font-weight:500;
    box-shadow: 0 14px 40px rgba(0,0,0,.55);
    transform: translateX(120%); opacity:0;
    transition: transform .42s cubic-bezier(.22,1,.36,1), opacity .35s;
}
.qc-toast.qc-in { transform: translateX(0); opacity:1; }
.qc-toast.qc-out { transform: translateX(120%); opacity:0; }
.qc-toast-icon { flex:0 0 22px; width:22px; height:22px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; color:#fff; background:var(--qc-tc); box-shadow:0 0 14px -2px var(--qc-tc); }
.qc-toast-text { line-height:1.35; }

/* ── HUD ────────────────────────────────────────────────────────────── */
#qc-hud {
    position: fixed; bottom: 96px; right: 26px; width: 320px;
    background: rgba(18,18,27,.85); backdrop-filter: blur(18px) saturate(1.2);
    border:1px solid ${T.line}; border-radius:18px; padding:16px 18px;
    box-shadow: 0 18px 50px rgba(0,0,0,.6); pointer-events:auto;
    transform: translateY(40%) scale(.96); opacity:0;
    transition: transform .5s cubic-bezier(.22,1,.36,1), opacity .4s;
}
#qc-hud.qc-show { transform: translateY(0) scale(1); opacity:1; }
#qc-hud .qc-hud-top { display:flex; align-items:center; gap:10px; margin-bottom:4px; }
#qc-hud .qc-dot { width:8px; height:8px; border-radius:50%; background:${T.ok}; box-shadow:0 0 10px ${T.ok}; animation: qc-orb 2s infinite; }
#qc-hud .qc-hud-title { color:${T.text}; font-weight:600; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; }
#qc-hud .qc-hud-pct { color:${T.accentBright}; font-weight:700; font-size:13px; }
#qc-hud .qc-hud-sub { color:${T.dim}; font-size:12px; margin-bottom:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
#qc-hud .qc-track { height:8px; border-radius:99px; background: rgba(255,255,255,.07); overflow:hidden; position:relative; }
#qc-hud .qc-fill {
    height:100%; width:0%; border-radius:99px;
    background: linear-gradient(90deg, ${T.accentDeep}, ${T.accent}, ${T.accentBright});
    background-size: 200% 100%;
    box-shadow: 0 0 14px -2px ${T.accent};
    transition: width .6s cubic-bezier(.22,1,.36,1);
    animation: qc-sheen 2.4s linear infinite;
}
@keyframes qc-sheen { to { background-position: -200% 0; } }
#qc-hud.qc-indeterminate .qc-fill { width:40% !important; animation: qc-indet 1.3s ease-in-out infinite, qc-sheen 2.4s linear infinite; }
@keyframes qc-indet { 0% { margin-left:-40%; } 100% { margin-left:100%; } }

/* ── Modals (captcha + settings) ────────────────────────────────────── */
.qc-modal-overlay {
    position: fixed; inset:0; pointer-events:auto;
    background: rgba(5,5,9,.55); backdrop-filter: blur(6px);
    display:flex; align-items:center; justify-content:center;
    opacity:0; transition: opacity .3s;
}
.qc-modal-overlay.qc-in { opacity:1; }
.qc-modal, .qc-settings {
    width: 420px; max-width: 92vw; background: ${T.chrome};
    border:1px solid ${T.line2}; border-radius:22px; padding:26px;
    box-shadow: 0 30px 80px rgba(0,0,0,.7), 0 0 60px -20px ${T.accent};
    transform: translateY(18px) scale(.96); opacity:0;
    transition: transform .42s cubic-bezier(.22,1,.36,1), opacity .35s;
    color:${T.text};
}
.qc-modal-overlay.qc-in .qc-modal, .qc-modal-overlay.qc-in .qc-settings { transform: translateY(0) scale(1); opacity:1; }
.qc-modal-badge { width:48px; height:48px; border-radius:16px; display:flex; align-items:center; justify-content:center; font-size:22px; background: rgba(168,85,247,.16); border:1px solid ${T.line2}; margin-bottom:14px; }
.qc-modal-title { font-size:19px; font-weight:700; margin-bottom:8px; }
.qc-modal-body { font-size:13.5px; color:${T.dim}; line-height:1.55; margin-bottom:20px; }
.qc-modal-row { display:flex; gap:10px; justify-content:flex-end; }

.qc-btn-primary {
    padding:10px 18px; border-radius:12px; border:1px solid transparent; cursor:pointer;
    background: linear-gradient(135deg, ${T.accentBright}, ${T.accent} 55%, ${T.accentDeep});
    color:#fff; font-weight:600; font-size:13.5px;
    transition: transform .18s cubic-bezier(.34,1.56,.64,1), filter .2s, box-shadow .2s;
    box-shadow: 0 6px 20px -6px ${T.accent};
}
.qc-btn-primary:hover { transform: translateY(-2px); filter:brightness(1.08); box-shadow: 0 10px 26px -6px ${T.accent}; }
.qc-btn-primary:active { transform: translateY(0) scale(.97); }
.qc-btn-ghost {
    padding:10px 18px; border-radius:12px; cursor:pointer;
    background: rgba(255,255,255,.05); border:1px solid ${T.line}; color:${T.dim}; font-weight:500; font-size:13.5px;
    transition: background .2s, color .2s, transform .18s;
}
.qc-btn-ghost:hover { background: rgba(255,255,255,.09); color:${T.text}; transform: translateY(-1px); }

/* ── Settings panel ─────────────────────────────────────────────────── */
.qc-settings-head { display:flex; align-items:center; gap:14px; margin-bottom:22px; }
.qc-logo { width:46px; height:46px; border-radius:14px; display:flex; align-items:center; justify-content:center; font-weight:800; color:#fff; background: linear-gradient(135deg, ${T.accentBright}, ${T.accentDeep}); box-shadow:0 8px 24px -6px ${T.accent}; }
.qc-settings-title { font-size:17px; font-weight:700; }
.qc-settings-sub { font-size:12px; color:${T.dim}; }
.qc-x { margin-left:auto; width:30px; height:30px; border-radius:9px; background:rgba(255,255,255,.05); border:1px solid ${T.line}; color:${T.dim}; cursor:pointer; transition: all .2s; }
.qc-x:hover { background:rgba(251,93,106,.16); color:${T.danger}; border-color:rgba(251,93,106,.4); }
.qc-row { display:flex; align-items:center; gap:14px; padding:14px 0; border-bottom:1px solid rgba(255,255,255,.06); }
.qc-row:last-of-type { border-bottom:none; }
.qc-row-text { flex:1; }
.qc-row-title { font-size:14px; font-weight:600; margin-bottom:3px; }
.qc-row-desc { font-size:12px; color:${T.dim}; line-height:1.4; }
.qc-switch { position:relative; width:46px; height:26px; border-radius:99px; background:rgba(255,255,255,.10); border:1px solid ${T.line}; cursor:pointer; flex:0 0 46px; transition: background .3s, border-color .3s; }
.qc-switch.on { background: linear-gradient(135deg, ${T.accent}, ${T.accentDeep}); border-color: transparent; box-shadow:0 0 16px -4px ${T.accent}; }
.qc-knob { position:absolute; top:2px; left:2px; width:20px; height:20px; border-radius:50%; background:#fff; box-shadow:0 2px 6px rgba(0,0,0,.4); transition: transform .32s cubic-bezier(.34,1.56,.64,1); }
.qc-switch.on .qc-knob { transform: translateX(20px); }
.qc-settings-foot { display:flex; align-items:center; justify-content:space-between; margin-top:18px; }
.qc-foot-note { font-size:11.5px; color:${T.dim}; }

/* settings body scroll + sections */
.qc-settings { display:flex; flex-direction:column; max-height: min(80vh, 720px); }
.qc-settings-body { overflow-y:auto; margin:-4px -8px 0; padding:0 8px; flex:1; }
.qc-settings-body::-webkit-scrollbar { width:8px; }
.qc-settings-body::-webkit-scrollbar-thumb { background:rgba(168,85,247,.4); border-radius:99px; }
.qc-settings-body::-webkit-scrollbar-track { background:transparent; }
.qc-section { margin-bottom:8px; }
.qc-section-title { font-size:11px; font-weight:700; letter-spacing:.8px; text-transform:uppercase; color:${T.accentBright}; margin:16px 0 4px; opacity:.9; }
.qc-row-stack { display:flex; flex-direction:column; gap:10px; width:100%; }

/* segmented control (menu filter) */
.qc-seg { display:flex; gap:6px; background:rgba(255,255,255,.04); padding:4px; border-radius:12px; border:1px solid ${T.line}; }
.qc-seg-opt { flex:1; padding:7px 8px; border-radius:9px; border:none; cursor:pointer; font-size:12px; font-weight:600; color:${T.dim}; background:transparent; transition: all .22s cubic-bezier(.34,1.56,.64,1); }
.qc-seg-opt:hover { color:${T.text}; background:rgba(255,255,255,.05); }
.qc-seg-opt.on { color:#fff; background: linear-gradient(135deg, ${T.accent}, ${T.accentDeep}); box-shadow:0 4px 14px -4px ${T.accent}; }

/* shared badge */
.qc-badge {
    display:flex; align-items:center; justify-content:center;
    min-width:18px; height:18px; padding:0 5px; border-radius:99px;
    background:${T.danger}; color:#fff; font-size:11px; font-weight:700; line-height:1;
    box-shadow:0 0 0 2px ${T.bg};
}
.qc-fab-badge { position:absolute; top:-7px; left:-7px; box-shadow:0 0 0 2px ${T.chrome}, 0 2px 8px rgba(0,0,0,.5); }

/* chrome (title bar / settings bar) buttons — live outside #qc-root */
.qc-chrome-btn {
    position:relative; display:inline-flex; align-items:center; justify-content:center;
    height:32px; min-width:32px; padding:0 9px; margin:0 4px; border-radius:9px;
    border:1px solid ${T.line2}; cursor:pointer; font-family:${T.font};
    background: linear-gradient(135deg, ${T.accentBright}, ${T.accent} 55%, ${T.accentDeep});
    color:#fff; font-weight:700; font-size:12px; letter-spacing:.4px;
    transition: transform .18s cubic-bezier(.34,1.56,.64,1), filter .2s, box-shadow .2s;
    box-shadow:0 4px 14px -6px ${T.accent};
    -webkit-app-region: no-drag;
}
.qc-chrome-btn:hover { transform:translateY(-1px) scale(1.04); filter:brightness(1.1); box-shadow:0 8px 20px -6px ${T.accent}; }
.qc-chrome-btn:active { transform:scale(.94); }
.qc-chrome-btn.qc-chrome-sm { height:28px; min-width:28px; margin:0 2px; }
.qc-chrome-btn .qc-badge { position:absolute; top:-6px; right:-6px; box-shadow:0 0 0 2px ${T.chrome}; }
`;
    document.head.appendChild(s);
}

// ────────────────────────────────────────────────────────────────────────────
//  Plugin definition
// ────────────────────────────────────────────────────────────────────────────
export default definePlugin({
    name: "Quest Auto Completer",
    description:
        "Completes Discord quests with a sleek themed UI — auto-claim, captcha-aware claiming, game/activity quest support, and a settings panel.",
    authors: [{ name: "Aseoriy", id: 0n }],
    settings,

    start() {
        injectCss();

        const root = el("div", { id: ROOT_ID });

        // Floating button
        const fab = el("button", { id: "qc-fab", className: "qc-idle" });
        fab.append(
            "QC",
            el("div", { className: "qc-fab-cog", textContent: "⚙" }),
            el("span", { className: "qc-badge qc-fab-badge", textContent: "0" })
        );
        const cog = fab.querySelector(".qc-fab-cog") as HTMLDivElement;
        cog.onclick = e => { e.stopPropagation(); openSettings(); };
        fab.onclick = () => runEngine(fab);

        // Toast host
        toastHost = el("div", { id: "qc-toasts" });

        // HUD
        const hudRoot = el("div", { id: "qc-hud" });
        const top = el("div", { className: "qc-hud-top" });
        const hTitle = el("div", { className: "qc-hud-title", textContent: "Idle" });
        const hPct = el("div", { className: "qc-hud-pct" });
        top.append(el("div", { className: "qc-dot" }), hTitle, hPct);
        const hSub = el("div", { className: "qc-hud-sub", textContent: "" });
        const track = el("div", { className: "qc-track" });
        const fill = el("div", { className: "qc-fill" });
        track.append(fill);
        hudRoot.append(top, hSub, track);
        hud = { root: hudRoot, title: hTitle, sub: hSub, bar: fill, pct: hPct };

        root.append(fab, toastHost, hudRoot);
        document.body.appendChild(root);

        // ── Smart visibility + chrome buttons + badges (lightweight tick) ────
        let autoStarted = false;
        const tick = () => {
            const onQuests = isOnQuests();

            // Floating orb
            fab.style.display = onQuests && settings.store.showButton ? "flex" : "none";
            syncBadge(fab, eligibleCount());

            // Progress HUD (only shows on the Quests screen unless overridden)
            applyHudVisibility();

            // Title bar + settings bar buttons (mount/unmount + badges)
            mountChromeButtons();

            // Auto-start
            if (onQuests && settings.store.autoStart && !autoStarted && !isRunning) {
                autoStarted = true;
                setTimeout(() => runEngine(fab), 1200);
            }
            if (!onQuests) autoStarted = false;
        };
        const interval = setInterval(tick, 1000);
        tick();

        log("started ✦");

        cleanup = () => {
            clearInterval(interval);
            root.remove();
            removeChromeButtons();
            document.getElementById(STYLE_ID)?.remove();
            toastHost = null;
            hud = null;
            isRunning = false;
        };
    },

    stop() {
        cleanup?.();
        cleanup = null;
    }
});
