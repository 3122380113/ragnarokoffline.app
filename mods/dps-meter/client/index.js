// A DPS meter: the player's own hits, from the client API's combat:damage
// event (one per damage packet the client receives), in a window of the
// plugin's own (api.ui.window).

/**
 * The arithmetic, kept apart from the window so it can be tested. Times are
 * milliseconds. A fight starts with a hit and ends `idleMs` after the last
 * one; the next hit starts a new fight. Total and biggest run until reset().
 */
export function createMeter({ idleMs = 5000 } = {}) {
    let total = 0, biggest = 0, hits = 0;
    let fight = null; // { start, last, damage }
    return {
        hit(amount, now) {
            if (!Number.isFinite(amount) || amount <= 0) return;
            if (!fight || now - fight.last > idleMs) fight = { start: now, last: now, damage: 0 };
            fight.last = now;
            fight.damage += amount;
            total += amount;
            hits += 1;
            biggest = Math.max(biggest, amount);
        },
        read(now) {
            const active = Boolean(fight) && now - fight.last <= idleMs;
            // While the fight is on, the clock runs; once it is over it stops at
            // the last hit. At least one second, so one hit is not "infinite" DPS.
            const ms = fight ? Math.max(1000, (active ? now : fight.last) - fight.start) : 0;
            return {
                active,
                dps: fight ? fight.damage / (ms / 1000) : 0,
                fightDamage: fight ? fight.damage : 0,
                fightSeconds: ms / 1000,
                total, biggest, hits,
            };
        },
        reset() { total = 0; biggest = 0; hits = 0; fight = null; },
    };
}

const STYLE = `
.meter { padding: 8px 10px; display: grid; grid-template-columns: 1fr auto; gap: 3px 10px; }
.meter b { color: #556; font-weight: normal; }
.meter span { text-align: right; font-variant-numeric: tabular-nums; }
.meter .dps { font-size: 18px; font-weight: bold; color: #273256; }
.meter .idle { color: #889; }
.actions { padding: 0 10px 8px; text-align: right; }
.actions button { font: inherit; padding: 2px 10px; }
.launcher { position: fixed; right: 145px; top: 92px; width: 43px; height: 22px; z-index: 8999; font: bold 11px Tahoma, sans-serif; padding: 0;
  border: 1px solid #6b7a99; border-radius: 4px; background: linear-gradient(#f3f6fd, #d3dbef); color: #273256; cursor: pointer; display: none; }
.launcher.ingame { display: block; }
`;

const number = value => Math.round(value).toLocaleString();

export default function init(parameters, api) {
    if (api?.version !== 1) throw new Error('dps-meter requires client API 1');
    const seconds = Number(parameters?.fight_timeout);
    const meter = createMeter({ idleMs: (Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000 });
    const win = api.ui.window({ id: 'dps', title: 'DPS meter', width: 210, height: 190 });
    win.body.innerHTML = `<style>${STYLE}</style>
        <div class="meter">
            <b>DPS</b><span class="dps" data-k="dps">0</span>
            <b>This fight</b><span data-k="fight">0</span>
            <b>Fight time</b><span data-k="time">0s</span>
            <b>Total</b><span data-k="total">0</span>
            <b>Biggest hit</b><span data-k="biggest">0</span>
            <b>Hits</b><span data-k="hits">0</span>
        </div>
        <div class="actions"><button>Reset</button></div>`;
    const field = key => win.body.querySelector(`[data-k="${key}"]`);
    const fields = Object.fromEntries(['dps', 'fight', 'time', 'total', 'biggest', 'hits'].map(key => [key, field(key)]));

    function draw() {
        const now = performance.now();
        const r = meter.read(now);
        fields.dps.textContent = number(r.dps);
        fields.dps.classList.toggle('idle', !r.active);
        fields.fight.textContent = number(r.fightDamage);
        fields.time.textContent = `${r.fightSeconds.toFixed(1)}s`;
        fields.total.textContent = number(r.total);
        fields.biggest.textContent = number(r.biggest);
        fields.hits.textContent = number(r.hits);
    }

    win.body.querySelector('.actions button').addEventListener('click', () => { meter.reset(); draw(); });
    api.on('combat:damage', ({ amount, own }) => { if (own) meter.hit(amount, performance.now()); });

    // Redraw only while the window is open; the clock in "Fight time" moves.
    const timer = setInterval(() => { if (win.isOpen()) draw(); }, 250);
    api.cleanup(() => clearInterval(timer));

    let inGame = false;
    let launcher = null;
    const toggle = () => { win.toggle(); if (win.isOpen()) draw(); };
    const setInGame = value => {
        inGame = value;
        launcher?.classList.toggle('ingame', value);
        if (!value && win.isOpen()) win.hide();
    };
    api.on('map:enter', () => setInGame(true), { replay: true });
    api.on('map:leave', () => setInGame(false));

    const onKey = event => { if (inGame && event.altKey && event.code === 'KeyN') { event.preventDefault(); toggle(); } };
    addEventListener('keydown', onKey, true);
    api.cleanup(() => removeEventListener('keydown', onKey, true));
    if (parameters?.show_button !== false) {
        const host = document.createElement('div');
        const root = host.attachShadow({ mode: 'open' });
        // Under the in-game database's DB button (top 66px), same edge.
        root.innerHTML = `<style>${STYLE}</style><button class="launcher${inGame ? ' ingame' : ''}" title="DPS meter (Alt+N)">DPS</button>`;
        launcher = root.querySelector('button');
        // The map is under the button: a press here must not walk the character there.
        launcher.addEventListener('mousedown', event => event.stopImmediatePropagation());
        launcher.addEventListener('click', toggle);
        document.body.appendChild(host);
        api.cleanup(() => host.remove());
    }
}
