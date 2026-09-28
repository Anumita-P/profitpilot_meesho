"""Acceptance flows as a pytest gate — the same checks the demo script walks through (SPEC 32).

`scripts/api_smoke.py` is the executable presenter script; this keeps it in `make test` so a
regression cannot ship silently.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]


def test_acceptance_flows_pass():
    proc = subprocess.run([sys.executable, str(ROOT / "scripts" / "api_smoke.py")],
                          capture_output=True, text=True, cwd=str(ROOT))
    assert proc.returncode == 0, proc.stdout[-4000:] + proc.stderr[-2000:]


def test_scenario_goldens_hold():
    proc = subprocess.run([sys.executable, str(ROOT / "scripts" / "verify_scenarios.py")],
                          capture_output=True, text=True, cwd=str(ROOT))
    assert proc.returncode == 0, proc.stdout[-4000:]
