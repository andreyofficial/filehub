#!/usr/bin/env bash
# Push this project to GitHub (then Render/etc. pulls from there).
set -e
cd "$(dirname "$0")/.."

echo ""
echo "  FileHub — upload to GitHub"
echo "  ---------------------------"
echo ""

if ! command -v git >/dev/null 2>&1; then
  echo "Install Git first: https://git-scm.com/downloads"
  exit 1
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "No git repo here. Run: git init && git add -A && git commit -m \"first commit\""
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "No GitHub remote yet. Pick ONE:"
  echo ""
  echo "  A) GitHub CLI (easiest if installed):"
  echo "       gh auth login"
  echo "       gh repo create MY-REPO-NAME --public --source=. --remote=origin --push"
  echo ""
  echo "  B) Manually: create an empty repo on github.com, then:"
  echo "       git remote add origin https://github.com/YOU/MY-REPO-NAME.git"
  echo "       git branch -M main"
  echo "       git push -u origin main"
  echo ""
  exit 1
fi

git add -A
if git diff --cached --quiet && git diff --quiet; then
  echo "No file changes to commit."
else
  git commit -m "deploy $(date -u +%Y-%m-%dT%H:%MZ)" || true
fi

echo "Pushing to origin (main)..."
git push -u origin main

echo ""
echo "  Done. Next (Render — free):"
echo "  https://dashboard.render.com → New → Web Service → Connect this repo → Deploy"
echo "  Set env vars from .env.example (JWT_SECRET, PayPal, ADMIN_EMAIL, PUBLIC_BASE_URL)."
echo ""
