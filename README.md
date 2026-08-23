# NullWebMonitor for AutoClash

A self-hosted web control panel for [AutoClash](https://autoclash.net). Watch and
control your bots from your phone — live emulator view, stats, logs, crash
detection and remote settings — without opening a port to the internet.

> Not affiliated with AutoClash, MuMu Player, LDPlayer, Discord or Supercell.
> You need your own valid AutoClash licence. See [NOTICE](NOTICE).

---

## What it does

| | |
|---|---|
| **Control** | Start, pause, stop, open and close AutoClash and your emulator — per window or all at once |
| **Live view** | Both emulator screens, auto-captured and downscaled so it is light on mobile data. Tap mode turns clicks into real taps |
| **Logs** | One always-on tab per instance, auto-scrolling, with a health strip showing errors, warnings and recoveries in the last hour |
| **Stats** | Session and daily figures straight from AutoClash's `stats.db`, split into Main Base and Builder Base, with per-hour rates and trend charts |
| **Incidents** | A durable record of crashes, recoveries and updates — each with a screenshot taken at the moment it happened |
| **Config** | Edit AutoClash's own settings remotely, one page per window |
| **Discord** | Optional bot with a control panel, status embeds and live log threads. One channel for the panel plus an optional channel per instance, renamed 🟢/🟠/🔴 by status. Start and stop it from the web panel |
| **Alerts** | Optional phone notifications via ntfy when something actually breaks |

Installs to your phone's home screen as a PWA.

---

## Requirements

- Windows (it drives AutoClash windows through PowerShell)
- [Node.js 18+](https://nodejs.org)
- AutoClash, already set up and working
- MuMu Player or LDPlayer
- [Tailscale](https://tailscale.com/download) — free, and the recommended way to
  reach the panel from your phone

---

## Install

**Easiest:** download the project, then double-click **`Start NullWebMonitor.bat`**. It checks for Node, installs dependencies on first run, starts the monitor and opens the panel for you.

Or from a terminal:

```bash
git clone https://github.com/Bytelocker-dev/NullWebMonitor.git
cd NullWebMonitor
npm install
npm start
```

Then open **http://localhost:8477** and follow the setup wizard. It will:

1. Ask you to create a password (stored only as a scrypt hash)
2. **Detect your running AutoClash instances** — folder, ADB device, emulator
   type and current account are filled in for you; you just name each one
3. Work out how to reach the panel from your phone
4. Optionally connect Discord and phone alerts

No file editing required. `.env.example` documents every option if you prefer
doing it by hand.

---

## Reaching it from your phone

### Tailscale — recommended

Free, no open ports, works anywhere.

1. Install Tailscale on this PC and on your phone, signed into the same account
2. The wizard shows your address, e.g. `http://100.x.y.z:8477`
3. Allow it through Windows Firewall — the wizard gives you the exact command,
   which you run once in an **Administrator** PowerShell:

```powershell
New-NetFirewallRule -DisplayName "NullWebMonitor (Tailscale)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8477 -Profile Private -RemoteAddress 100.64.0.0/10
```

This is the step most people miss. Your Tailscale adapter is usually on the
*Private* firewall profile while Node's default rules only cover *Public*, so
without it the phone just times out.

Traffic inside Tailscale is WireGuard-encrypted, so plain HTTP is fine there.

### Cloudflare Tunnel

Also free, but needs a domain you own added to Cloudflare. Run `cloudflared`
pointing at `http://localhost:8477`. Put Cloudflare Access in front of it.

### Port forwarding — not recommended

**This process runs PowerShell and launches programs on your PC.** Exposing it
directly to the internet is a bad trade. If you do it anyway: use a strong
password, put HTTPS in front, and never reuse that password.

---

## Multiple instances

Add as many as you run — 2, 4, 8. The wizard detects them; the Instances section
in Settings lets you add or remove more later. Each gets its own log tab, live
view, stats and config page.

For many instances, tune these in `.env`:

```
CHECK_CONCURRENCY=3     # instances checked at once
CHECK_STAGGER_MS=7000   # spacing between their heavy checks
```

---

## Editing AutoClash settings remotely

The Config tab edits AutoClash's own `config.json` files — but **only while that
instance's exe is closed**.

That is not an arbitrary restriction. AutoClash rewrites its config on every
account rotation and again when it exits, so an edit made while it runs is
silently overwritten within the hour. Note the Stop button is not enough: it
stops the bot loop inside AutoClash but leaves the process running. **Close exe**
is what ends it.

The flow, all from your phone:

1. **Close exe** — the form unlocks once the process is really gone
2. Edit — changed fields are marked and counted
3. **Save** — writes only what you changed, keeps a timestamped backup, and
   writes atomically so a crash cannot truncate your config
4. **Launch & start**

**Restore backup** rolls back the last save.

Use **Launch & start** rather than Open exe then Start: AutoClash opens on a
licence dialog and needs its Activate button clicked, and activation polls for up
to 20 seconds, so a Start sent immediately lands on the wrong window.

---

## Security

- Password stored as a scrypt hash; plaintext is removed from `.env` on first run
- Sessions are `HttpOnly` + `SameSite=Strict`, and only a SHA-256 hash of each
  token is written to disk, so the session file cannot be replayed
- Five failed logins from one IP triggers a five-minute lockout
- WebSocket upgrades require a valid session
- Static file serving cannot escape `public/`
- Config writes are re-checked server-side against the process being stopped, so
  a stale browser tab cannot push changes into a running bot
- Your AutoClash `license.key` is never read

Before publishing a fork, run:

```bash
npm run check-secrets
```

It fails on Discord tokens, password hashes, Tailscale addresses and anything in
`scripts/secret-denylist.txt` (gitignored — put your own account names there).

---

## Troubleshooting

**Phone can't connect** — the firewall rule above is almost always the reason.
Check `WEB_HOST` is `0.0.0.0` or your Tailscale IP, and that both devices show as
connected in Tailscale.

**"ADB is not configured"** — set the adb.exe path in Settings. AutoClash ships
one at `<AutoClash folder>\Tools\adb\adb.exe`. Without it, screenshots, live
view, tap control and frozen-screen detection are skipped; everything else works.

**Bot stuck on the licence dialog** — use **Launch & start**, not Open exe.

**Log tab shows a break instead of a stall** — that is correct. AutoClash closes
Clash during a humanized break, so the log goes quiet on purpose. The panel reads
the break duration from the log and shows an orange countdown.

**Config form is locked** — the instance is still running. Close exe first.

---

## Development

```bash
npm test             # 7 suites, ~80 checks, no AutoClash needed
npm run check-secrets
npm run icons        # regenerate PWA icons
```

Tests use stubs and temp directories throughout — they never touch a real
AutoClash install or contact Discord.

---

## Licence

MIT — see [LICENSE](LICENSE).
