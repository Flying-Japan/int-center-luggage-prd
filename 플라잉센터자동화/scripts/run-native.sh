#!/bin/bash
# Native macOS runner - sources .env.local and starts uvicorn
set -a
source "$(dirname "$0")/../.env.local"
set +a

cd "$(dirname "$0")/.."
exec .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
