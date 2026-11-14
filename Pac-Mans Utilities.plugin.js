/**
 * @name Pac-Mans Utilities
 * @author the.pacman.is.back
 * @authorId 280218268038463489
 * @version 3.0.3
 * @description Automatically copies User IDs and highlights voice users using cascading rule priority, multi-role checks, and exception role bypasses with manual role ID entry, custom rule labeling, and individual server preset import/export.
 */

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

const parseIds = (str) => String(str || "").split(/[\s,]+/).filter(Boolean);

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
    }

    getGuildMember(guildId, userId) {
        let member = this.GuildMemberStore?.getMember?.(guildId, userId);
        if (!member && this.GuildActions?.requestMembers) {
            this.GuildActions.requestMembers(guildId, [userId]);
            member = this.GuildMemberStore?.getMember?.(guildId, userId);
        }
        return member;
    }

    evaluateRule(member, rule) {
        const memberRoles = member?.roles || member?.roleIds;
        if (!memberRoles) return false;

        const exceptionIdsArr = parseIds(rule.exceptionRoleIds);
        if (exceptionIdsArr.length > 0) {
            if (exceptionIdsArr.some(excId => memberRoles.some(r => (typeof r === "string" ? r === excId : r?.id === excId)))) {
                return false;
            }
        }

        const roleIdsArr = parseIds(rule.roleIds);
        if (roleIdsArr.length === 0) return false;

        const condition = rule.condition || "lacks_any";
        const hasRole = (targetId) => memberRoles.some(r => (typeof r === "string" ? r === targetId : r?.id === targetId));

        switch (condition) {
            case "has_all":
                return roleIdsArr.every(hasRole);
            case "has_any":
                return roleIdsArr.some(hasRole);
            case "lacks_all":
                return roleIdsArr.every(id => !hasRole(id));
            case "lacks_any":
            case "missing":
            default:
                return roleIdsArr.some(id => !hasRole(id));
        }
    }

    clearAllHighlights() {
        const elements = document.querySelectorAll('[class*="voiceUser"]');
        for (let i = 0; i < elements.length; i++) {
            const div = elements[i];
            const targetEl = div.querySelector('[class*="content"]') || div.querySelector('[class*="avatar"]') || div;
            if (targetEl) this.resetElementStyle(targetEl);
        }
    }

    getGuildIdFromNode(node) {
        let fiber = getFiber(node);
        while (fiber) {
            const props = fiber.memoizedProps || fiber.props;
            if (props) {
                if (props.guildId) return props.guildId;
                if (props.channel?.guild_id) return props.channel.guild_id;
                if (props.channelId) {
                    const ch = this.ChannelStore?.getChannel?.(props.channelId);
                    if (ch?.guild_id) return ch.guild_id;
                }
            }
            fiber = fiber.return;
        }
        return null;
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
        for (let i = 0; i < voiceUsers.length; i++) {
            const div = voiceUsers[i];
            const userId = this.extractUserIdFromNode(div);
            const targetEl = div.querySelector('[class*="content"]') || div.querySelector('[class*="avatar"]') || div;
            if (!targetEl) continue;

            if (userId) {
                const user = this.UserStore?.getUser?.(userId);
                if (!user || user.bot || user.system) {
                    this.resetElementStyle(targetEl);
                    continue;
                }

                const guildId = this.getGuildIdFromNode(div) || defaultGuildId;
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

                for (let j = 0; j < serverConfig.rules.length; j++) {
                    const rule = serverConfig.rules[j];
                    if (rule.enabled && rule.roleIds && this.evaluateRule(member, rule)) {
                        primaryColor = rule.highlightColor || "#f04747";
                        break;
                    }
                }

                if (primaryColor) {
                    targetEl.style.boxShadow = `inset 0 0 0 2px ${primaryColor}`;
                    targetEl.style.backgroundColor = hexToRgba(primaryColor, 0.2);
                    targetEl.style.borderRadius = "4px";
                    if (isMac) {
                        targetEl.style.webkitTransform = "translateZ(0)";
                        targetEl.style.transform = "translateZ(0)";
                        targetEl.style.webkitBackfaceVisibility = "hidden";
                        targetEl.style.backfaceVisibility = "hidden";
                    }
                } else {
                    this.resetElementStyle(targetEl);
                }
            } else {
                this.resetElementStyle(targetEl);
            }
        }
    }

    resetElementStyle(el) {
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

    extractUserIdFromNode(node) {
        let fiber = getFiber(node);
        while (fiber) {
            const props = fiber.memoizedProps || fiber.props;
            if (props) {
                if (props.user?.id) return props.user.id;
                if (props.userId) return props.userId;
                if (props.message?.author?.id) return props.message.author.id;
            }
            fiber = fiber.return;
        }
        return null;
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

    // --- SETTINGS PANEL UI (Cross-OS Responsive Architecture) ---
    getSettingsPanel() {
        const panel = document.createElement("div");
        panel.className = "pmu-settings-root";
        panel.style.cssText = `box-sizing: border-box; width: 100%; max-width: 1100px; padding: clamp(14px, 2.5vw, 28px); color: var(--text-normal); font-family: var(--font-primary); font-size: 14px; line-height: 1.4; -webkit-font-smoothing: antialiased; ${isMac ? 'contain: layout style paint; position: relative;' : ''}`;

        const scopedStyles = document.createElement("style");
        scopedStyles.textContent = `
            .pmu-settings-root *, .pmu-settings-root *::before, .pmu-settings-root *::after {
                box-sizing: border-box;
                font-family: inherit;
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
        `;
        panel.appendChild(scopedStyles);

        const header = document.createElement("div");
        header.style.cssText = "background: var(--background-secondary-alt); border: 1px solid var(--background-tertiary); border-radius: 12px; padding: 18px 20px; margin-bottom: 20px;";
        header.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap;">
                <span style="font-size: 20px; line-height: 1;">🛡️</span>
                <h2 style="color: var(--header-primary); font-size: 18px; font-weight: 700; margin: 0; line-height: 1.3;">Pac-Mans Utilities - Server Rules</h2>
            </div>
            <p style="color: var(--text-muted); font-size: 13px; line-height: 1.5; margin: 0;">
                Configure server presets, label your rules, and type or paste Role IDs directly. Use ⬆️ / ⬇️ to reorder priority. Export or import individual server configurations below.
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
        addBtn.style.cssText = "background: var(--button-primary-background, #5865f2); color: white; padding: 9px 16px; font-size: 13px;";
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
        importBtn.style.cssText = "background: var(--background-modifier-selected); color: var(--interactive-active); padding: 9px 14px; font-size: 13px;";
        importBtn.onclick = () => importSingleInput.click();
        toolbarRight.appendChild(importBtn);

        toolbar.appendChild(toolbarRight);
        panel.appendChild(toolbar);

        const container = document.createElement("div");
        container.style.cssText = "display: flex; flex-direction: column; gap: 16px; width: 100%;";
        panel.appendChild(container);

        const renderPresets = () => {
            container.innerHTML = "";
            if (this.settings.presets.length === 0) {
                const emptyState = document.createElement("div");
                emptyState.style.cssText = "padding: 36px 20px; text-align: center; background: var(--background-secondary); border: 2px dashed var(--background-modifier-accent); border-radius: 12px; color: var(--text-muted); font-size: 13px;";
                emptyState.innerHTML = `
                    <div style="font-size: 30px; margin-bottom: 8px; line-height: 1;">📂</div>
                    <div style="font-weight: 600; color: var(--header-secondary); margin-bottom: 4px;">No server configs added yet</div>
                    <div>Click '+ Add Server Config' or '📥 Import Server Config' above to get started!</div>
                `;
                container.appendChild(emptyState);
                return;
            }

            this.settings.presets.forEach((serverPreset, pIndex) => {
                if (serverPreset.collapsed === undefined) serverPreset.collapsed = false;

                const card = document.createElement("div");
                card.style.cssText = "background: var(--background-secondary); border: 1px solid var(--background-tertiary); border-radius: 10px; padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); width: 100%;";

                const cardHeader = document.createElement("div");
                cardHeader.style.cssText = "display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--background-tertiary); padding-bottom: 12px; cursor: pointer; user-select: none; flex-wrap: wrap; gap: 12px;";

                const guildInfoWrapper = document.createElement("div");
                guildInfoWrapper.style.cssText = "display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1 1 220px;";

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
                iconImg.style.cssText = "width: 44px; height: 44px; border-radius: 50%; object-fit: cover; background: var(--background-tertiary); flex-shrink: 0;";
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
                    serverTopRow.style.cssText = "display: flex; gap: 14px; align-items: center; background: var(--background-tertiary); padding: 12px; border-radius: 8px; flex-wrap: wrap;";

                    const guildWrapper = document.createElement("div");
                    guildWrapper.style.cssText = "display: flex; flex-direction: column; flex: 1 1 240px; min-width: 0;";
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
                    rulesList.style.cssText = "display: flex; flex-direction: column; gap: 10px; width: 100%;";

                    if (!serverPreset.rules || serverPreset.rules.length === 0) {
                        const noRules = document.createElement("div");
                        noRules.style.cssText = "padding: 12px; text-align: center; color: var(--text-muted); font-size: 13px; font-style: italic;";
                        noRules.innerText = "No role rules added for this server yet.";
                        rulesList.appendChild(noRules);
                    } else {
                        serverPreset.rules.forEach((rule, rIndex) => {
                            const ruleBox = document.createElement("div");
                            ruleBox.style.cssText = "background: var(--background-secondary-alt); padding: 12px; border-radius: 8px; border: 1px solid var(--background-tertiary); display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; width: 100%;";

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
                            nameWrapper.style.cssText = "display: flex; flex-direction: column; flex: 1 1 110px; min-width: 100px;";
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
                            targetWrapper.style.cssText = "display: flex; flex-direction: column; flex: 1.5 1 150px; min-width: 130px;";
                            targetWrapper.innerHTML = '<label class="pmu-label">Target Role ID(s)</label>';

                            const roleInput = document.createElement("input");
                            roleInput.type = "text";
                            roleInput.className = "pmu-input";
                            roleInput.value = rule.roleIds || "";
                            roleInput.placeholder = "e.g. 1234567890";
                            roleInput.oninput = (e) => {
                                rule.roleIds = e.target.value;
                                BdApi.Data.save("PacMansUtilities", "settings", this.settings);
                            };
                            targetWrapper.appendChild(roleInput);
                            ruleBox.appendChild(targetWrapper);

                            const excWrapper = document.createElement("div");
                            excWrapper.style.cssText = "display: flex; flex-direction: column; flex: 1.5 1 150px; min-width: 130px;";
                            excWrapper.innerHTML = '<label class="pmu-label">Exception Role ID(s)</label>';

                            const excInput = document.createElement("input");
                            excInput.type = "text";
                            excInput.className = "pmu-input";
                            excInput.value = rule.exceptionRoleIds || "";
                            excInput.placeholder = "e.g. 1122334455";
                            excInput.oninput = (e) => {
                                rule.exceptionRoleIds = e.target.value;
                                BdApi.Data.save("PacMansUtilities", "settings", this.settings);
                            };
                            excWrapper.appendChild(excInput);
                            ruleBox.appendChild(excWrapper);

                            const cWrapper = document.createElement("div");
                            cWrapper.style.cssText = "display: flex; flex-direction: column; flex: 1.2 1 135px; min-width: 125px;";
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
                            trailingControls.style.cssText = "display: flex; align-items: flex-end; gap: 12px; flex-shrink: 0;";

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

                container.appendChild(card);
            });
        };

        renderPresets();
        return panel;
    }
};
