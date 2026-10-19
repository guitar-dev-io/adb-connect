#!/usr/bin/env bash
set -euo pipefail

echo "Bootstrap: install root dependencies"
npm install

echo "Build core"
npm run -w packages/core build || true

echo "Build vscode extension"
npm run -w extensions/vscode build || true


echo "Done. To run the VS Code extension in dev: open the repo in VS Code and run 'Run Extension'" 
