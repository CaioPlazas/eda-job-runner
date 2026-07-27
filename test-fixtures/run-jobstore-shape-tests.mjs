import { readFileSync } from 'fs';

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
}

const typesSrc = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
const jobStoreSrc = readFileSync(new URL('../src/jobStore.ts', import.meta.url), 'utf8');

// Extract the JobDefinition interface body (from "export interface JobDefinition {"
// to the matching closing brace at the start of a line).
const ifaceMatch = typesSrc.match(/export interface JobDefinition \{([\s\S]*?)\n\}/);
if (!ifaceMatch) {
  console.error('FAIL: could not locate JobDefinition interface in src/types.ts');
  process.exit(1);
}
const ifaceBody = ifaceMatch[1];

// Extract only the optional fields (declared as `name?: type;`), skipping
// `id`, `name`, `command`, `cwd` which are required and always present.
const optionalFieldNames = [...ifaceBody.matchAll(/^\s*(\w+)\?:/gm)].map(m => m[1]);

check(optionalFieldNames.length > 5, `found a plausible number of optional JobDefinition fields (got ${optionalFieldNames.length}: ${optionalFieldNames.join(', ')})`);

// Extract normalize()'s job-building block: from "const job: JobDefinition = {"
// (inside the `.map(j => {` callback) up to the matching "return job;" line.
const normalizeMatch = jobStoreSrc.match(/const job: JobDefinition = \{[\s\S]*?return job;/);
if (!normalizeMatch) {
  console.error('FAIL: could not locate the job-building block in normalize() in src/jobStore.ts');
  process.exit(1);
}
const normalizeBlock = normalizeMatch[0];

for (const field of optionalFieldNames) {
  // The loader may reference the field either as `j.<field>` (reading the
  // raw parsed input) or `job.<field>` (assigning the normalized output) --
  // either is proof the loader is aware of this field.
  const referenced = normalizeBlock.includes(`.${field}`);
  check(referenced, `normalize() references optional field "${field}" (would silently drop it on load otherwise)`);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
} else {
  console.log(`\nAll ${optionalFieldNames.length} optional JobDefinition fields are referenced by normalize().`);
}
