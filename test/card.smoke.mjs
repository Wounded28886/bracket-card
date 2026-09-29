import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

// Minimal DOM + globals for the card bundle.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.customElements = window.customElements;
// Keep Node's own timers (jsdom's setTimeout delegates back to the global and
// would recurse). Run rAF callbacks synchronously so the connector-line pass
// executes inside the test; jsdom has no layout, so it draws zero-length paths.
globalThis.requestAnimationFrame = (f) => { f(); return 0; };
globalThis.SVGElement = window.SVGElement;
// jsdom lacks color-mix but never evaluates CSS values in JS, so nothing to shim.

let pass = 0, fail = 0;
const ok = (c, m) => c ? pass++ : (fail++, console.error('  ✗', m));

// Load the bundle as a module.
const code = readFileSync(new URL('../dist/ha-bracket-card.js', import.meta.url), 'utf8');
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
await import(dataUrl);

ok(!!customElements.get('bracket-card'), 'custom element registered');
ok(window.customCards && window.customCards.some(c => c.type === 'bracket-card'), 'card registered in picker');

// Fake hass with a mutable input_text state and a recording callService.
const ENTITY = 'input_text.game_night_bracket';
let saved = '';
const calls = [];
function makeHass(value) {
  return {
    states: { [ENTITY]: { state: value, attributes: {} } },
    callService: (domain, service, data) => {
      calls.push({ domain, service, data });
      saved = data.value;
    },
  };
}

const el = document.createElement('bracket-card');
el.setConfig({ entity: ENTITY, title: 'Game Night' });
el.hass = makeHass('');
document.body.appendChild(el);

// Setup view should be present.
ok(!!el.shadowRoot.querySelector('#draft'), 'setup textarea shown when empty');
ok(!!el.shadowRoot.querySelector('#create'), 'create button shown');

// Simulate typing a game and players, then creating.
ok(!!el.shadowRoot.querySelector('#game'), 'game name input shown on setup');
el._game = 'Mario Kart';
el._draft = 'Alice\nBob\nCharlie\nDana\nEve';
el.shadowRoot.querySelector('#create').click();
ok(calls.length === 1 && calls[0].service === 'set_value', 'create wrote to helper');
ok(saved.length > 0 && saved.length <= 255, `payload persisted and <=255 chars (len=${saved.length})`);
const parsed = JSON.parse(saved);
ok(parsed.p.length === 5, 'stored 5 players');
ok(parsed.g === 'Mario Kart', 'stored game name');
ok(Number.isInteger(parsed.c) && parsed.c > 1700000000, 'stored creation time');

// Feed the saved value back as new hass state -> bracket view.
el.hass = makeHass(saved);
ok(!el.shadowRoot.querySelector('#draft'), 'setup gone after creation');
ok(el.shadowRoot.querySelectorAll('.section').length >= 2, 'winners + losers sections rendered');
ok(!!el.shadowRoot.querySelector('#new'), 'New bracket button shown');
ok(el.shadowRoot.querySelector('.title .pill')?.textContent === 'Mario Kart', 'game name shown in header');
ok(el.shadowRoot.querySelector('.title .pill.mode')?.textContent === 'Double elimination', 'format shown in header');
ok(!!el.shadowRoot.querySelector('#mode') === false, 'mode select only on setup');

// New layout: 5 players -> 2 real round-1 matches, 1 walkover, 1 hidden bye-vs-bye;
// grand final in its own column on the right; connector SVG present.
const r1 = [...el.shadowRoot.querySelectorAll('.section.wb .col')][0].querySelectorAll('.match');
ok(r1.length === 4, `round 1 keeps 4 slots (got ${r1.length})`);
ok([...r1].filter(m => m.classList.contains('hidden')).length === 1, 'exactly one bye-vs-bye slot hidden');
ok([...r1].filter(m => m.querySelectorAll('.p.real').length === 2).length === 2, 'two real round-1 matches');
ok(!!el.shadowRoot.querySelector('.bracket > .gf-col .match[data-id="GF-1"]'), 'grand final in right-hand column');
ok(!el.shadowRoot.querySelector('.match[data-id="GF-2"]'), 'reset game not shown before it exists');
ok(!!el.shadowRoot.querySelector('svg.lines path'), 'connector path drawn');
// Names were shuffled: the stored order is a permutation of the input.
ok([...parsed.p].sort().join() === ['Alice','Bob','Charlie','Dana','Eve'].join(), 'stored players are a permutation of the input');

// Play the whole thing out by repeatedly clicking the first clickable name
// until a champion banner appears (guard against infinite loop).
let guard = 0;
while (!el.shadowRoot.querySelector('.champ') && guard++ < 100) {
  // Pick a name only inside an UNDECIDED match (no .p.win present), to mimic
  // real forward play rather than re-picking settled matches.
  let clicked = false;
  for (const match of el.shadowRoot.querySelectorAll('.match')) {
    if (match.querySelector('.p.win')) continue;           // already decided
    const name = match.querySelector('.p[data-click="1"]');
    if (name) { name.click(); clicked = true; break; }
  }
  if (!clicked) break;
  el.hass = makeHass(saved); // reflect the just-saved state back
}
ok(guard < 100, 'bracket resolved without runaway loop');
const champ = el.shadowRoot.querySelector('.champ');
ok(!!champ, 'champion banner appears when tournament completes');
ok(/Champion:/.test(champ ? champ.textContent : ''), 'champion banner text');

// Re-pick safety: clicking a decided early match should not throw.
let threw = false;
try {
  const anyName = el.shadowRoot.querySelector('.p.real');
  if (anyName && anyName.getAttribute('data-click') === '1') anyName.click();
} catch (e) { threw = true; }
ok(!threw, 're-pick does not throw');

// Reset flow.
el.hass = makeHass(saved);
el.shadowRoot.querySelector('#new').click();          // -> confirm
ok(!!el.shadowRoot.querySelector('#do-reset'), 'confirm shown');
el.shadowRoot.querySelector('#do-reset').click();      // -> clear
ok(saved === '', 'reset cleared the helper value');

// Unknown entity handling.
const el2 = document.createElement('bracket-card');
el2.setConfig({ entity: ENTITY });
el2.hass = { states: {}, callService: () => {} };
ok(/not found/.test(el2.shadowRoot.textContent), 'missing helper message');

// Bad config rejected.
let cfgThrew = false;
try { document.createElement('bracket-card').setConfig({}); } catch (e) { cfgThrew = true; }
ok(cfgThrew, 'setConfig without entity throws');

// ---- tracking: result written through the rest_command, then flagged ----
const tick = () => new Promise((r) => setTimeout(r, 0));
async function playOut(card, hassFor) {
  let g = 0;
  while (!card.shadowRoot.querySelector('.champ') && g++ < 100) {
    let clicked = false;
    for (const match of card.shadowRoot.querySelectorAll('.match')) {
      if (match.querySelector('.p.win')) continue;
      const name = match.querySelector('.p[data-click="1"]');
      if (name) { name.click(); clicked = true; break; }
    }
    if (!clicked) break;
    await tick();
    card.hass = hassFor(saved);
  }
}
// The board a real tournament recorded, replayed further down.
let recordedReplay = null;
{
  saved = '';
  const ws = [];
  let failWrite = false;
  const hassT = (value) => ({
    ...makeHass(value),
    callWS: async (msg) => {
      ws.push(msg);
      if (failWrite) throw new Error('boom');
      return { response: { status: 204, content: '' } };
    },
  });
  const t = document.createElement('bracket-card');
  t.setConfig({ entity: ENTITY, tracking: true });
  t.hass = hassT('');
  t._game = 'UNO';
  t._draft = 'Alice\nBob\nCharlie';
  t.shadowRoot.querySelector('#create').click();
  t.hass = hassT(saved);
  failWrite = true;
  await playOut(t, hassT);
  await tick();
  t.hass = hassT(saved);
  ok(ws.length === 1 && ws[0].domain === 'rest_command' && ws[0].service === 'game_night_write'
     && ws[0].return_response === true, 'write went to rest_command.game_night_write with return_response');
  const line = ws[0].service_data.line;
  ok(/^result,game=UNO,mode=double_elimination winner="[A-Za-z]+",runner_up="[A-Za-z]+",players="[^"]+",player_count=3i,replay="(\\.|[^"])+",placings="[^"]+" \d{10}$/.test(line),
     `line protocol shape (got ${line})`);
  // The board is stored as it finished, so the history can replay it.
  recordedReplay = line.match(/replay="((?:\\.|[^"])*)"/)[1].replace(/\\(.)/g, '$1');
  const replay = JSON.parse(recordedReplay);
  ok(Array.isArray(replay.p) && replay.p.length === 3 && typeof replay.w === 'string' && replay.w.length > 0,
     `the stored board carries the players and every decision (${JSON.stringify(replay)})`);
  const placed = /placings="([^"]+)"/.exec(line)[1].split(', ');
  const winner = /winner="([^"]+)"/.exec(line)[1];
  const second = /runner_up="([^"]+)"/.exec(line)[1];
  ok(placed.length === 3 && placed[0] === winner && placed[1] === second,
     `the finishing order leads with the champion and runner-up (${placed})`);
  ok(new Set(placed).size === 3, 'every player is placed exactly once');
  ok(!JSON.parse(saved).r && /Not saved: boom/.test(t.shadowRoot.querySelector('.champ').textContent)
     && !!t.shadowRoot.querySelector('#retry'), 'failed write shows error and Retry, state not flagged');
  failWrite = false;
  t.shadowRoot.querySelector('#retry').click();
  await tick(); await tick();
  t.hass = hassT(saved);
  ok(ws.length === 2 && ws[1].service_data.line === line, 'retry re-sends the same line');
  ok(JSON.parse(saved).r === 1 && /Result recorded/.test(t.shadowRoot.querySelector('.champ').textContent),
     'successful write flags the bracket as recorded');

  // Escaping: spaces/commas in the game tag, quotes in names.
  saved = '';
  ws.length = 0;
  const t2 = document.createElement('bracket-card');
  t2.setConfig({ entity: ENTITY, tracking: { measurement: 'gn' } });
  t2.hass = hassT('');
  t2._game = 'Mario Kart, deluxe';
  t2._draft = 'Al "Ace"\nBo';
  t2.shadowRoot.querySelector('#create').click();
  t2.hass = hassT(saved);
  await playOut(t2, hassT);
  await tick();
  const l2 = ws[0].service_data.line;
  ok(l2.startsWith('gn,game=Mario\\ Kart\\,\\ deluxe,mode=double_elimination ') && l2.includes('\\"Ace\\"'),
     `tag and string escaping (got ${l2})`);
  let badCfg = false;
  try { document.createElement('bracket-card').setConfig({ entity: ENTITY, tracking: { measurement: 'a b' } }); } catch (e) { badCfg = true; }
  ok(badCfg, 'invalid measurement rejected');
}

// ---- history card ----
{
  const DAY = 86400;
  const at = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d, 12) / 1000);
  const cols = ['time', 'winner', 'runner_up', 'players', 'player_count', 'placings',
                'standings', 'top_wins', 'games', 'sessions', 'last_played', 'temp', 'replay', 'game', 'mode'];
  const row = (time, game, mode, winner, runnerUp, players, placings, extra = {}) => ([
    time, winner, runnerUp, players.join(', '), players.length,
    placings ? placings.join(', ') : null, extra.standings ?? null, extra.top_wins ?? null,
    extra.games ?? null, extra.sessions ?? null, extra.last_played ?? null,
    extra.temp ?? null, extra.replay ?? null, game, mode,
  ]);
  const thisYear = new Date().getFullYear();
  const values = [
    row(at(thisYear, 9, 20), 'UNO', 'double_elimination', 'Dad', 'Mum',
        ['Dad', 'Mum', 'Atlas'], ['Dad', 'Mum', 'Atlas']),
    row(at(thisYear, 9, 13), 'UNO', 'double_elimination', 'Dad', 'Atlas',
        ['Dad', 'Mum', 'Atlas'], ['Dad', 'Atlas', 'Mum']),
    row(at(thisYear, 9, 6), 'UNO', 'round_robin', 'Mum', 'Dad',
        ['Dad', 'Mum', 'Atlas'], ['Mum', 'Dad', 'Atlas']),
    // Carries the board as it finished: three rounds of a four-player
    // free-for-all, each chunk a finishing order of base-36 player indices.
    row(at(thisYear, 8, 30), 'Mario Kart', 'free_for_all', 'Atlas', 'Dad',
        ['Atlas', 'Dad', 'Mum', 'Miles'], ['Atlas', 'Dad', 'Mum', 'Miles'],
        { replay: JSON.stringify({ v: 2, p: ['Atlas', 'Dad', 'Mum', 'Miles'],
          w: '0123|0132|1023', x: 1, m: 'f', f: 1, g: 'Mario Kart' }) }),
    // A one-off: no belt, no win, but still listed and tagged.
    row(at(thisYear, 8, 1), 'Table tennis', 'king_of_the_hill', 'Guest', 'Mum',
        ['Guest', 'Mum'], null, { temp: true, top_wins: 2 }),
    row(at(thisYear - 1, 9, 21), 'UNO', 'double_elimination', 'Miles', 'Dad',
        ['Miles', 'Dad', 'Mum', 'Atlas'], null),
  ];
  const influx = { results: [{ series: [{ name: 'result', columns: cols, values }] }] };

  const queries = [];
  const h = document.createElement('bracket-history-card');
  h.setConfig({ title: 'Hall of Fame' });
  h.hass = { states: {}, callWS: async (msg) => { queries.push(msg); return { response: { status: 200, content: influx } }; } };
  await tick(); await tick();
  const txt = () => h.shadowRoot.textContent.replace(/\s+/g, ' ');
  const click = (sel) => { const el = h.shadowRoot.querySelector(sel); ok(!!el, `found ${sel}`); el.onclick(); };

  ok(queries.length === 1 && queries[0].service === 'game_night_query'
     && /"placings"/.test(queries[0].service_data.q)
     && /ORDER BY time DESC LIMIT 100$/.test(queries[0].service_data.q),
     'history asks for the finishing order too');

  // --- champions: belts, season, leaderboard ---
  ok(/Title holders/.test(txt()), 'the champions view leads with the belts');
  const beltCards = [...h.shadowRoot.querySelectorAll('.belt')];
  ok(beltCards.length === 2, `one belt per game, a one-off game holds none (${beltCards.length})`);
  const uno = beltCards.find((b) => /UNO/.test(b.textContent));
  ok(/👑 Dad/.test(uno.textContent), `UNO is held by its latest winner (${uno.textContent.trim().slice(0, 40)})`);
  ok(/1 defence/.test(uno.textContent), 'and shows the defence count');
  ok(/took it from Mum/.test(uno.textContent), 'and who it was taken from');

  ok(new RegExp(`${thisYear} leader`).test(txt()), 'this season has a leader');
  ok(/Dad/.test(h.shadowRoot.querySelector('.champ').textContent), 'and it is the points leader');

  const headerCells = [...h.shadowRoot.querySelectorAll('tr.th td')].map((td) => td.textContent.trim());
  ok(headerCells.includes('Rate') && headerCells.includes('Pts') && headerCells.includes('Rating'),
     `the leaderboard shows rate, points and rating (${headerCells})`);
  const boardRows = [...h.shadowRoot.querySelectorAll('table tr')]
    .filter((tr) => !tr.classList.contains('th'))
    .map((tr) => [...tr.children].map((td) => td.textContent.trim()));
  const dadRow = boardRows.find((r) => r[1].startsWith('Dad'));
  ok(dadRow && dadRow[2] === '2', `wins counted (${dadRow})`);
  ok(dadRow[5] === '40%', `win rate is wins over appearances (${dadRow[5]})`);
  ok(/🔥2/.test(dadRow[1]), `a run of wins is badged (${dadRow[1]})`);
  ok(h.shadowRoot.querySelectorAll('.dot').length > 0, 'form is drawn as dots');

  // Sorting the board is a click.
  click('[data-sort="rating"]');
  const firstAfter = h.shadowRoot.querySelectorAll('table tr')[1].children[1].textContent.trim();
  ok(firstAfter.length > 0, `sorting by rating re-orders the board (top: ${firstAfter})`);
  click('[data-sort="wins"]');

  // --- league ---
  click('[data-view="league"]');
  ok(new RegExp(`${thisYear} —`).test(txt()) && new RegExp(`${thisYear - 1} —`).test(txt()),
     'the league view lists every season');
  ok(/By format/.test(txt()) && /Double elimination/.test(txt()), 'and breaks results down by format');
  ok(/Biggest fields/.test(txt()) && /beat 3 others/.test(txt()), 'and names the biggest win');

  // --- head to head ---
  click('[data-view="h2h"]');
  ok(/Wins against/.test(txt()), 'the head-to-head grid is shown');
  const matrix = h.shadowRoot.querySelector('table.matrix');
  ok(!!matrix && matrix.querySelectorAll('tr').length >= 4, 'the matrix has a row per finalist');
  ok(/Rivalries/.test(txt()) && /leads|all square/.test(txt()), 'rivalries are listed with who leads');

  // --- history list ---
  click('[data-view="history"]');
  ok(/one-off/.test(txt()), 'the results list tags a one-off game');
  ok(/Atlas won it — Dad 2nd/.test(txt()),
     'a free-for-all names its runner-up without claiming a head-to-head win');
  ok(/Dad<\/strong><\/button><span class="muted"> beat Mum/.test(h.shadowRoot.innerHTML),
     'while a format with a final still reads "beat"');
  ok(/Guest/.test(txt()), 'and still lists it');
  const listRows = h.shadowRoot.querySelectorAll('table tr').length;
  ok(listRows === values.length, `every result is listed (${listRows} of ${values.length})`);

  // --- the play-by-play behind a result ---
  const ffaTime = at(thisYear, 8, 30);
  const toggles = h.shadowRoot.querySelectorAll('[data-replay]');
  ok(toggles.length === 1, `only the row that stored its board offers one (${toggles.length})`);
  ok(toggles[0].getAttribute('data-replay') === String(ffaTime), 'and it is the free-for-all');
  ok(!h.shadowRoot.querySelector('.replay'), 'nothing is expanded to begin with');
  toggles[0].onclick();
  const plays = [...h.shadowRoot.querySelectorAll('table.plays tr')]
    .map((tr) => [...tr.children].map((td) => td.textContent.trim()));
  ok(plays.length === 3, `every round is listed (${plays.length})`);
  ok(plays[0][0] === 'Round 1' && plays[0][1] === '1. Atlas   2. Dad   3. Mum   4. Miles',
     `each round shows its finishing order (${JSON.stringify(plays[0])})`);
  ok(plays[1][1] === '1. Atlas   2. Dad   3. Miles   4. Mum', `round 2 differs (${plays[1][1]})`);
  ok(plays[2][1] === '1. Dad   2. Atlas   3. Mum   4. Miles', `round 3 differs (${plays[2][1]})`);
  ok(/Hide how it was won/.test(h.shadowRoot.textContent), 'the toggle knows it is open');
  h.shadowRoot.querySelector('[data-replay]').onclick();
  ok(!h.shadowRoot.querySelector('.replay'), 'and closes again');

  // Round trip: a double-elimination bracket actually played out above,
  // recorded, and read back as the list of matches that decided it.
  const beRows = [row(at(thisYear, 8, 28), 'UNO', 'double_elimination', 'Dad', 'Mum',
    ['Dad', 'Mum'], null, { replay: recordedReplay })];
  const hBracket = document.createElement('bracket-history-card');
  hBracket.setConfig({});
  hBracket.hass = { states: {}, callWS: async () => ({ response: { status: 200,
    content: { results: [{ series: [{ name: 'result', columns: cols, values: beRows }] }] } } }) };
  await tick(); await tick();
  hBracket.shadowRoot.querySelector('[data-view="history"]').onclick();
  hBracket.shadowRoot.querySelector('[data-replay]').onclick();
  const bp = [...hBracket.shadowRoot.querySelectorAll('table.plays tr')]
    .map((tr) => [...tr.children].map((td) => td.textContent.trim()));
  ok(bp.length >= 3, `a played-out bracket replays its matches (${bp.length})`);
  ok(bp.every(([, d]) => / beat /.test(d)), `each one reads as a result (${JSON.stringify(bp[0])})`);
  ok(bp.some(([l]) => /^Winners/.test(l)) && bp.some(([l]) => /Grand final|Losers/.test(l)),
     `and is labelled by where in the bracket it was (${bp.map(([l]) => l).join(', ')})`);
  ok(!bp.some(([, d]) => /bye|—/.test(d)), 'walkovers are not presented as results');

  // King of the hill: each pair in `w` is a challenger letter and who won.
  // Nobody starts as king, so the first game crowns one.
  const kothRows = [row(at(thisYear, 8, 27), 'Darts', 'king_of_the_hill', 'Dad', 'Atlas',
    ['Dad', 'Atlas', 'Mum'], null, { replay: JSON.stringify({ v: 2, p: ['Dad', 'Atlas', 'Mum'],
      w: 'B2C1A2', x: 1, m: 'k', f: 1, g: 'Darts' }) })];
  const hKoth = document.createElement('bracket-history-card');
  hKoth.setConfig({});
  hKoth.hass = { states: {}, callWS: async () => ({ response: { status: 200,
    content: { results: [{ series: [{ name: 'result', columns: cols, values: kothRows }] }] } } }) };
  await tick(); await tick();
  hKoth.shadowRoot.querySelector('[data-view="history"]').onclick();
  hKoth.shadowRoot.querySelector('[data-replay]').onclick();
  const kp = [...hKoth.shadowRoot.querySelectorAll('table.plays tr')]
    .map((tr) => [...tr.children].map((td) => td.textContent.trim()));
  ok(kp.length === 3, `every challenge is listed (${kp.length})`);
  ok(kp[0][0] === 'Game 1' && kp[0][1] === 'Atlas beat Dad — crowned',
     `the first game crowns a king (${JSON.stringify(kp[0])})`);
  ok(kp[1][1] === 'Atlas beat Mum — held the hill', `a defence reads as one (${kp[1][1]})`);
  ok(kp[2][1] === 'Dad beat Atlas — took the hill', `and so does a takeover (${kp[2][1]})`);

  // A board that can't be read says so rather than showing an empty drawer.
  const brokenRows = [row(at(thisYear, 8, 29), 'UNO', 'free_for_all', 'Dad', 'Mum',
    ['Dad', 'Mum'], null, { replay: 'not json' })];
  const hBad = document.createElement('bracket-history-card');
  hBad.setConfig({});
  hBad.hass = { states: {}, callWS: async () => ({ response: { status: 200,
    content: { results: [{ series: [{ name: 'result', columns: cols, values: brokenRows }] }] } } }) };
  await tick(); await tick();
  hBad.shadowRoot.querySelector('[data-view="history"]').onclick();
  hBad.shadowRoot.querySelector('[data-replay]').onclick();
  ok(/couldn't be read/.test(hBad.shadowRoot.textContent), 'an unreadable board says so');

  // --- a player page ---
  click('[data-view="champions"]');
  click('[data-player="Dad"]');
  ok(/Dad/.test(h.shadowRoot.querySelector('.title').textContent), 'the player page names the player');
  const stats = [...h.shadowRoot.querySelectorAll('.stat')].map((s) => s.textContent.replace(/\s+/g, ' '));
  ok(stats.some((s) => /2Wins/.test(s)), `wins shown (${stats[0]})`);
  ok(stats.some((s) => /Rating/.test(s)) && stats.some((s) => /Points/.test(s)), 'points and rating shown');
  ok(/By game/.test(txt()) && /By format/.test(txt()), 'broken down by game and format');
  ok(/Recent results/.test(txt()), 'with recent results');
  ok(/Beaten most often by|Beats/.test(txt()), 'and who they beat or lose to');
  click('#back');
  ok(/Title holders/.test(txt()), 'back returns to the champions view');

  // --- filtering by game ---
  const sel = h.shadowRoot.querySelector('#filter');
  ok(!!sel, 'game filter shown when more than one game');
  sel.value = 'Mario Kart'; sel.onchange({ target: sel });
  ok(h.shadowRoot.querySelectorAll('.belt').length === 1, 'filtering narrows to one game');
  ok(/Atlas/.test(h.shadowRoot.querySelector('.belt').textContent), 'and shows that game\'s holder');
  sel.value = ''; sel.onchange({ target: sel });

  // --- no data, and a failed load ---
  const hEmpty = document.createElement('bracket-history-card');
  hEmpty.setConfig({});
  hEmpty.hass = { states: {}, callWS: async () => ({ response: { status: 200, content: { results: [{}] } } }) };
  await tick(); await tick();
  ok(/No results recorded yet/.test(hEmpty.shadowRoot.textContent), 'an empty history says so');

  const hErr = document.createElement('bracket-history-card');
  hErr.setConfig({});
  hErr.hass = { states: {}, callWS: async () => { throw new Error('Service rest_command.game_night_query not found'); } };
  await tick(); await tick();
  ok(/Couldn't load results: Service rest_command.game_night_query not found/.test(hErr.shadowRoot.textContent), 'history shows load error');

  // ---- deleting a result ----
  // A card whose rows are served fresh from `live`, so a delete can be seen
  // to take effect.
  const makeCard = async (cfg, extraHass) => {
    let live = values.slice();
    const sent = [];
    const card = document.createElement('bracket-history-card');
    card.setConfig({ title: 'Hall of Fame', ...cfg });
    card.hass = {
      states: {},
      ...extraHass,
      callWS: async (msg) => {
        sent.push(msg);
        const q = msg.service_data.q;
        if (/^DELETE/i.test(q)) {
          if (extraHass && extraHass.__refuse) throw new Error(extraHass.__refuse);
          const t = Number((q.match(/time >= (\d+)s/) || [])[1]);
          live = live.filter((v) => v[0] !== t);
          return { response: { status: 200, content: { results: [{ statement_id: 0 }] } } };
        }
        return { response: { status: 200, content: { results: [{ series: [{ name: 'result', columns: cols, values: live }] }] } } };
      },
    };
    await tick(); await tick();
    card.shadowRoot.querySelector('[data-view="history"]').onclick();
    return { card, sent, rows: () => live.length };
  };
  const admin = { user: { is_admin: true, name: 'Dad' } };
  const kid = { user: { is_admin: false, name: 'Atlas' } };

  // Nothing at all unless the dashboard config asks for it.
  const offCard = await makeCard({}, admin);
  ok(!offCard.card.shadowRoot.querySelector('[data-del]'), 'no delete control without allow_delete');
  ok(!/allow_delete/.test(offCard.card.shadowRoot.textContent),
     'and no explanation either, since nothing was asked for');
  // …and, with it, still nothing for a child's account — but the card says so,
  // rather than leaving an adult hunting through YAML that was already right.
  const kidCard = await makeCard({ allow_delete: true }, kid);
  ok(!kidCard.card.shadowRoot.querySelector('[data-del]'), 'a non-admin user never sees the delete control');
  const kidNote = kidCard.card.shadowRoot.textContent.replace(/\s+/g, ' ');
  ok(/limited to Home Assistant admin accounts/.test(kidNote) && /Atlas/.test(kidNote),
     'and the card explains which gate refused, and who it thinks you are');
  // …nor when the card cannot tell who is looking.
  const anonCard = await makeCard({ allow_delete: true }, {});
  ok(!anonCard.card.shadowRoot.querySelector('[data-del]'), 'an unknown user is denied, not allowed');
  ok(/can't tell who is signed in/.test(anonCard.card.shadowRoot.textContent.replace(/\s+/g, ' ')),
     'and says that too');
  // allow_delete with tracking off needs no explanation of its own: the card
  // already says tracking is disabled instead of showing any history.
  const untracked = document.createElement('bracket-history-card');
  untracked.setConfig({ allow_delete: true, tracking: false });
  untracked.hass = { states: {}, ...admin };
  await tick();
  ok(/Tracking is disabled/.test(untracked.shadowRoot.textContent), 'tracking off says so first');

  // An admin in Home Assistant: a control per row, a confirmation, no PIN.
  const a = await makeCard({ allow_delete: true }, admin);
  const dels = a.card.shadowRoot.querySelectorAll('[data-del]');
  ok(dels.length === values.length, `an admin gets one delete control per result (${dels.length})`);
  ok(!a.card.shadowRoot.querySelector('.delbox'), 'and no confirmation until one is clicked');
  const target = values[3];   // Atlas at Mario Kart
  a.card.shadowRoot.querySelector(`[data-del="${target[0]}"]`).onclick();
  const box = a.card.shadowRoot.querySelector('.delbox');
  ok(!!box && /Atlas/.test(box.textContent) && /Mario Kart/.test(box.textContent),
     'the confirmation names the result it would delete');
  ok(!box.querySelector('#del-pin'), 'no PIN is asked for in Home Assistant');
  a.card.shadowRoot.querySelector('#del-cancel').onclick();
  ok(!a.card.shadowRoot.querySelector('.delbox'), 'cancel closes it');
  ok(a.rows() === values.length, 'and deletes nothing');

  a.card.shadowRoot.querySelector(`[data-del="${target[0]}"]`).onclick();
  a.sent.length = 0;
  a.card.shadowRoot.querySelector('#del-confirm').onclick();
  await tick(); await tick(); await tick();
  const dq = a.sent[0];
  ok(dq && dq.service === 'game_night_query',
     `the delete rides the existing query command, so nothing new to configure (${dq && dq.service})`);
  ok(/^DELETE FROM "result" WHERE /.test(dq.service_data.q), `it is a DELETE (${dq.service_data.q})`);
  ok(dq.service_data.q.includes(`time >= ${target[0]}s`) && dq.service_data.q.includes(`time <= ${target[0]}s`),
     'bounded to the one timestamp, so it can never take the lot');
  ok(/"game" = 'Mario Kart'/.test(dq.service_data.q) && /"mode" = 'free_for_all'/.test(dq.service_data.q),
     'and narrowed by the tags');
  ok(dq.service_data.pin === undefined, 'no PIN is sent in Home Assistant');
  // …unless an InfluxDB that insists on POST is pointed at with a command of
  // its own.
  const ov = await makeCard({ allow_delete: true, tracking: { delete_service: 'rest_command.gn_del' } }, admin);
  ov.card.shadowRoot.querySelector(`[data-del="${values[1][0]}"]`).onclick();
  ov.sent.length = 0;
  ov.card.shadowRoot.querySelector('#del-confirm').onclick();
  await tick(); await tick();
  ok(ov.sent[0] && ov.sent[0].service === 'gn_del', `delete_service overrides it (${ov.sent[0] && ov.sent[0].service})`);
  ok(a.rows() === values.length - 1, 'the result is gone');
  ok(!a.card.shadowRoot.querySelector('.delbox'), 'and the confirmation closed');
  ok(a.card.shadowRoot.querySelectorAll('[data-del]').length === values.length - 1,
     'the card re-read the history rather than trusting its own copy');

  // The standalone board: no users, so a PIN the server checks.
  const s = await makeCard({ allow_delete: true }, { adminPin: true });
  ok(s.card.shadowRoot.querySelectorAll('[data-del]').length === values.length, 'the standalone board offers it too');
  s.card.shadowRoot.querySelector(`[data-del="${target[0]}"]`).onclick();
  ok(!!s.card.shadowRoot.querySelector('#del-pin'), 'and asks for a PIN');
  s.sent.length = 0;
  s.card.shadowRoot.querySelector('#del-confirm').onclick();
  await tick();
  ok(s.sent.length === 0 && /Enter the PIN/.test(s.card.shadowRoot.textContent),
     'an empty PIN never reaches the server');
  const field = s.card.shadowRoot.querySelector('#del-pin');
  field.value = '2468'; field.oninput({ target: field });
  s.card.shadowRoot.querySelector('#del-confirm').onclick();
  await tick(); await tick(); await tick();
  ok(s.sent[0] && s.sent[0].service_data.pin === '2468', 'the typed PIN is sent with the delete');
  ok(s.rows() === values.length - 1, 'and the result goes');

  // A server that refuses keeps the row and says why.
  const r = await makeCard({ allow_delete: true }, { adminPin: true, __refuse: 'Wrong PIN.' });
  r.card.shadowRoot.querySelector(`[data-del="${target[0]}"]`).onclick();
  const rf = r.card.shadowRoot.querySelector('#del-pin');
  rf.value = '1111'; rf.oninput({ target: rf });
  r.card.shadowRoot.querySelector('#del-confirm').onclick();
  await tick(); await tick();
  ok(/Wrong PIN/.test(r.card.shadowRoot.textContent), 'a refusal is shown on the confirmation');
  ok(!!r.card.shadowRoot.querySelector('.delbox'), 'which stays open to try again');
  ok(r.rows() === values.length, 'and nothing was deleted');

  // Deleting a live king-of-the-hill lineage says what it costs.
  const k = await makeCard({ allow_delete: true }, admin);
  const koth = values.find((v) => v[cols.indexOf('mode')] === 'king_of_the_hill');
  k.card.shadowRoot.querySelector(`[data-del="${koth[0]}"]`).onclick();
  ok(!/ongoing king-of-the-hill lineage/.test(k.card.shadowRoot.textContent),
     'a one-off king of the hill carries no lineage warning');
  const lineage = [...values[4]];
  lineage[0] = at(thisYear, 7, 1); lineage[cols.indexOf('temp')] = null;
  values.push(lineage);
  const kl = await makeCard({ allow_delete: true }, admin);
  kl.card.shadowRoot.querySelector(`[data-del="${lineage[0]}"]`).onclick();
  ok(/ongoing king-of-the-hill lineage/.test(kl.card.shadowRoot.textContent),
     'but an ongoing one warns that the reigning champion goes with it');
  values.pop();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
