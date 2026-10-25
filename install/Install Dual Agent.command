#!/usr/bin/env bash
# Double-click in Finder to install Dual Agent into VS Code.
cd "$(dirname "$0")"
bash ./install.sh
echo
read -n 1 -s -r -p "Press any key to close."
