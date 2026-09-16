#!/usr/bin/env node
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) { console.error(`smc-map-inventory requires Node.js 20 or newer; this is ${process.version}. Use nvm/fnm to switch, then run \`npm rebuild\` for better-sqlite3.`); process.exit(1); }
import { Command } from 'commander';
import { TOOL_VERSION } from '../src/lib/config.js';

const program = new Command();
program.name('smc-map-inventory').description('Client-side inventory of mapping applications on www.smcgov.org').version(TOOL_VERSION)
  .option('-c, --config <file>', 'config.yaml path', 'config.yaml')
  .option('-r, --rules <file>', 'rules.yaml path', 'rules.yaml')
  .option('-d, --db <file>', 'SQLite database path (overrides config)');

const run = (fn) => async (cmdOpts, cmd) => {
  const opts = { ...program.opts(), ...cmdOpts };
  try { await fn(opts); if (process.env.SMC_DEBUG_HANDLES) console.error('active resources:', process.getActiveResourcesInfo()); process.exit(0); }
  catch (e) { console.error(`\nERROR: ${e && e.stack || e}`); process.exit(1); }
};

program.command('preflight').description('Phase 0: consent-gating probe (differential render over a page sample)')
  .option('--sample <n>', 'pages to sample', '30')
  .action(run(async (o) => (await import('../src/commands/preflight.js')).preflight(o)));

program.command('inventory').description('Phase 1: discover URLs (sitemaps, robots.txt, BFS link crawl) into the queue; idempotent')
  .option('--no-crawl', 'skip the BFS link crawl (sitemaps + robots only)')
  .action(run(async (o) => (await import('../src/commands/inventory.js')).inventory(o)));

program.command('scan').description('Phase 2: tier-1 static + tier-2 headless detection; resumable (Ctrl-C safe)')
  .option('--tier <n>', 'run only tier 1 or only tier 2 (default both)')
  .option('--concurrency <n>', 'browser contexts / workers')
  .option('--screenshots <mode>', 'none | identity | all')
  .option('--max-runtime <minutes>', 'stop claiming new pages after this long (0 = unbounded)')
  .option('--limit <n>', 'process at most n pages this run')
  .option('--url <url...>', 'scan only these URLs (adds them to the queue; forces a re-scan)')
  .option('--consent <mode>', 'auto | on | off')
  .option('--reset-in-progress', 'reset ALL in_progress rows to pending, regardless of age')
  .action(run(async (o) => (await import('../src/commands/scan.js')).scan(o)));

program.command('arcgis').description('ArcGIS Online org cross-reference (public item search)')
  .action(run(async (o) => (await import('../src/commands/arcgis.js')).arcgis(o)));

program.command('report').description('Phase 3: aggregate, deduplicate, export CSV / JSONL / HTML from SQLite (no recrawl)')
  .option('--out <dir>', 'output directory')
  .option('--no-probe-keys', 'do not probe API keys for referrer restriction')
  .option('--include-chrome-occurrences', 'also enumerate site-chrome (nav/footer) presence per page in occurrences.csv')
  .action(run(async (o) => (await import('../src/commands/report.js')).report(o)));

program.parseAsync(process.argv);
