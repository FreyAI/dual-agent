# Dual Agent: build, test and install on macOS, Linux and Windows.
#
#   make install      build, run the unit and webview tests, remove the installed version, and install this build
#                     (a failing test stops it; DUAL_AGENT_SKIP_TESTS=1 make install skips them)
#   make uninstall    remove it again
#   make package      build the VSIX for this machine into dist/
#   make package-all  build the VSIX for every platform into dist/
#   make test         unit, webview and in-VS Code tests (free)
#
# On Windows, make comes with Git for Windows' SDK, MSYS2, or `winget install ezwinports.make`.
# Without make, run install\install.ps1 (or install/install.sh elsewhere) directly.

ifeq ($(OS),Windows_NT)
  PLATFORM := win32
  CPU := $(if $(filter ARM64,$(PROCESSOR_ARCHITEW6432) $(PROCESSOR_ARCHITECTURE)),arm64,x64)
  INSTALLER := powershell -NoProfile -ExecutionPolicy Bypass -File install/install.ps1
  UNINSTALLER := $(INSTALLER) -Uninstall
else
  UNAME_S := $(shell uname -s)
  UNAME_M := $(shell uname -m)
  PLATFORM := $(if $(filter Darwin,$(UNAME_S)),darwin,linux)
  CPU := $(if $(filter arm64 aarch64,$(UNAME_M)),arm64,x64)
  # Rosetta reports x86_64 on Apple silicon; the native build is the right one.
  ifeq ($(PLATFORM)-$(shell sysctl -n sysctl.proc_translated 2>/dev/null),darwin-1)
    CPU := arm64
  endif
  INSTALLER := bash install/install.sh
  UNINSTALLER := $(INSTALLER) --uninstall
endif

TARGET := $(PLATFORM)-$(CPU)
VERSION := $(shell node -p "require('./package.json').version" 2>/dev/null)
VSIX := dist/dual-agent-$(VERSION)-$(TARGET).vsix

.PHONY: help install uninstall package package-all deps test test-unit test-webview test-vscode clean

help:
	@echo "Dual Agent $(VERSION) - this machine is $(TARGET)"
	@echo "  make install      install into the VS Code(s) found here"
	@echo "  make uninstall    remove it"
	@echo "  make package      build $(VSIX)"
	@echo "  make package-all  build every platform"
	@echo "  make test         run the test suites"

# Builds this checkout (needs Node.js), removes the installed version and
# installs the new build, so the version number needn't change. A copy without
# the source (the dist/ folder on its own) installs its prebuilt VSIX.
install:
ifeq ($(VERSION),)
	$(INSTALLER)
else
	@$(MAKE) --no-print-directory package
	$(INSTALLER)
endif

uninstall:
	$(UNINSTALLER)

$(VSIX):
	@$(MAKE) --no-print-directory package

package: deps
	node scripts/package.mjs $(TARGET)

package-all: deps
	node scripts/package.mjs all

deps: node_modules/.package-lock.json

node_modules/.package-lock.json: package.json package-lock.json
	npm ci

test: deps
	npm test

test-unit: deps
	npm run test:unit

test-webview: deps
	npm run test:webview

test-vscode: deps
	npm run test:vscode

clean:
	node -e "for (const d of ['out','test-output','.vscode-test']) require('fs').rmSync(d, { recursive: true, force: true })"
