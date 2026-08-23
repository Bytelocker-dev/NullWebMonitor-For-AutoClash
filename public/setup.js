/* First-run setup wizard.
 *
 * Shown instead of the login page while the panel is unconfigured. Writes .env
 * through the server so a new user never has to edit a file by hand.
 */

const SETUP_STEPS = ["Password", "Instances", "Access", "Optional"];

let wiz = {
  step: 0,
  state: null,        // from /api/setup/state
  instances: [],
  detected: [],
  emulator: "",
  adbPath: "",
  access: { host: "0.0.0.0", port: 8477 },
  discord: { token: "", channelId: "" },
  ntfy: { topic: "" },
  busy: false,
};

async function setupBoot() {
  try {
    wiz.state = await api("/api/setup/state");
    wiz.access.port = wiz.state.port || 8477;
    // Skip the password step if one already exists (re-running setup later).
    if (!wiz.state.needsPassword && wiz.step === 0) wiz.step = 1;
    renderSetup();
  } catch (error) {
    $("#setupBody").innerHTML = '<div class="card sub">' + esc(error.message) + "</div>";
  }
}

function setupShell(inner, opts = {}) {
  const dots = SETUP_STEPS.map((name, i) =>
    '<span class="wiz-dot' + (i === wiz.step ? " on" : "") + (i < wiz.step ? " done" : "") + '">' + esc(name) + "</span>"
  ).join("");

  return '<div class="card wiz">'
    + '<h2>Set up NullWebMonitor</h2>'
    + '<div class="wiz-steps">' + dots + "</div>"
    + '<div class="wiz-body">' + inner + "</div>"
    + '<div class="btn-row" style="margin-top:18px">'
    + (wiz.step > (wiz.state && wiz.state.needsPassword ? 0 : 1)
      ? '<button class="btn" id="wizBack">Back</button>' : "")
    + (opts.next === false ? "" : '<button class="btn primary" id="wizNext"' + (wiz.busy ? " disabled" : "") + ">" + esc(opts.nextLabel || "Continue") + "</button>")
    + '<span class="sub tiny" style="align-self:center">' + esc(opts.hint || "") + "</span>"
    + "</div></div>";
}

function renderSetup() {
  const body = $("#setupBody");
  if (wiz.step === 0) return void (body.innerHTML = setupShell(stepPassword(), { nextLabel: "Create password" }));
  if (wiz.step === 1) return void (body.innerHTML = setupShell(stepInstances(), { hint: wiz.instances.length + " instance(s)" }));
  if (wiz.step === 2) return void (body.innerHTML = setupShell(stepAccess()));
  body.innerHTML = setupShell(stepOptional(), { nextLabel: "Finish setup" });
}

function stepPassword() {
  return '<p class="sub">Pick a password for this panel. It is stored only as a scrypt hash — the plaintext is never written to disk.</p>'
    + '<label class="field" style="margin-top:12px">Password'
    + '<input type="password" id="wizPass" autocomplete="new-password" placeholder="at least 8 characters"></label>'
    + '<label class="field" style="margin-top:10px">Repeat'
    + '<input type="password" id="wizPass2" autocomplete="new-password"></label>'
    + '<div class="sub tiny" id="wizPassErr" style="color:#ff8a85;margin-top:8px"></div>';
}

function stepInstances() {
  const rows = wiz.instances.map((inst, i) =>
    '<div class="card" style="margin-top:10px;background:var(--panel-2)">'
    + '<div class="btn-row"><b style="flex:1">Instance ' + (i + 1) + "</b>"
    + '<button class="btn sm bad" data-wizdel="' + i + '">Remove</button></div>'
    + '<label class="field" style="margin-top:8px">Name (yours — shown on tabs, Discord and channel names)'
    + '<input type="text" data-wiz="name" data-i="' + i + '" value="' + esc(inst.name) + '" placeholder="e.g. Main"></label>'
    + '<label class="field" style="margin-top:8px">AutoClash folder'
    + '<input type="text" data-wiz="folder" data-i="' + i + '" value="' + esc(inst.folder) + '" placeholder="C:\\AutoClash\\Main"></label>'
    + '<div class="grid" style="grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">'
    + '<label class="field">ADB device<input type="text" data-wiz="device" data-i="' + i + '" value="' + esc(inst.device) + '" placeholder="127.0.0.1:16384"></label>'
    + '<label class="field">Logs folder<input type="text" data-wiz="logsDir" data-i="' + i + '" value="' + esc(inst.logsDir || "") + '" placeholder="(folder)\\logs"></label>'
    + "</div></div>"
  ).join("");

  const found = wiz.detected.length
    ? '<div class="sub tiny" style="margin-top:8px">Found ' + wiz.detected.length + " running instance(s): "
      + wiz.detected.map((d) => esc(d.suggestedName)).join(", ") + "</div>"
    : "";

  return '<p class="sub">Add each AutoClash window you want to monitor. You can add more later in Settings.</p>'
    + '<div class="btn-row" style="margin-top:10px">'
    + '<button class="btn" id="wizDetect"' + (wiz.busy ? " disabled" : "") + ">Detect running instances</button>"
    + '<button class="btn" id="wizAdd">Add manually</button></div>'
    + found
    + rows
    + (wiz.instances.length ? "" : '<div class="sub tiny" style="margin-top:12px">No instances yet. Detect finds them automatically if AutoClash is running.</div>')
    + '<div class="sub tiny" id="wizInstErr" style="color:#ff8a85;margin-top:8px"></div>';
}

function stepAccess() {
  const a = (wiz.state && wiz.state.access) || {};
  const port = wiz.access.port;
  const tsUrl = a.tailscaleIp ? "http://" + a.tailscaleIp + ":" + port : "";

  const fw = a.firewallRuleExists
    ? '<div class="sub tiny" style="color:#6fdc93;margin-top:6px">A firewall rule for port ' + port + " already exists.</div>"
    : '<div class="wiz-warn">'
      + "<b>One firewall rule is needed.</b> Your Tailscale adapter is on the "
      + esc(a.tailscaleProfile || "Private") + " profile, and Windows blocks inbound connections there by default. "
      + "Run this once in an <b>Administrator</b> PowerShell:"
      + '<pre class="log" style="height:auto;margin-top:8px">New-NetFirewallRule -DisplayName "NullWebMonitor" -Direction Inbound -Action Allow -Protocol TCP -LocalPort '
      + port + " -Profile " + esc(a.tailscaleProfile || "Private") + " -RemoteAddress 100.64.0.0/10</pre>"
      + '<div class="sub tiny" style="margin-top:6px">This panel will not run it for you — changing firewall rules is yours to approve.</div>'
      + "</div>";

  const ts = a.tailscaleInstalled
    ? '<div class="wiz-ok"><b>Tailscale detected.</b><br>Open <code>' + esc(tsUrl) + "</code> on your phone"
      + (a.tailscaleName ? ", or <code>http://" + esc(a.tailscaleName) + ":" + port + "</code> with MagicDNS." : ".") + "</div>"
    : '<div class="wiz-warn"><b>Tailscale not found.</b> It is free and the easiest way to reach this from your phone with no open ports. '
      + 'Install it from tailscale.com/download on this PC and your phone, then re-run detection.</div>';

  const lan = (a.lanAddresses || []).length
    ? '<div class="sub tiny" style="margin-top:8px">On your home network: '
      + a.lanAddresses.map((ip) => "<code>http://" + esc(ip) + ":" + port + "</code>").join(" ") + "</div>"
    : "";

  return "<p class=\"sub\">How you will reach the panel from your phone.</p>"
    + ts + lan + fw
    + '<label class="field" style="margin-top:14px">Bind to'
    + '<select id="wizHost">'
    + '<option value="0.0.0.0"' + (wiz.access.host === "0.0.0.0" ? " selected" : "") + ">All interfaces — Tailscale and home network</option>"
    + (a.tailscaleIp ? '<option value="' + esc(a.tailscaleIp) + '"' + (wiz.access.host === a.tailscaleIp ? " selected" : "") + ">Tailscale only (" + esc(a.tailscaleIp) + ")</option>" : "")
    + '<option value="127.0.0.1"' + (wiz.access.host === "127.0.0.1" ? " selected" : "") + ">This PC only</option>"
    + "</select></label>"
    + '<label class="field" style="margin-top:10px">Port<input type="number" id="wizPort" value="' + port + '"></label>'
    + '<div class="sub tiny" style="margin-top:10px">Do not port-forward this to the internet. It runs PowerShell and launches programs on this PC.</div>';
}

// One Discord channel per instance, separate from the control panel's.
// The channel name is what the bot renames that channel to as status changes,
// so "main-farm" becomes 🟢-main-farm while it is running.
function channelRows() {
  if (!wiz.instances.length) return "";

  const rows = wiz.instances.map((inst, i) =>
    '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line-soft)">'
    + '<b style="font-size:13px">' + esc(inst.name || "Instance " + (i + 1)) + "</b>"
    + '<div class="grid" style="grid-template-columns:1fr 1fr;gap:8px;margin-top:6px">'
    + '<label class="field">Channel ID'
    + '<input type="text" data-wiz="channelId" data-i="' + i + '" value="' + esc(inst.channelId || "")
    + '" placeholder="optional"></label>'
    + '<label class="field">Channel name'
    + '<input type="text" data-wiz="channelName" data-i="' + i + '" value="' + esc(inst.channelName || "")
    + '" placeholder="' + esc(inst.name || "") + '"></label>'
    + "</div></div>"
  ).join("");

  return '<div style="margin-top:14px"><b style="font-size:13px">Per-instance channels</b>'
    + '<div class="sub tiny" style="margin-top:4px">Give each instance its own channel for its status embed and log thread. '
    + 'Leave blank to send everything to the control panel channel.</div>'
    + rows + "</div>";
}

function stepOptional() {
  return "<p class=\"sub\">Both are optional — the panel is fully usable without them. You can set these up later in Settings.</p>"
    + '<div class="card" style="margin-top:12px;background:var(--panel-2)">'
    + "<b>Discord bot</b>"
    + '<div class="sub tiny" style="margin-top:4px">Adds a control panel, status embeds and log threads in your server. '
    + 'Step-by-step instructions are in the <b>Guide</b> tab once setup finishes.</div>'
    + '<label class="field" style="margin-top:10px">Bot token<input type="password" id="wizDToken" placeholder="leave blank to skip" autocomplete="off"></label>'
    + '<label class="field" style="margin-top:8px">Control panel channel ID'
    + '<input type="text" id="wizDChan" placeholder="right-click a channel with Developer Mode on"></label>'
    + '<div class="sub tiny" style="margin-top:4px">Where the buttons and daily summary are posted.</div>'
    + '<label class="field" style="margin-top:8px">Control panel channel name'
    + '<input type="text" id="wizDChanName" placeholder="NullWebMonitor Panel"></label>'
    + '<div class="sub tiny" style="margin-top:4px">The bot renames that channel to this once, on start.</div>'
    + '<div class="btn-row" style="margin-top:10px"><button class="btn sm" id="wizDTest">Send test message</button>'
    + '<span class="sub tiny" id="wizDResult" style="align-self:center"></span></div>'
    + channelRows()
    + '</div>'
    + '<div class="card" style="margin-top:12px;background:var(--panel-2)">'
    + "<b>Phone alerts (ntfy)</b>"
    + '<div class="sub tiny" style="margin-top:4px">Pushes a notification when something actually breaks. '
    + "The topic name is the only thing protecting it on the public server, so use a long random one.</div>"
    + '<label class="field" style="margin-top:10px">Topic<input type="text" id="wizNtfy" placeholder="leave blank to skip"></label>'
    + '<button class="btn sm" id="wizNtfyGen" style="margin-top:8px">Generate a random topic</button></div>'
    + '<div class="sub tiny" id="wizSaveErr" style="color:#ff8a85;margin-top:10px"></div>';
}

// --- interaction -------------------------------------------------------------

document.addEventListener("click", async (event) => {
  const b = event.target.closest("button");
  if (!b || !$("#setup").classList.contains("show")) return;

  if (b.id === "wizBack") { wiz.step = Math.max(0, wiz.step - 1); return renderSetup(); }
  if (b.id === "wizAdd") { wiz.instances.push({ name: "", folder: "", device: "", logsDir: "" }); return renderSetup(); }
  if (b.dataset.wizdel !== undefined) { wiz.instances.splice(Number(b.dataset.wizdel), 1); return renderSetup(); }

  if (b.id === "wizDetect") {
    wiz.busy = true; renderSetup();
    try {
      const found = await post("/api/setup/detect");
      wiz.detected = found.instances || [];
      // Only pre-fill rows the user has not started filling in.
      if (!wiz.instances.some((i) => i.name || i.folder)) {
        wiz.instances = wiz.detected.map((d) => ({
          name: d.suggestedName, folder: d.folder, device: d.device, logsDir: d.logsDir || "",
        }));
        if (wiz.detected[0]) {
          wiz.emulator = wiz.detected[0].emulator || "";
          wiz.adbPath = wiz.detected[0].adbPath || "";
        }
      }
    } catch (error) { toast(error.message, true); }
    wiz.busy = false; return renderSetup();
  }

  if (b.id === "wizNtfyGen") {
    const rnd = crypto.getRandomValues(new Uint8Array(9));
    $("#wizNtfy").value = "nwm-" + [...rnd].map((n) => n.toString(16).padStart(2, "0")).join("");
    return;
  }

  if (b.id === "wizDTest") {
    const out = $("#wizDResult");
    out.textContent = "Sending...";
    try {
      const r = await post("/api/setup/discord-test", { token: $("#wizDToken").value, channelId: $("#wizDChan").value });
      out.style.color = "#6fdc93"; out.textContent = r.output;
    } catch (error) { out.style.color = "#ff8a85"; out.textContent = error.message; }
    return;
  }

  if (b.id === "wizNext") return wizardNext();
});

document.addEventListener("input", (event) => {
  const el = event.target;
  if (el.dataset && el.dataset.wiz !== undefined) {
    wiz.instances[Number(el.dataset.i)][el.dataset.wiz] = el.value;
  }
});

async function wizardNext() {
  // Password
  if (wiz.step === 0) {
    const p1 = $("#wizPass").value, p2 = $("#wizPass2").value;
    const err = $("#wizPassErr");
    if (p1.length < 8) return void (err.textContent = "Use at least 8 characters.");
    if (p1 !== p2) return void (err.textContent = "The two passwords do not match.");
    wiz.busy = true; renderSetup();
    try {
      await post("/api/setup/password", { password: p1 });
      wiz.step = 1;
    } catch (error) { toast(error.message, true); }
    wiz.busy = false; return renderSetup();
  }

  // Instances
  if (wiz.step === 1) {
    const err = $("#wizInstErr");
    if (!wiz.instances.length) return void (err.textContent = "Add at least one instance.");
    const bad = wiz.instances.find((i) => !i.name.trim() || !i.folder.trim());
    if (bad) return void (err.textContent = "Every instance needs a name and a folder.");
    wiz.step = 2; return renderSetup();
  }

  // Access
  if (wiz.step === 2) {
    wiz.access.host = $("#wizHost").value;
    wiz.access.port = Number($("#wizPort").value) || 8477;
    wiz.step = 3; return renderSetup();
  }

  // Finish.
  //
  // Read the optional fields BEFORE re-rendering: renderSetup() rebuilds the
  // DOM, so reading them afterwards silently drops whatever was typed.
  const payload = {
    instances: wiz.instances,
    emulator: wiz.emulator,
    adbPath: wiz.adbPath,
    access: wiz.access,
    discord: {
      token: ($("#wizDToken") || {}).value || "",
      channelId: ($("#wizDChan") || {}).value || "",
      channelName: ($("#wizDChanName") || {}).value || "",
    },
    ntfy: { topic: ($("#wizNtfy") || {}).value || "" },
  };

  wiz.busy = true; renderSetup();
  try {
    await post("/api/setup/save", payload);
    $("#setupBody").innerHTML = '<div class="card wiz"><h2>Setup complete</h2>'
      + '<p class="sub">Restart the monitor to start watching. Close the console window and run '
      + "<code>npm start</code> again, then sign in with the password you just set.</p>"
      + '<p class="sub tiny">The Guide tab has step-by-step instructions for Discord, Tailscale and everything else.</p></div>';
  } catch (error) {
    wiz.busy = false; renderSetup();
    const err = $("#wizSaveErr");
    if (err) err.textContent = error.message; else toast(error.message, true);
  }
}
