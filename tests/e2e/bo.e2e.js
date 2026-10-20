// Back Office browser suite: runs tests/e2e/bo/part0..part6 in order on ONE freshly seeded database
// (each part builds on the one before). Window size from BO_VIEWPORT (default 1280x900).
//   tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
//   FAKE_PORT=8787 FAKE_DB=cccc BO_VIEWPORT=1280x900 node tests/e2e/bo.e2e.js
//   FAKE_PORT=8787 FAKE_DB=cccc BO_VIEWPORT=768x1024 node tests/e2e/bo.e2e.js     (after a fresh e2e_reset)
// Stops at the first part that crashes (later parts need its data); a part with failed checks
// does not stop the run.
const { spawnSync } = require('child_process');
const path = require('path');
const PARTS = ['part0_smoke.js', 'part1_setup.js', 'part2_sales.js', 'part3_import.js', 'part4_admin.js', 'part5_import_refunds.js', 'part6_sale_lock.js'];
const size = process.env.BO_VIEWPORT || '1280x900';
let checks = 0, failed = 0, crashed = null;
for(const p of PARTS){
  console.log(`---- bo/${p} @ ${size}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'bo', p)], {stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: process.env, timeout: 15 * 60 * 1000});
  process.stdout.write(r.stdout || ''); if(r.stderr) process.stdout.write(r.stderr);
  const m = /SUMMARY [^:]+: (\d+) checks, (\d+) failed/.exec(r.stdout || '');
  if(m){ checks += Number(m[1]); failed += Number(m[2]); }
  if(!m || /FAIL \(stopped\)/.test(r.stdout || '') || r.status === null){ crashed = p; failed += m ? 0 : 1; break; }
}
console.log(`SUMMARY bo.e2e@${size}: ${checks} checks, ${failed} failed${crashed ? ' (stopped in ' + crashed + ')' : ''}`);
process.exit(failed ? 1 : 0);
