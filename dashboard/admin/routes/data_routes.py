"""Data management routes — session cleanup, wipe test data."""
import json
import logging
import os
import re
import uuid

import asyncpg
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import verify_super_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin/data", tags=["admin-data"])

DATABASE_URL = os.getenv("DATABASE_URL", "")

# Admin DB browser — allowlisted table names only (see plan).
ALLOWED_TABLES = frozenset({"sessions", "hunt_results", "trainers", "qc_runs"})
_IDENT_RE = re.compile(r"^[a-z_][a-z0-9_]*$")


def _get_sync_url():
    """Convert async PG URL to sync for direct queries."""
    return DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")


@router.delete("/session/{session_id}")
async def delete_session(session_id: str, _=Depends(verify_super_admin)):
    """Delete a session from PostgreSQL (and associated hunt_results)."""
    if not DATABASE_URL:
        raise HTTPException(503, "DATABASE_URL not configured")

    conn = await _get_conn()
    try:
        await _ensure_tables(conn)
        results_deleted = await conn.execute("DELETE FROM hunt_results WHERE session_id = $1", session_id)
        session_deleted = await conn.execute("DELETE FROM sessions WHERE id = $1", session_id)
        logger.info(f"Admin deleted session {session_id}: {session_deleted}, results: {results_deleted}")
        return {
            "deleted": True,
            "session_id": session_id,
            "session_rows": session_deleted,
            "result_rows": results_deleted,
        }
    finally:
        await conn.close()


class WipeRequest(BaseModel):
    confirm: str
    older_than_days: Optional[int] = None


@router.post("/wipe-sessions")
async def wipe_sessions(body: WipeRequest, _=Depends(verify_super_admin)):
    """Delete all non-submitted sessions from PostgreSQL. Requires confirm='yes'."""
    if body.confirm != "yes":
        raise HTTPException(400, "Set confirm='yes' to proceed")
    if not DATABASE_URL:
        raise HTTPException(503, "DATABASE_URL not configured")

    conn = await _get_conn()
    try:
        await _ensure_tables(conn)
        where = "WHERE status NOT IN ('submitted', 'approved')"
        if body.older_than_days:
            where += f" AND updated_at < NOW() - INTERVAL '{int(body.older_than_days)} days'"

        result_rows = await conn.execute(
            f"DELETE FROM hunt_results WHERE session_id IN (SELECT id FROM sessions {where})"
        )
        session_rows = await conn.execute(f"DELETE FROM sessions {where}")
        logger.info(f"Admin wiped sessions: {session_rows}, results: {result_rows}")
        return {"wiped": True, "sessions": session_rows, "results": result_rows}
    finally:
        await conn.close()


async def _get_conn():
    import asyncpg
    dsn = DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")
    return await asyncpg.connect(dsn)


async def _ensure_tables(conn):
    """Create all browseable tables if they don't exist."""
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS trainers (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            email TEXT UNIQUE NOT NULL,
            display_name TEXT,
            team TEXT,
            role TEXT NOT NULL DEFAULT 'trainer',
            config JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            trainer_id UUID REFERENCES trainers(id),
            notebook_json JSONB,
            config JSONB,
            status TEXT NOT NULL DEFAULT 'pending',
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            human_reviews JSONB NOT NULL DEFAULT '{}'::jsonb,
            conversation_history JSONB NOT NULL DEFAULT '[]'::jsonb,
            turns JSONB NOT NULL DEFAULT '[]'::jsonb,
            total_hunts INTEGER NOT NULL DEFAULT 0,
            completed_hunts INTEGER NOT NULL DEFAULT 0,
            breaks_found INTEGER NOT NULL DEFAULT 0,
            passes_found INTEGER NOT NULL DEFAULT 0,
            accumulated_hunt_count INTEGER NOT NULL DEFAULT 0,
            current_turn INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS hunt_results (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            hunt_id INTEGER NOT NULL,
            model TEXT NOT NULL,
            provider TEXT NOT NULL DEFAULT 'openrouter',
            status TEXT NOT NULL DEFAULT 'pending',
            prompt TEXT,
            response TEXT,
            reasoning_trace TEXT,
            judge_score INTEGER,
            judge_output TEXT,
            judge_explanation TEXT,
            judge_criteria JSONB NOT NULL DEFAULT '{}'::jsonb,
            scores JSONB NOT NULL DEFAULT '{}'::jsonb,
            error TEXT,
            is_breaking BOOLEAN NOT NULL DEFAULT FALSE,
            sample_label TEXT,
            duration_ms INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS qc_runs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            run_type TEXT NOT NULL,
            result JSONB NOT NULL,
            rules_applied JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)


@router.get("/stats")
async def data_stats(_=Depends(verify_super_admin)):
    """Quick counts for the data management panel."""
    if not DATABASE_URL:
        return {
            "total_sessions": 0,
            "submitted_sessions": 0,
            "draft_sessions": 0,
            "total_hunt_results": 0,
            "total_trainers": 0,
        }

    conn = await _get_conn()
    try:
        await _ensure_tables(conn)
        total = await conn.fetchval("SELECT COUNT(*) FROM sessions")
        submitted = await conn.fetchval("SELECT COUNT(*) FROM sessions WHERE status IN ('submitted', 'approved')")
        draft = await conn.fetchval("SELECT COUNT(*) FROM sessions WHERE status NOT IN ('submitted', 'approved')")
        results = await conn.fetchval("SELECT COUNT(*) FROM hunt_results")
        trainers_n = await conn.fetchval("SELECT COUNT(*) FROM trainers")
        return {
            "total_sessions": total,
            "submitted_sessions": submitted,
            "draft_sessions": draft,
            "total_hunt_results": results,
            "total_trainers": trainers_n,
        }
    finally:
        await conn.close()


# ─── DB browser (super-admin) ─────────────────────────────────────────────


def _assert_allowed_table(table: str) -> str:
    if table not in ALLOWED_TABLES:
        raise HTTPException(404, "Unknown table")
    return table


def _quote_ident(name: str) -> str:
    if not _IDENT_RE.match(name):
        raise HTTPException(400, "Invalid column name")
    return '"' + name.replace('"', '""') + '"'


def _serialize_cell(val: Any) -> Any:
    if val is None:
        return None
    if isinstance(val, uuid.UUID):
        return str(val)
    if isinstance(val, datetime):
        return val.isoformat()
    if isinstance(val, (dict, list)):
        return val
    if isinstance(val, memoryview):
        return val.tobytes().decode("utf-8", errors="replace")
    return val


def _serialize_row(row: dict) -> dict:
    return {k: _serialize_cell(v) for k, v in row.items()}


async def _fetch_columns(conn, table: str) -> list[dict]:
    await _ensure_tables(conn)
    rows = await conn.fetch(
        """
        SELECT c.column_name,
               CASE WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name::text ELSE c.data_type END AS data_type,
               c.is_nullable,
               COALESCE(pk.is_pk, false) AS is_pk
        FROM information_schema.columns c
        LEFT JOIN (
            SELECT ku.table_name, ku.column_name, true AS is_pk
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage ku
              ON tc.constraint_catalog = ku.constraint_catalog
             AND tc.constraint_schema = ku.constraint_schema
             AND tc.constraint_name = ku.constraint_name
            WHERE tc.table_schema = 'public'
              AND tc.constraint_type = 'PRIMARY KEY'
        ) pk ON c.table_name = pk.table_name AND c.column_name = pk.column_name
        WHERE c.table_schema = 'public' AND c.table_name = $1
        ORDER BY c.ordinal_position
        """,
        table,
    )
    if not rows:
        return []
    out = []
    for r in rows:
        dt = r["data_type"]
        is_jsonb = dt == "jsonb"
        out.append({
            "name": r["column_name"],
            "data_type": "jsonb" if is_jsonb else dt,
            "nullable": r["is_nullable"] == "YES",
            "is_pk": bool(r["is_pk"]),
        })
    return out


async def _get_pk_name(columns: list[dict]) -> str:
    for c in columns:
        if c["is_pk"]:
            return c["name"]
    raise HTTPException(500, "Table has no primary key in metadata")


def _parse_value_for_column(col_meta: dict, raw: Any) -> Any:
    if raw is None:
        return None
    dt = col_meta["data_type"]
    if raw == "" and col_meta["nullable"] and (dt == "uuid" or "uuid" in str(dt)):
        return None
    if dt == "jsonb":
        if isinstance(raw, (dict, list)):
            return raw
        if isinstance(raw, str):
            return json.loads(raw)
        raise HTTPException(400, f"Invalid JSONB for {col_meta['name']}")
    if dt == "uuid" or "uuid" in str(dt):
        return uuid.UUID(str(raw))
    if dt in ("integer", "bigint", "smallint") or "integer" in str(dt):
        return int(raw)
    if dt in ("boolean",) or dt == "bool":
        return bool(raw)
    if dt in ("double precision", "real") or "numeric" in str(dt) or dt == "float":
        return float(raw)
    if "timestamp" in str(dt) or dt == "date":
        if isinstance(raw, (int, float)):
            return datetime.fromtimestamp(raw, tz=timezone.utc)
        s = str(raw).strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        d = datetime.fromisoformat(s)
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return d
    return raw


async def _coerce_body_for_write(
    conn, table: str, body: dict[str, Any], *, partial: bool
) -> dict[str, Any]:
    columns = await _fetch_columns(conn, table)
    if not columns:
        raise HTTPException(404, "Table not found or empty metadata")
    col_by_name = {c["name"]: c for c in columns}
    out: dict[str, Any] = {}
    for key, val in body.items():
        if key not in col_by_name:
            continue
        meta = col_by_name[key]
        if meta["is_pk"] and partial:
            continue
        if val is None and not meta["nullable"] and not meta["is_pk"]:
            raise HTTPException(400, f"{key} cannot be null")
        if val == "" and meta["nullable"]:
            out[key] = None
            continue
        if val is None:
            out[key] = None
            continue
        out[key] = _parse_value_for_column(meta, val)
    return out


def _searchable_columns(columns: list[dict]) -> list[str]:
    return [c["name"] for c in columns if c["data_type"] != "jsonb"]


@router.get("/browse/{table}/schema")
async def browse_schema(table: str, _=Depends(verify_super_admin)):
    """Column metadata for building the admin grid and forms."""
    table = _assert_allowed_table(table)
    if not DATABASE_URL:
        raise HTTPException(503, "DATABASE_URL not configured")
    conn = await _get_conn()
    try:
        cols = await _fetch_columns(conn, table)
        if not cols:
            raise HTTPException(404, "Table not found")
        pk = await _get_pk_name(cols)
        sortable = [c["name"] for c in cols if c["data_type"] != "jsonb"]
        return {"table": table, "columns": cols, "pk": pk, "sortable": sortable}
    finally:
        await conn.close()


@router.get("/browse/{table}")
async def browse_list(
    table: str,
    _=Depends(verify_super_admin),
    page: int = Query(1, ge=1),
    limit: int = Query(25, ge=1, le=100),
    search: str = Query("", max_length=500),
    sort: Optional[str] = None,
    order: str = Query("desc"),
):
    table = _assert_allowed_table(table)
    if not DATABASE_URL:
        raise HTTPException(503, "DATABASE_URL not configured")
    conn = await _get_conn()
    try:
        columns = await _fetch_columns(conn, table)
        if not columns:
            raise HTTPException(404, "Table not found")
        col_names = [c["name"] for c in columns]
        pk = await _get_pk_name(columns)
        sort_col = sort if sort in col_names else None
        if not sort_col:
            if "updated_at" in col_names:
                sort_col = "updated_at"
            elif "created_at" in col_names:
                sort_col = "created_at"
            else:
                sort_col = pk
        ol = order.lower()
        if ol not in ("asc", "desc"):
            raise HTTPException(400, "order must be asc or desc")
        order_sql = "ASC" if ol == "asc" else "DESC"
        q_ident = _quote_ident
        t_ref = q_ident(table)
        order_expr = f"{q_ident(sort_col)} {order_sql} NULLS LAST"
        offset = (page - 1) * limit
        params: list[Any] = []
        where_sql = ""
        if search.strip():
            s = f"%{search.strip()}%"
            search_cols = _searchable_columns(columns)
            if search_cols:
                parts = [f"CAST({q_ident(c)} AS TEXT) ILIKE $1" for c in search_cols]
                params.append(s)
                where_sql = "WHERE (" + " OR ".join(parts) + ")"
        count_sql = f"SELECT COUNT(*) FROM {t_ref} {where_sql}"
        total = await conn.fetchval(count_sql, *params)
        ni = len(params)
        list_sql = (
            f"SELECT * FROM {t_ref} {where_sql} ORDER BY {order_expr} "
            f"LIMIT ${ni + 1} OFFSET ${ni + 2}"
        )
        params.extend([limit, offset])
        recs = await conn.fetch(list_sql, *params)
        rows = [_serialize_row(dict(r)) for r in recs]
        return {
            "rows": rows,
            "total": total,
            "page": page,
            "limit": limit,
            "sort": sort_col,
            "order": order.lower(),
        }
    finally:
        await conn.close()


@router.get("/browse/{table}/{row_id}")
async def browse_get(table: str, row_id: str, _=Depends(verify_super_admin)):
    table = _assert_allowed_table(table)
    if not DATABASE_URL:
        raise HTTPException(503, "DATABASE_URL not configured")
    conn = await _get_conn()
    try:
        columns = await _fetch_columns(conn, table)
        if not columns:
            raise HTTPException(404, "Table not found")
        pk = await _get_pk_name(columns)
        pk_meta = next(c for c in columns if c["name"] == pk)
        typed = _parse_value_for_column(pk_meta, row_id)
        q = f"SELECT * FROM {_quote_ident(table)} WHERE {_quote_ident(pk)} = $1"
        rec = await conn.fetchrow(q, typed)
        if not rec:
            raise HTTPException(404, "Row not found")
        return _serialize_row(dict(rec))
    finally:
        await conn.close()


@router.post("/browse/{table}")
async def browse_create(
    table: str,
    body: dict = Body(default_factory=dict),
    _=Depends(verify_super_admin),
):
    table = _assert_allowed_table(table)
    if not DATABASE_URL:
        raise HTTPException(503, "DATABASE_URL not configured")
    conn = await _get_conn()
    try:
        columns = await _fetch_columns(conn, table)
        if not columns:
            raise HTTPException(404, "Table not found")
        coerced = await _coerce_body_for_write(conn, table, body, partial=False)
        pk = await _get_pk_name(columns)
        pk_meta = next(c for c in columns if c["name"] == pk)
        if pk not in coerced or coerced.get(pk) is None:
            if pk_meta["data_type"] == "uuid":
                coerced[pk] = uuid.uuid4()
            elif table == "sessions" and pk == "id":
                raise HTTPException(400, "sessions.id is required for insert")
        cols = list(coerced.keys())
        placeholders = [f"${i + 1}" for i in range(len(cols))]
        sql = (
            f"INSERT INTO {_quote_ident(table)} ({', '.join(_quote_ident(c) for c in cols)}) "
            f"VALUES ({', '.join(placeholders)}) RETURNING *"
        )
        rec = await conn.fetchrow(sql, *[coerced[c] for c in cols])
        return _serialize_row(dict(rec))
    finally:
        await conn.close()


@router.put("/browse/{table}/{row_id}")
async def browse_update(
    table: str,
    row_id: str,
    body: dict = Body(default_factory=dict),
    _=Depends(verify_super_admin),
):
    table = _assert_allowed_table(table)
    if not DATABASE_URL:
        raise HTTPException(503, "DATABASE_URL not configured")
    conn = await _get_conn()
    try:
        columns = await _fetch_columns(conn, table)
        if not columns:
            raise HTTPException(404, "Table not found")
        pk = await _get_pk_name(columns)
        pk_meta = next(c for c in columns if c["name"] == pk)
        pk_val = _parse_value_for_column(pk_meta, row_id)
        coerced = await _coerce_body_for_write(conn, table, body, partial=True)
        for k in list(coerced.keys()):
            if k == pk:
                coerced.pop(k, None)
        if not coerced:
            raise HTTPException(400, "No columns to update")
        sets = [f"{_quote_ident(k)} = ${i + 1}" for i, k in enumerate(coerced.keys())]
        vals = list(coerced.values())
        sql = (
            f"UPDATE {_quote_ident(table)} SET {', '.join(sets)} "
            f"WHERE {_quote_ident(pk)} = ${len(vals) + 1} RETURNING *"
        )
        rec = await conn.fetchrow(sql, *vals, pk_val)
        if not rec:
            raise HTTPException(404, "Row not found")
        return _serialize_row(dict(rec))
    finally:
        await conn.close()


class BulkDeleteRequest(BaseModel):
    """Delete up to 500 rows by primary key (same table as browse)."""

    ids: list[str]
    confirm: str = ""

    model_config = {"extra": "forbid"}


@router.post("/browse/{table}/bulk-delete")
async def browse_bulk_delete(
    table: str,
    body: BulkDeleteRequest,
    _=Depends(verify_super_admin),
):
    """Delete many rows by PK. For `trainers`, clears sessions.trainer_id first."""
    table = _assert_allowed_table(table)
    if body.confirm != "yes":
        raise HTTPException(400, "Set confirm to 'yes'")
    if not body.ids:
        raise HTTPException(400, "ids must be non-empty")
    if len(body.ids) > 500:
        raise HTTPException(400, "At most 500 ids per request")
    if not DATABASE_URL:
        raise HTTPException(503, "DATABASE_URL not configured")

    conn = await _get_conn()
    try:
        columns = await _fetch_columns(conn, table)
        if not columns:
            raise HTTPException(404, "Table not found")
        pk = await _get_pk_name(columns)
        pk_meta = next(c for c in columns if c["name"] == pk)
        t_ref = _quote_ident(table)
        pk_ref = _quote_ident(pk)
        dt = pk_meta["data_type"]
        is_uuid = dt == "uuid" or "uuid" in str(dt).lower()

        if is_uuid:
            try:
                parsed = [uuid.UUID(str(x)) for x in body.ids]
            except (ValueError, AttributeError) as e:
                raise HTTPException(400, f"Invalid UUID in ids: {e}") from e
            if table == "trainers":
                await conn.execute(
                    f'UPDATE sessions SET trainer_id = NULL, updated_at = NOW() '
                    f"WHERE trainer_id = ANY($1::uuid[])",
                    parsed,
                )
            res = await conn.execute(
                f"DELETE FROM {t_ref} WHERE {pk_ref} = ANY($1::uuid[])",
                parsed,
            )
        else:
            res = await conn.execute(
                f"DELETE FROM {t_ref} WHERE {pk_ref} = ANY($1::text[])",
                body.ids,
            )
        # asyncpg returns e.g. "DELETE 3"
        deleted = 0
        if res and res.startswith("DELETE "):
            try:
                deleted = int(res.split()[-1])
            except (ValueError, IndexError):
                deleted = 0
        return {"deleted": deleted, "table": table}
    except asyncpg.exceptions.ForeignKeyViolationError as e:
        raise HTTPException(409, f"Cannot delete: rows still referenced ({e})") from e
    finally:
        await conn.close()


@router.post("/sync-trainers-from-sessions")
async def sync_trainers_from_sessions(_=Depends(verify_super_admin)):
    """
    Upsert `trainers` from distinct emails in `sessions.metadata`, then link sessions.trainer_id.
    Normal runtime never populated `trainers` (only migrations did); this backfills from PG sessions.
    """
    if not DATABASE_URL:
        raise HTTPException(503, "DATABASE_URL not configured")

    conn = await _get_conn()
    try:
        await _ensure_tables(conn)
        before = await conn.fetchval("SELECT COUNT(*) FROM trainers")
        await conn.execute(
            """
            INSERT INTO trainers (email, display_name, team, role)
            SELECT email, NULLIF(dname, ''), NULL, 'trainer'
            FROM (
                SELECT DISTINCT ON (lower(trim(BOTH FROM metadata->>'trainer_email')))
                    lower(trim(BOTH FROM metadata->>'trainer_email')) AS email,
                    COALESCE(
                        NULLIF(trim(BOTH FROM metadata->>'trainer_name'), ''),
                        split_part(
                            lower(trim(BOTH FROM metadata->>'trainer_email')),
                            '@',
                            1
                        )
                    ) AS dname
                FROM sessions
                WHERE metadata->>'trainer_email' IS NOT NULL
                  AND position('@' IN trim(BOTH FROM metadata->>'trainer_email')) > 0
                ORDER BY lower(trim(BOTH FROM metadata->>'trainer_email')), updated_at DESC NULLS LAST
            ) sub
            ON CONFLICT (email) DO UPDATE SET
                display_name = COALESCE(EXCLUDED.display_name, trainers.display_name),
                updated_at = NOW()
            """
        )
        linked = await conn.execute(
            """
            UPDATE sessions s
            SET trainer_id = t.id, updated_at = NOW()
            FROM trainers t
            WHERE lower(trim(BOTH FROM coalesce(s.metadata->>'trainer_email', ''))) = lower(t.email)
              AND s.trainer_id IS DISTINCT FROM t.id
            """
        )
        after = await conn.fetchval("SELECT COUNT(*) FROM trainers")
        linked_n = 0
        if linked and linked.startswith("UPDATE "):
            try:
                linked_n = int(linked.split()[-1])
            except (ValueError, IndexError):
                linked_n = 0
        return {
            "trainers_before": before,
            "trainers_after": after,
            "sessions_updated": linked_n,
        }
    finally:
        await conn.close()


@router.delete("/browse/{table}/{row_id}")
async def browse_delete(table: str, row_id: str, _=Depends(verify_super_admin)):
    table = _assert_allowed_table(table)
    if not DATABASE_URL:
        raise HTTPException(503, "DATABASE_URL not configured")
    conn = await _get_conn()
    try:
        columns = await _fetch_columns(conn, table)
        if not columns:
            raise HTTPException(404, "Table not found")
        pk = await _get_pk_name(columns)
        pk_meta = next(c for c in columns if c["name"] == pk)
        pk_val = _parse_value_for_column(pk_meta, row_id)
        res = await conn.execute(
            f"DELETE FROM {_quote_ident(table)} WHERE {_quote_ident(pk)} = $1",
            pk_val,
        )
        if res == "DELETE 0":
            raise HTTPException(404, "Row not found")
        return {"deleted": True, "table": table, "pk": pk, "row_id": row_id}
    finally:
        await conn.close()
