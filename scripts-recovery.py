#!/usr/bin/env python3
"""Private backup manifests and exact table fingerprints. No credentials in argv or output."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

DATABASES = ("foc_user", "foc_supplier", "foc_order", "foc_credit")


def psql(db, sql):
    return ["docker", "compose", "exec", "-T", "postgres", "psql", "-X", "-qAt",
            "-v", "ON_ERROR_STOP=1", "-U", os.environ.get("POSTGRES_USER", "postgres"),
            "-d", db, "-c", sql]


def tables(db):
    sql = """SELECT schemaname || '.' || tablename FROM pg_tables
        WHERE schemaname NOT LIKE 'pg_%' AND schemaname <> 'information_schema'
        ORDER BY schemaname,tablename"""
    return subprocess.check_output(psql(db, sql), text=True).splitlines()


def snapshot():
    result = {}
    for db in DATABASES:
        result[db] = {}
        for name in tables(db):
            # Names originate in pg_tables, never from a restore manifest or caller-supplied SQL.
            schema, table = name.split(".", 1)
            quoted = '.'.join('"' + part.replace('"', '""') + '"' for part in (schema, table))
            sql = ("SET TIME ZONE 'UTC'; COPY (SELECT to_jsonb(t)::text FROM " + quoted +
                   ' t ORDER BY to_jsonb(t)::text COLLATE "C") TO STDOUT')
            digest, count = hashlib.sha256(), 0
            with tempfile.TemporaryFile() as errors:
                with subprocess.Popen(psql(db, sql), stdout=subprocess.PIPE, stderr=errors) as process:
                    for row in process.stdout:
                        digest.update(row)
                        count += 1
                    if process.wait() != 0:
                        raise ValueError(f"Could not fingerprint {db}.{name}; backup/restore failed")
            result[db][name] = {"rows": count, "sha256": digest.hexdigest()}
    return result


def digest_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        if stream.read(5) != b"PGDMP":
            raise ValueError(f"{path.name} is not a custom-format PostgreSQL dump")
        stream.seek(0)
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify(bundle):
    manifest_path = bundle / "manifest.json"
    if manifest_path.is_symlink():
        raise ValueError("Manifest must not be a symbolic link")
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("format") != 1 or set(manifest.get("databases", {})) != set(DATABASES):
        raise ValueError("Expected format 1 with exactly the four service databases")
    for db in DATABASES:
        item = manifest["databases"][db]
        path = bundle / f"{db}.dump"
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Missing or unsafe dump for {db}")
        if item.get("sha256") != digest_file(path):
            raise ValueError(f"Checksum mismatch for {db}")
        if not isinstance(item.get("tables"), dict) or not item["tables"]:
            raise ValueError(f"Missing table fingerprints for {db}")
        for table, fingerprint in item["tables"].items():
            if (not isinstance(table, str) or not isinstance(fingerprint, dict) or
                    not isinstance(fingerprint.get("rows"), int) or fingerprint["rows"] < 0 or
                    not isinstance(fingerprint.get("sha256"), str) or
                    len(fingerprint["sha256"]) != 64):
                raise ValueError(f"Invalid table fingerprint for {db}")
    return manifest


def main():
    action = sys.argv[1]
    if action == "empty":
        for db in DATABASES:
            if tables(db):
                raise ValueError(f"{db} already contains tables; restore requires fresh volumes")
        return
    if action == "snapshot":
        print(json.dumps(snapshot(), indent=2, sort_keys=True))
        return
    bundle = Path(sys.argv[2]).resolve(strict=True)
    if action == "manifest":
        fingerprints = snapshot()
        manifest = {
            "format": 1,
            "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
            "workingTreeDirty": bool(subprocess.check_output(["git", "status", "--porcelain"], text=True).strip()),
            "project": os.environ.get("COMPOSE_PROJECT_NAME", "foc"),
            "consistency": "applications stopped; queues and unpublished outboxes empty",
            "databases": {db: {"sha256": digest_file(bundle / f"{db}.dump"),
                               "tables": fingerprints[db]} for db in DATABASES},
        }
        path = bundle / "manifest.json"
        with path.open("x") as stream:
            json.dump(manifest, stream, indent=2, sort_keys=True)
            stream.write("\n")
        verify(bundle)
    elif action == "verify":
        verify(bundle)
    elif action == "compare":
        manifest, current = verify(bundle), snapshot()
        differences = [db for db in DATABASES if manifest["databases"][db]["tables"] != current[db]]
        if differences:
            raise ValueError("Restored table contents differ: " + ", ".join(differences))
        print("Every service table has its original row count and SHA-256 fingerprint.")
    else:
        raise ValueError("Unknown recovery action")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        print(f"Recovery check failed: {error}", file=sys.stderr)
        sys.exit(1)
