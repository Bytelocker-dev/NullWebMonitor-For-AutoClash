const fs = require('fs');
let code = fs.readFileSync('bot.js', 'utf8');

const bannerFunction = \unction printStartupBanner() {
  console.log(\\\\\\\x1b[1;37m
  ██╗  ██╗     ██████     ██████╗ 
  ╚██╗██╔╝   ██████████   ██╔══██╗
   ╚███╔╝    ██\\\\x1b[1;31m██\\\\x1b[1;37m██\\\\x1b[1;31m██\\\\x1b[1;37m██   ██████╔╝
   ██╔██╗    ██  \\\\x1b[1;30m██\\\\x1b[1;37m  ██   ██╔══██╗
  ██╔╝ ██╗    ████████    ██║  ██║
  ╚═╝  ╚═╝     ║ ║ ║ ║    ╚═╝  ╚═╝
               ▄ ▄ ▄ ▄            
  \\\\x1b[90m──────────────────────────────────\\\\x1b[0m
  \\\\x1b[1;36mXOR WebMonitor v2.0.2\\\\x1b[0m
  Self-Hosted Control Panel & Stats Monitor
  \\\);
}\;

const startIndex = code.indexOf('function printStartupBanner() {');
const endIndex = code.indexOf('async function handlePasswordResetCli');

code = code.substring(0, startIndex) + bannerFunction + '\n\n' + code.substring(endIndex);
fs.writeFileSync('bot.js', code, 'utf8');
