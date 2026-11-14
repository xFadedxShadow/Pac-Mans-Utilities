# Pac-Mans Utilities (`Pac-Mans Utilities.plugin.js`)

A high-performance, feature-rich BetterDiscord plugin designed for granular voice channel user monitoring, automated user ID copying, and cascading server-specific role-based UI highlighting.

---

## Prerequisites & BetterDiscord Installation

1. **Download BetterDiscord:** Navigate to the [official BetterDiscord website](https://betterdiscord.app/) and download the installer for your operating system (Windows, macOS, or Linux).
2. **Run the Installer:** Execute the downloaded installer file, accept the license agreements, select **Install BetterDiscord**, and choose your active Discord client instance.
3. **Restart Client:** Allow the installer to automatically restart your Discord client. Verify that the BetterDiscord section appears under your client's **User Settings**.

---

## Installing the Plugin

1. Open Discord and go to **User Settings** (the gear icon near your profile).
2. Scroll down to the **BetterDiscord** section on the left sidebar and click on **Plugins**.
3. Click the **Open Plugins Folder** button at the top to open the local plugins directory.
4. Place the `Pac-Mans Utilities.plugin.js` file directly into this folder.
5. Toggle the switch next to **Pac-Mans Utilities** in your Discord settings to activate the plugin.

---

## Architecture & How It Works

`Pac-Mans Utilities` operates via a robust event-driven architecture combined with continuous DOM polling to maintain real-time UI synchronization:

* **Store Integration:** Connects directly into BetterDiscord's internal Webpack store abstractions (`SelectedChannelStore`, `VoiceStateStore`, `UserStore`, `ChannelStore`, `GuildMemberStore`, `GuildStore`) to track live voice states and member rosters without overhead.
* **Event Listeners & Fallbacks:** Listens for voice state change events to trigger immediate evaluation upon user connection changes, backed by a 1-second interval poller (`updateAllVCHighlights`) to handle dynamic DOM re-renders and React state updates.
* **Fiber Node Inspection:** Recursively traverses React Fiber trees (`__reactFiber$`) on target DOM elements (`[class*="voiceUser"]`) to extract precise internal `userId`, `guildId`, and metadata.
* **Caching Layer:** Utilizes an optimized memoized RGBA cache (`hexToRgba`) to convert HEX configuration colors into performant CSS values dynamically without redundant string parsing.

---

## Key Features & Technical Justification

* **Cascading Rule Priority (Top-to-Bottom Execution):**
  * *Why:* Allows administrators and moderators to structure complex permission hierarchies where specific rules override general rules. The plugin evaluates rules sequentially and applies the first matching condition.
* **Multi-Role Conditional Logic (`lacks_any`, `lacks_all`, `has_any`, `has_all`):**
  * *Why:* Provides flexible boolean evaluation modes against member role arrays, accommodating everything from missing verification roles to possession of specific clearance tiers.
* **Exception Role Bypasses:**
  * *Why:* Prevents false positives by letting users define explicit exception role IDs that immediately short-circuit and reject rule execution if present on a member.
* **Automated User ID Clipboard Copying:**
  * *Why:* Streamlines moderation workflows by automatically copying targeted user IDs to the system clipboard upon voice channel entry, accompanied by a status toast notification (`BdApi.UI.showToast`).
* **Dynamic Visual UI Highlighting:**
  * *Why:* Injects targeted inline CSS styles (`boxShadow` with inset borders, custom background tints, and rounded corners) directly onto voice participant elements for instant visual identification.
* **Server Preset Import / Export & Settings Panel:**
  * *Why:* Built entirely with vanilla DOM manipulation inside `getSettingsPanel()`, the configuration UI supports live guild selector dropdowns, guild icon rendering, rule reordering (`⬆️` / `⬇️`), and complete JSON-based preset backups for easy sharing across servers.

---

## Configuration

Access the configuration interface via **User Settings -> Plugins -> Pac-Mans Utilities (Settings)**:
* **Add Server Config:** Associate rules with specific servers using their Guild IDs or select from active joined servers.
* **Role Rules:** Input target Role IDs and exception Role IDs manually, assign custom labels (e.g., *VIP Pass*), pick highlight colors, and toggle individual rules on or off.
