/**
 * @name Pac-Mans Utilities Dev
 * @author the.pacman.is.back
 * @authorId 280218268038463489
 * @description Automatically copies User IDs and highlights voice users using cascading rule priority, multi-role checks, and exception role bypasses with manual role ID entry or a searchable in-field role picker, custom rule labeling, and individual server preset import/export.
 * @version 4.2.0
 * @updateUrl https://raw.githubusercontent.com/xFadedxShadow/Pac-Mans-Utilities/dev/Source/Pac-Mans%20Utilities.plugin.js
 * @source https://github.com/xFadedxShadow/Pac-Mans-Utilities/tree/dev/Source
 */

module.exports = class PacMansUtilitiesLoader {
    constructor() {
        this.instance = null;
    }

    start() {
        this.loadRemotePlugin();
    }

    stop() {
        if (this.instance && typeof this.instance.stop === "function") {
            this.instance.stop();
        }
    }

    async loadRemotePlugin() {
        try {
            const rawUrl = "https://raw.githubusercontent.com/xFadedxShadow/Pac-Mans-Utilities/refs/heads/dev/Source/Pac-Mans%20Utilities.plugin.js?cache=" + Date.now();
            const response = await fetch(rawUrl);
            if (!response.ok) throw new Error(`Failed to fetch remote plugin: ${response.statusText}`);
            
            const code = await response.text();
            const exportModule = { exports: {} };
            const evaluate = new Function("module", "exports", "require", "BdApi", code);
            evaluate(exportModule, exportModule.exports, require, BdApi);

            const PluginClass = exportModule.exports;
            this.instance = new PluginClass();
            
            if (typeof this.instance.start === "function") {
                this.instance.start();
            }
            
            BdApi.UI.showToast("Pac-Mans Utilities: Loaded remote update successfully.", { type: "success" });
        } catch (err) {
            console.error("Pac-Mans Utilities Remote Loader Error:", err);
            BdApi.UI.showToast("Pac-Mans Utilities: Failed to load remote code.", { type: "error" });
        }
    }

    getSettingsPanel() {
        if (this.instance && typeof this.instance.getSettingsPanel === "function") {
            return this.instance.getSettingsPanel();
        }
        const panel = document.createElement("div");
        panel.style.cssText = "padding: 20px; color: var(--text-normal); font-family: var(--font-primary);";
        panel.innerText = "Plugin is still downloading or failed to fetch from GitHub.";
        return panel;
    }
};
