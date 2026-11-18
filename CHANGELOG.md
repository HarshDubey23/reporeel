# Changelog

## Unreleased

- `check` no longer reports a render as out of date just because a file was checked out with Windows line endings: hashes ignore CRLF versus LF.
- `--sandbox [image]` runs terminal scenes and `verify` steps in a Docker container: only the repository is visible, no network unless `--net`, none of your environment, bounded memory, CPU, processes and time. `app.start` is not covered.
- `plan --audience executive|developer|architecture|walkthrough|demo` for different cuts of the same repository (Claude planner only).
- `bench/run.ts` and `bench/RESULTS.md`: the graph, the offline draft and the evidence check on 20 real repositories. Fixed from what it found: folder imports now follow `package.json` `main`, imported stylesheets and images are no longer counted as unresolved, code quoted inside a string is no longer read as an import, and the draft is valid for a workspace root with a nameless `package.json`.
- This repository's own storyboard cites evidence for every claim, and `.github/workflows/media.yml` re-renders its video on demand.
- `reporeel graph`: modules, top-level symbols and resolved imports for TypeScript, JavaScript and Python, as `graph.json` and a clickable `explore.html`. Static: nothing is run.
- Scenes can cite `evidence` (file, line range, symbol, test). `reporeel check` reports each scene as observed, grounded, unsupported or broken; `video` refuses a storyboard with a broken citation, including a code scene whose lines are not in the file.
- Every render writes `evidence.json` (commit and a hash of each cited range); `check` names the scenes that are out of date with the code.
- `reporeel pr` adds how far the change reaches: modules that depend on the changed files and the test files that reach them.
- `plan` gives Claude the symbol list and sends broken citations back for a fix; the workflow from `reporeel ci` runs `check` on pull requests.
- **Breaking, security:** commands from a storyboard (`terminal` scenes, `app.start`) or a README (`verify`) no longer run unasked. The CLI lists them and asks; `--run` approves up front; without a terminal they are refused. Library callers pass `approve` to `render` and `verify`.
- Those commands no longer inherit credential-like environment variables (`REPOREEL_PASS_ENV` lets named ones through).
- The workflow from `reporeel ci` gives pull requests a read-only token; only the release job can write.
- Storyboards are rejected if a code scene points outside the repository or a web scene is not `http`/`https`.
- `doctor` works on Windows outside a git checkout.
- `doctor` reports a private key only when key material follows the header, so tests that guard against keys are no longer flagged.
- `doctor` finds the one-line description when badges, images or HTML come first.

## 0.2.0

- `reporeel setup` checks Node, ffmpeg, Chromium and keys, and says how to fix each; `--fix` installs Chromium.
- ffmpeg is found on PATH, in `REPOREEL_FFMPEG`, or from the bundled `ffmpeg-static`; ffprobe is no longer needed.
- Unchanged scenes are reused from a cache, so re-rendering after a small fix takes seconds. `--fresh` records everything again.
- `video --only 2,3` renders a preview of just those scenes.
- Videos carry chapters, and scenes dip through black between each other.
- `social` also makes vertical (9:16) and square (1:1) cuts for Reels, Shorts, TikTok and LinkedIn.
- JSON schema for the storyboard (`schema/reporeel.schema.json`), stamped into generated storyboards for editor autocomplete.
- Library API (`import { render, doctor } from '@theharshdubey/reporeel'`) with type declarations.
- End-to-end render test in CI.

## 0.1.0

- First release: `doctor`, `verify`, `plan`, `video`, `dub`, `shots`, `diagram`, `social`, `readme`, `pr`, `ci`, and the agent skill.
