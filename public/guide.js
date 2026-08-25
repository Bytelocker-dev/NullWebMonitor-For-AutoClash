/* Setup & User Guide tab.
 *
 * Lives in the panel rather than only in the README, because the moment you
 * need it you are usually standing at the machine with a phone in your hand.
 * Static content, no network calls.
 */

const GUIDE_SECTIONS = [
  {
    title: "Discord bot — step by step",
    body: `
<p class="sub">Optional. Adds a control panel, live status embeds and log threads to your server. The panel works fully without it.</p>
<ol class="guide-list">
  <li>Open the <b>Discord Developer Portal</b> → <b>New Application</b> → give it a name.</li>
  <li><b>Bot</b> → <b>Add Bot</b> → <b>Reset Token</b> → copy the token.
      <div class="guide-warn">That token is a password for your bot. Anyone holding it controls it. Never paste it into a chat, screenshot or public repo. If it leaks, press Reset Token.</div></li>
  <li>No privileged intents are needed — this monitor uses none. Leave them off.</li>
  <li><b>OAuth2 → URL Generator</b>. Scopes: <code>bot</code> and <code>applications.commands</code>.</li>
  <li>Permissions: Send Messages, Embed Links, Attach Files, Manage Messages, Manage Channels, Create Public Threads, Send Messages in Threads, Read Message History.</li>
  <li>Open the generated URL and invite the bot to your server.</li>
  <li>In Discord: <b>Settings → Advanced → Developer Mode</b> on. Then right-click a channel → <b>Copy Channel ID</b>.</li>
  <li>Paste the token and the <b>control panel channel ID</b> into Settings, then press <b>Send test message</b>. You should see it appear in the channel within a second.</li>
  <li>Optionally give each instance its own channel — see below.</li>
</ol>
<h4>One channel per instance</h4>
<p class="sub">Two kinds of channel, set separately in the Discord step:</p>
<ul class="guide-list">
  <li><b>Control panel channel</b> — the buttons, the overall status embed and the daily summary. One channel, always.</li>
  <li><b>Per-instance channel</b> — one instance's status embed and its live log thread. One per instance, all optional.</li>
</ul>
<p class="sub">Leave an instance's channel blank and everything for it goes to the control panel channel instead. That is fine for one or two instances; with four or more, separate channels keep each log readable.</p>
<p class="sub"><b>Channel name</b> is what the bot renames that channel to as status changes, so <code>main-farm</code> shows as <code>🟢-main-farm</code> while running, <code>🟠-main-farm</code> on a break and <code>🔴-main-farm</code> when down. Leave it blank to use the instance name. Renaming needs the <b>Manage Channels</b> permission; without it the bot still posts, it just cannot recolour the name.</p>
<p class="sub tiny">Discord rate-limits channel renames to twice per 10 minutes per channel, so the emoji can lag a status change by a few minutes. The embed itself updates immediately.</p>
<p class="sub tiny"><b>Why those permissions?</b> Manage Channels is what renames a channel to 🟢/🟠/🔴 as the bot's status changes. Manage Messages lets it clear its own old panels on restart so they do not stack up. It never deletes anyone else's messages.</p>`,
  },
  {
    title: "Attack strategies",
    body: "\n<p class=\"sub\">All eight strategies AutoClash 2.0.9 offers are available in the Attack Strategy dropdown, for both your main attack and Ranked/War.</p>\n<ul class=\"guide-list\">\n  <li>Electro Dragon/Loon</li><li>Dragon/Loon</li><li>Valkyrie + Quake</li><li>Valkyrie 1 Side</li>\n  <li>BArch or Goblin</li><li>Super Minion + Quake</li><li>Super Barbarian + Quake</li><li>Thrower Smash</li>\n</ul>\n<p class=\"sub tiny\">If a future AutoClash version adds a strategy, pick it once in AutoClash itself and this panel learns it automatically. <b>Custom value…</b> also lets you type an identifier directly.</p>",
  },
  {
    title: "Reaching the panel from your phone",
    body: `
<p class="sub"><b>Tailscale is the recommended route.</b> Free, no open ports, works from anywhere.</p>
<ol class="guide-list">
  <li>Install Tailscale on this PC and on your phone, signed into the same account.</li>
  <li>The setup wizard shows your address — something like <code>http://100.x.y.z:8477</code>.</li>
  <li>Add the firewall rule the wizard gives you, in an <b>Administrator</b> PowerShell.</li>
</ol>
<div class="guide-warn">The firewall rule is the step almost everyone misses. Your Tailscale adapter usually sits on the <b>Private</b> network profile, while Node's default rules only cover <b>Public</b> — so without it the phone just times out with no error.</div>
<p class="sub" style="margin-top:10px">Traffic inside Tailscale is WireGuard-encrypted, so plain HTTP is fine there.</p>
<p class="sub"><b>Cloudflare Tunnel</b> also works and is free, but needs a domain you own added to Cloudflare. Run <code>cloudflared</code> pointing at <code>http://localhost:8477</code> and put Cloudflare Access in front of it.</p>
<div class="guide-warn"><b>Port forwarding is not recommended.</b> This process runs PowerShell and launches programs on your PC. Exposing it directly to the internet is a bad trade for convenience. If you do it anyway, use a long unique password and put HTTPS in front.</div>`,
  },
  {
    title: "Instances, emulators and ADB",
    body: `
<p class="sub">Add one instance per AutoClash window. The wizard detects running ones automatically; you choose the name.</p>
<ul class="guide-list">
  <li><b>Folder</b> — point at the AutoClash install directory, not the .exe. That way a new <code>AutoClash-x.y.z.exe</code> after an update is picked up on its own.</li>
  <li><b>ADB device</b> — MuMu numbers its instances from <code>127.0.0.1:16384</code> upward in steps of 32 (16384, 16416, 16448…). LDPlayer starts at <code>127.0.0.1:5555</code> in steps of 2.</li>
  <li><b>ADB path</b> — AutoClash ships one at <code>&lt;folder&gt;\\Tools\\adb\\adb.exe</code>. Without it the panel still runs, but screenshots, live view, tap control and frozen-screen detection are skipped.</li>
</ul>
<p class="sub tiny">Running many instances? Raise <code>CHECK_CONCURRENCY</code> in Settings so they are polled in parallel rather than one after another.</p>`,
  },
  {
    title: "Editing AutoClash settings remotely",
    body: `
<p class="sub">The Config tab edits AutoClash's own config files — but only while that instance's exe is <b>closed</b>.</p>
<div class="guide-warn">This is not an arbitrary restriction. AutoClash rewrites its config on every account rotation and again when it exits, so an edit made while it is running is silently overwritten within the hour.</div>
<p class="sub" style="margin-top:10px"><b>Stop is not enough.</b> Stop presses Stop inside AutoClash's own window and leaves the process alive. <b>Close exe</b> is what actually ends it.</p>
<ol class="guide-list">
  <li><b>Close exe</b> — the form unlocks once the process is really gone.</li>
  <li>Edit. Changed fields are marked and counted; nothing is sent until you save.</li>
  <li><b>Save</b> — writes only what you changed, keeps a timestamped backup, and writes atomically so a crash cannot truncate your config.</li>
  <li><b>Launch &amp; start</b>.</li>
</ol>
<p class="sub tiny"><b>Restore backup</b> rolls back the last save. The ten most recent backups per file are kept.</p>
<p class="sub tiny">Settings are grouped to match AutoClash's own sidebar. Anything this panel does not recognise — usually new in a fresh AutoClash version — appears under <b>Other / New</b> and is still fully editable.</p>`,
  },
  {
    title: "Launching remotely",
    body: `
<p class="sub">Use <b>Launch &amp; start</b>, not Open exe followed by Start.</p>
<p class="sub">AutoClash opens on an "Enter License Key" dialog and waits on its Activate button. Launch &amp; start runs the whole sequence: open, click Activate, wait for the window to settle, then Stop/Start with retries until the log actually starts moving.</p>
<div class="guide-warn">Pressing Open exe and then Start separately does not work remotely: activation polls for up to 20 seconds, so a Start sent before it finishes lands on the wrong window.</div>
<p class="sub tiny">A cold start after a forced close needs patience. If launches time out, raise <code>APP_LAUNCH_SETTLE_SECONDS</code> and <code>APP_AUTOSTART_LOG_WAIT_SECONDS</code> in Settings.</p>`,
  },
  {
    title: "Breaks, stalls and incidents",
    body: `
<p class="sub">AutoClash closes Clash during a humanized break, so the log goes completely silent on purpose. The panel reads the break length out of the log line and shows an <b>orange countdown</b> instead of a red stall.</p>
<p class="sub">While a break is running, stall alerts, auto-restart and the frozen-screen check are all suppressed — a closed game is a motionless screen by design.</p>
<p class="sub"><b>Frozen-screen detection</b> compares a perceptual hash of the emulator every few minutes. If the picture has not changed and no new log lines arrived, it records an incident with a photo. Two frames of a live game differ by around 27–30 bits out of 64, against a tolerance of 4, so a false positive needs a genuinely frozen screen.</p>
<p class="sub"><b>Incidents</b> keep their screenshots in their own folder, untouched by the temporary-screenshot cleanup, so evidence survives.</p>`,
  },
  {
    title: "Phone alerts (ntfy)",
    body: `
<p class="sub">Off by default. Turn it on in Settings, install the <b>ntfy</b> app, and subscribe to your topic.</p>
<div class="guide-warn">On the public ntfy.sh server the topic name is the <b>only</b> thing protecting your alerts — anyone who knows it can read them. Use a long random topic, keep it private, and do not shorten it. Self-host ntfy and point <code>NTFY_SERVER</code> at it to avoid the public server entirely.</div>
<p class="sub" style="margin-top:10px">Only warnings and errors are pushed, so a healthy run stays silent. Change the threshold with <code>NTFY_MIN_SEVERITY</code>.</p>`,
  },
  {
    title: "Install on your phone",
    body: `
<p class="sub">The panel is a PWA, so it can live on your home screen and open fullscreen with no browser chrome.</p>
<ul class="guide-list">
  <li><b>iPhone</b> — open it in Safari, press Share, then <b>Add to Home Screen</b>.</li>
  <li><b>Android</b> — open it in Chrome and use <b>Install app</b> from the menu.</li>
</ul>
<p class="sub tiny">Nothing is cached offline by design: this panel shows live bot state, and a stale cached copy would be worse than useless.</p>`,
  },
  {
    title: "Terminal CLI commands & Password reset",
    body: `
<p class="sub">XOR WebMonitor runs with an interactive command prompt in your terminal (PowerShell / Command Prompt). Type commands directly into the running terminal window:</p>
<ul class="guide-list">
  <li><code>help</code> — Displays all available console commands.</li>
  <li><code>reset-password [newpass]</code> — Reset the web panel admin password immediately.</li>
  <li><code>status</code> — Print real-time status of all monitored AutoClash instances.</li>
  <li><code>stats</code> — Print latest farming loot gained and attack counts.</li>
  <li><code>instances</code> — List configured instances and ADB ports.</li>
  <li><code>restart</code> — Safely restart the monitor process.</li>
  <li><code>clear</code> — Clear the terminal screen and redraw the ASCII banner.</li>
  <li><code>exit</code> — Stop XOR WebMonitor.</li>
</ul>
<h4>Emergency password reset via CLI</h4>
<p class="sub">If you ever get locked out of the web panel, you can reset your password from the terminal without starting the full monitor:</p>
<ol class="guide-list">
  <li>Open PowerShell or Command Prompt in the repository folder.</li>
  <li>Run: <code>npm run reset-password</code> (or <code>node bot.js --reset-password</code>).</li>
  <li>Enter your new password (minimum 8 characters). It will be hashed with scrypt and saved to <code>.env</code> automatically.</li>
</ol>`,
  },
  {
    title: "Same-folder multiple instances",
    body: `
<p class="sub">XOR WebMonitor 2.0 natively supports running multiple AutoClash windows out of the same installation folder:</p>
<ul class="guide-list">
  <li>During Setup, the detector identifies each open window by its window title, PID, ADB port and logged-in account name.</li>
  <li>Unique instance IDs (e.g. <code>AutoClash (16416)</code>) are automatically generated.</li>
  <li>Stats and session logs are parsed per instance without overwriting each other.</li>
</ul>`,
  },
  {
    title: "Cloudflare Tunnel & Reverse Proxy",
    body: `
<p class="sub">You can securely expose XOR WebMonitor over Cloudflare Tunnels (Zero Trust) or reverse proxies (Nginx / Caddy):</p>
<ol class="guide-list">
  <li>Set <b>Trust Cloudflare / Reverse Proxy</b> (<code>TRUST_PROXY=true</code>) in Settings.</li>
  <li>Point your Cloudflare Tunnel to <code>http://localhost:8477</code>.</li>
  <li>This ensures the monitor reads real client IPs from <code>CF-Connecting-IP</code> and <code>X-Forwarded-For</code> headers, preventing false rate limiter lockouts.</li>
</ol>`,
  },
  {
    title: "Security",
    body: `
<ul class="guide-list">
  <li>Your password is stored only as a scrypt hash. Plaintext is removed from <code>.env</code> on first start.</li>
  <li>Special characters (including <code>#</code>, <code>=</code>, <code>"</code>, <code>$</code>, spaces, emojis, and Unicode) are fully supported in passwords.</li>
  <li>Session cookies are HttpOnly and SameSite=Strict, and only a SHA-256 hash of each token is written to disk, so the session file cannot be replayed.</li>
  <li>Five failed logins from one address triggers a five-minute lockout.</li>
  <li>Config writes are re-checked on the server against the process being stopped, so a stale browser tab cannot push changes into a running bot.</li>
  <li>Your AutoClash <code>license.key</code> is never read or shown.</li>
</ul>
<p class="sub tiny">Forking this? Run <code>npm run check-secrets</code> before you publish. It fails on tokens, password hashes, tailnet addresses and anything you list in <code>scripts/secret-denylist.txt</code>.</p>`,
  },
];

function renderGuide() {
  $("#guideBody").innerHTML = GUIDE_SECTIONS.map((section, i) =>
    '<details class="card guide"' + (i === 0 ? " open" : "") + ">"
    + "<summary>" + esc(section.title) + "</summary>"
    + '<div class="guide-content">' + section.body + "</div>"
    + "</details>"
  ).join("");
}
