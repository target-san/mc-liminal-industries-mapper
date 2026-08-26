/* Runs every suite and reports the totals. */
const suites = [
  (await import('./pure.test.mjs')).default,
  (await import('./app.test.mjs')).default,
];

let pass = 0, fail = 0;
for (const s of suites) {
  console.log(`${s.label.padEnd(6)} ${String(s.pass).padStart(3)} passed` +
              (s.fail ? `, ${s.fail} failed` : ''));
  pass += s.pass;
  fail += s.fail;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
