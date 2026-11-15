/**
 * @name Pac-Mans Utilities
 * @author the.pacman.is.back
 * @authorId 280218268038463489
 * @version 3.0.16
 * @description Automatically copies User IDs and highlights voice users using cascading rule priority, multi-role checks, and exception role bypasses with manual role ID entry or a searchable in-field role picker, custom rule labeling, and individual server preset import/export.
 * @updateUrl https://raw.githubusercontent.com/xFadedxShadow/Pac-Mans-Utilities/master/Pac-Mans%20Utilities.plugin.js
 * @source https://github.com/xFadedxShadow/Pac-Mans-Utilities/tree/master
 */

// Testing the updateURL inside discord.

const rgbaCache = new Map();
const hexToRgba = (hex, alpha) => {
    const key = `${hex}_${alpha}`;
    if (rgbaCache.has(key)) return rgbaCache.get(key);
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const num = parseInt(c, 16);
    const result = `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
    rgbaCache.set(key, result);
    return result;
};

// Memoized string -> Set parsing for $O(1)$ membership lookups instead of $O(N)$ array searches.
const parsedIdsCache = new Map();
const parseIdsSet = (str) => {
    const key = String(str || "");
    if (parsedIdsCache.has(key)) return parsedIdsCache.get(key);
    const result = new Set(key.split(/[\s,]+/).filter(Boolean));
    parsedIdsCache.set(key, result);
    return result;
};

const getFiber = (node) => {
    const key = Object.keys(node).find(k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    return key ? node[key] : null;
};

const isMac = typeof navigator !== 'undefined' && (/Mac|iPod|iPhone|iPad/.test(navigator.platform) || navigator.userAgent.includes('Macintosh'));

module.exports = class PacMansUtilities {
    constructor() {
        this.defaultSettings = { presets: [] };
        this.settings = {};
        this.highlightInterval = null;
        this.listener = null;
        this.lastChannelId = null;
        this.knownUsers = new Set();
        this.memberRequestTimestamps = new Map();
        this.MEMBER_REQUEST_COOLDOWN = 10000;
        this.appliedHighlightState = new WeakMap();
        this.loadSettings();
    }

    loadSettings() {
        const raw = BdApi.Data.load("PacMansUtilities", "settings");
        if (!raw) {
            this.settings = JSON.parse(JSON.stringify(this.defaultSettings));
            return;
        }
        this.normalizeSettings(raw);
        this.settings = raw;
        if (!this.settings.presets) this.settings.presets = [];
        BdApi.Data.save("PacMansUtilities", "settings", this.settings);
    }

    normalizeSettings(obj) {
        if (!obj || typeof obj !== "object") return;
        if (!Array.isArray(obj.presets)) {
            obj.presets = [];
        }
        for (let i = 0; i < obj.presets.length; i++) {
            this.normalizePreset(obj.presets[i]);
        }
    }

    normalizePreset(p) {
        if (!p || typeof p !== "object") return;
        if (p.collapsed === undefined) p.collapsed = false;
        if (p.enabled === undefined) p.enabled = true;
        if (p.guildId === undefined) p.guildId = "";
        if (p.roleId && !p.rules) {
            p.rules = [{ name: "", roleIds: p.roleId, exceptionRoleIds: "", condition: "lacks_any", highlightColor: "#f04747", enabled: true, copyId: true }];
            delete p.roleId;
        }
        if (Array.isArray(p.rules)) {
            for (let j = 0; j < p.rules.length; j++) {
                const r = p.rules[j];
                if (!r || typeof r !== "object") continue;
                if (r.name === undefined) r.name = "";
                if (r.roleIds === undefined) { r.roleIds = r.roleId || ""; delete r.roleId; }
                if (r.exceptionRoleIds === undefined) r.exceptionRoleIds = "";
                if (r.copyId === undefined) r.copyId = true;
                if (!r.highlightColor) r.highlightColor = "#f04747";
                if (!r.condition) r.condition = "lacks_any";
                if (r.condition === "missing") r.condition = "lacks_any";
                if (r.condition === "has") r.condition = "has_all";
                if (r.enabled === undefined) r.enabled = true;
            }
        } else {
            p.rules = [];
        }
    }

    start() {
        const wp = BdApi.Webpack;
        this.SelectedChannelStore = wp.getStore("SelectedChannelStore") || wp.getModule(m => m?.getVoiceChannelId);
        this.VoiceStateStore = wp.getStore("VoiceStateStore") || wp.getModule(m => m?.getVoiceStates && m?.addChangeListener);
        this.UserStore = wp.getStore("UserStore") || wp.getModule(m => m?.getCurrentUser);
        this.ChannelStore = wp.getStore("ChannelStore") || wp.getModule(m => m?.getChannel);
        this.GuildMemberStore = wp.getStore("GuildMemberStore") || wp.getModule(m => m?.getMember);
        this.GuildStore = wp.getStore("GuildStore") || wp.getModule(m => m?.getGuild);
        this.GuildActions = wp.getStore("GuildActions") || wp.getModule(m => m?.requestMembers);
        this.ensureRoleStore();

        if (!this.SelectedChannelStore || !this.VoiceStateStore || !this.UserStore) {
            BdApi.UI.showToast("Pac-Mans Utilities: Failed to locate required Discord stores.", { type: "error" });
            return;
        }

        this.lastChannelId = this.SelectedChannelStore.getVoiceChannelId();
        this.knownUsers = new Set(this.getCurrentChannelUsers());

        this.listener = () => {
            const currentChannelId = this.SelectedChannelStore.getVoiceChannelId();
            if (currentChannelId !== this.lastChannelId) {
                this.lastChannelId = currentChannelId;
                this.knownUsers = new Set(this.getCurrentChannelUsers());
                this.updateAllVCHighlights();
                return;
            }
            if (!currentChannelId) {
                this.updateAllVCHighlights();
                return;
            }

            const currentUsers = this.getCurrentChannelUsers();
            const currentUserId = this.UserStore.getCurrentUser()?.id;
            const channel = this.ChannelStore?.getChannel?.(currentChannelId);
            const guildId = channel?.guild_id;

            const serverConfig = (guildId && this.settings.presets) ? this.settings.presets.find(p => p.guildId === guildId && p.enabled) : null;

            for (const userId of currentUsers) {
                if (!this.knownUsers.has(userId) && userId !== currentUserId) {
                    const user = this.UserStore.getUser(userId);
                    if (!user || user.bot || user.system) continue;

                    const name = user.globalName || user.username || userId;
                    let shouldCopy = false;

                    if (serverConfig && serverConfig.rules) {
                        for (const rule of serverConfig.rules) {
                            if (!rule.enabled || !rule.roleIds) continue;
                            const member = this.getGuildMember(guildId, userId);
                            if (this.evaluateRule(member, rule)) {
                                if (rule.copyId) shouldCopy = true;
                                break;
                            }
                        }
                    }

                    if (shouldCopy) {
                        this.copyToClipboard(userId);
                        BdApi.UI.showToast(`Copied ID for ${name}: ${userId}`, { type: "success" });
                    }
                }
            }

            this.knownUsers = new Set(currentUsers);
            this.updateAllVCHighlights();
        };

        this.VoiceStateStore.addChangeListener(this.listener);
        this.highlightInterval = setInterval(() => this.updateAllVCHighlights(), 1000);
    }

    stop() {
        if (this.VoiceStateStore && this.listener) this.VoiceStateStore.removeChangeListener(this.listener);
        if (this.highlightInterval) clearInterval(this.highlightInterval);
        this.clearAllHighlights();
        this.memberRequestTimestamps.clear();
    }

    getGuildMember(guildId, userId) {
        let member = this.GuildMemberStore?.getMember?.(guildId, userId);
        if (!member && this.GuildActions?.requestMembers) {
            const key = `${guildId}:${userId}`;
            const now = Date.now();
            const last = this.memberRequestTimestamps.get(key) || 0;
            if (now - last > this.MEMBER_REQUEST_COOLDOWN) {
                this.memberRequestTimestamps.set(key, now);
                this.GuildActions.requestMembers(guildId, [userId]);
                this.pruneMemberRequestTimestamps(now);
            }
            member = this.GuildMemberStore?.getMember?.(guildId, userId);
        }
        return member;
    }

    pruneMemberRequestTimestamps(now) {
        if (this.memberRequestTimestamps.size < 500) return;
        for (const [key, ts] of this.memberRequestTimestamps) {
            if (now - ts > this.MEMBER_REQUEST_COOLDOWN * 5) {
                this.memberRequestTimestamps.delete(key);
            }
        }
    }

    evaluateRule(member, rule) {
        const memberRoles = member?.roles || member?.roleIds;
        if (!memberRoles) return false;

        // Convert member roles array to a fast lookup Set once per evaluation
        const memberRoleSet = new Set(
            Array.isArray(memberRoles) 
                ? memberRoles.map(r => (typeof r === "string" ? r : r?.id)).filter(Boolean)
                : []
        );

        const exceptionIdsSet = parseIdsSet(rule.exceptionRoleIds);
        if (exceptionIdsSet.size > 0) {
            for (const excId of exceptionIdsSet) {
                if (memberRoleSet.has(excId)) return false;
            }
        }

        const roleIdsSet = parseIdsSet(rule.roleIds);
        if (roleIdsSet.size === 0) return false;

        const condition = rule.condition || "lacks_any";

        switch (condition) {
            case "has_all": {
                for (const id of roleIdsSet) {
                    if (!memberRoleSet.has(id)) return false;
                }
                return true;
            }
            case "has_any": {
                for (const id of roleIdsSet) {
                    if (memberRoleSet.has(id)) return true;
                }
                return false;
            }
            case "lacks_all": {
                for (const id of roleIdsSet) {
                    if (memberRoleSet.has(id)) return false;
                }
                return true;
            }
            case "lacks_any":
            case "missing":
            default: {
                for (const id of roleIdsSet) {
                    if (!memberRoleSet.has(id)) return true;
                }
                return false;
            }
        }
    }

    clearAllHighlights() {
        const elements = document.querySelectorAll('[class*="voiceUser"]');
        for (let i = 0, len = elements.length; i < len; i++) {
            const div = elements[i];
            const targetEl = div.querySelector('[class*="content"]') || div.querySelector('[class*="avatar"]') || div;
            if (targetEl) this.resetElementStyle(targetEl);
        }
    }

    getNodeInfo(node) {
        let userId = null;
        let guildId = null;
        let fiber = getFiber(node);
        while (fiber && (!userId || !guildId)) {
            const props = fiber.memoizedProps || fiber.props;
            if (props) {
                if (!userId) {
                    if (props.user?.id) userId = props.user.id;
                    else if (props.userId) userId = props.userId;
                    else if (props.message?.author?.id) userId = props.message.author.id;
                }
                if (!guildId) {
                    if (props.guildId) guildId = props.guildId;
                    else if (props.channel?.guild_id) guildId = props.channel.guild_id;
                    else if (props.channelId) {
                        const ch = this.ChannelStore?.getChannel?.(props.channelId);
                        if (ch?.guild_id) guildId = ch.guild_id;
                    }
                }
            }
            fiber = fiber.return;
        }
        return { userId, guildId };
    }

    updateAllVCHighlights() {
        if (!this.settings.presets || this.settings.presets.length === 0) {
            this.clearAllHighlights();
            return;
        }

        const currentChannelId = this.SelectedChannelStore?.getVoiceChannelId?.();
        let defaultGuildId = currentChannelId ? this.ChannelStore?.getChannel?.(currentChannelId)?.guild_id : null;
        if (!defaultGuildId) {
            const SelectedGuildStore = BdApi.Webpack.getStore("SelectedGuildStore");
            defaultGuildId = SelectedGuildStore?.getGuildId?.();
        }

        const voiceUsers = document.querySelectorAll('[class*="voiceUser"]');
        for (let i = 0, len = voiceUsers.length; i < len; i++) {
            const div = voiceUsers[i];
            const { userId, guildId: nodeGuildId } = this.getNodeInfo(div);
            const targetEl = div.querySelector('[class*="content"]') || div.querySelector('[class*="avatar"]') || div;
            if (!targetEl) continue;

            if (userId) {
                const user = this.UserStore?.getUser?.(userId);
                if (!user || user.bot || user.system) {
                    this.resetElementStyle(targetEl);
                    continue;
                }

                const guildId = nodeGuildId || defaultGuildId;
                if (!guildId) {
                    this.resetElementStyle(targetEl);
                    continue;
                }

                const serverConfig = this.settings.presets.find(p => p.guildId === guildId && p.enabled);
                if (!serverConfig || !serverConfig.rules || serverConfig.rules.length === 0) {
                    this.resetElementStyle(targetEl);
                    continue;
                }

                const member = this.getGuildMember(guildId, userId);
                let primaryColor = null;

                for (let j = 0, rLen = serverConfig.rules.length; j < rLen; j++) {
                    const rule = serverConfig.rules[j];
                    if (rule.enabled && rule.roleIds && this.evaluateRule(member, rule)) {
                        primaryColor = rule.highlightColor || "#f04747";
                        break;
                    }
                }

                if (primaryColor) {
                    this.applyHighlightStyle(targetEl, primaryColor);
                } else {
                    this.resetElementStyle(targetEl);
                }
            } else {
                this.resetElementStyle(targetEl);
            }
        }
    }

    applyHighlightStyle(el, color) {
        if (this.appliedHighlightState.get(el) === color) return;
        this.appliedHighlightState.set(el, color);

        el.style.boxShadow = `inset 0 0 0 2px ${color}`;
        el.style.backgroundColor = hexToRgba(color, 0.2);
        el.style.borderRadius = "4px";
        if (isMac) {
            el.style.webkitTransform = "translateZ(0)";
            el.style.transform = "translateZ(0)";
            el.style.webkitBackfaceVisibility = "hidden";
            el.style.backfaceVisibility = "hidden";
        }
    }

    resetElementStyle(el) {
        if (this.appliedHighlightState.get(el) === null) return;
        this.appliedHighlightState.set(el, null);

        el.style.backgroundColor = "";
        el.style.boxShadow = "";
        el.style.borderRadius = "";
        if (isMac) {
            el.style.webkitTransform = "";
            el.style.transform = "";
            el.style.webkitBackfaceVisibility = "";
            el.style.backfaceVisibility = "";
        }
    }

    getCurrentChannelUsers() {
        const channelId = this.SelectedChannelStore?.getVoiceChannelId?.();
        if (!channelId) return [];
        const states = this.VoiceStateStore?.getVoiceStatesForChannel?.(channelId) || {};
        return Object.keys(states);
    }

    copyToClipboard(text) {
        if (window.DiscordNative?.clipboard?.copy) window.DiscordNative.clipboard.copy(text);
        else if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text);
    }

    getCurrentActiveGuildId() {
        const currentChannelId = this.SelectedChannelStore?.getVoiceChannelId?.();
        if (currentChannelId) {
            const channel = this.ChannelStore?.getChannel?.(currentChannelId);
            if (channel?.guild_id) return channel.guild_id;
        }
        const SelectedGuildStore = BdApi.Webpack.getStore("SelectedGuildStore");
        return SelectedGuildStore?.getGuildId?.() || null;
    }

    ensureRoleStore() {
        if (this.GuildRoleStore) return;
        const wp = BdApi.Webpack;
        this.GuildRoleStore = wp.getStore("GuildRoleStore") || wp.getModule(m => m?.getRolesSnapshot && m?.getRole);
    }

    getGuildRoles(guildId) {
        this.ensureRoleStore();
        if (!guildId) return [];

        let rolesObj = null;
        if (this.GuildRoleStore?.getRolesSnapshot) {
            rolesObj = this.GuildRoleStore.getRolesSnapshot(guildId);
        } else if (this.GuildRoleStore?.getRoles) {
            rolesObj = this.GuildRoleStore.getRoles(guildId);
        }

        if (!rolesObj) {
            const guild = this.GuildStore?.getGuild?.(guildId);
            rolesObj = guild?.roles || null;
        }

        return rolesObj ? Object.values(rolesObj).filter(Boolean) : [];
    }

    injectRolePickerStyles() {
        const existing = document.getElementById("pmu-rp-styles");
        if (existing) existing.remove();
        const style = document.createElement("style");
        style.id = "pmu-rp-styles";
        style.textContent = `
            .pmu-rp-overlay {
                position: fixed;
                inset: 0;
                background: rgba(0, 0, 0, 0.7);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10000;
                color-scheme: dark;
            }
            .pmu-rp-modal {
                background: #313338 !important;
                color: #f2f3f5 !important;
                width: min(640px, 92vw);
                max-height: 80vh;
                border-radius: 10px;
                border: 1px solid #1e1f22;
                display: flex;
                flex-direction: column;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
                overflow: hidden;
                font-family: var(--font-primary, "gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif);
            }
            .pmu-rp-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                padding: 14px 16px;
                background: #2b2d31;
                border-bottom: 1px solid #1e1f22;
                flex-shrink: 0;
            }
            .pmu-rp-title {
                font-size: 15px;
                font-weight: 700;
                color: #ffffff !important;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .pmu-rp-close {
                background: transparent;
                border: none;
                color: #b5bac1 !important;
                font-size: 16px;
                cursor: pointer;
                padding: 4px 8px;
                border-radius: 4px;
                flex-shrink: 0;
            }
            .pmu-rp-close:hover {
                background: #3f4147;
                color: #ffffff !important;
            }
            .pmu-rp-count {
                font-size: 11px;
                font-weight: 700;
                color: #b5bac1 !important;
                white-space: nowrap;
                text-transform: uppercase;
                letter-spacing: 0.03em;
            }
            .pmu-rp-grid-wrap {
                overflow-y: auto;
                padding: 12px 16px;
                flex: 1;
                background: #313338;
            }
            .pmu-rp-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
                gap: 8px;
            }
            .pmu-rp-empty {
                grid-column: 1 / -1;
                text-align: center;
                color: #949ba4 !important;
                font-size: 13px;
                padding: 20px 0;
            }
            .pmu-rp-cell {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px 10px;
                background: #2b2d31 !important;
                border: 1px solid #1e1f22;
                border-radius: 6px;
                cursor: pointer;
                min-width: 0;
                transition: background 0.1s ease, border-color 0.1s ease;
            }
            .pmu-rp-cell:hover {
                background: #35373c !important;
            }
            .pmu-rp-cell-checked {
                border-color: #5865f2 !important;
                background: #3f4147 !important;
            }
            .pmu-rp-dot {
                width: 10px;
                height: 10px;
                border-radius: 50%;
                flex-shrink: 0;
            }
            .pmu-rp-text {
                display: flex;
                flex-direction: column;
                min-width: 0;
                overflow: hidden;
            }
            .pmu-rp-name {
                font-size: 12.5px;
                font-weight: 600;
                color: #f2f3f5 !important;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .pmu-rp-id {
                font-size: 10px;
                color: #949ba4 !important;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .pmu-rp-footer {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 12px 16px;
                background: #2b2d31;
                border-top: 1px solid #1e1f22;
                flex-shrink: 0;
            }
            .pmu-rp-checkbox {
                width: 17px;
                height: 17px;
                margin: 0;
                cursor: pointer;
                accent-color: #5865f2;
                flex-shrink: 0;
            }
            .pmu-rp-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                border: none;
                border-radius: 6px;
                font-weight: 600;
                line-height: 1.2;
                cursor: pointer;
                white-space: nowrap;
                flex-shrink: 0;
                -webkit-appearance: none;
                appearance: none;
            }
        `;
        document.head.appendChild(style);
    }

    openRolePicker(guildId, inputEl) {
        if (!guildId) {
            BdApi.UI.showToast("Set a Server for this config before picking roles.", { type: "error" });
            return;
        }

        const roles = this.getGuildRoles(guildId).sort((a, b) => (b.position ?? 0) - (a.position ?? 0));
        if (roles.length === 0) {
            BdApi.UI.showToast("No roles found for this server yet. Open the server in Discord, then try again.", { type: "error" });
            return;
        }

        this.injectRolePickerStyles();

        const selected = new Set(parseIdsSet(inputEl.value));

        const overlay = document.createElement("div");
        overlay.className = "pmu-rp-overlay";

        const modal = document.createElement("div");
        modal.className = "pmu-rp-modal";
        overlay.appendChild(modal);

        const closeModal = () => {
            overlay.remove();
            document.removeEventListener("keydown", onKeyDown);
        };
        const onKeyDown = (e) => { if (e.key === "Escape") closeModal(); };
        document.addEventListener("keydown", onKeyDown);
        overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };

        const header = document.createElement("div");
        header.className = "pmu-rp-header";

        const guild = this.GuildStore?.getGuild?.(guildId);
        const titleEl = document.createElement("span");
        titleEl.className = "pmu-rp-title";
        titleEl.innerText = guild?.name ? `Select Roles — ${guild.name}` : "Select Roles";
        header.appendChild(titleEl);

        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "pmu-rp-close";
        closeBtn.innerText = "✕";
        closeBtn.onclick = closeModal;
        header.appendChild(closeBtn);
        modal.appendChild(header);

        const gridWrap = document.createElement("div");
        gridWrap.className = "pmu-rp-grid-wrap";
        const grid = document.createElement("div");
        grid.className = "pmu-rp-grid";
        gridWrap.appendChild(grid);
        modal.appendChild(gridWrap);

        const footer = document.createElement("div");
        footer.className = "pmu-rp-footer";

        const clearBtn = document.createElement("button");
        clearBtn.type = "button";
        clearBtn.className = "pmu-rp-btn";
        clearBtn.innerText = "Clear All";
        clearBtn.style.cssText = "background: transparent; color: #f23f43 !important; font-size: 12px; padding: 8px 12px;";
        
        const countLabel = document.createElement("span");
        countLabel.className = "pmu-rp-count";
        countLabel.style.marginLeft = "8px";

        const updateCount = () => {
            countLabel.innerText = `${selected.size} selected`;
        };

        const cellEntries = [];
        const fragment = document.createDocumentFragment();

        roles.forEach(role => {
            const cell = document.createElement("label");
            cell.className = "pmu-rp-cell";

            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.className = "pmu-rp-checkbox";
            checkbox.checked = selected.has(role.id);
            cell.appendChild(checkbox);

            const colorInt = role.color;
            const colorHex = colorInt ? `#${colorInt.toString(16).padStart(6, "0")}` : "#99aab5";
            const dot = document.createElement("span");
            dot.className = "pmu-rp-dot";
            dot.style.background = colorHex;
            cell.appendChild(dot);

            const textWrap = document.createElement("span");
            textWrap.className = "pmu-rp-text";

            const nameSpan = document.createElement("span");
            nameSpan.className = "pmu-rp-name";
            nameSpan.innerText = role.name || "unknown-role";
            textWrap.appendChild(nameSpan);

            const idSpan = document.createElement("span");
            idSpan.className = "pmu-rp-id";
            idSpan.innerText = role.id;
            textWrap.appendChild(idSpan);

            cell.appendChild(textWrap);

            const setChecked = (checked) => {
                checkbox.checked = checked;
                cell.classList.toggle("pmu-rp-cell-checked", checked);
            };
            setChecked(checkbox.checked);

            checkbox.onchange = () => {
                if (checkbox.checked) selected.add(role.id);
                else selected.delete(role.id);
                setChecked(checkbox.checked);
                updateCount();
            };

            cellEntries.push({ el: cell, setChecked });
            fragment.appendChild(cell);
        });

        grid.appendChild(fragment);

        clearBtn.onclick = () => {
            selected.clear();
            cellEntries.forEach(({ setChecked }) => setChecked(false));
            updateCount();
        };
        footer.appendChild(clearBtn);
        footer.appendChild(countLabel);

        const spacer = document.createElement("div");
        spacer.style.flex = "1";
        footer.appendChild(spacer);

        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "pmu-rp-btn";
        cancelBtn.innerText = "Cancel";
        cancelBtn.style.cssText = "background: #3f4147 !important; color: #f2f3f5 !important; font-size: 13px; padding: 8px 16px;";
        cancelBtn.onclick = closeModal;
        footer.appendChild(cancelBtn);

        const applyBtn = document.createElement("button");
        applyBtn.type = "button";
        applyBtn.className = "pmu-rp-btn";
        applyBtn.innerText = "Apply";
        applyBtn.style.cssText = "background: #5865f2 !important; color: #ffffff !important; font-size: 13px; padding: 8px 16px;";
        applyBtn.onclick = () => {
            inputEl.value = Array.from(selected).join(", ");
            inputEl.dispatchEvent(new Event("input", { bubbles: true }));
            closeModal();
        };
        footer.appendChild(applyBtn);

        modal.appendChild(footer);
        updateCount();

        document.body.appendChild(overlay);
    }

    getSettingsPanel() {
        this.ensureRoleStore();
        const panel = document.createElement("div");
        panel.className = `pmu-settings-root ${isMac ? "pmu-os-mac" : "pmu-os-desktop"}`;
        panel.style.cssText = "box-sizing: border-box; width: 100%; max-width: 100%; margin: 0 auto; color: var(--text-normal); font-family: var(--font-primary); font-size: clamp(13px, 1vw, 14px); line-height: 1.4; -webkit-font-smoothing: antialiased; container-type: inline-size; container-name: pmu-panel;";

        const scopedStyles = document.createElement("style");
        scopedStyles.textContent = `
            .pmu-settings-root *, .pmu-settings-root *::before, .pmu-settings-root *::after {
                box-sizing: border-box;
                font-family: inherit;
            }
            .pmu-settings-root.pmu-os-mac {
                padding: clamp(10px, 2vw, 16px);
                width: 100%;
                height: 100%;
                min-width: 380px;
                min-height: 280px;
                max-width: 100vw;
                max-height: 90vh;
                resize: both;
                overflow: auto;
                position: relative;
                contain: layout style;
            }
            .pmu-settings-root.pmu-os-desktop {
                padding: clamp(14px, 2.5vw, 28px);
                max-width: min(1200px, 100%);
            }
            .pmu-header-box {
                background: var(--background-secondary-alt);
                border: 1px solid var(--background-tertiary);
                border-radius: 12px;
                padding: clamp(14px, 2vw, 18px) clamp(16px, 2.2vw, 20px);
                margin-bottom: clamp(14px, 2vw, 20px);
            }
            .pmu-card {
                background: var(--background-secondary);
                border: 1px solid var(--background-tertiary);
                border-radius: 10px;
                padding: clamp(12px, 1.8vw, 16px) clamp(14px, 2vw, 18px);
                display: flex;
                flex-direction: column;
                gap: clamp(10px, 1.5vw, 14px);
                box-shadow: 0 2px 5px rgba(0,0,0,0.1);
                width: 100%;
                min-width: 0;
            }
            .pmu-rule-row {
                background: var(--background-secondary-alt);
                padding: clamp(10px, 1.5vw, 12px);
                border-radius: 8px;
                border: 1px solid var(--background-tertiary);
                display: flex;
                flex-wrap: wrap;
                gap: clamp(8px, 1.2vw, 10px);
                align-items: flex-end;
                width: 100%;
                min-width: 0;
            }
            .pmu-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                border: none;
                border-radius: 6px;
                font-weight: 600;
                line-height: 1.2;
                cursor: pointer;
                white-space: nowrap;
                flex-shrink: 0;
                -webkit-appearance: none;
                appearance: none;
                transition: opacity 0.15s ease, background 0.15s ease;
            }
            .pmu-btn:disabled {
                cursor: not-allowed;
                opacity: 0.4;
            }
            .pmu-input, .pmu-select {
                width: 100%;
                min-width: 0;
                height: 32px;
                padding: 0 10px;
                background: var(--input-background, #202225);
                color: var(--text-normal, #dcddde);
                border: 1px solid var(--input-border, rgba(255, 255, 255, 0.08));
                border-radius: 5px;
                font-size: 12px;
                line-height: 30px;
                outline: none;
                margin: 0;
                -webkit-appearance: none;
                appearance: none;
            }
            .pmu-input:focus, .pmu-select:focus {
                border-color: var(--brand-experiment, #5865f2);
            }
            .pmu-select {
                padding-right: 26px;
                background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23b9bbbe' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
                background-repeat: no-repeat;
                background-position: right 8px center;
                background-size: 13px;
                cursor: pointer;
            }
            .pmu-color {
                width: 32px;
                height: 32px;
                padding: 0;
                margin: 0;
                border: 1px solid var(--input-border, rgba(255, 255, 255, 0.12));
                border-radius: 5px;
                background: transparent;
                cursor: pointer;
                overflow: hidden;
                -webkit-appearance: none;
                appearance: none;
            }
            .pmu-color::-webkit-color-swatch-wrapper {
                padding: 0;
            }
            .pmu-color::-webkit-color-swatch {
                border: none;
                border-radius: 4px;
            }
            .pmu-checkbox {
                width: 17px;
                height: 17px;
                margin: 0;
                cursor: pointer;
                accent-color: var(--brand-experiment, #5865f2);
                flex-shrink: 0;
            }
            .pmu-label {
                display: block;
                font-size: 10px;
                font-weight: 700;
                line-height: 1.2;
                color: var(--text-muted);
                text-transform: uppercase;
                letter-spacing: 0.03em;
                margin-bottom: 5px;
                white-space: nowrap;
            }
            .pmu-field-name { flex: 1 1 100px; min-width: 90px; }
            .pmu-field-ids { flex: 1.5 1 130px; min-width: 110px; }
            .pmu-field-cond { flex: 1.2 1 120px; min-width: 110px; }
            .pmu-trailing-group {
                display: flex;
                align-items: flex-end;
                gap: 10px;
                flex-shrink: 0;
                margin-left: auto;
            }
            .pmu-field-ids-wrap {
                position: relative;
                width: 100%;
            }
            .pmu-input-with-btn {
                padding-right: 32px;
            }
            .pmu-inline-pick-btn {
                position: absolute;
                right: 3px;
                top: 50%;
                transform: translateY(-50%);
                width: 24px;
                height: 24px;
                padding: 0;
                font-size: 14px;
                font-weight: 700;
                line-height: 1;
                border: none;
                border-radius: 4px;
                background: var(--background-modifier-selected);
                color: var(--interactive-active);
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
            }
            .pmu-inline-pick-btn:hover {
                background: var(--background-modifier-hover);
            }
            @container pmu-panel (max-width: 720px) {
                .pmu-field-name, .pmu-field-ids, .pmu-field-cond {
                    flex: 1 1 calc(50% - 8px);
                    min-width: 120px;
                }
                .pmu-trailing-group {
                    width: 100%;
                    justify-content: flex-end;
                    padding-top: 6px;
                    border-top: 1px solid var(--background-tertiary);
                    margin-left: 0;
                }
            }
            @container pmu-panel (max-width: 480px) {
                .pmu-field-name, .pmu-field-ids, .pmu-field-cond {
                    flex: 1 1 100%;
                    min-width: 0;
                }
            }
        `;
        panel.appendChild(scopedStyles);

        const header = document.createElement("div");
        header.className = "pmu-header-box";
        header.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap;">
                <span style="font-size: clamp(18px, 1.5vw, 20px); line-height: 1;">🛡️</span>
                <h2 style="color: var(--header-primary); font-size: clamp(16px, 1.4vw, 18px); font-weight: 700; margin: 0; line-height: 1.3;">Pac-Mans Utilities - Server Rules</h2>
            </div>
            <p style="color: var(--text-muted); font-size: clamp(12px, 1vw, 13px); line-height: 1.5; margin: 0;">
                Configure server presets, label your rules, and type or paste Role IDs directly — or use the "+" inside the field to pick roles from a list. Use ⬆️ / ⬇️ to reorder priority. Export or import individual server configurations below.
            </p>
        `;
        panel.appendChild(header);

        const toolbar = document.createElement("div");
        toolbar.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 10px;";

        const toolbarLeft = document.createElement("div");
        toolbarLeft.style.cssText = "display: flex; gap: 10px; align-items: center; flex-wrap: wrap;";

        const addBtn = document.createElement("button");
        addBtn.className = "pmu-btn";
        addBtn.innerHTML = '<span style="font-size: 16px; font-weight: bold; line-height: 1;">+</span><span>Add Server Config</span>';
        addBtn.style.cssText = "background: var(--button-primary-background, #5865f2); color: white; padding: 8px 14px; font-size: 13px;";
        addBtn.onmouseover = () => addBtn.style.background = "var(--button-primary-background-hover, #4752c4)";
        addBtn.onmouseout = () => addBtn.style.background = "var(--button-primary-background, #5865f2)";
        addBtn.onclick = () => {
            this.settings.presets.push({ guildId: "", enabled: true, collapsed: false, rules: [{ name: "", roleIds: "", exceptionRoleIds: "", condition: "lacks_any", highlightColor: "#f04747", enabled: true, copyId: true }] });
            BdApi.Data.save("PacMansUtilities", "settings", this.settings);
            renderPresets();
        };
        toolbarLeft.appendChild(addBtn);
        toolbar.appendChild(toolbarLeft);

        const toolbarRight = document.createElement("div");
        toolbarRight.style.cssText = "display: flex; gap: 10px; align-items: center; flex-wrap: wrap;";

        const importSingleInput = document.createElement("input");
        importSingleInput.type = "file";
        importSingleInput.accept = ".json";
        importSingleInput.style.cssText = "display: none;";
        importSingleInput.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const parsed = JSON.parse(event.target.result);
                    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                        this.normalizePreset(parsed);
                        this.settings.presets.push(parsed);
                        BdApi.Data.save("PacMansUtilities", "settings", this.settings);
                        renderPresets();
                        this.updateAllVCHighlights();
                        BdApi.UI.showToast("Server configuration imported successfully!", { type: "success" });
                    } else {
                        BdApi.UI.showToast("Invalid server preset configuration format.", { type: "error" });
                    }
                } catch (err) {
                    BdApi.UI.showToast("Failed to parse JSON configuration file.", { type: "error" });
                } finally {
                    importSingleInput.value = "";
                }
            };
            reader.readAsText(file);
        };
        panel.appendChild(importSingleInput);

        const importBtn = document.createElement("button");
        importBtn.className = "pmu-btn";
        importBtn.innerText = "📥 Import Server Config";
        importBtn.style.cssText = "background: var(--background-modifier-selected); color: var(--interactive-active); padding: 8px 14px; font-size: 13px;";
        importBtn.onclick = () => importSingleInput.click();
        toolbarRight.appendChild(importBtn);

        toolbar.appendChild(toolbarRight);
        panel.appendChild(toolbar);

        const container = document.createElement("div");
        container.style.cssText = "display: flex; flex-direction: column; gap: 16px; width: 100%; min-width: 0;";
        panel.appendChild(container);

        const renderPresets = () => {
            container.innerHTML = "";
            if (this.settings.presets.length === 0) {
                const emptyState = document.createElement("div");
                emptyState.style.cssText = "padding: 32px 16px; text-align: center; background: var(--background-secondary); border: 2px dashed var(--background-modifier-accent); border-radius: 12px; color: var(--text-muted); font-size: 13px;";
                emptyState.innerHTML = `
                    <div style="font-size: 28px; margin-bottom: 8px; line-height: 1;">📂</div>
                    <div style="font-weight: 600; color: var(--header-secondary); margin-bottom: 4px;">No server configs added yet</div>
                    <div>Click '+ Add Server Config' or '📥 Import Server Config' above to get started!</div>
                `;
                container.appendChild(emptyState);
                return;
            }

            const fragment = document.createDocumentFragment();

            this.settings.presets.forEach((serverPreset, pIndex) => {
                if (serverPreset.collapsed === undefined) serverPreset.collapsed = false;

                const card = document.createElement("div");
                card.className = "pmu-card";

                const cardHeader = document.createElement("div");
                cardHeader.style.cssText = "display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--background-tertiary); padding-bottom: 10px; cursor: pointer; user-select: none; flex-wrap: wrap; gap: 10px;";

                const guildInfoWrapper = document.createElement("div");
                guildInfoWrapper.style.cssText = "display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1 1 200px;";

                const guild = this.GuildStore?.getGuild?.(serverPreset.guildId);
                const guildName = guild?.name;

                let guildIconUrl = null;
                if (guild) {
                    if (typeof guild.getIconURL === "function") {
                        guildIconUrl = guild.getIconURL();
                    } else if (guild.icon) {
                        guildIconUrl = `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.${guild.icon.startsWith("a_") ? "gif" : "png"}?size=128`;
                    }
                }

                const iconImg = document.createElement("img");
                iconImg.style.cssText = "width: clamp(36px, 3vw, 44px); height: clamp(36px, 3vw, 44px); border-radius: 50%; object-fit: cover; background: var(--background-tertiary); flex-shrink: 0;";
                iconImg.src = guildIconUrl || "https://cdn.discordapp.com/embed/avatars/0.png";
                guildInfoWrapper.appendChild(iconImg);

                const statusDot = document.createElement("span");
                statusDot.style.cssText = `width: 9px; height: 9px; border-radius: 50%; background: ${guildName ? "var(--status-positive, #3ba55d)" : "var(--status-warning, #faa61a)"}; display: inline-block; flex-shrink: 0;`;
                guildInfoWrapper.appendChild(statusDot);

                const titleSpan = document.createElement("span");
                titleSpan.style.cssText = "font-size: 14px; font-weight: 700; color: var(--header-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
                titleSpan.innerText = guildName ? `Server: ${guildName}` : (serverPreset.guildId ? "Server: [Unrecognized ID]" : "New Server Config");
                guildInfoWrapper.appendChild(titleSpan);

                const collapseIndicator = document.createElement("span");
                collapseIndicator.style.cssText = "font-size: 11px; color: var(--text-muted); margin-left: 4px; white-space: nowrap; flex-shrink: 0;";
                collapseIndicator.innerText = serverPreset.collapsed ? "▶ (Collapsed)" : "▼ (Expanded)";
                guildInfoWrapper.appendChild(collapseIndicator);

                cardHeader.appendChild(guildInfoWrapper);

                const actionGroup = document.createElement("div");
                actionGroup.style.cssText = "display: flex; align-items: center; gap: 6px; flex-wrap: wrap; flex-shrink: 0;";

                const moveUpBtn = document.createElement("button");
                moveUpBtn.className = "pmu-btn";
                moveUpBtn.innerText = "⬆️";
                moveUpBtn.disabled = pIndex === 0;
                moveUpBtn.style.cssText = "background: var(--background-modifier-selected); color: var(--interactive-active); font-size: 12px; padding: 6px 8px;";
                moveUpBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (pIndex > 0) {
                        const temp = this.settings.presets[pIndex];
                        this.settings.presets[pIndex] = this.settings.presets[pIndex - 1];
                        this.settings.presets[pIndex - 1] = temp;
                        BdApi.Data.save("PacMansUtilities", "settings", this.settings);
                        renderPresets();
                    }
                };
                actionGroup.appendChild(moveUpBtn);

                const moveDownBtn = document.createElement("button");
                moveDownBtn.className = "pmu-btn";
                moveDownBtn.innerText = "⬇️";
                moveDownBtn.disabled = pIndex === this.settings.presets.length - 1;
                moveDownBtn.style.cssText = "background: var(--background-modifier-selected); color: var(--interactive-active); font-size: 12px; padding: 6px 8px;";
                moveDownBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (pIndex < this.settings.presets.length - 1) {
                        const temp = this.settings.presets[pIndex];
                        this.settings.presets[pIndex] = this.settings.presets[pIndex + 1];
                        this.settings.presets[pIndex + 1] = temp;
                        BdApi.Data.save("PacMansUtilities", "settings", this.settings);
                        renderPresets();
                    }
                };
                actionGroup.appendChild(moveDownBtn);

                const quickFillBtn = document.createElement("button");
                quickFillBtn.className = "pmu-btn";
                quickFillBtn.innerText = "📍 Use Current";
                quickFillBtn.style.cssText = "background: var(--background-modifier-selected); color: var(--interactive-active); font-size: 12px; padding: 6px 10px;";
                quickFillBtn.onclick = (e) => {
                    e.stopPropagation();
                    const currentGuildId = this.getCurrentActiveGuildId();
                    if (currentGuildId) {
                        serverPreset.guildId = currentGuildId;
                        BdApi.Data.save("PacMansUtilities", "settings", this.settings);
                        renderPresets();
                        BdApi.UI.showToast("Applied current server ID!", { type: "success" });
                    } else {
                        BdApi.UI.showToast("Could not detect active server.", { type: "error" });
                    }
                };
                actionGroup.appendChild(quickFillBtn);

                const exportPresetBtn = document.createElement("button");
                exportPresetBtn.className = "pmu-btn";
                exportPresetBtn.innerText = "📤";
                exportPresetBtn.title = "Export Server Config";
                exportPresetBtn.style.cssText = "background: var(--background-modifier-selected); color: var(--interactive-active); font-size: 12px; padding: 6px 8px;";
                exportPresetBtn.onclick = (e) => {
                    e.stopPropagation();
                    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(serverPreset, null, 2));
                    const downloadAnchor = document.createElement("a");
                    downloadAnchor.setAttribute("href", dataStr);
                    downloadAnchor.setAttribute("download", `pac-mans-utilities-config-${serverPreset.guildId || 'unnamed'}-${Date.now()}.json`);
                    document.body.appendChild(downloadAnchor);
                    downloadAnchor.click();
                    downloadAnchor.remove();
                    BdApi.UI.showToast("Server configuration exported successfully!", { type: "success" });
                };
                actionGroup.appendChild(exportPresetBtn);

                const deleteBtn = document.createElement("button");
                deleteBtn.className = "pmu-btn";
                deleteBtn.innerText = "🗑️";
                deleteBtn.style.cssText = "background: transparent; color: var(--status-danger, #f04747); font-size: 14px; padding: 6px 8px;";
                deleteBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.settings.presets.splice(pIndex, 1);
                    BdApi.Data.save("PacMansUtilities", "settings", this.settings);
                    renderPresets();
                };
                actionGroup.appendChild(deleteBtn);
                cardHeader.appendChild(actionGroup);

                cardHeader.onclick = () => {
                    serverPreset.collapsed = !serverPreset.collapsed;
                    BdApi.Data.save("PacMansUtilities", "settings", this.settings);
                    renderPresets();
                };

                card.appendChild(cardHeader);

                if (!serverPreset.collapsed) {
                    const serverTopRow = document.createElement("div");
                    serverTopRow.style.cssText = "display: flex; gap: 12px; align-items: center; background: var(--background-tertiary); padding: 10px 12px; border-radius: 8px; flex-wrap: wrap;";

                    const guildWrapper = document.createElement("div");
                    guildWrapper.style.cssText = "display: flex; flex-direction: column; flex: 1 1 200px; min-width: 0;";
                    guildWrapper.innerHTML = '<label class="pmu-label" style="color: var(--header-secondary);">Server</label>';

                    const guildSelect = document.createElement("select");
                    guildSelect.className = "pmu-select";

                    const defaultOpt = document.createElement("option");
                    defaultOpt.value = "";
                    defaultOpt.innerText = "-- Select a Server --";
                    guildSelect.appendChild(defaultOpt);

                    const guilds = this.GuildStore?.getGuilds ? Object.values(this.GuildStore.getGuilds()) : [];
                    guilds.sort((a, b) => a.name.localeCompare(b.name)).forEach(g => {
                        const opt = document.createElement("option");
                        opt.value = g.id;
                        opt.innerText = g.name;
                        if (g.id === serverPreset.guildId) opt.selected = true;
                        guildSelect.appendChild(opt);
                    });

                    guildSelect.onchange = (e) => {
                        serverPreset.guildId = e.target.value.trim();
                        BdApi.Data.save("PacMansUtilities", "settings", this.settings);
                        renderPresets();
                    };
                    guildWrapper.appendChild(guildSelect);
                    serverTopRow.appendChild(guildWrapper);

                    const serverToggleWrapper = document.createElement("div");
                    serverToggleWrapper.style.cssText = "display: flex; flex-direction: column; align-items: center; justify-content: center; flex-shrink: 0;";
                    serverToggleWrapper.innerHTML = '<label class="pmu-label" style="color: var(--header-secondary);">Server Enabled</label>';

                    const switchBox = document.createElement("div");
                    switchBox.style.cssText = "height: 32px; display: flex; align-items: center; justify-content: center;";
                    const sSwitch = document.createElement("input");
                    sSwitch.type = "checkbox";
                    sSwitch.className = "pmu-checkbox";
                    sSwitch.checked = serverPreset.enabled;
                    sSwitch.onchange = (e) => {
                        serverPreset.enabled = e.target.checked;
                        BdApi.Data.save("PacMansUtilities", "settings", this.settings);
                    };
                    switchBox.appendChild(sSwitch);
                    serverToggleWrapper.appendChild(switchBox);
                    serverTopRow.appendChild(serverToggleWrapper);
                    card.appendChild(serverTopRow);

                    const rulesHeader = document.createElement("div");
                    rulesHeader.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-top: 2px; flex-wrap: wrap; gap: 8px;";
                    rulesHeader.innerHTML = '<span style="font-size: 12px; font-weight: 700; color: var(--header-secondary); text-transform: uppercase;">Role Rules (Top to Bottom Priority)</span>';

                    const addRuleBtn = document.createElement("button");
                    addRuleBtn.className = "pmu-btn";
                    addRuleBtn.innerText = "+ Add Role Rule";
                    addRuleBtn.style.cssText = "background: var(--background-modifier-selected); color: var(--interactive-active); font-size: 12px; padding: 6px 12px;";
                    addRuleBtn.onclick = () => {
                        if (!serverPreset.rules) serverPreset.rules = [];
                        serverPreset.rules.push({ name: "", roleIds: "", exceptionRoleIds: "", condition: "lacks_any", highlightColor: "#f04747", enabled: true, copyId: true });
                        BdApi.Data.save("PacMansUtilities", "settings", this.settings);
                        renderPresets();
                    };
                    rulesHeader.appendChild(addRuleBtn);
                    card.appendChild(rulesHeader);

                    const rulesList = document.createElement("div");
                    rulesList.style.cssText = "display: flex; flex-direction: column; gap: 10px; width: 100%; min-width: 0;";

                    if (!serverPreset.rules || serverPreset.rules.length === 0) {
                        const noRules = document.createElement("div");
                        noRules.style.cssText = "padding: 12px; text-align: center; color: var(--text-muted); font-size: 13px; font-style: italic;";
                        noRules.innerText = "No role rules added for this server yet.";
                        rulesList.appendChild(noRules);
                    } else {
                        serverPreset.rules.forEach((rule, rIndex) => {
                            const ruleBox = document.createElement("div");
                            ruleBox.className = "pmu-rule-row";

                            const orderGroup = document.createElement("div");
                            orderGroup.style.cssText = "display: flex; gap: 4px; align-items: center; height: 32px; flex-shrink: 0;";

                            const rMoveUp = document.createElement("button");
                            rMoveUp.className = "pmu-btn";
                            rMoveUp.innerText = "⬆️";
                            rMoveUp.disabled = rIndex === 0;
                            rMoveUp.title = "Move Rule Up";
                            rMoveUp.style.cssText = "background: var(--background-modifier-selected); color: var(--interactive-active); font-size: 11px; width: 28px; height: 32px; padding: 0;";
                            rMoveUp.onclick = () => {
                                if (rIndex > 0) {
                                    const temp = serverPreset.rules[rIndex];
                                    serverPreset.rules[rIndex] = serverPreset.rules[rIndex - 1];
                                    serverPreset.rules[rIndex - 1] = temp;
                                    BdApi.Data.save("PacMansUtilities", "settings", this.settings);
                                    renderPresets();
                                }
                            };
                            orderGroup.appendChild(rMoveUp);

                            const rMoveDown = document.createElement("button");
                            rMoveDown.className = "pmu-btn";
                            rMoveDown.innerText = "⬇️";
                            rMoveDown.disabled = rIndex === serverPreset.rules.length - 1;
                            rMoveDown.title = "Move Rule Down";
                            rMoveDown.style.cssText = "background: var(--background-modifier-selected); color: var(--interactive-active); font-size: 11px; width: 28px; height: 32px; padding: 0;";
                            rMoveDown.onclick = () => {
                                if (rIndex < serverPreset.rules.length - 1) {
                                    const temp = serverPreset.rules[rIndex];
                                    serverPreset.rules[rIndex] = serverPreset.rules[rIndex + 1];
                                    serverPreset.rules[rIndex + 1] = temp;
                                    BdApi.Data.save("PacMansUtilities", "settings", this.settings);
                                    renderPresets();
                                }
                            };
                            orderGroup.appendChild(rMoveDown);
                            ruleBox.appendChild(orderGroup);

                            const nameWrapper = document.createElement("div");
                            nameWrapper.className = "pmu-field-name";
                            nameWrapper.style.cssText = "display: flex; flex-direction: column;";
                            nameWrapper.innerHTML = '<label class="pmu-label">Rule Label</label>';

                            const nameInput = document.createElement("input");
                            nameInput.type = "text";
                            nameInput.className = "pmu-input";
                            nameInput.value = rule.name || "";
                            nameInput.placeholder = "e.g. VIP Pass";
                            nameInput.oninput = (e) => {
                                rule.name = e.target.value;
                                BdApi.Data.save("PacMansUtilities", "settings", this.settings);
                            };
                            nameWrapper.appendChild(nameInput);
                            ruleBox.appendChild(nameWrapper);

                            const targetWrapper = document.createElement("div");
                            targetWrapper.className = "pmu-field-ids";
                            targetWrapper.style.cssText = "display: flex; flex-direction: column;";
                            targetWrapper.innerHTML = '<label class="pmu-label">Target Role ID(s)</label>';

                            const targetFieldWrap = document.createElement("div");
                            targetFieldWrap.className = "pmu-field-ids-wrap";

                            const roleInput = document.createElement("input");
                            roleInput.type = "text";
                            roleInput.className = "pmu-input pmu-input-with-btn";
                            roleInput.value = rule.roleIds || "";
                            roleInput.placeholder = "e.g. 1234567890";
                            roleInput.oninput = (e) => {
                                rule.roleIds = e.target.value;
                                BdApi.Data.save("PacMansUtilities", "settings", this.settings);
                            };
                            targetFieldWrap.appendChild(roleInput);

                            const targetPickerBtn = document.createElement("button");
                            targetPickerBtn.type = "button";
                            targetPickerBtn.className = "pmu-inline-pick-btn";
                            targetPickerBtn.innerText = "+";
                            targetPickerBtn.title = "Pick roles from this server";
                            targetPickerBtn.onclick = () => this.openRolePicker(serverPreset.guildId, roleInput);
                            targetFieldWrap.appendChild(targetPickerBtn);

                            targetWrapper.appendChild(targetFieldWrap);
                            ruleBox.appendChild(targetWrapper);

                            const excWrapper = document.createElement("div");
                            excWrapper.className = "pmu-field-ids";
                            excWrapper.style.cssText = "display: flex; flex-direction: column;";
                            excWrapper.innerHTML = '<label class="pmu-label">Exception Role ID(s)</label>';

                            const excFieldWrap = document.createElement("div");
                            excFieldWrap.className = "pmu-field-ids-wrap";

                            const excInput = document.createElement("input");
                            excInput.type = "text";
                            excInput.className = "pmu-input pmu-input-with-btn";
                            excInput.value = rule.exceptionRoleIds || "";
                            excInput.placeholder = "e.g. 1122334455";
                            excInput.oninput = (e) => {
                                rule.exceptionRoleIds = e.target.value;
                                BdApi.Data.save("PacMansUtilities", "settings", this.settings);
                            };
                            excFieldWrap.appendChild(excInput);

                            const excPickerBtn = document.createElement("button");
                            excPickerBtn.type = "button";
                            excPickerBtn.className = "pmu-inline-pick-btn";
                            excPickerBtn.innerText = "+";
                            excPickerBtn.title = "Pick roles from this server";
                            excPickerBtn.onclick = () => this.openRolePicker(serverPreset.guildId, excInput);
                            excFieldWrap.appendChild(excPickerBtn);

                            excWrapper.appendChild(excFieldWrap);
                            ruleBox.appendChild(excWrapper);

                            const cWrapper = document.createElement("div");
                            cWrapper.className = "pmu-field-cond";
                            cWrapper.style.cssText = "display: flex; flex-direction: column;";
                            cWrapper.innerHTML = '<label class="pmu-label">Condition</label>';

                            const cSelect = document.createElement("select");
                            cSelect.className = "pmu-select";
                            cSelect.innerHTML = `
                                <option value="lacks_any" ${rule.condition === "lacks_any" ? "selected" : ""}>User Lacks Any</option>
                                <option value="lacks_all" ${rule.condition === "lacks_all" ? "selected" : ""}>User Lacks All</option>
                                <option value="has_any" ${rule.condition === "has_any" ? "selected" : ""}>User Has Any</option>
                                <option value="has_all" ${rule.condition === "has_all" ? "selected" : ""}>User Has All</option>
                            `;
                            cSelect.onchange = (e) => {
                                rule.condition = e.target.value;
                                BdApi.Data.save("PacMansUtilities", "settings", this.settings);
                            };
                            cWrapper.appendChild(cSelect);
                            ruleBox.appendChild(cWrapper);

                            const trailingControls = document.createElement("div");
                            trailingControls.className = "pmu-trailing-group";

                            const colWrapper = document.createElement("div");
                            colWrapper.style.cssText = "display: flex; flex-direction: column; align-items: center;";
                            colWrapper.innerHTML = '<label class="pmu-label">Color</label>';

                            const colInput = document.createElement("input");
                            colInput.type = "color";
                            colInput.className = "pmu-color";
                            colInput.value = rule.highlightColor || "#f04747";
                            colInput.oninput = (e) => {
                                rule.highlightColor = e.target.value;
                                BdApi.Data.save("PacMansUtilities", "settings", this.settings);
                            };
                            colWrapper.appendChild(colInput);
                            trailingControls.appendChild(colWrapper);

                            const copyWrapper = document.createElement("div");
                            copyWrapper.style.cssText = "display: flex; flex-direction: column; align-items: center;";
                            copyWrapper.innerHTML = '<label class="pmu-label" title="Copy User ID when triggered">Copy ID</label>';

                            const copyBox = document.createElement("div");
                            copyBox.style.cssText = "height: 32px; display: flex; align-items: center; justify-content: center;";
                            const copyCheck = document.createElement("input");
                            copyCheck.type = "checkbox";
                            copyCheck.className = "pmu-checkbox";
                            copyCheck.checked = rule.copyId !== false;
                            copyCheck.onchange = (e) => {
                                rule.copyId = e.target.checked;
                                BdApi.Data.save("PacMansUtilities", "settings", this.settings);
                            };
                            copyBox.appendChild(copyCheck);
                            copyWrapper.appendChild(copyBox);
                            trailingControls.appendChild(copyWrapper);

                            const activeWrapper = document.createElement("div");
                            activeWrapper.style.cssText = "display: flex; flex-direction: column; align-items: center;";
                            activeWrapper.innerHTML = '<label class="pmu-label" title="Enable or Disable Rule">Active</label>';

                            const activeBox = document.createElement("div");
                            activeBox.style.cssText = "height: 32px; display: flex; align-items: center; justify-content: center;";
                            const rCheck = document.createElement("input");
                            rCheck.type = "checkbox";
                            rCheck.className = "pmu-checkbox";
                            rCheck.checked = rule.enabled !== false;
                            rCheck.onchange = (e) => {
                                rule.enabled = e.target.checked;
                                BdApi.Data.save("PacMansUtilities", "settings", this.settings);
                            };
                            activeBox.appendChild(rCheck);
                            activeWrapper.appendChild(activeBox);
                            trailingControls.appendChild(activeWrapper);

                            const delBox = document.createElement("div");
                            delBox.style.cssText = "height: 32px; display: flex; align-items: center; justify-content: center;";
                            const rDel = document.createElement("button");
                            rDel.className = "pmu-btn";
                            rDel.innerText = "❌";
                            rDel.title = "Delete Rule";
                            rDel.style.cssText = "background: transparent; font-size: 12px; width: 28px; height: 32px; padding: 0;";
                            rDel.onclick = () => {
                                serverPreset.rules.splice(rIndex, 1);
                                BdApi.Data.save("PacMansUtilities", "settings", this.settings);
                                renderPresets();
                            };
                            delBox.appendChild(rDel);
                            trailingControls.appendChild(delBox);

                            ruleBox.appendChild(trailingControls);
                            rulesList.appendChild(ruleBox);
                        });
                    }

                    card.appendChild(rulesList);
                }

                fragment.appendChild(card);
            });

            container.appendChild(fragment);
        };

        renderPresets();
        return panel;
    }
};
