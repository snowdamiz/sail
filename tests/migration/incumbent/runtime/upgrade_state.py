import argparse
import hashlib
import json
from contextlib import closing
from pathlib import Path
import sqlite3


def recorded_state(database, thread):
    with closing(
        sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    ) as db:
        db.execute("BEGIN")
        if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ValueError("The fixture database failed its integrity check")
        if (
            db.execute(
                "SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ?",
                (thread,),
            ).fetchone()
            is None
        ):
            raise ValueError("The fixture thread is absent from the database")
        messages = db.execute(
            """
            SELECT message_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
            FROM orchestration_v2_projection_messages
            WHERE thread_id = ?
            ORDER BY created_at, message_id
            """,
            (thread,),
        ).fetchall()
        runs = db.execute(
            """
            SELECT run_id, status, payload_json
            FROM orchestration_v2_projection_runs
            WHERE thread_id = ?
            ORDER BY run_id
            """,
            (thread,),
        ).fetchall()
    return {
        "messages": [(*row[:-1], json.loads(row[-1])) for row in messages],
        "runs": [(*row[:-1], json.loads(row[-1])) for row in runs],
    }


def state_fingerprint(state):
    def fingerprint(rows):
        encoded = json.dumps(rows, sort_keys=True, separators=(",", ":")).encode()
        return hashlib.sha256(encoded).hexdigest()

    return {field: fingerprint(rows) for field, rows in state.items()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Fingerprint the saved message and run payloads for an upgrade fixture"
    )
    parser.add_argument("database", type=Path)
    parser.add_argument("thread")
    args = parser.parse_args()
    print(json.dumps(state_fingerprint(recorded_state(args.database, args.thread))))
