# Working on the code and running the tests

How to build, test and package Dual Agent from source.

Code layout: `src/`, the chat page in `media/chat/`, and tests in `src/test/` (unit tests using node's test runner, and real runs against both providers). [CONTRIBUTING.md](../CONTRIBUTING.md) covers pull requests and releases; [SECURITY.md](../SECURITY.md) covers reporting problems.

```sh
npm ci
npm run compile
npm test              # unit tests (fast)
npx --no-install tsc --noEmit   # typecheck
```

The suite runs without network access and needs no keys.

- **Test keys:** tests read keys from `credentials/deepseek.env` and `credentials/anthropic.env` in the repo, and skip those runs if they're missing. Tests are grouped (`--group remote-control`, `--group live`), and `--solo` stops other packages' suites while they run. See `npm test -- --help`.
- **Claude sign-in:** the tests use the sign-in from your desktop Claude Code (`~/.claude/.credentials.json`) or `ANTHROPIC_API_KEY`.
- **Env:** run tests in a plain terminal; some editor shells export variables that change behaviour.
- **Dictation:** `npm run build:dictation` needs macOS with the Xcode command line tools and writes a bundle (ignored by git). `npm test` covers the parser and the server half.
- **TypeScript settings:** Promise timers are typechecked with `DOM` only, so type uses of `Promise` come from the repo's `IThenable<T>` shim in `src/global.d.ts`; don't pass the `lib` type to `Thenable` parameters.
- **Creating a VSIX:** `scripts/package.mjs` builds the bundle (`esbuild`), compiles the dictation app on a Mac when it changed, and packs `.vsix` files into `dist/`; its usage is at the top of the file.
- **Makefile:** `make install` installs into the editors on the machine running it; there is no other target needed for a local build.
- **Model prices:** the cost figures use the table in `src/usage.ts`; update it when a provider changes its prices.
