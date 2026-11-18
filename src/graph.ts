// `reporeel graph`: what the code itself says about its structure. Modules, their top-level symbols
// and the imports between them, for TypeScript/JavaScript and Python. No model, and nothing from
// the repository is run: files are only read.
//
// Rule: an edge exists only when the import resolves to a real file in the repo. Anything else is
// kept as `unresolved` or `external`, never guessed.
//
// shortcut: declarations and imports are matched by pattern, not parsed. Top-level declarations
// must start in column 0, nested ones are not listed, and an import statement quoted inside a
// string could be picked up. Call relationships are not extracted at all. Upgrade to tree-sitter
// when call graphs are needed.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { files } from './doctor.ts';

export interface Sym { id: string; name: string; kind: 'function' | 'class' | 'const' | 'type'; file: string; line: number; exported: boolean }
export interface Mod {
  file: string; lang: 'js' | 'py'; lines: number; test: boolean;
  /** Repo files this one imports. */ imports: string[];
  /** Packages from outside the repo. */ external: string[];
  /** Relative imports that point at no file in the repo. */ unresolved: string[];
  /** Of the file's content, so a later run can tell whether it changed. */ hash: string;
}
export interface Graph { commit: string | null; modules: Mod[]; symbols: Sym[] }

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py)$/;
const SKIP = /(^|\/)(node_modules|dist|build|\.next|vendor|__pycache__|\.venv|venv|coverage|target)\/|\.min\.|\.d\.ts$/;
const TEST = /(^|\/)(tests?|__tests__|specs?)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.py$/;
const JS_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

// Line endings are not content: a Windows checkout (autocrlf) and the Linux CI one must hash the same.
export const sha = (s: string | Buffer) => createHash('sha256').update(s.toString().replaceAll('\r\n', '\n')).digest('hex').slice(0, 16);

function jsSymbols(file: string, lines: string[]): Sym[] {
  const out: Sym[] = [];
  lines.forEach((l, i) => {
    const m = l.match(/^(export\s+(?:default\s+)?)?(?:declare\s+)?(?:(async\s+)?function\*?|(abstract\s+)?class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/);
    if (!m) return;
    const word = l.slice((m[1] ?? '').length).match(/function|class|const|let|var|interface|type|enum/)![0];
    const kind: Sym['kind'] = word === 'function' ? 'function' : word === 'class' ? 'class' : /interface|type|enum/.test(word) ? 'type'
      : /=\s*(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*(:[^=]+)?=>|=\s*(async\s+)?function\b/.test(l) ? 'function' : 'const';
    out.push({ id: `${file}#${m[4]}`, name: m[4], kind, file, line: i + 1, exported: !!m[1] });
  });
  return out;
}

function pySymbols(file: string, lines: string[]): Sym[] {
  const out: Sym[] = [];
  lines.forEach((l, i) => {
    const m = l.match(/^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/);
    if (m) out.push({ id: `${file}#${m[2]}`, name: m[2], kind: m[1] === 'def' ? 'function' : 'class', file, line: i + 1, exported: !m[2].startsWith('_') });
  });
  return out;
}

/** Does this start of a line end inside a quoted string? Strings that span lines are not followed. */
function inString(before: string): boolean {
  let open = '';
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (c === '\\') i++;
    else if (open ? c === open : c === "'" || c === '"' || c === '`') open = open ? '' : c;
  }
  return open !== '';
}

/** Import specifiers as written, comments removed first so commented-out imports do not count. */
function jsSpecs(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...code.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[\w$*{}\s,]+?\sfrom\s+)?['"]([^'"\n]+)['"]|\b(?:require|import)\(\s*['"]([^'"\n]+)['"]\s*\)/g)]
    // A require(...) written inside a string on the same line is text, not an import.
    .filter(m => m[1] !== undefined || !inString(code.slice(code.lastIndexOf('\n', m.index) + 1, m.index)))
    // "./a.css?inline" names the file ./a.css.
    .map(m => (m[1] ?? m[2]).replace(/[?#].*$/, ''));
}

/** Each entry is one import statement as a list of candidates: `from pkg import a` may mean the
 *  package or its submodule `pkg.a`, so both are offered and whichever exists is used. */
function pySpecs(text: string): string[][] {
  const out: string[][] = [];
  for (const l of text.split('\n')) {
    const from = l.match(/^\s*from\s+(\.*[\w.]*)\s+import\s+(.+)/);
    if (from) out.push([from[1], ...from[2].replace(/[()\\]|#.*$/g, '').split(',').map(n => n.trim().split(/\s+as\s+/)[0]).filter(n => /^\w+$/.test(n)).map(n => `${from[1]}${from[1].endsWith('.') ? '' : '.'}${n}`)]);
    const imp = l.match(/^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)\s*(#.*)?$/);
    if (imp) for (const n of imp[1].split(',')) out.push([n.trim().split(/\s+as\s+/)[0]]);
  }
  return out;
}

export function analyze(root: string): Graph {
  const everything = new Set(files(root));
  const all = [...everything].filter(f => CODE.test(f) && !SKIP.test(f)).sort();
  const have = new Set(all);
  const pick = (cands: string[]) => cands.map(c => posix.normalize(c)).find(c => have.has(c));
  const modules: Mod[] = [], symbols: Sym[] = [];
  for (const file of all) {
    let text: string;
    try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    const lang = file.endsWith('.py') ? 'py' as const : 'js' as const, dir = posix.dirname(file), lines = text.split('\n');
    const imports = new Set<string>(), external = new Set<string>(), unresolved = new Set<string>();
    if (lang === 'js') for (const spec of jsSpecs(text)) {
      if (spec.startsWith('.')) {
        const base = posix.join(dir, spec), bare = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
        // A folder import goes through that folder's package.json "main" before index.*, as Node does.
        let main: string[] = [];
        if (everything.has(posix.join(base, 'package.json'))) try { const m = JSON.parse(readFileSync(join(root, base, 'package.json'), 'utf8')).main; if (typeof m === 'string') main = [posix.join(base, m), ...JS_EXT.map(e => posix.join(base, m + e)), posix.join(base, m, 'index.js')]; } catch {}
        const hit = pick([base, ...JS_EXT.map(e => bare + e), ...JS_EXT.map(e => base + e), ...main, ...JS_EXT.map(e => posix.join(base, 'index' + e))]);
        // A stylesheet, image or JSON file that exists is a real import, just not of a module: no edge, and not a miss.
        if (hit) imports.add(hit); else if (!everything.has(posix.normalize(base))) unresolved.add(spec);
      } else if (!spec.startsWith('node:')) external.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
    } else for (const alts of pySpecs(text)) {
      const hits = alts.flatMap(spec => {
        const dots = spec.match(/^\.*/)![0].length, path = spec.slice(dots).split('.').filter(Boolean).join('/');
        // Relative imports start at the file's package; absolute ones are tried from the repo root, src/ and the file's folder.
        const bases = dots ? [posix.join(dir, ...Array(dots - 1).fill('..'))] : ['.', 'src', dir];
        return pick(bases.flatMap(b => path ? [posix.join(b, path + '.py'), posix.join(b, path, '__init__.py')] : [posix.join(b, '__init__.py')])) ?? [];
      });
      for (const h of hits) if (h !== file) imports.add(h);
      if (!hits.length) alts[0].startsWith('.') ? unresolved.add(alts[0]) : external.add(alts[0].split('.')[0]);
    }
    modules.push({ file, lang, lines: lines.length, test: TEST.test(file), imports: [...imports].sort(), external: [...external].sort(), unresolved: [...unresolved].sort(), hash: sha(text) });
    symbols.push(...(lang === 'py' ? pySymbols : jsSymbols)(file, lines));
  }
  let commit: string | null = null;
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  return { commit, modules, symbols };
}

/** Everything that can be reached from `start` by following `next`, not counting `start` itself. */
function reach(start: string[], next: (f: string) => string[]): string[] {
  const seen = new Set(start), queue = [...start];
  for (let f; (f = queue.shift()) !== undefined;) for (const n of next(f)) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  return [...seen].filter(f => !start.includes(f)).sort();
}

/** What a change to `changed` can affect: every module that imports those files, directly or through
 *  others, and the test files among them. Reachability by import, not measured coverage. */
export function impact(g: Graph, changed: string[]): { changed: string[]; dependents: string[]; tests: string[] } {
  const known = changed.filter(f => g.modules.some(m => m.file === f));
  const isTest = new Set(g.modules.filter(m => m.test).map(m => m.file));
  const up = reach(known, f => g.modules.filter(m => m.imports.includes(f)).map(m => m.file));
  return { changed: known, dependents: up.filter(f => !isTest.has(f)), tests: [...new Set([...up, ...known].filter(f => isTest.has(f)))].sort() };
}
