# XOR WebMonitor Changelog

All notable changes to **XOR WebMonitor for AutoClash** are documented in this file.

---

## [2.0.1] - 2026-08-25

### 🎮 Clash of Clans Vector Game Asset Suite
- **37 Hand-Crafted CoC SVG Icons**: Replaced all generic emojis with high-resolution vector assets across the Web UI and documentation:
  - Town Hall Badges: `TH1` through `TH18`
  - Builder Hall Badges: `BH1` through `BH10`
  - Resources & Currencies: Gold, Elixir, Dark Elixir, and Gems
  - Combat & Shields: Full/Empty Stars, Swords, and Donation Shields

### ⏱️ Break-Aware Multi-Village Rotation Engine
- **Eliminated False Modulo Clock Wrapping**: Fixed a desync where rotation timers reset back to `29:59` during humanized breaks.
- **Accurate Break Duration Subtraction**: Active profile timers now hold and freeze while AutoClash is in a scheduled break, accurately displaying `(paused)` or `switching after break` when the session timer elapses.

### ⚡ Dual-Mode Live View & Touch/Drag Controller
- **Dual Stream Modes**: Switch seamlessly between **Data Saver** (low bandwidth snapshots) and **Ultra-Live Stream** (up to 30 FPS high-rate streaming).
- **Interactive Drag & Swipe Controller**: Phone and desktop gestures now support drag-to-swipe, translating touches directly to `adb shell input swipe` with animated touch ripple feedback.
- **ADB Quick-Fix Drawer**: 1-Click remote action toolbar for:
  - 🔄 **Restart Clash**: Force-stops and relaunches Clash of Clans.
  - 🧹 **Clear Cache**: Clears game cache to resolve asset stalling.
  - 📐 **Fix Resolution (1600x900 @ 300 DPI)**: Restores standard AutoClash emulator display dimensions.
  - 🔌 **Reconnect ADB**: Instantly restores lost device connections.

### ⚔️ Recent Raids Live Feed (Home Base & Builder Base)
- **Real-Time Battle Feed**: Live stream of recent attacks displaying stars won (0–3), loot looted, defender Town Hall levels, and army archetypes for both Home Village and Builder Base.

### 🤖 Discord Rich Presence ("Playing XOR WebMonitor")
- Added Discord Gateway Op 2 / Op 3 presence payload displaying `Playing XOR WebMonitor` on the Discord bot when active.

### 🎨 Stealth Slate & Studio Theme Engine
- Added 3 distinct UI color schemes: **Stealth Slate** (rich charcoal/mint), **Studio Slate** (daylight contrast), and **Cyber Neon** (cyan/violet) with instant persistent theme switching.

---

## [2.0.0] - 2026-08-25

### 🚀 Major Highlights & Rebranding
- **Rebranded to XOR WebMonitor**: Full aesthetic overhaul featuring the dark cyber-grunge XOR Skull branding, custom favicon, PWA icons, and dynamic console ASCII banner.
- **Interactive Terminal Command Prompt**: Dedicated `xor>` interactive terminal prompt with built-in commands (`help`, `reset-password`, `status`, `stats`, `instances`, `restart`, `clear`, `exit`), isolated from background logs so user commands are never interrupted.
- **Terminal & CLI Password Reset**: Added non-interactive flag `node bot.js --reset-password <password>` and `npm run reset-password` alongside runtime console reset command.
- **In-App Changelog Tab & Markdown Parser**: Live Changelog tab in the web panel powered by `/api/changelog` that automatically reads and renders updates whenever the repo is updated.

### 📊 All-Time Stats & Lifetime Analytics
- **Lifetime Aggregation Selector**: Added **All-Time** toggle alongside Session and Daily views in the Farming Statistics tab.
- **Multi-Day & Multi-Session Totals**: Aggregates all historical SQLite database records and fallback daily totals into lifetime Gold, Elixir, Dark Elixir, walls upgraded, obstacles removed, research done, and attack stars.
- **Calculated Lifetime Farm Rates**: Accurately computes loot-per-hour and attacks-per-hour across overall runtime and total active farming days.
- **Builder Base Lifetime Tracking**: Tracks all-time Builder Base attack counts and wall upgrades.
- **Discord Bot All-Time Embed**: Added all-time embed generation and interaction button support for Discord channels.

### 🏰 Multi-Account, Town Hall & Village Rotation
- **Active Account & Town Hall Tracking**: Auto-detects the currently active village name and Town Hall level badge (`TH18`, `TH17`, etc.) directly from configuration files and window titles.
- **Multi-Village Rotation Countdown**: Displays a live timer showing the time remaining on the current village before auto-swapping to the next queued account.
- **Same-Name & Shared-Folder Multi-Instance Support**:
  - AutoClash window detection differentiates instances by Process ID, ADB port, and account rather than collapsing on identical folder names.
  - Automatically disambiguates colliding instance labels (e.g. `AutoClash (Port 16416)` or `AutoClash-2`).
  - Added dedicated per-instance statistics and log directory isolation.

### 🛠️ Resilience, Password Security & Bug Fixes
- **Discord Bot Auto-Start on Setup**: Automatically initializes and launches the Discord gateway immediately upon saving the Web Setup wizard or Settings without requiring a terminal restart.
- **Discord Break Channel Renaming**: Channels dynamically switch to `🟠-<channel-name>` when AutoClash is on a humanized break with 5-minute rate-limit tracking.
- **Exact Break Timer Precision**: Stripped buffer bloat from `breakUntil` so announced break durations (e.g. 22 min) match the exact countdown to the second.
- **Special Character & Unicode Password Support**: Completely character-resilient `.env` parser and serializer that safely handles `#`, `=`, `"`, `$`, spaces, symbols, and UTF-8 characters without string truncation or corruption.
- **Fail-Safe UI Initialization**: Enhanced frontend view rendering and error boundaries to prevent blank screen states on page refresh or startup.
- **Cloudflare & Reverse Proxy Support**: Real client IP extraction from `CF-Connecting-IP` and `X-Forwarded-For` with `TRUST_PROXY` configuration, preventing remote lockout on Cloudflare Tunnels.

### ⚡ Settings & Options Revamp
- **Card Categorization**: Grouped options into clean cards (Security, AutoClash Controls, Discord Bot, Mobile & Remote Access).
- **Modern UI Toggles**: Replaced raw text inputs with interactive switches for boolean configuration keys.
- **In-App Master Password Changer**: Easily update the web panel password with instant verification and hashing.

---

## [1.0.0] - Initial Release
- Self-hosted web control panel with real-time WebSocket events.
- AutoClash process and window control (Start, Pause, Stop, Launch, Close).
- Live screenshot stream and ADB touch interaction.
- Clash of Clans farming statistics viewer (Session & Daily SQLite breakdown).
- Discord bot integration with channel status alerts and control panel buttons.
- Tailscale remote access setup wizard and diagnostic checker.
