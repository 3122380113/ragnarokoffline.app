# New skills, passives and statuses

A mod can give a job skills it never had, take stock skills away from it, and
give those skills buffs and debuffs of their own, with stacks. That is enough
to rework a class: fewer skills, new passives, new statuses for them to build
and spend, and stock skills that work differently. The server side is the
mod's `db/` and `lua/`. The client side is four small tables under `data/`.
Nothing is rebuilt.

This page covers what a new skill is made of, how each kind works, how to take
a skill away without costing players their points, and what the client can and
cannot show. [Making mods → lua/](../MODDING.md#lua--changing-how-a-skill-or-item-works)
is the reference for every hook, field and action used here.
[`examples/mods/custom-skills`](../../examples/mods/custom-skills) is a
complete example: a Guillotine Cross that loses two skills and gains seven.

## What goes in the mod

```
my-class-rework/
├── mod.json
├── db/
│   ├── skill_db.yml        the new skills: id, name, levels, kind, range, cost, delays
│   └── skill_tree.yml      who learns them, and which stock skills go away
├── lua/
│   ├── passives.lua        what the passives do
│   ├── actives.lua         what the new skills do beyond their table entry
│   └── statuses.lua        the buffs and debuffs they use
├── npc/
│   └── refund.txt          skill points back for the skills taken away
└── data/luafiles514/lua files/skillinfoz/
    ├── skillid.lub         the new skills' names, for the client
    ├── skillinfolist.lub   icon, name, levels, SP, range, what it needs
    ├── skilldescript.lub   the description
    └── skilltreeview.lub   where each goes in the skill window, and what it leaves out
```

| | read by | decides |
|---|---|---|
| `db/skill_db.yml` | the map server, at start | that the skill **exists**: its id, name, levels, target, range, element, cast time, delays, cooldown, cost and area |
| `db/skill_tree.yml` | the map server, at start | which jobs learn it and what it needs first, and which stock skills a job no longer has |
| `lua/*.lua` | the map server, at start | what the skill **does**: its damage, what follows a hit, what a passive gives |
| `data/.../skillinfoz/*.lub` | the client, at load | what the player **sees**: the name, icon, description and place in the skill window. Nothing else |

They are joined by the skill's **name**, `GCR_VENOM_BURST`, and the client's
tables also by its **id**, 3103.

## Ids and names

rAthena's own skills stop at 3045 and start again at 5001, so **3100–4999 is
free in both eras**. Take a block and keep to it. A second mod with the same
id is the same skill: its entry is merged over yours, and Settings → Mods does
not report it the way it reports a clashing item or monster id. The fork has
room for 1,000 skills from mods on top of rAthena's own.

The name is the skill's AegisName. `skill_tree.yml`, Lua, NPC scripts
(`skill "GCR_VENOM_BURST", 5;`) and the client's `SKID` table all use it.
Give yours a prefix of your own (`GCR_`, for "Guillotine Cross rework"), so it
can never be a stock skill's name.

## A passive

A skill with no `TargetType` is learned and never used:

```yaml
# db/skill_db.yml
Header:
  Type: SKILL_DB
  Version: 4

Body:
  - Id: 3100
    Name: GCR_CONTACT_POISON
    Description: Contact Poison
    MaxLevel: 5
```

What it does is its hooks. They run for every player who has learned it,
whatever that player is doing, and `c.skill_lv` is the level learned:

```lua
-- lua/passives.lua: 10% a level that a normal attack which lands poisons.
skill("GCR_CONTACT_POISON", {
  on_attack = function(c)
    if c.attack_skill_id == 0 and c.connected and c:chance(1000 * c.skill_lv) then
      c:apply_status("GCR_TOXIN", { stacks = 1 }, "target")
    end
  end,
})
```

| Hook | Runs | `c.caster` | `c.target` |
|---|---|---|---|
| `bonus(c)` | whenever the player's stats are worked out | the player | — |
| `on_attack(c)` | the player attacked, normal or skill, hit or miss | the player | what it attacked |
| `on_hit_taken(c)` | the player was attacked | the attacker | the player |
| `damage_dealt(c, damage)` | the final damage of the player's blow. Return a new one | the player | what it hit |
| `damage_taken(c, damage)` | the final damage of a blow at the player | the attacker | the player |
| `on_kill(c)` | the player killed something | the player | what died |
| `on_death(c)` | the player is about to die. `c:survive()` keeps them at 1 HP | the killer, or nil | the player |
| `on_skill(c)` | the player used a skill: `c.used_skill`, `c.used_skill_id`, `c.used_skill_lv`, and `c.x`, `c.y` | the player | the skill's target; nil for a ground skill |
| `tick(c)` | every second, while the player is online and alive | the player | the player |

`bonus` takes item bonuses by name, exactly as rAthena's `doc/item_bonus.txt`
lists them: `c:bonus("bFlee2", c.skill_lv)`, `c:bonus2("bSkillAtk",
"AS_SONICBLOW", 20)`, and so on up to `c:bonus5`. `c:grant_skill("AL_HEAL", 3)`
lends a skill the way a card does. Everything a bonus gives shows in the
status window.

These hooks work on stock skills as well: `skill("AS_KATAR", { bonus = ... })`
gives something to every player with Katar Mastery. They run for players only;
a monster or homunculus with the skill does not run them.

## A skill a player uses

Give it a `TargetType`, what it costs, and `custom = true` in its Lua:

```yaml
  - Id: 3103
    Name: GCR_VENOM_BURST
    Description: Venom Burst
    MaxLevel: 5
    Type: Weapon
    TargetType: Attack
    Range: 1
    Hit: Single
    HitCount: 1
    Element: Weapon
    AfterCastActDelay: 1000
    Cooldown: 2000
    Requires:
      SpCost: 30
```

```lua
skill("GCR_VENOM_BURST", {
  custom = true,
  ratio = function(c, stock) return stock + 60 * c.skill_lv end,
})
```

What a stock skill does is C++ in the server, a class for each skill. A new
skill has none. `custom = true` gives it one that does what its table entry
says:

| `TargetType` | What it does |
|---|---|
| `Attack` | hits its target. With a `SplashArea`, everything around the target too |
| `Self` | starts its `Status` on the caster. With a `SplashArea` and a `Type` that deals damage, hits everything around the caster |
| `Support` | starts its `Status` on the target |
| `Ground` | places its `Unit`. With none, hits everything in its `SplashArea` once |

The damage is the skill's `Type` (`Weapon`, `Magic` or `Misc`) at its `ratio`,
100% unless the hook says otherwise, through the server's usual formula: ATK or
MATK, DEF, element, size, race and cards. `Element`, `HitCount`, `Range`, cast
time, delays, cooldown and cost are the table's, as for any skill. A splash
passes over enemies that are hiding when `DamageFlags` has `Splash: true`, as
Magnum Break's does.

`Status` is one of the server's own (`IncreaseAgi`, `Angelus`, ...). To start
one of the mod's own statuses instead, call `c:apply_status` from `on_cast`.

A ground skill that hits over time takes the `Dummyskill` unit. Each
`Interval` it deals the skill's damage to the enemies standing in it, for
`Duration1`, with nothing else built in:

```yaml
    TargetType: Ground
    Duration1: 6000
    Unit:
      Id: Dummyskill
      Layout: 2          # 5x5
      Interval: 1000
      Target: Enemy
```

Any other unit does what it does for its own stock skill, which is rarely what
a new skill wants.

Whatever else the skill does is its hooks: `on_hit` after each hit, `on_cast`
once per use.

**To rework a stock skill from scratch**, give it `replace = true` instead.
It keeps its id, name and table entry, and its own class is swapped for the
one a new skill gets. Checks and formulas the server keeps elsewhere for that
skill's id, which some skills have, still apply. To change only its damage, or
what follows a hit, hook it without `replace`.

## When a skill may be used, and what it costs

Three more hooks work on any skill, a stock one or a mod's own:

- `can_cast(c)` runs when a player starts to use it. Returning `false`, with
  a message, refuses the use and shows the player the message.
- `cost(c, cost)` changes what a use costs, in place: `cost.sp`, `cost.hp`,
  `cost.ap`, `cost.zeny`, `cost.spiritball`, `cost.ammo_qty`, and `cost.items`,
  a list of `{ item = "RED_POTION", amount = 1 }`. The server asks for it
  several times for one use, so it must only compute: no actions, and nothing
  that counts or remembers.
- `on_cast(c)` runs once per use, after the skill's effect, for monsters as
  well as players. `c.x` and `c.y` are where.

Together they make a combo window: a skill that opens it, a status that is the
window, and a skill that needs it.

```lua
status("GCR_SONIC_WINDOW", { icon = "EFST_COMBOATTACK", duration = 3000 })

skill("AS_SONICBLOW", {
  on_cast = function(c) c:apply_status("GCR_SONIC_WINDOW", {}, "caster") end,
})

skill("GC_CROSSIMPACT", {
  can_cast = function(c)
    if not c.caster:has_status("GCR_SONIC_WINDOW") then
      return false, "Cross Impact follows a Sonic Blow."
    end
  end,
  cost = function(c, cost) cost.sp = cost.sp // 2 end,
  on_cast = function(c) c:remove_status("GCR_SONIC_WINDOW", "caster") end,
})
```

Count the opener's own delays into the window. A player cannot use the next
skill before the opener's `AfterCastActDelay` has passed, nor use a skill that
needs to move (`State: Move_Enable`) before its `AfterCastWalkDelay` and the
server's 300 ms walk delay have. Pre-renewal's Sonic Blow holds the caster
for 2.3 seconds, so a 3-second window there leaves 0.7.

## Statuses: buffs, debuffs, marks and windows

`status("<NAME>", { ... })` defines a status of the mod's own: a name, how
long it lasts, how many stacks it can hold, and hooks.

```lua
-- lua/statuses.lua
status("GCR_TOXIN", {
  icon = "EFST_TOXIN",
  duration = 8000,
  max_stacks = 10,
  max_stacks_boss = 3,
  max_stacks_player = 5,
  per_source = true,
  decay = { every = 4000, stacks = 1 },

  -- Whoever poisoned the unit hits it 2% harder a stack.
  damage_taken = function(c, damage)
    if c.source and c.caster and c.caster.id == c.source.id then
      return damage * (100 + 2 * c.stacks) // 100
    end
  end,

  -- 4 HP a stack every second, dealt by the poisoner.
  tick = function(c) c:damage(4 * c.stacks) end,
})
```

| Field | Means | Default |
|---|---|---|
| `icon` | the icon a player sees while it lasts: one the client has, by its `EFST_` name | none |
| `duration` | how long it lasts, in ms | 0: until it is taken off |
| `refresh` | a new application starts the duration again | `true` |
| `max_stacks` | the most stacks it holds | 1 |
| `max_stacks_boss`, `max_stacks_player` | the most on a boss, and on a player | `max_stacks` |
| `per_source` | each unit that applies it keeps a count of its own | `false` |
| `decay` | `{ every = ms, stacks = n }`: loses `n` stacks every `ms` | never |
| `end_on_death` | ends when the unit dies. `false` keeps it on a player; a monster's ends anyway | `true` |

Its hooks see `c.unit` (who has it), `c.source` (who applied it, or nil once
that unit has logged out or gone), `c.stacks` and `c.remaining` (ms, or -1 for
no end):

| Hook | Runs | Return |
|---|---|---|
| `bonus(c)` | a player who has it has their stats worked out | nothing. `c:bonus(...)`, as in a passive |
| `stats(c, s)` | any unit who has it has their stats worked out, monsters too | nothing. Change `s.def`, `s.mdef`, `s.hit`, `s.flee`, `s.flee2`, `s.cri`, `s.speed`, `s.batk`, `s.atk`, `s.matk_min`, `s.matk_max`. `flee2` and `cri` are in tenths: +30 is 3 more |
| `damage_dealt(c, damage)` | the final damage of a blow by the unit | the damage |
| `damage_taken(c, damage)` | the final damage of a blow at the unit | the damage |
| `on_attack(c)`, `on_hit_taken(c)` | the unit attacked, or was attacked | nothing; actions |
| `on_start(c)` | it starts | nothing; actions |
| `on_end(c)` | it ends. `c.reason` is `"expired"`, `"decayed"`, `"removed"` or `"death"` | nothing; actions |
| `tick(c)` | every second | nothing; actions |

A hook that can act puts it on with `c:apply_status(name, { stacks = 1,
duration = ms, source = unit }, who)` and takes it off with
`c:remove_status(name, who, stacks, source)`. `who` is `"target"`, the
default, or `"caster"`, or a unit, such as one from `c.caster:party(5)`. The
status is applied by the hook's owner — the player who learned the passive,
the unit that has the status — unless `source` names someone else. With no
`stacks`, `remove_status` takes them all; with a `source`, only the ones that
unit applied. `unit:has_status(name)` and `unit:status_stacks(name, source)`
ask about it from any hook.

A status with no hooks at all is a marker, like the combo window above, for
other hooks to ask about.

A mod's status lives in the server's memory. It ends with a logout or a server
restart, and with the unit's death unless `end_on_death = false`.

### The server's own statuses

`status()` with a server status's name takes `on_start` and `on_end` only.
`on_start` sees `c.duration` and `c.val1` to `c.val4`, and returns a new
duration in ms, or `false` to refuse the status. `c.caster` is whoever started
it, and `c.target` whoever gets it:

```lua
-- Cloaking Exceed lasts 10% longer a level of Shadow Instinct.
status("SC_CLOAKINGEXCEED", {
  on_start = function(c)
    local lv = c.caster and c.caster:skill_lv("GCR_SHADOW_INSTINCT") or 0
    if lv > 0 and c.duration > 0 then
      return c.duration * (100 + 10 * lv) // 100
    end
  end,
})
```

What a server status *does*, such as how much STR Blessing gives, is still its
C++. `on_start` is asked once the status has got past the target's resistance,
and the server can still turn it away after that: an Undead is immune to
Freeze, and some statuses cannot start again while they last. A status a
character logs in with does not ask `on_start`, but one it logs out with runs
`on_end`.

## Taking a skill away

`MaxLevel: 0` in a job's `skill_tree.yml` removes a skill from that job, and
from every job that inherits its tree:

```yaml
# db/skill_tree.yml
Header:
  Type: SKILL_TREE_DB
  Version: 1

Body:
  - Job: Guillotine_Cross
    Tree:
      - Name: GC_DARKILLUSION
        MaxLevel: 0
      - Name: GC_PHANTOMMENACE      # needed Dark Illusion 5
        MaxLevel: 1
        Requires:
          - Name: GC_DARKILLUSION
            Level: 0                # a requirement at Level 0 is taken away
```

- **Check what needed it.** A skill whose requirement is gone can no longer be
  learned, and a character who has it loses it. Take the requirement away, as
  above, or point it at another skill.
- **Every entry needs its `MaxLevel`.** A skill that only gets new
  requirements repeats its stock one. A requirement listed is added or
  changed; the skill's others stay.
- **Know which jobs inherit.** rAthena's own `db/re/skill_tree.yml` says,
  under `Inherit:`. The transcendent and baby third jobs and the fourth jobs
  inherit the third job's tree, so a change there reaches them all.
- **Mind the skill points.** A job has as many skill points as its job levels
  give, so every skill added costs the player one taken somewhere else. Taking
  a stock skill away is what makes room.

### The points it cost

A character who had learned a skill that is taken away loses it, and the
points it cost: the server forgets a skill that is no longer in the job's
tree, and the character's next save drops it from the database for good.
Until that save, the database still has it.

The example's [`npc/refund.txt`](../../examples/mods/custom-skills/npc/refund.txt)
reads those rows when a character logs in and gives the points back, once.
Copy it, and list the ids your mod takes away. It also clears the level the
server still holds for the rest of that session; without that, a skill reset
in the same session would pay the points out a second time. A character whose
job still has the skill keeps it and is not paid.

### In the skill window

The client draws a job's skill window from its own tables, so a skill taken
away stays in it, unlearnable, until the mod's `skilltreeview.lub` leaves it
out with `SKILL_TREEVIEW_HIDE` (below).

## What players see: the client's skill tables

The client knows a skill by four tables, in
`data/luafiles514/lua files/skillinfoz/`. Each is one table for every skill in
the game, so a mod does not replace them: it ships files of the same names
holding only its own rows, and the app adds them to the client's. Mods are read
in order after the client's own tables, every mod's `skillid.lub` first, so a
later mod's row for a skill wins.

### skillid.lub

The new skills' names and ids, for the other three tables:

```lua
SKID = {
	GCR_CONTACT_POISON = 3100,
	GCR_VENOM_BURST = 3103,
}
```

Only the new skills: the client knows the rest.

### skillinfolist.lub

What the skill window knows of a skill: its icon, name, levels, SP, range and
what it needs first.

```lua
SKILL_INFO_LIST = {
	[SKID.GCR_VENOM_BURST] = {
		"GC_VENOMPRESSURE";
		SkillName = "Venom Burst",
		MaxLv = 5,
		SpAmount = { 22, 24, 26, 28, 30 },
		bSeperateLv = true,
		AttackRange = { 1, 1, 1, 1, 1 },
		_NeedSkillList = {
			{ SKID.GCR_CONTACT_POISON, 1 },
		},
	},
}
```

- **The first value names the icon**: the client draws `<it>.bmp` from the
  `item` folder of its interface textures, where the stock skills' icons are.
  A stock skill's name borrows that skill's icon, so a mod needs no image.
- **A row replaces the client's whole row** for that skill. To change a stock
  skill's requirements in the window, as `skill_tree.yml` changed them on the
  server, ship its full row.
- **`bSeperateLv`** (the client's spelling) lets the player choose the level
  to use. A passive has `false`.

### skilldescript.lub

The description the skill window shows, a line per string. `^rrggbb` starts a
colour and `^000000` goes back to black:

```lua
SKILL_DESCRIPT = {
	[SKID.GCR_VENOM_BURST] = {
		"Venom Burst",
		"Max Level:^777777 5 ^000000",
		"Requirement:^777777 Contact Poison 1 ^000000",
		"Skill Form:^777777 Offensive ^000000",
		"Description:^777777 A strike that bursts your Toxin on the target. ^000000",
	},
}
```

### skilltreeview.lub

Where a job's skill window puts each skill, by slot: counted from the top left,
seven to a row. A skill already on a slot a mod takes moves to the first free
one.

```lua
SKILL_TREEVIEW_FOR_JOB = {
	[JOBID.JT_GUILLOTINE_CROSS] = {
		[7] = SKID.GCR_VENOM_BURST,       -- Dark Illusion's place
	},
	[JOBID.JT_GUILLOTINE_CROSS_H] = {
		[7] = SKID.GCR_VENOM_BURST,
	},
}

SKILL_TREEVIEW_HIDE = {
	[JOBID.JT_GUILLOTINE_CROSS] = { SKID.GC_DARKILLUSION },
	[JOBID.JT_GUILLOTINE_CROSS_H] = { SKID.GC_DARKILLUSION },
}
```

`SKILL_TREEVIEW_HIDE` is not in the client's own file. It is how a mod takes a
skill out of a job's window. A job whose window shows that job's tab leaves it
out as well: the Shadow Cross's window shows the Guillotine Cross's skills.
The transcendent (`_H`) and baby (`_B`) jobs have windows of their own, so list
them too.

- **A tab can hold an earlier job's skills.** A first job's window shows the
  Novice's skills on the same tab, and a transcendent second job's the second
  job's. A slot one of those fills is not the mod's to take; the mod's skill
  goes to the first free slot instead.
- **A name the client does not know is left out**, and the browser console
  says so, rather than landing on the Novice's window.

The client keeps what it has downloaded. After changing a table, see
[The client caches, hard](../MODDING.md#the-client-caches-hard).

## Limits

- **A new skill has no animation of its own.** The client draws a skill's
  effect from its own code, by the stock skills' ids. A new skill shows its
  cast bar, its damage and the status icons, and nothing more.
- **A status icon is one the client already has.** It takes the stock status's
  tooltip with it.
- **A mod's statuses end with a logout or a restart.**
- **Passives and `cost`/`can_cast` are for players.** A monster that uses a
  skill runs its `ratio`, `on_hit` and `on_cast`, and nothing a learner would.
- **`custom = true` covers the four kinds above.** A skill that pushes,
  pulls, moves its caster or hits a shape of its own needs C++. That is a
  request for a general hook in [the fork](https://github.com/Flux159/rathena),
  made on an issue first.
- **`tick` hooks run every second for every player who has the skill.** Keep
  them short.

## Checking your work

At start-up, the map server's log says what loaded. For the example:

```
[Status]: Lua: loaded 4 of 4 file(s), 16 skill hook(s) across 9 skill(s), 0 item hook(s) across 0 item(s), 4 status(es) of mods' own and hooks on 1 of the server's.
```

A table that does not parse is named under Settings → Mods, and a hook that
fails is switched off and named in the log. `log(...)` from any hook writes a
line of your own there.

In game, a GM character can try it all at once: `@jobchange 4059` for a
Guillotine Cross, `@skillpoint 20` for points to spend, and `@resetskill` to
get them back.
