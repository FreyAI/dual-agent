# Contributing

Thanks for helping. Keep changes small and focused: one change per pull request.

## Setup

Requires Node.js 20 (see `@types/node` in `package.json`).

```sh
npm ci
npm run compile
```

To run the extension from source, open the folder in VS Code and press F5 ("Run Dual Agent", from `.vscode/launch.json`). It compiles first and opens a second VS Code window with the extension loaded.

## Checks

| Command | What it covers |
| --- | --- |
| `npx tsc --noEmit` | Typecheck (the lint step) |
| `npm run test:unit` | Unit tests (`node --test` over `out/test/unit/`) |
| `npm run test:webview` | Webview tests; skip themselves without Chrome |
| `npm run test:vscode` | Tests inside a separate VS Code window loaded from source |
| `npm test` | Compile, then all three suites |

Unit tests should run with the Claude Code environment unset, or the tests inherit it:

```sh
env -u CLAUDECODE -u CLAUDE_CODE_ENABLE_TASKS npm test
```

`npm run test:vscode` needs VS Code installed; it looks at the standard macOS install by default and takes `VSCODE_PATH` otherwise. It never downloads VS Code and skips when none is found.

## Packaging

`npm run package` builds the VSIX for this machine into `dist/`; `npm run package:all` builds every platform. `scripts/package.mjs` compiles, runs the unit and webview tests (`DUAL_AGENT_SKIP_TESTS=1` skips them), stages each target with only that platform's Claude Code binary, and calls `vsce package --target`. It must run on the target OS for macOS builds (the dictation helper is compiled with Swift on a Mac), and `dist/` and `install/` files are shipped alongside. `make package` / `make package-all` are the same with `npm ci` first.

## Eval

`npm run eval` (after a compile, `node out/test/eval/run.js`) runs tasks against the real providers and grades them, writing results to `eval-results/`. It spends real API credit; it stops starting runs once the budget would be exceeded (`--budget`, in dollars). Don't run it in CI or on pull requests.

## Commits and pull requests

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `fix(proxy): keep cache across cleared batches`, `feat(eval): add --k`.
- One change per PR. Add a test for every new behavior, including its failure path.
- Run `npx tsc --noEmit` and `npm test` before opening the PR.
- Never commit API keys or `credentials/`; the key files are gitignored and CI scans for secrets.
