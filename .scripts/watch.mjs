import {spawn} from 'node:child_process';

const run = process.argv[2];
if (!/^\d+$/.test(run ?? '')) throw new Error('Pass the run ID');
const child = spawn('gh', ['run', 'watch', run, '--repo', 'qmuntal/setup-go-cache-bench-20261005', '--exit-status', '--interval', '60'], {
  env: {...process.env, CI: 'true', TERM: 'dumb'},
  stdio: ['ignore', 'pipe', 'pipe']
});
const clean = data => data.toString().replace(/\x1b\[[?0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
child.stdout.on('data', data => process.stdout.write(clean(data)));
child.stderr.on('data', data => process.stderr.write(clean(data)));
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
