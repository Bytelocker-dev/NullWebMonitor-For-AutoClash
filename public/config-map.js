/* Presentation rules for AutoClash's config keys.
 *
 * Mirrors AutoClash's own sidebar so the panel feels like the same product.
 *
 * Design rule that keeps this from rotting: assignment is by PATTERN, never an
 * exhaustive key list, and anything unmatched falls into "Other / New" rather
 * than being hidden. A new AutoClash version can add keys and they will still
 * appear — at worst in the catch-all with a prettified raw name.
 */

// Ordered: first match wins, so put specific rules above general ones.
const CONFIG_SECTIONS = [
  { id: "runtime-state", name: "Runtime state", test: (k) => /(_DONE|_LAST_TIME|_CYCLE_START|_PERIOD_START|_COUNTER|_CLAIMED|_RECHECK_AFTER|_EXHAUSTED_STREAK|_UPGRADE_STARTED)$/.test(k) },

  { id: "bot-runtime", name: "Bot Runtime", test: (k) => /^(ACTIVE_HOURS_|BOT_END_|HUMANIZED_|ERROR_WATCHDOG_)/.test(k) },
  { id: "emulator", name: "Emulator & System", test: (k) => /^(EMULATOR_|UI_LANGUAGE|TEMPLATES_DIR)/.test(k) },
  { id: "multi-village", name: "Multi Village", test: (k) => /^(MULTI_VILLAGE_|VILLAGE_|START_PROFILE|USE_ROOT_PROFILE_SWAP|PROFILE_MATCH_THRESHOLD)/.test(k) },

  // Attack Army — the strategy and slot pickers, plus shared attack settings.
  { id: "attack-army", tab: "Attack Army", name: "Attack Army", test: (k) => /^(SELECTED_ATTACK_STRATEGY|SELECTED_ARMY_SLOT|AIR_TROOP_|HERO_TAP_DELAY_|VALKYRIE_)/.test(k) },
  { id: "attack-army", tab: "Ranked/War Army", name: "Attack Army", test: (k) => /^(RANKED_ATTACK_STRATEGY|RANKED_ARMY_SLOT)$/.test(k) },

  // Upgrades/Research has its own Home and Builder Base tabs.
  { id: "upgrades", tab: "Home", name: "Upgrades/Research", test: (k) => /^HOME_/.test(k) },
  { id: "upgrades", tab: "Builder Base", name: "Upgrades/Research", test: (k) => /^(BB_UPGRADE_|BB_RESEARCH_|BB_SAVE_1_BUILDER)/.test(k) },

  { id: "builder-base", name: "Builder Base", test: (k) => /^(BUILDER_|BUILDERBASE_|BB_)/.test(k) },
  { id: "clan-capital", name: "Clan Capital", test: (k) => /^CLAN_CAPITAL/.test(k) },
  { id: "xp-farming", name: "XP Farming", test: (k) => /^(REQUEST_AND_LEAVE_|DONATE_ONLY_)/.test(k) },
  { id: "extra-modes", name: "Extra Modes", test: (k) => /^(RANKED_|RANK_FIRST|CG_|CLAN_GAMES|WAR_|ACCOUNT_CREATION_)/.test(k) },

  // General is AutoClash's first page: farming, walls, attack filter, donations,
  // battle conditions and the "Extras" checkbox grid.
  { id: "general", name: "General", test: (k) => /^(FARMING_|UPGRADE_WALLS|WALL_|ATTACK_MIN_|REQUEST_DONATIONS|WAIT_FOR_CC_TROOPS|ENABLE_DONATIONS|DONATION_MODE|END_BATTLE_ON_STARS|TARGET_STARS|COLLECT_|REMOVE_OBSTACLES|START_HELPERS|CLEAR_|CLAIM_|WEEKLY_|CC_)/.test(k) },
];

const CONFIG_FALLBACK_SECTION = { id: "other", name: "Other / New" };

function sectionForKey(key) {
  return CONFIG_SECTIONS.find((s) => s.test(key)) || CONFIG_FALLBACK_SECTION;
}

/* Cosmetic only. A missing entry costs a prettier name, never a missing
 * setting — that is what stops this becoming a maintenance treadmill. */
const KEY_LABELS = {
  FARMING_ENABLED: "Enable Farming",
  UPGRADE_WALLS: "Upgrade Walls",
  WALL_STOP_LEVEL: "Stop walls at level",
  ATTACK_MIN_GOLD: "Min Gold",
  ATTACK_MIN_ELIXIR: "Min Elixir",
  ATTACK_MIN_DARK: "Min Dark",
  REQUEST_DONATIONS: "Request Donations",
  WAIT_FOR_CC_TROOPS: "Wait 60s for CC",
  ENABLE_DONATIONS: "Enable Donating",
  DONATION_MODE: "Donation Mode",
  END_BATTLE_ON_STARS: "End Battle On Stars",
  TARGET_STARS: "Target Stars",
  COLLECT_COLLECTORS: "Collect Collectors",
  COLLECT_CART: "Collect Loot Cart",
  COLLECT_CC_LOOT: "Collect CC Loot",
  COLLECT_ACHIEVEMENTS: "Collect Achievements",
  REMOVE_OBSTACLES: "Remove Obstacles",
  START_HELPERS: "Start Helpers",
  CLEAR_TOMBSTONES: "Clear Tombstones",
  CLAIM_WEEKLY_DEAL: "Claim Weekly Deal",
  WEEKLY_CLAIM_STARRY_ORE: "Claim Starry Ore",

  SELECTED_ATTACK_STRATEGY: "Attack Strategy",
  SELECTED_ARMY_SLOT: "Army Slot",
  RANKED_ATTACK_STRATEGY: "Ranked Attack Strategy",
  RANKED_ARMY_SLOT: "Ranked Army Slot",
  HERO_TAP_DELAY_ENABLED: "Hero Re-Tap Delay",
  HERO_TAP_DELAY_SECONDS: "Hero Re-Tap Delay (seconds)",
  AIR_TROOP_WIDTH_ENABLED: "Air Troop Spread",
  AIR_TROOP_WIDTH: "Air Troop Spread (%)",
  AIR_TROOP_WIDTH_IS_PERCENT: "Air Troop Spread is a percentage",

  MULTI_VILLAGE_ENABLED: "Enable Multi Village",
  USE_ROOT_PROFILE_SWAP: "Use Root Profile Swap",
  START_PROFILE: "Start Profile",
  VILLAGE_COUNT: "Village Count",
  VILLAGE_SWITCH_CONDITION: "Switch Condition",
  VILLAGE_SWITCH_MINUTES: "Switch Every (min)",

  BUILDER_ENABLED: "Enable Builder Base",
  BUILDER_RETURN_HOME_WHEN: "Return Home When",
  BUILDER_ARMY_TROOP: "Army Troop",
  BUILDER_TARGET_STARS: "Target Stars",
  BUILDER_MAX_ATTACKS: "Max Attacks Per Session",
  BUILDER_END_AFTER_TROOP_DROP: "End battle after troop drop",
  BUILDERBASE_UPGRADE_WALLS: "Upgrade Walls",
  BUILDER_COLLECT_RESOURCES: "Collect Resources",
  BUILDER_COLLECT_GEM_MINE: "Collect Gem Mine",
  BUILDER_BOOST_CLOCK_TOWER: "Boost Clock Tower",
  BB_REMOVE_OBSTACLES: "Remove Obstacles",

  CLAN_CAPITAL: "Enable Capital Raid",
  CLAN_CAPITAL_TROOP: "Troop",
  CLAN_CAPITAL_DUMP_GOLD_TREASURY_IF_FULL: "Dump gold in treasury if full",

  HOME_UPGRADE_ENABLED: "Upgrades",
  HOME_SAVE_1_BUILDER: "Save 1 Builder",
  HOME_RUSH_TH_ENABLED: "Rush TH",
  HOME_UPGRADE_PERFORM_SUGGESTED: "Perform Suggested",
  HOME_UPGRADE_SUGGESTED_IGNORE_TOWNHALL: "Ignore Townhall",
  HOME_UPGRADE_SUGGESTED_ROTATE: "Rotate Suggested Upgrades",
  HOME_UPGRADE_SLOTS: "Upgrade Slots",
  HOME_RESEARCH_ENABLED: "Research",
  HOME_RESEARCH_USE_1_GEM_HELPER: "Use 1 Gem Helper",
  HOME_RESEARCH_PERFORM_SUGGESTED: "Perform Suggested",
  HOME_RESEARCH_SUGGESTED_ROTATE: "Rotate Suggested Upgrades",
  HOME_RESEARCH_SLOTS: "Research Slots",
  HOME_RESEARCH_PETS: "Pets",
  HOME_RESEARCH_PET_TARGET: "Pet",
  BB_UPGRADE_ENABLED: "Upgrades",
  BB_SAVE_1_BUILDER: "Save 1 Builder",
  BB_UPGRADE_PERFORM_SUGGESTED: "Perform Suggested",
  BB_UPGRADE_SUGGESTED_ROTATE: "Rotate Suggested Upgrades",
  BB_UPGRADE_SLOTS: "Upgrade Slots",
  BB_RESEARCH_ENABLED: "Research",
  BB_RESEARCH_PERFORM_SUGGESTED: "Perform Suggested",
  BB_RESEARCH_SUGGESTED_ROTATE: "Rotate Suggested Upgrades",
  BB_RESEARCH_SLOTS: "Research Slots",

  REQUEST_AND_LEAVE_ENABLED: "Enable Request and Dump",
  REQUEST_AND_LEAVE_JOIN_LEAVE: "Enable Joining and Leaving Clan",
  REQUEST_AND_LEAVE_CLAN_TAG: "Clan Tag",
  REQUEST_AND_LEAVE_WAIT_FOR_COOLDOWN: "Wait for Cooldown",
  REQUEST_AND_LEAVE_SET_ARMY_SLOT1: "Set Army Slot 1",
  REQUEST_AND_LEAVE_ARMY_LINK: "Army Link",
  DONATE_ONLY_ENABLED: "Enable Donate Only",
  DONATE_ONLY_SPEED_MODE: "Speed Mode",
  DONATE_ONLY_SPEED_TROOPS: "Tap Points — Troops",
  DONATE_ONLY_SPEED_SPELLS: "Tap Points — Spells",
  DONATE_ONLY_SPEED_ELIXIR_COST: "Donation Cost — Elixir",
  DONATE_ONLY_SPEED_DARK_COST: "Donation Cost — Dark",

  RANKED_REQUEST_DONATIONS: "Request Donations",
  RANKED_WAIT_FOR_CC_TROOPS: "Wait 60s for CC",
  RANK_FIRST: "Enable Ranked Attacks",
  CLAN_GAMES: "Enable Clan Games",
  CG_TROOP_CHALLENGES: "Enable Super Troop Challenges",
  CG_DISABLED_CHALLENGES: "Challenge Filters",
  CG_CLAIM_REWARDS_FOR_GEMS: "Claim Rewards for Gems",
  WAR_ATTACKS_ENABLED: "Enable War Attacks",
  WAR_MODE: "War Mode",
  WAR_ATTACK1_TARGET: "Attack 1 Target",
  WAR_ATTACK1_STARS: "Attack 1 Stars",
  WAR_ATTACK2_TARGET: "Attack 2 Target",
  WAR_ATTACK2_STARS: "Attack 2 Stars",
  WAR_REQUEST_CC: "Request Donations",
  WAR_WAIT_FOR_CC: "Wait 60s for CC",
  WAR_ONE_ATTACK_PER_SESSION: "Use 1 Attack Per Session",
  ACCOUNT_CREATION_COUNT: "Times to Run",
  ACCOUNT_CREATION_NAME: "Account Name",
  ACCOUNT_CREATION_NUMERAL_SUFFIX: "Numeral Suffix",

  BOT_END_CONDITION_ENABLED: "Enable Bot End Condition",
  BOT_END_CONDITION_TYPE: "End Condition",
  BOT_END_TIME_MINUTES: "Time to End (minutes)",
  ACTIVE_HOURS_ENABLED: "Enable Active Hours",
  ACTIVE_HOURS_START: "Start (HH:MM)",
  ACTIVE_HOURS_END: "End (HH:MM)",
  HUMANIZED_BREAKS_ENABLED: "Enable Humanized Breaks",
  HUMANIZED_RUN_MIN_MINUTES: "Run from (minutes)",
  HUMANIZED_RUN_MAX_MINUTES: "Run to (minutes)",
  HUMANIZED_BREAK_MIN_MINUTES: "Break from (minutes)",
  HUMANIZED_BREAK_MAX_MINUTES: "Break to (minutes)",
  ERROR_WATCHDOG_ENABLED: "Enable Error Watchdog",
};


// Every strategy AutoClash 2.0.9 lists, for the guide. Ones without a confirmed
// identifier cannot be offered in the dropdown, but the panel learns them the
// first time you pick one in AutoClash itself.
/* Every strategy AutoClash 2.0.9 offers, with the identifier it actually
 * stores. Captured by selecting each one in AutoClash and reading the config it
 * wrote — not guessed. Note "Valkyrie + Quake" stores as `valkyrie`, which no
 * sensible guess would have produced, and a wrong identifier breaks a run with
 * no error. Order matches AutoClash's own dropdown. */
const ATTACK_STRATEGY_LABELS = {
  edragon: "Electro Dragon/Loon",
  dragon: "Dragon/Loon",
  valkyrie: "Valkyrie + Quake",
  valkyrie_1side: "Valkyrie 1 Side",
  barchgob: "BArch or Goblin",
  sminion: "Super Minion + Quake",
  sbarb: "Super Barbarian + Quake",
  thrower: "Thrower Smash",
};

const ATTACK_STRATEGY_CATALOGUE = Object.values(ATTACK_STRATEGY_LABELS);

// Values AutoClash shows differently from how it stores them.
const VALUE_LABELS = {
  // Display names taken from AutoClash 2.0.9. Only identifiers confirmed in
  // real config files are listed — the app offers more strategies, but their
  // stored identifiers are not published anywhere we can read, and guessing one
  // would write a value AutoClash does not recognise.
  SELECTED_ATTACK_STRATEGY: ATTACK_STRATEGY_LABELS,
  RANKED_ATTACK_STRATEGY: ATTACK_STRATEGY_LABELS,
  BOT_END_CONDITION_TYPE: {
    loot_full_all: "End when all active account(s) are loot full",
    time: "End after a set time",
  },
  VILLAGE_SWITCH_CONDITION: { after_time: "After a set time", loot_full: "When loot full" },
  HOME_RESEARCH_PET_TARGET: { pet_upgrade_lassi: "L.A.S.S.I" },
  DONATION_MODE: { hybrid: "Hybrid" },
};

/* Army slots are displayed as "Slot 1"-"Slot 5", but AutoClash stores them
 * with different bases depending on the key. Confirmed against a real config
 * and AutoClash 2.0.9 itself: SELECTED_ARMY_SLOT held 0 and RANKED_ARMY_SLOT
 * held 1, and the app showed "Slot1" for both. Getting this wrong would point
 * the user at the wrong army. */
const SLOT_BASE = { SELECTED_ARMY_SLOT: 0, RANKED_ARMY_SLOT: 1 };

/* Seed choices for keys that should always be a selector, even before the
 * panel has seen more than one value on this machine.
 *
 * These are only identifiers confirmed from real AutoClash config and log
 * output. Nothing is invented: writing a strategy name AutoClash does not
 * recognise would break a run silently, so an incomplete list is safer than a
 * guessed one. Anything missing still reaches the user through discovery from
 * their own profiles, and through the "Custom value" escape in the UI.
 */

const KNOWN_CHOICES = {
  SELECTED_ATTACK_STRATEGY: Object.keys(ATTACK_STRATEGY_LABELS),
  RANKED_ATTACK_STRATEGY: Object.keys(ATTACK_STRATEGY_LABELS),
  SELECTED_ARMY_SLOT: [0, 1, 2, 3, 4],
  RANKED_ARMY_SLOT: [1, 2, 3, 4, 5],
  BUILDER_TARGET_STARS: ["Full Battle", "1", "2", "3"],
  WAR_ATTACK1_TARGET: ["Mirror", "Any"],
  WAR_ATTACK2_TARGET: ["Mirror", "Any"],
  WAR_ATTACK1_STARS: [1, 2, 3],
  WAR_ATTACK2_STARS: [1, 2, 3],
  TARGET_STARS: [1, 2, 3],
  VILLAGE_SWITCH_CONDITION: ["after_time", "loot_full"],
  BOT_END_CONDITION_TYPE: ["loot_full_all", "time"],
};

/* The list a selector should offer: what AutoClash is known to accept, plus
 * whatever exists in this user's own profiles. Discovery alone drives keys we
 * have no seed for, so a fresh AutoClash option appears as soon as any profile
 * uses it. */
function choicesForKey(key, discovered) {
  const seed = KNOWN_CHOICES[key] || [];
  const found = Array.isArray(discovered) ? discovered : [];
  if (!seed.length && found.length < 2) return [];

  const out = [];
  for (const value of [...seed, ...found]) {
    if (!out.some((existing) => String(existing) === String(value))) out.push(value);
  }
  return out;
}

function prettifyKey(key) {
  return String(key)
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function labelForKey(key) {
  return KEY_LABELS[key] || prettifyKey(key);
}

function labelForValue(key, value) {
  if (key in SLOT_BASE) return `Slot ${Number(value) - SLOT_BASE[key] + 1}`;
  const map = VALUE_LABELS[key];
  if (map && map[value] !== undefined) return map[value];
  if (typeof value === "string" && /^[a-z0-9_]+$/.test(value)) return prettifyKey(value);
  return String(value);
}

if (typeof module !== "undefined") {
  module.exports = { CONFIG_SECTIONS, choicesForKey, KNOWN_CHOICES, ATTACK_STRATEGY_CATALOGUE, CONFIG_FALLBACK_SECTION, sectionForKey, labelForKey, labelForValue, prettifyKey, KEY_LABELS, VALUE_LABELS };
}
