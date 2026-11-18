// `reporeel check`: is what the storyboard says backed by the repository? Every scene that makes a
// claim is sorted into one of four kinds, and a reference that does not resolve stops the render.
//
//   observed     web and terminal scenes: recorded from the running app or a real command run
//   grounded     a code scene, or any scene whose evidence all resolves to files, symbols or tests
//   unsupported  a diagram or stats scene with no evidence: nothing in the repo is cited for it
//   broken       a file, line range, symbol or test that is cited but does not exist
//
// What this proves: the cited thing exists at this commit. It does not prove the narration
// describes it correctly; that still takes a reader.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { analyze, sha, type Graph } from './graph.ts';
import type { Scene, Storyboard } from './storyboard.ts';

/** `file`: a path, optionally with lines. `symbol`: "path#name" from `reporeel graph`. `test`: a test file. */
export interface Evidence { kind: 'file' | 'symbol' | 'test'; id: string; lines?: [number, number] }
export interface Ref extends Evidence { file: string; /** Of the cited lines (or the whole file), to notice later edits. */ hash: string }
export interface SceneReport { scene: number; id: string; type: Scene['type']; status: 'observed' | 'grounded' | 'unsupported' | 'broken' | 'none'; refs: Ref[]; problems: string[] }
export interface Report {
  commit: string | null;
  /** Share of claim-making scenes that are observed or grounded; null when no scene makes a claim. */
  coverage: number | null;
  scenes: SceneReport[];
}

/** The lines of a repo file, or a reason it cannot be cited. Symlinks may not lead outside the repo. */
function read(root: string, file: string): string[] | string {
  const p = join(root, file);
  if (/^([\\/]|[a-z]:)/i.test(file) || !existsSync(p)) return `${file}: no such file in the repository`;
  if (/^\.\.|^([\\/]|[a-z]:)/i.test(relative(realpathSync(root), realpathSync(p)))) return `${file}: is outside the repository`;
  try { return readFileSync(p, 'utf8').split(/\r?\n/); } catch { return `${file}: cannot be read`; }
}

function resolve(root: string, g: Graph, e: Evidence): Ref | string {
  let file = e.id;
  if (e.kind === 'symbol') {
    const s = g.symbols.find(x => x.id === e.id);
    if (!s) return `symbol ${e.id}: not found (ids are "path#name", see reporeel graph)`;
    file = s.file;
  }
  if (e.kind === 'test' && !g.modules.some(m => m.file === e.id && m.test)) return `test ${e.id}: not a test file in the repository`;
  const lines = read(root, file);
  if (typeof lines === 'string') return lines;
  if (e.lines) {
    const [a, b] = e.lines;
    if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 1 && b >= a && b <= lines.length)) return `${file}: lines ${a}-${b} are not in the file (it has ${lines.length})`;
  }
  return { ...e, file, hash: sha((e.lines ? lines.slice(e.lines[0] - 1, e.lines[1]) : lines).join('\n')) };
}

export function check(sb: Storyboard, root: string, g: Graph = analyze(root)): Report {
  const scenes = sb.scenes.map((s, i): SceneReport => {
    const cited: Evidence[] = [...(s.type === 'code' ? [{ kind: 'file' as const, id: s.file, lines: s.lines }] : []), ...(s.evidence ?? [])];
    const refs: Ref[] = [], problems: string[] = [];
    for (const e of cited) { const r = resolve(root, g, e); typeof r === 'string' ? problems.push(r) : refs.push(r); }
    if (s.type === 'code' && s.lines) for (const [a, b] of s.highlight ?? []) if (!(a >= s.lines[0] && b <= s.lines[1] && b >= a)) problems.push(`highlight ${a}-${b} is outside the shown lines ${s.lines[0]}-${s.lines[1]}`);
    const status = problems.length ? 'broken' : s.type === 'web' || s.type === 'terminal' ? 'observed' : refs.length ? 'grounded'
      : s.type === 'diagram' || s.type === 'stats' ? 'unsupported' : 'none';
    return { scene: i + 1, id: s.id ?? `${i + 1}-${s.type}`, type: s.type, status, refs, problems };
  });
  const claims = scenes.filter(s => s.status !== 'none');
  return { commit: g.commit, coverage: claims.length ? claims.filter(s => s.status === 'observed' || s.status === 'grounded').length / claims.length : null, scenes };
}

/** Scenes of an earlier render whose cited code has changed or gone since. */
export function stale(root: string, rendered: Report, g: Graph = analyze(root)): { scene: number; id: string; changed: string[] }[] {
  return rendered.scenes.map(s => ({ scene: s.scene, id: s.id, changed: s.refs.filter(r => { const now = resolve(root, g, r); return typeof now === 'string' || now.hash !== r.hash; }).map(r => r.id) })).filter(s => s.changed.length);
}

export function formatReport(r: Report, old?: { commit: string | null; stale: ReturnType<typeof stale> }): string {
  const mark = { observed: '●', grounded: '✓', unsupported: '?', broken: '✗', none: ' ' };
  const lines = r.scenes.map(s => `  ${mark[s.status]} ${String(s.scene).padStart(2)} ${s.type.padEnd(8)} ${s.status === 'none' ? '' : s.status}${s.refs.length ? '  ' + s.refs.map(x => x.id + (x.lines ? `:${x.lines[0]}-${x.lines[1]}` : '')).join(', ') : ''}${s.problems.map(p => `\n        ${p}`).join('')}`);
  const cov = r.coverage === null ? 'no scene makes a claim' : `${Math.round(r.coverage * 100)}% of claim-making scenes are observed or grounded`;
  const fresh = !old ? '' : old.stale.length ? `\n  out of date since the last render (${old.commit?.slice(0, 7) ?? 'no commit'}): ${old.stale.map(s => `scene ${s.scene} (${s.changed.join(', ')})`).join('; ')}` : '\n  the last render is still up to date with the code it cites';
  return `\n  evidence at ${r.commit?.slice(0, 7) ?? 'no commit'}\n${lines.join('\n')}\n\n  ${cov}${fresh}\n`;
}
