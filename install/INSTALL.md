# Installing Dual Agent

This folder has one VSIX per platform and an installer that picks the right one.

> **Beta:** only the macOS builds have been tested so far. The Windows and Linux builds are still awaiting tests; if one misbehaves, please [report it](https://github.com/FreyAI/dual-agent/issues/new/choose).

| File | For |
|---|---|
| `dual-agent-*-darwin-arm64.vsix` | Mac with Apple silicon (M1 and later) |
| `dual-agent-*-darwin-x64.vsix` | Intel Mac |
| `dual-agent-*-linux-x64.vsix` | Linux on x86-64 |
| `dual-agent-*-linux-arm64.vsix` | Linux on ARM (Raspberry Pi 64-bit, Graviton, …) |
| `dual-agent-*-win32-x64.vsix` | Windows on x64 |
| `dual-agent-*-win32-arm64.vsix` | Windows on ARM |

## From the project folder: `make install`

On any of your machines, open a terminal in the project folder and run:

```sh
make install
```

It detects the OS and CPU, finds the VS Code-family editors installed (VS Code, Insiders, VSCodium, Cursor, Windsurf), and installs the matching build into each. In the project folder it builds this machine's VSIX first (that needs Node.js 18+ and npm), then replaces the installed version; in a copy of `dist/` on its own it installs the prebuilt VSIX. `make uninstall` removes it.

On Windows, `make` comes with MSYS2 or Git for Windows' SDK, or install it with `winget install ezwinports.make`. Without `make`, run the installer below directly.

## macOS

Double-click **Install Dual Agent.command**. If macOS blocks it, right-click it, choose **Open**, then **Open** again.

Or in Terminal:

```sh
./install.sh
```

## Linux

```sh
chmod +x install.sh
./install.sh
```

The installer finds `code`, `code-insiders`, `codium`, `cursor` and `windsurf` and installs into each one it finds. To pick editors yourself: `./install.sh code-insiders`.

## Windows

In PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

It finds `code` on PATH or in the usual install folders. To pick editors: `.\install.ps1 -Editors code-insiders`. To remove: `.\install.ps1 -Uninstall`.

## By hand

In VS Code, open the Extensions view, click **…** → **Install from VSIX…**, and choose the file for your platform. Or run `code --install-extension dual-agent-<version>-<platform>.vsix`.

**Remote SSH, WSL and containers:** the agent runs on the remote machine, so install the build for the *remote's* platform (usually `linux-x64`) from a window connected to it.

## After installing

1. Reload VS Code (**Developer: Reload Window**).
2. Click the **Dual Agent** icon in the activity bar.
3. Click **Sign in** for Claude, **Add key** for DeepSeek, or both. The welcome screen shows each provider as **Ready** once it's set up.

## Uninstall

```sh
./install.sh --uninstall
```
