import { execSync } from 'child_process';

// Bundle the pure shell-quoting helpers to a temp ESM file and import them,
// the same approach every other test-fixtures harness uses.
execSync('npx esbuild ./src/shellQuote.ts --bundle --format=esm --outfile=/tmp/shellQuote.mjs', {
  stdio: 'inherit'
});
const { shellQuote, shellQuoteIfNeeded } = await import('/tmp/shellQuote.mjs');

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
}

// --- shellQuote: always wraps, even a plain bareword ---
check(shellQuote('foo') === "'foo'", `plain bareword still wrapped (got ${shellQuote('foo')})`);

// --- shellQuote: escapes an embedded single quote ---
check(shellQuote("it's") === "'it'\\''s'", `embedded single quote escaped (got ${shellQuote("it's")})`);

// --- shellQuote: empty string ---
check(shellQuote('') === "''", `empty string wrapped (got ${shellQuote('')})`);

// --- shellQuoteIfNeeded: bareword-safe characters pass through unquoted ---
check(shellQuoteIfNeeded('foo') === 'foo', 'plain word passes through');
check(shellQuoteIfNeeded('+define+FOO=1') === '+define+FOO=1', 'EDA-style define passes through');
check(shellQuoteIfNeeded('/path/to/file.f') === '/path/to/file.f', 'file path passes through');
check(shellQuoteIfNeeded('v1.2.3') === 'v1.2.3', 'version string passes through');
check(shellQuoteIfNeeded('a,b,c') === 'a,b,c', 'comma-separated list passes through');
check(shellQuoteIfNeeded('user@host:2222') === 'user@host:2222', '@ and : pass through');

// --- shellQuoteIfNeeded: a space triggers quoting ---
check(shellQuoteIfNeeded('a b') === "'a b'", `space triggers quoting (got ${shellQuoteIfNeeded('a b')})`);

// --- shellQuoteIfNeeded: embedded double quotes trigger quoting ---
check(
  shellQuoteIfNeeded('say "hi"') === `'say "hi"'`,
  `double quotes trigger quoting (got ${shellQuoteIfNeeded('say "hi"')})`
);

// --- shellQuoteIfNeeded: embedded single quote triggers quoting AND is escaped ---
check(
  shellQuoteIfNeeded("it's") === "'it'\\''s'",
  `single quote triggers quoting+escaping (got ${shellQuoteIfNeeded("it's")})`
);

// --- shellQuoteIfNeeded: shell metacharacters all trigger quoting ---
for (const value of ['$FOO', '`cmd`', 'a;b', 'a&b', 'a|b', 'a<b', 'a>b', 'a(b)', 'a*b', 'a?b', 'a#b']) {
  check(shellQuoteIfNeeded(value) === shellQuote(value), `metacharacter value quoted: ${value}`);
}

// --- shellQuoteIfNeeded: empty string is quoted (a bare empty word would vanish from argv otherwise) ---
check(shellQuoteIfNeeded('') === "''", `empty string quoted (got ${shellQuoteIfNeeded('')})`);

console.log(failures === 0 ? '\nALL SHELL-QUOTE ASSERTIONS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
