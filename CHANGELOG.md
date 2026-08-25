# XOR WebMonitor Changelog

All notable changes to **XOR WebMonitor for AutoClash** are documented in this file.

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
