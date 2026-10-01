// Bundle the logic modules and the card into one dist file for HACS.
import { readFileSync, writeFileSync } from 'node:fs';

const LIBS = ['bracket.js', 'formats.js', 'stats.js'];

const header = `/*! ha-bracket-card — bundled build. Do not edit dist/ directly; edit src/ and run "node build.mjs". */\n`;

const read = (f) => readFileSync(new URL(`./src/${f}`, import.meta.url), 'utf8');
// Everything ends up in one scope, so an import of a sibling module is both
// unnecessary and a duplicate declaration. Strip them wherever they appear —
// the libraries import each other too, not only the card.
const names = LIBS.map((f) => f.replace(/\.js$/, '')).join('|');
const dropImports = (src) => src
  .replace(new RegExp(`import\\s*\\{[\\s\\S]*?\\}\\s*from\\s*['"]\\./(${names})\\.js['"];\\s*`, 'gm'), '');
// Strip `export ` from the logic modules so their symbols are module-local —
// declarations as well as functions.
const lib = (f) => dropImports(read(f)).replace(/^export\s+(?=(function|const|let|class)\s)/gm, '');
const card = dropImports(read('card.js'));

const out = header + LIBS.map(lib).join('\n') + '\n' + card;
writeFileSync(new URL('./dist/ha-bracket-card.js', import.meta.url), out);
console.log('wrote dist/ha-bracket-card.js (' + out.length + ' bytes)');
