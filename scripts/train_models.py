"""Stage 2: fit M1-M4 on the synthetic dataset and write data/models/v1.json."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.ml.train import main  # noqa: E402

if __name__ == "__main__":
    main(ROOT / "data" / "synthetic", ROOT / "data" / "models" / "v1.json")
