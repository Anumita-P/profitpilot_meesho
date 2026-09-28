"""Test isolation: every pytest run gets its own throwaway SQLite database.

Several suites call `seed_all(reset=True, ...)` to get a deterministic catalogue. Without this
conftest they would do that against the shared demo database (`data/profitpilot.db`), which had two
consequences: `make test` silently destroyed the seeded observation history the K-118 diagnosis
story depends on, and test order could leak state into the running app. Pointing the whole test
session (subprocesses included, since they inherit the environment) at a temp file makes the suite
hermetic and leaves the demo database alone.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="profitpilot-test-"))
os.environ.setdefault("DATABASE_URL", f"sqlite:///{_TMP / 'test.db'}")
