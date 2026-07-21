import { execSync } from 'child_process';

// Bundle the pure --help parser to a temp ESM file and import it, the same
// approach run-shell-tests.mjs uses for shellInvocation.ts.
execSync('npx esbuild ./src/toolOptionParser.ts --bundle --format=esm --outfile=/tmp/toolOptionParser.mjs', {
  stdio: 'inherit'
});
const { parseHelpOutput, detectSubcommandChoices, mergeFavorites, parseChoices } = await import(
  '/tmp/toolOptionParser.mjs'
);

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- argparse-style: mix of short+long/value, long-only toggle, value-only long ---
{
  const help = `usage: sim_run.py [-h] [--seed SEED] [-v] [--bug] test_name

positional arguments:
  test_name             Name of test to run

optional arguments:
  -h, --help            show this help message and exit
  -s SEED, --seed SEED  Random seed for simulation
  -v, --verbose         Verbose output
  --bug                 Inject known bug for Problems-panel testing
`;
  const opts = parseHelpOutput(help);
  check(
    eq(opts, [
      { flags: ['-s', '--seed'], metavar: 'SEED', description: 'Random seed for simulation' },
      { flags: ['-v', '--verbose'], description: 'Verbose output' },
      { flags: ['--bug'], description: 'Inject known bug for Problems-panel testing' }
    ]),
    `argparse-style parsed (got ${JSON.stringify(opts)})`
  );
}

// --- click-style: value option with a bracketed default note, plain toggle ---
{
  const help = `Usage: run.py [OPTIONS]

Options:
  --seed INTEGER  Random seed to use  [default: 0]
  --waves         Dump waveforms
  --help          Show this message and exit.
`;
  const opts = parseHelpOutput(help);
  check(
    eq(opts, [
      { flags: ['--seed'], metavar: 'INTEGER', description: 'Random seed to use  [default: 0]' },
      { flags: ['--waves'], description: 'Dump waveforms' }
    ]),
    `click-style parsed (got ${JSON.stringify(opts)})`
  );
}

// --- --flag=VALUE metavar syntax ---
{
  const help = `optional arguments:
  --seed=SEED           Random seed
`;
  const opts = parseHelpOutput(help);
  check(eq(opts, [{ flags: ['--seed'], metavar: 'SEED', description: 'Random seed' }]), `--flag=VALUE parsed (got ${JSON.stringify(opts)})`);
}

// --- argparse choices= metavar: internal commas must not split flags ---
{
  const help = `optional arguments:
  --std {g2001,g2005,g2005-sv,g2009,g2012}
                        Verilog/SystemVerilog generation to compile with
`;
  // Note: the description wraps to its own line above, which this line-by-line
  // parser deliberately doesn't merge in (see toolOptionParser.ts) -- only the
  // flag/metavar on the option's own line is asserted here.
  const opts = parseHelpOutput(help);
  check(
    eq(opts, [{ flags: ['--std'], metavar: '{g2001,g2005,g2005-sv,g2009,g2012}' }]),
    `choices= metavar parsed as one atomic value (got ${JSON.stringify(opts)})`
  );
}

// --- positional-only tool: zero options ---
{
  const help = `usage: prog name

positional arguments:
  name        Just a name
`;
  const opts = parseHelpOutput(help);
  check(eq(opts, []), `positional-only -> zero options (got ${JSON.stringify(opts)})`);
}

// --- unrecognizable click boolean-pair syntax is dropped, not crashed on ---
{
  const help = `Options:
  --verbose / --no-verbose  Enable verbose logging
`;
  const opts = parseHelpOutput(help);
  check(eq(opts, []), `click boolean-pair syntax silently dropped (got ${JSON.stringify(opts)})`);
}

// --- argparse subparser signature: sub-command choices detected ---
{
  const help = `usage: sim_run.py [-h] {icarus,verilator,questa,dsim} ...

positional arguments:
  {icarus,verilator,questa,dsim}
                        sub-command help
    icarus              Run under Icarus Verilog
    verilator           Run under Verilator (lint-only)
    questa              Run under Questa
    dsim                Run under DSim

optional arguments:
  -h, --help            show this help message and exit
`;
  const choices = detectSubcommandChoices(help);
  check(eq(choices, ['icarus', 'verilator', 'questa', 'dsim']), `subcommand choices detected (got ${JSON.stringify(choices)})`);
}

// --- favorite status carries forward across a rescan by flag identity, not list position ---
{
  const previous = [
    { flags: ['-s', '--seed'], metavar: 'SEED', favorite: true },
    { flags: ['--verbose'] }
  ];
  // Simulates a rescan: --verbose dropped, a new --waves appeared, --seed's
  // description changed -- favorite must still land on --seed by flag match.
  const next = [
    { flags: ['--waves'], description: 'Dump waveforms' },
    { flags: ['-s', '--seed'], metavar: 'SEED', description: 'Random seed (updated)' }
  ];
  const merged = mergeFavorites(previous, next);
  check(
    eq(merged, [
      { flags: ['--waves'], description: 'Dump waveforms' },
      { flags: ['-s', '--seed'], metavar: 'SEED', description: 'Random seed (updated)', favorite: true }
    ]),
    `favorite re-applied by flag identity after rescan (got ${JSON.stringify(merged)})`
  );
}

// --- no subparser signature -> no choices ---
{
  check(eq(detectSubcommandChoices('usage: prog [-h] [--seed SEED]\n'), []), 'no subparser -> empty choices');
}

// --- parseChoices: a flag's fixed value set, tool-agnostic dropdown source ---
{
  check(eq(parseChoices('{qrun,dsim}'), ['qrun', 'dsim']), `parseChoices brace list (got ${JSON.stringify(parseChoices('{qrun,dsim}'))})`);
  check(
    eq(parseChoices('{g2001,g2005,g2005-sv,g2009,g2012}'), ['g2001', 'g2005', 'g2005-sv', 'g2009', 'g2012']),
    `parseChoices hyphenated entries (got ${JSON.stringify(parseChoices('{g2001,g2005,g2005-sv,g2009,g2012}'))})`
  );
  check(parseChoices('SEED') === undefined, 'parseChoices leaves a plain metavar alone');
  check(parseChoices(undefined) === undefined, 'parseChoices(undefined) -> undefined');
  check(parseChoices('{}') === undefined, 'parseChoices empty braces -> undefined');
}

console.log(failures === 0 ? '\nAll tool-parser tests passed.' : `\n${failures} tool-parser test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
