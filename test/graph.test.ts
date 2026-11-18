// The code graph and the evidence check, on a small made-up repository where every right answer is known.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { check, stale } from '../src/evidence.ts';
import { explorerHtml } from '../src/explore.ts';
import { analyze, impact } from '../src/graph.ts';
import { draft } from '../src/plan.ts';
import { validate, type Storyboard } from '../src/storyboard.ts';

const FILES: Record<string, string> = {
  'src/auth.ts': "import { hash } from './util.js';\nimport express from 'express';\nimport type { Db } from '@acme/db/client';\n// import { gone } from './commented-out';\nexport function validateRequest(t: string) { return hash(t); }\nconst secret = 1;\nexport const check = async (x: string) => x;\nexport class Guard {\n  method() { function inner() {} }\n}\nexport interface Token { id: string }\n",
  'src/util.ts': "export const hash = (s: string) => s;\nexport { helper } from './lib';\nimport './missing-file';\n",
  'src/lib/index.ts': "export function helper() {}\n",
  'src/orphan.js': "const fs = require('node:fs');\nconst lodash = require('lodash/fp');\nmodule.exports = {};\n",
  'test/auth.test.ts': "import { validateRequest } from '../src/auth.ts';\n",
  'app/__init__.py': '',
  'app/models.py': "class User:\n    def save(self):\n        pass\n\ndef _private():\n    pass\n\nasync def load():\n    pass\n",
  'app/api.py': "import os, json\nimport requests as r\nfrom . import models\nfrom .models import User\nfrom app.models import (User, load)\nfrom .nothing import x\nfrom os import path\n",
  'tests/test_api.py': "from app import api\n\ndef test_ok():\n    pass\n",
  'README.md': '# fixture\n',
};
function repo(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rr-graph-'));
  for (const [f, body] of Object.entries({ ...FILES, ...extra })) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), body); }
  return dir;
}
const mod = (g: ReturnType<typeof analyze>, f: string) => g.modules.find(m => m.file === f)!;

test('imports become edges only when they resolve to a file; the rest stay unresolved or external', () => {
  const g = analyze(repo());
  assert.deepEqual(g.modules.map(m => m.file), ['app/__init__.py', 'app/api.py', 'app/models.py', 'src/auth.ts', 'src/lib/index.ts', 'src/orphan.js', 'src/util.ts', 'test/auth.test.ts', 'tests/test_api.py']);
  // ./util.js is the TypeScript file; the commented-out import is not an edge and not an error.
  assert.deepEqual([mod(g, 'src/auth.ts').imports, mod(g, 'src/auth.ts').external, mod(g, 'src/auth.ts').unresolved], [['src/util.ts'], ['@acme/db', 'express'], []]);
  // A folder import resolves to its index; an import of nothing is reported, not dropped or guessed.
  assert.deepEqual([mod(g, 'src/util.ts').imports, mod(g, 'src/util.ts').unresolved], [['src/lib/index.ts'], ['./missing-file']]);
  // node: builtins are not packages; a subpath belongs to its package.
  assert.deepEqual(mod(g, 'src/orphan.js').external, ['lodash']);
  const api = mod(g, 'app/api.py');
  assert.deepEqual([api.imports, api.external, api.unresolved], [['app/__init__.py', 'app/models.py'], ['json', 'os', 'requests'], ['.nothing']]);
  assert.deepEqual(mod(g, 'tests/test_api.py').imports, ['app/__init__.py', 'app/api.py']);
  assert.deepEqual(g.modules.filter(m => m.test).map(m => m.file), ['test/auth.test.ts', 'tests/test_api.py']);
  assert.equal(g.commit, null, 'not a git checkout, so no commit is claimed');
});

// Each of these was a wrong answer on a real repository in bench/RESULTS.md before it was fixed.
test('folder imports follow package.json main, assets are not misses, and quoted code is not an import', () => {
  const g = analyze(repo({
    'pkg/package.json': '{ "main": "lib/entry" }', 'pkg/lib/entry.js': 'module.exports = 1;\n',
    'pkg/test/main.test.js': "const pkg = require('..');\nconst missing = require('../nowhere');\n",
    'web/app.js': "import './app.css?inline';\nimport logo from './logo.svg';\nimport gone from './gone.png';\nconst cmd = \"node -e \\\"require('leftpad')\\\"\";\nconst real = require('rightpad');\n",
    'web/app.css': 'a{}', 'web/logo.svg': '<svg/>',
  }));
  assert.deepEqual([mod(g, 'pkg/test/main.test.js').imports, mod(g, 'pkg/test/main.test.js').unresolved], [['pkg/lib/entry.js'], ['../nowhere']]);
  const app = mod(g, 'web/app.js');
  assert.deepEqual([app.imports, app.unresolved, app.external], [[], ['./gone.png'], ['rightpad']]);
});

test('a draft for a repository with a nameless package.json and nothing detectable is still a valid storyboard', () => {
  const dir = repo({ 'package.json': '{ "private": true }' });
  const d = draft(dir);
  assert.deepEqual(validate(d), []);
  assert.doesNotMatch(JSON.stringify(d), /undefined|0 parts/);
  assert.deepEqual(check(d, dir).scenes.flatMap(s => s.problems), []);
});

test('top-level symbols are listed with their real line, kind and visibility; nested ones are not', () => {
  const g = analyze(repo());
  const of = (f: string) => g.symbols.filter(s => s.file === f).map(s => `${s.name}:${s.kind}:${s.line}:${s.exported ? 'pub' : 'priv'}`);
  assert.deepEqual(of('src/auth.ts'), ['validateRequest:function:5:pub', 'secret:const:6:priv', 'check:function:7:pub', 'Guard:class:8:pub', 'Token:type:11:pub']);
  assert.deepEqual(of('app/models.py'), ['User:class:1:pub', '_private:function:5:priv', 'load:function:8:pub']);
  for (const s of g.symbols) assert.equal(s.id, `${s.file}#${s.name}`);
});

test('impact follows imports upward and names the tests that reach the change', () => {
  const g = analyze(repo());
  assert.deepEqual(impact(g, ['src/lib/index.ts', 'README.md']), { changed: ['src/lib/index.ts'], dependents: ['src/auth.ts', 'src/util.ts'], tests: ['test/auth.test.ts'] });
  assert.deepEqual(impact(g, ['src/orphan.js']), { changed: ['src/orphan.js'], dependents: [], tests: [] });
  assert.deepEqual(impact(g, ['app/models.py']).tests, ['tests/test_api.py']);
  assert.deepEqual(impact(g, ['test/auth.test.ts']), { changed: ['test/auth.test.ts'], dependents: [], tests: ['test/auth.test.ts'] });
});

const sb = (scenes: any[]): Storyboard => ({ title: 'x', scenes: scenes.map(s => ({ say: 's', ...s })) });

test('scenes are observed, grounded, unsupported or broken, and coverage counts only real backing', () => {
  const dir = repo();
  const r = check(sb([
    { type: 'title', heading: 'h' },
    { type: 'terminal', commands: ['npm test'] },
    { type: 'code', file: 'src/auth.ts', lines: [5, 8], highlight: [[5, 5]] },
    { type: 'stats', items: [{ value: '1', label: 'guard' }], evidence: [{ kind: 'symbol', id: 'src/auth.ts#Guard' }, { kind: 'test', id: 'test/auth.test.ts' }] },
    { type: 'stats', items: [{ value: '99%', label: 'faster' }] },
    { type: 'diagram', mermaid: 'flowchart LR\n a-->b', evidence: [{ kind: 'file', id: 'src/util.ts', lines: [1, 2] }] },
  ]), dir);
  assert.deepEqual(r.scenes.map(s => s.status), ['none', 'observed', 'grounded', 'grounded', 'unsupported', 'grounded']);
  assert.equal(r.coverage, 4 / 5, 'the title makes no claim; the uncited number counts against coverage');
  assert.deepEqual(r.scenes[3].refs.map(x => x.file), ['src/auth.ts', 'test/auth.test.ts']);
  assert.equal(check(sb([{ type: 'title', heading: 'h' }]), dir).coverage, null);
});

test('a citation of something that is not there is broken, with the reason', () => {
  const dir = repo();
  const bad: [any, RegExp][] = [
    [{ type: 'code', file: 'src/nope.ts' }, /no such file/],
    [{ type: 'code', file: 'src/auth.ts', lines: [5, 400] }, /lines 5-400 are not in the file \(it has 12\)/],
    [{ type: 'code', file: 'src/auth.ts', lines: [8, 5] }, /lines 8-5/],
    [{ type: 'code', file: 'src/auth.ts', lines: [5, 8], highlight: [[2, 6]] }, /highlight 2-6 is outside the shown lines 5-8/],
    [{ type: 'stats', items: [{ value: '1', label: 'x' }], evidence: [{ kind: 'symbol', id: 'src/auth.ts#inner' }] }, /symbol src\/auth\.ts#inner: not found/],
    [{ type: 'stats', items: [{ value: '1', label: 'x' }], evidence: [{ kind: 'symbol', id: 'auth.validateRequest' }] }, /not found/],
    [{ type: 'diagram', mermaid: 'x', evidence: [{ kind: 'test', id: 'src/auth.ts' }] }, /not a test file/],
    [{ type: 'web', url: 'https://x.dev', evidence: [{ kind: 'file', id: '../outside.txt' }] }, /no such file|outside/],
    [{ type: 'end', heading: 'h', evidence: [{ kind: 'file', id: 'src/util.ts', lines: [0, 1] }] }, /lines 0-1/],
  ];
  for (const [scene, why] of bad) {
    const s = check(sb([scene]), dir).scenes[0];
    assert.equal(s.status, 'broken', JSON.stringify(scene));
    assert.match(s.problems.join('\n'), why);
  }
  assert.match(validate(sb([{ type: 'title', heading: 'h', evidence: [{ kind: 'vibes', id: 'x' }] }])).join('\n'), /evidence\[0\]: needs kind/);
  assert.match(validate(sb([{ type: 'title', heading: 'h', evidence: 'src/a.ts' }])).join('\n'), /evidence: must be a list/);
});

test('a render goes stale when the lines it cites change, and only then', () => {
  const dir = repo();
  const board = sb([
    { type: 'code', file: 'src/auth.ts', lines: [5, 5] },
    { type: 'stats', items: [{ value: '1', label: 'x' }], evidence: [{ kind: 'file', id: 'src/util.ts' }, { kind: 'symbol', id: 'app/models.py#User' }] },
  ]);
  const rendered = JSON.parse(JSON.stringify(check(board, dir)));
  assert.deepEqual(stale(dir, rendered), []);
  // An edit below the cited line of auth.ts changes nothing that was shown; an edit to util.ts does.
  writeFileSync(join(dir, 'src/auth.ts'), FILES['src/auth.ts'].replace('const secret = 1;', 'const secret = 2;'));
  assert.deepEqual(stale(dir, rendered), []);
  writeFileSync(join(dir, 'src/util.ts'), FILES['src/util.ts'] + '// changed\n');
  assert.deepEqual(stale(dir, rendered), [{ scene: 2, id: '2-stats', changed: ['src/util.ts'] }]);
  // A cited line that moved, and a cited symbol whose file is deleted, are both out of date.
  writeFileSync(join(dir, 'src/auth.ts'), '// new first line\n' + FILES['src/auth.ts']);
  rmSync(join(dir, 'app/models.py'));
  assert.deepEqual(stale(dir, rendered).map(s => [s.scene, s.changed]), [[1, ['src/auth.ts']], [2, ['src/util.ts', 'app/models.py#User']]]);
});

test('re-saving a cited file with Windows line endings does not make a render stale', () => {
  const dir = repo();
  const board = sb([{ type: 'code', file: 'src/auth.ts', lines: [5, 8] }, { type: 'stats', items: [{ value: '1', label: 'x' }], evidence: [{ kind: 'symbol', id: 'src/auth.ts#Guard' }] }]);
  const rendered = JSON.parse(JSON.stringify(check(board, dir)));
  writeFileSync(join(dir, 'src/auth.ts'), FILES['src/auth.ts'].replaceAll('\n', '\r\n'));
  assert.deepEqual(stale(dir, rendered), [], 'same text, different line endings');
  assert.equal(analyze(dir).modules.find(m => m.file === 'src/auth.ts')!.hash, analyze(repo()).modules.find(m => m.file === 'src/auth.ts')!.hash);
  writeFileSync(join(dir, 'src/auth.ts'), FILES['src/auth.ts'].replace('return hash(t)', 'return t').replaceAll('\n', '\r\n'));
  assert.equal(stale(dir, rendered).length, 2, 'a real edit is still caught');
});

test('the explorer page carries the graph as data and cannot be broken out of by a file name', () => {
  const g = analyze(repo());
  // Such a name cannot exist on every filesystem, so it is put straight into the graph.
  g.modules.push({ ...g.modules[0], file: 'src/</script><svg onload=alert(1)>.js' });
  const html = explorerHtml(g, { title: '<b>t</b>', repo: 'owner/name"><script>' });
  assert.equal(html.match(/<\/script>/g)?.length, 2, 'only the two real script elements close');
  assert.doesNotMatch(html, /<svg|<b>t/);
  const data = JSON.parse(html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/)![1]);
  assert.deepEqual(data.g, JSON.parse(JSON.stringify(g)), 'the embedded graph is the graph, unchanged');
  assert.equal(data.repo, null, 'a repo that is not owner/name makes no links');
  assert.equal(JSON.parse(explorerHtml(g, { title: 't', repo: 'owner/name' }).match(/id="data">([\s\S]*?)<\/script>/)![1]).repo, 'owner/name');
  assert.doesNotMatch(html, /innerHTML|document\.write/);
});

test("this repository's own storyboards cite nothing that is missing", () => {
  for (const [dir, file] of [['.', 'reporeel.json'], ['examples/hello', 'examples/hello/reporeel.example.json']]) {
    const r = check(JSON.parse(readFileSync(file, 'utf8')), dir);
    assert.deepEqual(r.scenes.flatMap(s => s.problems), [], file);
  }
});
