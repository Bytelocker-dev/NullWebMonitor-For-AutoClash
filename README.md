# XOR WebMonitor for AutoClash

<div align="center">

![XOR WebMonitor](public/logo.png)

**A high-performance, open-source, self-hosted web control panel & monitor for [AutoClash](https://autoclash.net).**  
Watch and control all your Clash of Clans bots from your phone — live emulator view, lifetime farming statistics, multi-village timers, logs, crash detection, and remote configuration — without opening risky ports to the internet.

[![Open Source Love](https://badges.frapsoft.com/os/v1/open-source.svg?v=103)](https://github.com/Bytelocker-dev/NullWebMonitor-For-AutoClash-Open-Source-)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/Bytelocker-dev/NullWebMonitor-For-AutoClash-Open-Source-/pulls)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)
[![PWA Ready](https://img.shields.io/badge/PWA-Ready-purple.svg)](#connecting-from-your-phone)
[![Tailscale](https://img.shields.io/badge/Tailscale-Mesh%20VPN-blue.svg)](https://tailscale.com)

</div>

> **Notice:** Not affiliated with AutoClash, Supercell, LDPlayer, MuMu Player, or Discord. You must have your own valid AutoClash licence. See [NOTICE](NOTICE).

---

## 🌟 100% Free & Open Source

XOR WebMonitor is **free, open-source software** under the MIT License.  
We built this to give the Clash of Clans community the best possible self-hosted monitoring and control experience.
- ⭐️ **Star the repository** if you find it helpful!
- 🍴 **Fork it & customize** to suit your personal setup or bot farm.
- 🤝 **Contribute!** Pull requests, bug reports, and new feature ideas are always welcome.

---

## ✨ Features at a Glance

| Feature | Description |
|---|---|
| 🎮 **Remote Control** | Start, pause, stop, launch, and close AutoClash and your emulators (MuMu / LDPlayer) — per window or across all instances at once. |
| 📊 **All-Time & Daily Stats** | Switch between **Session**, **Daily**, and **All-Time** statistics straight from `stats.db` — tracks lifetime Gold, Elixir, Dark Elixir, walls, obstacles, upgrades, and 14-day trending charts. |
| 🏰 **Multi-Village Rotation** | Live tracking of the currently active account, detected Town Hall badge (`TH18`), live rotation countdown (`20:56 left`), and next account indicator (`→ Next: AltVillage`). |
| 📺 **Live View & Tap Mode** | Real-time lightweight emulator screens streamed to your phone. Enable **Tap mode** to click or tap on the game screen directly from your browser. |
| 💻 **Interactive CLI Terminal** | Clean, isolated `xor>` command prompt in the terminal to inspect `status`, `stats`, `instances`, `restart`, or `reset-password` without interruption from bot logs. |
| 🪵 **Live Multi-Tab Logs** | Real-time logs for every instance with auto-scroll, search, and a 1-hour health monitor bar showing errors, warnings, and recoveries. |
| 📸 **Visual Incident Logger** | Automatic detection of Clash of Clans connection drops, frozen screens, and bot errors — with instant screenshots saved for review. |
| ⚙️ **Remote Config Editor** | Edit AutoClash's `config.json` remotely from your phone with atomic saves, backup retention, and one-click rollback. |
| ⏱️ **Humanized Break Timer** | Detects scheduled breaks and displays an orange countdown banner so quiet logs are never mistaken for freezes. |
| 🤖 **Discord Integration** | Optional bot with live control buttons, status embeds, all-time stats, and auto-renamed channels (🟢 active / 🟠 break / 🔴 stopped) plus log threads. |
| 📱 **Instant Mobile Access** | Built-in QR codes with one-tap switching between **Tailscale**, **MagicDNS**, and **Home Network (LAN)**. Installable as a PWA. |

---

## 📋 Requirements

* **Windows 10 / 11** (drives AutoClash through PowerShell automation)
* **[Node.js 18+](https://nodejs.org)** (installer includes automatic winget install check)
* **AutoClash**, already installed and configured
* **MuMu Player** or **LDPlayer**
* **[Tailscale](https://tailscale.com/download)** (Recommended for zero-configuration, encrypted phone access anywhere)

---

## 🚀 Quick Start (Easiest Method)

1. **Download** or clone this repository:
   ```bash
   git clone https://github.com/Bytelocker-dev/NullWebMonitor-For-AutoClash-Open-Source-.git
   cd NullWebMonitor-For-AutoClash-Open-Source-
   ```
2. Double-click **`Start XOR WebMonitor.bat`**.
   * Automatically verifies Node.js
   * Automatically installs dependencies on first launch
   * Starts the supervisor watchdog and opens your browser
3. Follow the **Setup Wizard** in your browser (`http://localhost:8477`):
   * **Password**: Create a secure password (stored as a scrypt hash; plaintext is never saved)
   * **Instances**: Click **Auto-Detect** — automatically detects all running AutoClash folders, ADB ports, and active accounts
   * **Remote Access**: Scan the QR code with your phone to connect instantly via Tailscale or LAN
   * **Discord / Notifications** (Optional): Add bot tokens or ntfy alert channels

---

## 📱 Connecting From Your Phone

### 1. Tailscale (Recommended — Secure & Anywhere)
Tailscale creates a secure peer-to-peer mesh between your PC and phone without opening router ports.

1. Install Tailscale on your PC and Phone, signed in to the same account.
2. The WebMonitor **Remote Access** card displays your Tailscale URL (e.g. `http://100.x.y.z:8477`).
3. Allow incoming traffic through Windows Firewall by running this once in an **Administrator PowerShell**:
   ```powershell
   New-NetFirewallRule -DisplayName "XOR WebMonitor (Tailscale)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8477 -Profile Private -RemoteAddress 100.64.0.0/10
   ```
4. Open the link on your phone and tap **Add to Home Screen** for a full native PWA app experience.

### 2. Home Network (LAN)
If your phone is on the same local Wi-Fi, select **Home network** in the access tab to get your local IP (e.g. `http://192.168.1.x:8477`).

### 3. Cloudflare Tunnel (Optional)
If you own a custom domain, point `cloudflared` to `http://localhost:8477` with `TRUST_PROXY=true` in your `.env`.

---

## 🔄 Multi-Instance & Multi-Village Support

XOR WebMonitor is architected to handle multiple simultaneous instances with zero log crossover:
* **Same-Name & Shared-Folder Disambiguation**: Differentiates instances by process ID and ADB port even when sharing identical folders.
* **Live Profile Tracking**: Reads `profiles/config.json`, `profiles/order.txt`, and log switches to display the exact account currently running.
* **Resource Optimization**: Tune concurrency in `.env` if running 4+ instances:
  ```env
  CHECK_CONCURRENCY=3     # Number of instances checked concurrently
  CHECK_STAGGER_MS=7000   # Delay between heavy screen & ADB checks
  ```

---

## ⚙️ Remote Config Editor

Edit AutoClash settings safely from your phone:
1. Click **Close exe** on the target instance (AutoClash requires the process to be closed to prevent overwrite on exit).
2. The Config tab unlocks. Modify fields, toggle options, or change farming priorities.
3. Click **Save** — atomic file writing creates a timestamped backup (`.bak.json`) and updates `config.json`.
4. Click **Launch & start** to relaunch AutoClash and resume farming.
5. Use **Restore backup** at any time to roll back changes.

---

## 🛡️ Security Architecture

* **Zero Plaintext Passwords**: Passwords are saved strictly as high-cost `scrypt` hashes in `.env`.
* **CLI Password Reset**: Easily reset passwords anytime via terminal `reset-password` or `npm run reset-password`.
* **Hardened Web Sessions**: Session cookies use `HttpOnly`, `SameSite=Strict`, and tokens are validated via SHA-256 memory hashes.
* **Brute-Force Rate Limiting**: 5 failed login attempts trigger an automatic IP lockout.
* **Path Traversal Guards**: Web server strictly isolates static file delivery to `public/`.
* **Zero Secret Leakage**: AutoClash licence keys and internal credentials are never transmitted.

---

## 🧪 Testing & Validation

Run the comprehensive test suite (17 automated test suites, ~130 assertions):

```bash
npm test
```

Includes unit and integration checks for:
* All-Time, Daily, and Session stats aggregation from SQLite `stats.db`
* Multi-Village profile & timer resolution
* AM/PM 12-hour and 24-hour break countdown accuracy
* Session persistence and scrypt password hashing with unicode/special characters
* Config schema mappings and atomic rollbacks
* WebSocket live log multiplexing and fail-safe view initializers
* QR code generation and route resilience

---

## 🤝 Contributing & Community

Contributions are what make the open source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📄 Licence

Distributed under the **MIT License**. See [LICENSE](LICENSE) for more information.
