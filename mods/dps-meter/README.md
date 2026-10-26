# DPS meter

A small window that shows how hard you are hitting. Off by default: turn on
**dps-meter** in Settings → Mods. In game, press **Alt+N** or the **DPS**
button under the **DB** button to open it. Drag it by its title bar; it
remembers where you left it.

| Line | What it means |
|---|---|
| DPS | damage per second over the current fight |
| This fight | damage dealt in the current fight |
| Fight time | from the fight's first hit to now, or to its last hit once it is over |
| Total | all damage since the window was last reset |
| Biggest hit | the largest single hit since the last reset |
| Hits | how many hits landed since the last reset |

A fight starts with your first hit and ends after five seconds with no hits
(change it in the mod's settings). The next hit starts a new fight. **Reset**
clears everything.

It counts your own character's damage: plain attacks, criticals, double
attacks, the off hand when dual wielding, and skills. Misses count as nothing.
Companions', pets' and homunculi's damage is not counted.

The numbers are what the server told the client, from the client API's
`combat:damage` event ([docs/MODDING.md](../../docs/MODDING.md#client-api-1)),
so the meter needs app 1.7.3 or later.
