// Hostile input: a README, a storyboard and an environment that try to make reporeel run or reveal
// something nobody approved.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeWorkflow } from '../src/ci.ts';
import { childEnv, dockerArgs, mustApprove } from '../src/exec.ts';
import { render } from '../src/render.ts';
import { validate } from '../src/storyboard.ts';
import { verify } from '../src/verify.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'rr-sec-'));
// A command that leaves proof if it ever runs.
const mark = (dir: string) => `node -e "require('fs').writeFileSync('${join(dir, 'pwned').replaceAll('\\', '/')}','x')"`;

test('a storyboard terminal command and app.start do not run without approval', async () => {
  const dir = tmp();
  const sb: any = { title: 'x', voice: { provider: 'none' }, app: { url: 'http://localhost:9/', start: mark(dir) },
    scenes: [{ type: 'terminal', commands: [mark(dir)], say: 'a' }, { type: 'web', say: 'b' }] };
  const seen: string[][] = [];
  // No answer, a no, and a truthy non-boolean all count as "not approved".
  for (const approve of [undefined, () => false, (c: string[]) => { seen.push(c); return 'yes' as any; }])
    await assert.rejects(render(sb, join(dir, 'reporeel.json'), { out: join(dir, 'out'), approve }), /not approved[\s\S]*pwned/);
  assert.equal(existsSync(join(dir, 'pwned')), false);
  assert.deepEqual(seen, [[mark(dir), mark(dir)]], 'approve sees the terminal command and app.start, exactly');
});

test('verify refuses README commands without approval, before it even clones', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'README.md'), '# x\n\n## Install\n\n```bash\ncd app\n' + mark(dir) + '\n```\n');
  let asked: string[] = [];
  await assert.rejects(verify(dir, { approve: c => { asked = c; return false; } }), /not approved/);
  await assert.rejects(verify(dir), /not approved/);
  assert.deepEqual(asked, [mark(dir)], 'only the commands that would run are shown; skipped ones are not');
  assert.equal(existsSync(join(dir, 'pwned')), false);
});

test('an approved README command runs, and cannot read a token from our environment', async () => {
  const dir = tmp();
  // Exits 1 if the token leaked, 0 if it is absent.
  writeFileSync(join(dir, 'README.md'), '# x\n\n## Install\n\n```bash\nnode -e "process.exit(process.env.GITHUB_TOKEN ? 1 : 0)"\n```\n');
  for (const a of [['init', '-q'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x']]) execFileSync('git', a, { cwd: dir });
  const had = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'ghp_should_not_leak';
  try {
    const r = await verify(dir, { approve: () => true });
    assert.deepEqual(r.steps.map(s => [s.ok, s.note]), [[true, 'ok']]);
  } finally { had === undefined ? delete process.env.GITHUB_TOKEN : (process.env.GITHUB_TOKEN = had); }
});

test('the sandbox command line shares the repo and nothing else', () => {
  const had = [process.env.REPOREEL_PASS_ENV, process.env.GITHUB_TOKEN];
  process.env.REPOREEL_PASS_ENV = 'NPM_TOKEN'; process.env.GITHUB_TOKEN = 'ghp_x';
  try {
    const a = dockerArgs('npm test && echo "a b"', '/repo/dir', { image: 'node:22-slim', workdir: 'packages\\app', timeoutMs: 90_500, env: { CI: '1' } });
    const after = (flag: string) => a.flatMap((x, i) => (x === flag ? [a[i + 1]] : []));
    assert.deepEqual(after('--network'), ['none'], 'no network unless asked');
    assert.deepEqual(after('-v'), ['/repo/dir:/work'], 'exactly one mount: the repo');
    assert.deepEqual(after('-w'), ['/work/packages/app']);
    // The only environment is what we name: no host variable is copied by value, and a passed one is named, not inlined.
    assert.deepEqual(after('-e'), ['HOME=/tmp', 'CI=1', 'NPM_TOKEN']);
    assert.ok(!a.join(' ').includes('ghp_x') && !a.includes('--privileged') && !a.includes('--env-file'));
    assert.deepEqual(after('--cap-drop'), ['ALL']);
    assert.deepEqual(after('--security-opt'), ['no-new-privileges']);
    // The command is one argument to sh, so its quotes and && cannot leak into docker's own flags; the limit is rounded up.
    assert.deepEqual(a.slice(a.indexOf('node:22-slim')), ['node:22-slim', 'timeout', '91', 'sh', '-c', 'npm test && echo "a b"']);
    assert.deepEqual(dockerArgs('x', '/r', { image: 'i', network: true, timeoutMs: 1000 }).flatMap((x, i, all) => (x === '--network' ? [all[i + 1]] : [])), ['bridge']);
  } finally { for (const [k, v] of [['REPOREEL_PASS_ENV', had[0]], ['GITHUB_TOKEN', had[1]]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v); }
});

test('in the sandbox a README command sees the checkout, but not this machine, its secrets or the network', { timeout: 240_000 }, async t => {
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) return t.skip('docker is not running here');
  const dir = tmp(), outside = join(tmp(), 'host-only.txt');
  writeFileSync(outside, 'x');
  const node = (js: string) => `node -e "${js}"`;
  writeFileSync(join(dir, 'README.md'), ['# x', '', '## Install', '', '```bash',
    node("process.exit(require('fs').existsSync('/work/README.md') ? 0 : 1)"),
    node(`process.exit(require('fs').existsSync('${outside.replaceAll('\\', '/')}') ? 1 : 0)`),
    node("process.exit(process.env.GITHUB_TOKEN ? 1 : 0)"),
    node("fetch('https://example.com').then(() => process.exit(1), () => process.exit(0))"),
    node("require('fs').writeFileSync('/work/made-inside', 'x')"),
    node("process.exit(require('fs').existsSync('/work/made-inside') ? 0 : 1)"),
    '```', ''].join('\n'));
  for (const a of [['init', '-q'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x']]) execFileSync('git', a, { cwd: dir });
  const had = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'ghp_should_not_leak';
  try {
    const r = await verify(dir, { approve: () => true, sandbox: { image: 'node:22-slim' } });
    assert.deepEqual(r.steps.map(s => `${s.ok} ${s.note}`), Array(6).fill('true ok'), r.steps.map(s => s.tail).join('\n'));
  } finally { had === undefined ? delete process.env.GITHUB_TOKEN : (process.env.GITHUB_TOKEN = had); }
});

test('mustApprove asks nothing when there is nothing to run', async () => {
  await mustApprove([], () => { throw new Error('asked'); });
});

test('repository commands do not inherit credentials', () => {
  const secret: Record<string, string> = { ANTHROPIC_API_KEY: 'a', ELEVENLABS_API_KEY: 'b', GITHUB_TOKEN: 'c', NPM_TOKEN: 'd', AWS_SECRET_ACCESS_KEY: 'e', DB_PASSWORD: 'f', SSH_AUTH_SOCK: 'g' };
  const mine = [...Object.keys(secret), 'RR_PLAIN', 'REPOREEL_PASS_ENV'];
  const saved = Object.fromEntries(mine.map(k => [k, process.env[k]]));
  try {
    Object.assign(process.env, secret, { RR_PLAIN: 'kept', REPOREEL_PASS_ENV: ' NPM_TOKEN ,MISSING' });
    const env = childEnv({ CI: '1' });
    for (const k of Object.keys(secret)) if (k !== 'NPM_TOKEN') assert.equal(env[k], undefined, k);
    assert.equal(env.NPM_TOKEN, 'd', 'REPOREEL_PASS_ENV lets a named variable through');
    assert.equal(env.RR_PLAIN, 'kept');
    assert.equal(env.CI, '1');
    assert.ok(env.PATH ?? env.Path, 'PATH survives, or nothing could run');
    assert.equal(process.env.GITHUB_TOKEN, 'c', 'our own environment is untouched');
  } finally { for (const k of mine) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]); }
});

test('a storyboard cannot show files outside the repo or non-http pages', () => {
  const sb = (scene: object, app?: object) => ({ title: 'x', app, scenes: [{ say: 's', ...scene }] });
  for (const file of ['../../.ssh/id_rsa', 'src/../../secret', '/etc/passwd', 'C:\\Users\\me\\.npmrc', '..\\x', '..'])
    assert.match(validate(sb({ type: 'code', file })).join('\n'), /inside the repo/, file);
  for (const file of ['src/a.ts', 'a..b.ts', '.github/workflows/ci.yml', 'docs/..hidden/x'])
    assert.deepEqual(validate(sb({ type: 'code', file })), [], file);
  for (const url of ['file:///etc/passwd', 'FILE:///c:/x', 'chrome://settings', 'javascript:alert(1)', 'data:text/html,x'])
    assert.match(validate(sb({ type: 'web', url }, { url: 'http://localhost:1/' })).join('\n'), /only http and https/, url);
  assert.match(validate(sb({ type: 'web', url: '/' }, { url: 'file:///etc/' })).join('\n'), /app\.url/);
  for (const url of ['/', '/a?b=c:d', 'https://example.com/', undefined])
    assert.deepEqual(validate(sb({ type: 'web', url }, { url: 'http://localhost:1/' })), [], String(url));
});

test('the generated workflow gives pull requests a read-only token', () => {
  const yml = readFileSync(writeWorkflow(tmp()), 'utf8');
  const [top, jobs] = yml.split('\njobs:\n');
  assert.match(top, /\npermissions:\n  contents: read$/);
  assert.doesNotMatch(top, /contents: write/);
  const [check, refresh] = jobs.split('\n  refresh:\n');
  assert.match(check, /if: github\.event_name == 'pull_request'/);
  assert.doesNotMatch(check, /write|secrets\./, 'the pull-request job has no write permission and no secrets');
  assert.match(refresh, /if: github\.event_name != 'pull_request'[\s\S]*permissions:\n      contents: write/);
  assert.doesNotMatch(yml, /pull_request_target/);
  assert.match(top, /
env:
  ONNXRUNTIME_NODE_INSTALL_CUDA: skip
/, 'npx installs the voice engine, which must not fetch CUDA on a runner');
});
