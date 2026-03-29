import os
from pathlib import Path


def resolve_data_dir() -> Path:
    raw = os.getenv("VISTA_DATA_DIR", "").strip()
    if raw:
        data_dir = Path(raw)
    else:
        data_dir = Path(__file__).resolve().parent / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir
