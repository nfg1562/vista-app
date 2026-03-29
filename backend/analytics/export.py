from __future__ import annotations

import io
import zipfile

import pandas as pd


def build_export_zip_bytes(
    positions_df: pd.DataFrame,
    events_df: pd.DataFrame,
    physical_df: pd.DataFrame,
    stats_df: pd.DataFrame,
) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        for df, name in [
            (positions_df, "positions.csv"),
            (events_df, "events.csv"),
            (physical_df, "physical.csv"),
            (stats_df, "stats.csv"),
        ]:
            csv_bytes = df.to_csv(index=False).encode("utf-8")
            archive.writestr(name, csv_bytes)
    buf.seek(0)
    return buf.getvalue()
