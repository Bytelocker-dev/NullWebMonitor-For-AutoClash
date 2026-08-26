# XOR WebMonitor Changelog

All notable changes to **XOR WebMonitor for AutoClash** are documented in this file.

---

## [2.0.4] - 2026-08-26

### ⏱️ Incident Burst Time-Lapse & Crash Reporter
- **Interactive Incident Carousel**: Crash and recovery incident reports now feature a swipeable 5-frame carousel of screenshots (captured at 1-second intervals) instead of a single static image, allowing you to clearly see what happened leading up to an incident.
- **Copy Crash Report Button**: Added a dedicated button to copy a formatted markdown crash report (time, kind, instance, message) to the clipboard.

### 📱 Live View Touch Gestures & Keys
- **Advanced Swipe Controller**: Drag-and-drop mouse gestures on the Live View are now converted into fluid ADB swipe commands (`adb shell input swipe X1 Y1 X2 Y2 duration`).
- **Virtual Navigation Keys**: Added dedicated "Back" and "Home" buttons under the Live View to send ADB keyevents (4 and 3) instantly.

### 💻 Live ANSI Web Terminal
- **Native ANSI Parsing**: Added a new "Terminal" tab that streams the monitor's raw Node.js backend console output in real-time, parsing complex ANSI color codes (`\x1b[36m`, etc.) directly into a beautifully colored, auto-scrolling HTML terminal view.

### 🚀 Server Bandwidth & Speed Optimization
- **Gzip & Deflate Compression**: Static assets are now heavily compressed using native Node.js `zlib` compression if the browser supports it, drastically reducing load times over slow cellular connections.
- **Aggressive Browser Caching**: Added ETag hashing and Cache-Control headers to cache static assets, icons, and UI components indefinitely until they change.

### 📊 About & System Diagnostics Tab
- **System Health Monitor**: Added a new "About" tab displaying vital diagnostics including Node.js version, platform, uptime, RSS and Heap memory usage, and total/free OS memory to help monitor the host machine's health.
- **Explicit Network Interface Binding**: Added `WEB_HOST` setting support to optionally bind the HTTP server to a specific network interface (e.g., Tailscale IP or localhost), while defaulting to `0.0.0.0` to preserve full Cloudflare Tunnel compatibility.

### 🐞 Bug Fixes & Polish
- **Discord Paused State Sync**: Improved Discord embed color coding to correctly flag "Paused" versus "On a Break" states.
- **Terminal Wrap Fixes**: Restored the custom "XOR WebMonitor" terminal banner using standard figlet width sizing to prevent wrapping glitches on 80-column console windows.

---

## [2.0.2] - 2026-08-26

### ✨ True Apple iOS Liquid Glass UI — Full Implementation
- **Glass material applied across every surface**: Cards, header, nav bar, instance cards, live screen cards, stat cells, village cards, raid cards, toast notifications, and segmented controls all now carry the full specular glass treatment — not just defined in CSS but actually rendered in the HTML.
- **Specular rim highlight (`::before` pseudo-element)**: All `.card` elements render a real light-catching rim via the XOR mask-composite technique (`mask-composite: exclude`), replicating the exact specular sheen from the xor.tools reference design.
- **Header glass bar**: Sticky header upgraded from flat `var(--panel)` to a layered translucent gradient with 40px backdrop blur, specular inset glow, and bottom rim shadow — matches iOS control center frosted glass.
- **Navigation pill bar**: Tab nav upgraded from flat panel to translucent gradient, pill-shaped tab buttons with glass-pill active state and inner top-highlight.
- **iOS-grade button system**: `.btn` base upgraded to glass-pill (border-radius: 999px), `.btn.primary` to cyan gradient with specular inset shine matching the xor.tools `btn-primary` spec. Green and red action buttons follow the same pattern.
- **Segmented controls**: `.seg` pill controls upgraded from flat to glass-pill with inner specular highlight and matching cyan active segment.
- **Toast notifications**: Glass pill with specular top-rim, 40px blur, smooth spring entrance animation.
- **High-DPI Branding Suite**: Regenerated crisp transparent `favicon.png`, `apple-touch-icon.png` (180x180), `icon-192.png`, and `icon-512.png`.
- **Tailwind v4 Pipeline**: Design tokens (`--bg`, `--panel`, `--line`, `--accent`, `--shadow`) compiled via `@tailwindcss/cli` into `public/css/tw.css`.
- **Unified Aesthetic**: Merged the True Apple iOS Liquid Glass UI effects into the deep blue "Studio Slate" palette. This is now the permanent, hardcoded default theme, removing any legacy layout conflicts and looking incredibly clean.

### 🤖 AutoClash Auto-Updater Integration
- **Full UI Support**: The `AUTOCONTROL_AUTO_UPDATE_ENABLED` toggle is now fully integrated into the Web Setup Wizard and Settings menu. When enabled, it quietly detects new AutoClash releases, triggers the update process, and restarts the bot automatically without user intervention.

### 🎮 Discord Bot Gateway Modernization
- **Dynamic Active Farming Presence**: The Discord Gateway Rich Presence now polls on a 15-second loop to display the exact number of active instances running (e.g. `Farming on 2/3 instances`).
- **Relative Timestamps**: Replaced raw time readouts with dynamic `<t:TIMESTAMP:R>` relative time badges for all paused/break states on the embed.

### 🔤 Font System Fixed
- **Inter now renders**: Removed the `-apple-system` / `BlinkMacSystemFont` inline `font:` shorthand that overrode Tailwind's `Inter` base layer. Inter and JetBrains Mono now apply globally as intended.

### 🩺 XOR System Doctor (`npm run doctor` & In-App Diagnostics)
- **1-Click Diagnostic Health Suite**: Interactive CLI (`npm run doctor`) and web-based diagnostics panel checking:
  - Node.js runtime version compatibility (Node 18+).
  - Android Debug Bridge (ADB) discovery and attached emulator devices (`127.0.0.1:16384`, `16416`).
  - Web port availability and firewall status.
  - Tailscale mesh network connectivity and secure password hash verification.

### ⚡ True MJPEG Live Stream Endpoint (`/api/stream/:id`)
- **Multipart Video Streaming**: Native `multipart/x-mixed-replace` continuous stream endpoint delivering smooth frames directly to browsers without client-side polling overhead.

### 🚀 PWA Offline & High-Speed Asset Pre-Caching (`public/sw.js`)
- **Pre-Cached Vector Assets**: Pre-caches all 37 Clash of Clans vector SVG icons, scripts, and stylesheets for instant sub-millisecond mobile launch.
- **Smart Network Routing**: Keeps all live bot control, stats, and stream routes live-first while serving UI chrome from local cache.

### 🏰 Multi-Village Profiles & Rotation Queue Breakdown
- **Dedicated Village Overview Card**: Visual roster displaying each configured account profile, detected Town Hall badges (`TH1`–`TH18`), active farming status, break timers, and rotation queue position.

### 🧹 Clean Workspace & Modular Source Reorganization
- **Organized Architecture**: Reorganized root workspace by relocating test suites to `test/` with unified runner `test/run-all.js` and automation scripts to `scripts/powershell/`.
- **Automated Workspace Sweep (`npm run clean`)**: Purges temporary test directories, leftover PID markers, and outdated screenshot artifacts with a single command.

### 🐛 Bug Fixes & Polish
- **Fixed Blank UI Screen**: Resolved an issue where the Web Panel would render completely blank due to missing `.show` display CSS classes.
- **Advanced Terminal Logo**: Upgraded the standard terminal startup sequence to an aggressive, large-scale Block ASCII rendering of the XOR skull logo with stark ANSI coloring.
- **Guide Page Accordion Spacing**: Fixed a visual regression on the Setup & User Guide tab where the accordion components were cramped with no vertical gap.

### ✅ Verification
- **17/17 test suites pass** (`npm test`, 9.99s)
- **Tailwind v4 compiles** (`npm run build`, 111ms)
- **Workspace sanitized**: All test HTMLs, temporary `.env` caches, and local configurations successfully purged for open-source distribution.

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


