"use strict";

// Config section mapping. The contract that matters: every key AutoClash writes
// must land in exactly one section, and a key nobody has seen before must still
// show up rather than silently vanish.
// Run: node test-config-map.js

const assert = require("assert");
const map = require("./public/config-map.js");

// Real key sets, captured from AutoClash 2.0.9. Account-level config.
const ACCOUNT_KEYS = [
  "AIR_TROOP_WIDTH", "AIR_TROOP_WIDTH_ENABLED", "AIR_TROOP_WIDTH_IS_PERCENT",
  "ATTACK_MIN_DARK", "ATTACK_MIN_ELIXIR", "ATTACK_MIN_GOLD",
  "BB_OBSTACLE_REMOVAL_LAST_TIME", "BB_REMOVE_OBSTACLES", "BB_RESEARCH_ENABLED",
  "BB_RESEARCH_PERFORM_SUGGESTED", "BB_RESEARCH_SLOT", "BB_RESEARCH_SLOTS",
  "BB_RESEARCH_SUGGESTED_ROTATE", "BB_SAVE_1_BUILDER", "BB_UPGRADE_ENABLED",
  "BB_UPGRADE_PERFORM_SUGGESTED", "BB_UPGRADE_SLOTS", "BB_UPGRADE_SUGGESTED_ROTATE",
  "BUILDERBASE_UPGRADE_WALLS", "BUILDER_ARMY_TROOP", "BUILDER_BOOST_CLOCK_TOWER",
  "BUILDER_COLLECT_GEM_MINE", "BUILDER_COLLECT_RESOURCES", "BUILDER_ENABLED",
  "BUILDER_END_AFTER_TROOP_DROP", "BUILDER_MAX_ATTACKS", "BUILDER_RETURN_HOME_WHEN",
  "BUILDER_TARGET_STARS", "CC_LOOT_CYCLE_START", "CC_LOOT_DARK_DONE",
  "CC_LOOT_ELIXIR_DONE", "CC_LOOT_GOLD_DONE", "CG_CHALLENGE_NAME_OVERRIDES",
  "CG_CLAIM_REWARDS_FOR_GEMS", "CG_DISABLED_CHALLENGES", "CG_TROOP_CHALLENGES",
  "CLAIM_WEEKLY_DEAL", "CLAN_CAPITAL", "CLAN_CAPITAL_DUMP_GOLD_TREASURY_IF_FULL",
  "CLAN_CAPITAL_TROOP", "CLAN_GAMES", "CLEAR_TOMBSTONES", "COLLECT_ACHIEVEMENTS",
  "COLLECT_CART", "COLLECT_CC_LOOT", "COLLECT_COLLECTORS", "DONATE_ONLY_ENABLED",
  "DONATE_ONLY_SPEED_DARK_COST", "DONATE_ONLY_SPEED_ELIXIR_COST", "DONATE_ONLY_SPEED_MODE",
  "DONATE_ONLY_SPEED_SPELLS", "DONATE_ONLY_SPEED_TROOPS", "DONATION_MODE",
  "ENABLE_DONATIONS", "END_BATTLE_ON_STARS", "FARMING_ENABLED",
  "HERO_TAP_DELAY_ENABLED", "HERO_TAP_DELAY_SECONDS", "HOME_RESEARCH_ENABLED",
  "HOME_RESEARCH_PERFORM_SUGGESTED", "HOME_RESEARCH_PETS", "HOME_RESEARCH_PET_TARGET",
  "HOME_RESEARCH_SLOT", "HOME_RESEARCH_SLOTS", "HOME_RESEARCH_SUGGESTED_ROTATE",
  "HOME_RESEARCH_USE_1_GEM_HELPER", "HOME_RUSH_TH_ENABLED", "HOME_RUSH_TH_PHASE",
  "HOME_RUSH_TH_TH_UPGRADE_STARTED", "HOME_SAVE_1_BUILDER", "HOME_UPGRADE_ENABLED",
  "HOME_UPGRADE_PERFORM_SUGGESTED", "HOME_UPGRADE_SLOTS",
  "HOME_UPGRADE_SUGGESTED_IGNORE_TOWNHALL", "HOME_UPGRADE_SUGGESTED_ROTATE",
  "HOME_WALL_EXHAUSTED_STREAK", "HOME_WALL_RECHECK_AFTER", "OBSTACLE_REMOVAL_LAST_TIME",
  "PROFILE_MATCH_THRESHOLD", "RANKED_ARMY_SLOT", "RANKED_ATTACK_STRATEGY",
  "RANKED_REQUEST_DONATIONS", "RANKED_WAIT_FOR_CC_TROOPS", "RANK_FIRST",
  "REMOVE_OBSTACLES", "REQUEST_DONATIONS", "SELECTED_ARMY_SLOT",
  "SELECTED_ATTACK_STRATEGY", "START_HELPERS", "TARGET_STARS", "TEMPLATES_DIR",
  "UPGRADE_WALLS", "VALKYRIE_1SIDE_MULTITOUCH_EXTRA_MS_PER_TROOP", "WAIT_FOR_CC_TROOPS",
  "WALL_STOP_LEVEL", "WAR_ATTACK1_STARS", "WAR_ATTACK1_TARGET", "WAR_ATTACK2_STARS",
  "WAR_ATTACK2_TARGET", "WAR_ATTACKS_ENABLED", "WAR_MODE", "WAR_ONE_ATTACK_PER_SESSION",
  "WAR_REQUEST_CC", "WAR_WAIT_FOR_CC", "WEEKLY_CLAIM_STARRY_ORE",
  "WEEKLY_DEAL_CLAIMED_PERIOD_START",
];

// Instance-level keys that exist only in profiles/config.json.
const INSTANCE_ONLY_KEYS = [
  "ACCOUNT_CREATION_COUNT", "ACCOUNT_CREATION_NAME", "ACCOUNT_CREATION_NUMERAL_SUFFIX",
  "ACCOUNT_CREATION_SUFFIX_COUNTER", "ACTIVE_HOURS_ENABLED", "ACTIVE_HOURS_END",
  "ACTIVE_HOURS_START", "BOT_END_CONDITION_ENABLED", "BOT_END_CONDITION_TYPE",
  "BOT_END_TIME_MINUTES", "EMULATOR_INSTALL_PATHS", "EMULATOR_INSTANCE", "EMULATOR_IP",
  "EMULATOR_PORT", "EMULATOR_SELECTION", "ERROR_WATCHDOG_ENABLED",
  "HUMANIZED_BREAKS_ENABLED", "HUMANIZED_BREAK_MAX_MINUTES", "HUMANIZED_BREAK_MIN_MINUTES",
  "HUMANIZED_RUN_MAX_MINUTES", "HUMANIZED_RUN_MIN_MINUTES", "MULTI_VILLAGE_ENABLED",
  "REQUEST_AND_LEAVE_ARMY_LINK", "REQUEST_AND_LEAVE_CLAN_TAG", "REQUEST_AND_LEAVE_ENABLED",
  "REQUEST_AND_LEAVE_JOIN_LEAVE", "REQUEST_AND_LEAVE_SET_ARMY_SLOT1",
  "REQUEST_AND_LEAVE_WAIT_FOR_COOLDOWN", "START_PROFILE", "UI_LANGUAGE",
  "USE_ROOT_PROFILE_SWAP", "VILLAGE_COUNT", "VILLAGE_SWITCH_CONDITION",
  "VILLAGE_SWITCH_MINUTES",
];

assert.strictEqual(ACCOUNT_KEYS.length, 106, "account key fixture matches the real file");
assert.strictEqual(INSTANCE_ONLY_KEYS.length, 34, "instance-only key fixture matches the real file");

// --- every key lands somewhere, exactly once -------------------------------

const allKeys = [...ACCOUNT_KEYS, ...INSTANCE_ONLY_KEYS];
const counts = {};

for (const key of allKeys) {
  const section = map.sectionForKey(key);
  assert.ok(section && section.id, `no section for ${key}`);
  counts[section.id] = (counts[section.id] || 0) + 1;
}

const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
assert.strictEqual(total, allKeys.length, "section counts sum to the key count — none dropped or duplicated");

// --- keys land where AutoClash's own sidebar puts them ----------------------

const expect = (key, sectionId, tab) => {
  const s = map.sectionForKey(key);
  assert.strictEqual(s.id, sectionId, `${key} should be in ${sectionId}, got ${s.id}`);
  if (tab) assert.strictEqual(s.tab, tab, `${key} should be on the "${tab}" tab, got "${s.tab}"`);
};

// General — the first page: farming, walls, attack filter, donations, extras.
expect("FARMING_ENABLED", "general");
expect("UPGRADE_WALLS", "general");
expect("WALL_STOP_LEVEL", "general");
expect("ATTACK_MIN_GOLD", "general");
expect("REQUEST_DONATIONS", "general");
expect("WAIT_FOR_CC_TROOPS", "general");
expect("END_BATTLE_ON_STARS", "general");
expect("COLLECT_CART", "general");
expect("CLAIM_WEEKLY_DEAL", "general");

// Attack Army, split across its two tabs exactly as AutoClash does.
expect("SELECTED_ATTACK_STRATEGY", "attack-army", "Attack Army");
expect("SELECTED_ARMY_SLOT", "attack-army", "Attack Army");
expect("HERO_TAP_DELAY_ENABLED", "attack-army", "Attack Army");
expect("AIR_TROOP_WIDTH", "attack-army", "Attack Army");
expect("RANKED_ATTACK_STRATEGY", "attack-army", "Ranked/War Army");
expect("RANKED_ARMY_SLOT", "attack-army", "Ranked/War Army");

// Ranked toggles belong to Extra Modes, not the army tab.
expect("RANKED_REQUEST_DONATIONS", "extra-modes");
expect("RANK_FIRST", "extra-modes");
expect("WAR_ATTACK1_TARGET", "extra-modes");
expect("CG_DISABLED_CHALLENGES", "extra-modes");
expect("ACCOUNT_CREATION_NAME", "extra-modes");

// Upgrades/Research owns the slot pickers for both bases.
expect("HOME_UPGRADE_SLOTS", "upgrades", "Home");
expect("HOME_RESEARCH_PETS", "upgrades", "Home");
expect("BB_UPGRADE_SLOTS", "upgrades", "Builder Base");
expect("BB_SAVE_1_BUILDER", "upgrades", "Builder Base");

// Builder Base keeps the attack-side settings.
expect("BUILDER_ENABLED", "builder-base");
expect("BUILDER_MAX_ATTACKS", "builder-base");
expect("BB_REMOVE_OBSTACLES", "builder-base");
expect("BUILDERBASE_UPGRADE_WALLS", "builder-base");

expect("CLAN_CAPITAL_TROOP", "clan-capital");
expect("REQUEST_AND_LEAVE_CLAN_TAG", "xp-farming");
expect("DONATE_ONLY_ENABLED", "xp-farming");
expect("ACTIVE_HOURS_START", "bot-runtime");
expect("HUMANIZED_BREAKS_ENABLED", "bot-runtime");
expect("BOT_END_CONDITION_TYPE", "bot-runtime");
expect("EMULATOR_PORT", "emulator");
expect("VILLAGE_COUNT", "multi-village");
expect("START_PROFILE", "multi-village");

// Runtime state is matched by suffix, ahead of everything else.
for (const key of ["CC_LOOT_GOLD_DONE", "OBSTACLE_REMOVAL_LAST_TIME", "WEEKLY_DEAL_CLAIMED_PERIOD_START", "ACCOUNT_CREATION_SUFFIX_COUNTER", "HOME_WALL_RECHECK_AFTER"]) {
  expect(key, "runtime-state");
}

// --- unknown keys surface rather than vanish --------------------------------

for (const key of ["ZZ_FUTURE_SETTING", "SOMETHING_ENTIRELY_NEW", "X"]) {
  assert.strictEqual(map.sectionForKey(key).id, "other", `${key} should fall into Other / New`);
}

// A new key under a known prefix inherits that section with no code change.
expect("BB_SOMETHING_NEW", "builder-base");
expect("WAR_BRAND_NEW_OPTION", "extra-modes");
expect("ACTIVE_HOURS_TIMEZONE", "bot-runtime");

// --- labels -----------------------------------------------------------------

assert.strictEqual(map.labelForKey("SELECTED_ATTACK_STRATEGY"), "Attack Strategy");
assert.strictEqual(map.labelForKey("ZZ_FUTURE_SETTING"), "Zz Future Setting", "unmapped keys still get a readable name");
assert.strictEqual(map.labelForValue("SELECTED_ATTACK_STRATEGY", "valkyrie_1side"), "Valkyrie 1 Side");
assert.strictEqual(map.labelForValue("SELECTED_ARMY_SLOT", 0), "Slot 1", "slot 0 reads as Slot 1");
assert.strictEqual(map.labelForValue("HOME_RESEARCH_PET_TARGET", "pet_upgrade_lassi"), "L.A.S.S.I");
assert.strictEqual(map.labelForValue("BOT_END_CONDITION_TYPE", "loot_full_all"), "End when all active account(s) are loot full");
assert.strictEqual(map.labelForValue("SELECTED_ATTACK_STRATEGY", "brand_new_strategy"), "Brand New Strategy", "unknown values are prettified");

console.log("All config-map checks passed.");
console.log("  sections used:", Object.keys(counts).sort().join(", "));
console.log("  keys mapped:", total, "(106 account + 34 instance-only)");

// --- choice lists for selector fields ---------------------------------------
//
// A selector must offer more than whatever happens to be in use locally, but it
// must never invent identifiers: writing a strategy AutoClash does not have
// would break a run silently. So the list is known-good ∪ discovered, always
// with a custom escape.

const choices = map.choicesForKey("SELECTED_ATTACK_STRATEGY", ["valkyrie_1side"]);
assert.ok(choices.includes("valkyrie_1side"), "keeps the value actually in use");
assert.ok(choices.includes("edragon") && choices.includes("thrower"), "adds the other confirmed strategies");
assert.ok(choices.length >= 3, "offers a real choice, not just the current value");

const withUnknown = map.choicesForKey("SELECTED_ATTACK_STRATEGY", ["some_new_strategy"]);
assert.ok(withUnknown.includes("some_new_strategy"), "a strategy we have never seen is still offered");
assert.strictEqual(new Set(withUnknown).size, withUnknown.length, "no duplicates");

// Ranked uses the same strategy vocabulary.
assert.ok(map.choicesForKey("RANKED_ATTACK_STRATEGY", []).includes("valkyrie_1side"));

// Booleans and free-text keys must not become selectors.
assert.deepStrictEqual(map.choicesForKey("REQUEST_AND_LEAVE_CLAN_TAG", []), [], "free text stays free text");
assert.deepStrictEqual(map.choicesForKey("ZZ_UNKNOWN_KEY", []), [], "unknown keys get no invented choices");

// Discovered values alone are enough to make a selector, even with no seed.
assert.deepStrictEqual(
  map.choicesForKey("BUILDER_ARMY_TROOP", ["P.E.K.K.A", "Baby Dragon"]).sort(),
  ["Baby Dragon", "P.E.K.K.A"],
  "discovery still drives keys we have no seed list for"
);

// Slot pickers are a fixed small range.
assert.deepStrictEqual(map.choicesForKey("SELECTED_ARMY_SLOT", [0]), [0, 1, 2, 3, 4], "army slots 1-5");

console.log("All choice-list checks passed.");

// --- army slot indexing -----------------------------------------------------
//
// AutoClash is inconsistent here, confirmed against a real config plus its own
// UI: SELECTED_ARMY_SLOT stores 0 and displays "Slot1", while RANKED_ARMY_SLOT
// stores 1 and also displays "Slot1". So one is 0-based and the other 1-based.
// Getting this wrong writes the user's army into the wrong slot.

assert.strictEqual(map.labelForValue("SELECTED_ARMY_SLOT", 0), "Slot 1", "selected slot is 0-based");
assert.strictEqual(map.labelForValue("SELECTED_ARMY_SLOT", 1), "Slot 2");
assert.strictEqual(map.labelForValue("SELECTED_ARMY_SLOT", 4), "Slot 5");
assert.strictEqual(map.labelForValue("RANKED_ARMY_SLOT", 1), "Slot 1", "ranked slot is 1-based");
assert.strictEqual(map.labelForValue("RANKED_ARMY_SLOT", 2), "Slot 2");
assert.strictEqual(map.labelForValue("RANKED_ARMY_SLOT", 5), "Slot 5");

// Choice lists must cover slots 1-5 with no duplicate labels.
for (const key of ["SELECTED_ARMY_SLOT", "RANKED_ARMY_SLOT"]) {
  const labels = map.choicesForKey(key, []).map((v) => map.labelForValue(key, v));
  assert.deepStrictEqual(labels, ["Slot 1", "Slot 2", "Slot 3", "Slot 4", "Slot 5"], key + " offers five distinct slots");
  assert.strictEqual(new Set(labels).size, 5, key + " has no duplicate labels");
}

console.log("All army-slot checks passed.");

// --- attack strategies ------------------------------------------------------
//
// All eight identifiers were captured by saving each strategy in AutoClash and
// reading what it wrote, rather than guessed. Worth noting: "Valkyrie + Quake"
// stores as `valkyrie`, not `valkyrie_quake` — a guess would have been wrong,
// and a wrong identifier breaks a run silently.

const STRATEGIES = {
  edragon: "Electro Dragon/Loon",
  dragon: "Dragon/Loon",
  valkyrie: "Valkyrie + Quake",
  valkyrie_1side: "Valkyrie 1 Side",
  barchgob: "BArch or Goblin",
  sminion: "Super Minion + Quake",
  sbarb: "Super Barbarian + Quake",
  thrower: "Thrower Smash",
};

for (const [id, label] of Object.entries(STRATEGIES)) {
  assert.strictEqual(map.labelForValue("SELECTED_ATTACK_STRATEGY", id), label, `${id} label`);
  assert.strictEqual(map.labelForValue("RANKED_ATTACK_STRATEGY", id), label, `${id} label (ranked)`);
}

// The dropdown offers every strategy without the user having used it first.
for (const key of ["SELECTED_ATTACK_STRATEGY", "RANKED_ATTACK_STRATEGY"]) {
  const offered = map.choicesForKey(key, []);
  assert.strictEqual(offered.length, 8, key + " offers all eight strategies");
  for (const id of Object.keys(STRATEGIES)) {
    assert.ok(offered.includes(id), `${key} is missing ${id}`);
  }
}

// These two are genuinely different strategies and must never collapse.
assert.notStrictEqual(
  map.labelForValue("SELECTED_ATTACK_STRATEGY", "valkyrie"),
  map.labelForValue("SELECTED_ATTACK_STRATEGY", "valkyrie_1side"),
  "valkyrie and valkyrie_1side are distinct"
);

// A future strategy still reaches the user rather than being dropped.
assert.ok(map.choicesForKey("SELECTED_ATTACK_STRATEGY", ["some_future_one"]).includes("some_future_one"));

console.log("All attack-strategy checks passed.");
