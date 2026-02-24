"""
Supabase client adapter for the Flying Japan luggage app.
Provides the same interface as the old D1Client so route handlers need minimal changes.
All luggage tables are accessed with 'luggage_' prefix.
Staff auth uses center-dashboard's user_profiles table (no prefix).
"""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Any, Optional
import supabase as _supabase


# Tables that don't get the luggage_ prefix (shared with center-dashboard)
_NO_PREFIX: frozenset[str] = frozenset({"user_profiles", "login_logs", "activity_logs"})

# Table primary key mapping
_PK_MAP: dict[str, str] = {
    "luggage_orders": "order_id",
    "luggage_audit_logs": "log_id",
    "luggage_daily_counters": "business_date",
    "luggage_daily_tag_counters": "business_date",
    "luggage_lost_found_entries": "entry_id",
    "luggage_handover_notes": "note_id",
    "luggage_handover_reads": "read_id",
    "luggage_handover_comments": "comment_id",
    "luggage_cash_closings": "closing_id",
    "luggage_cash_closing_audits": "audit_id",
    "luggage_rental_daily_sales": "rental_id",
    "luggage_app_settings": "setting_id",
    "luggage_work_schedules": "schedule_id",
    "user_profiles": "id",
}

# Tables that have updated_at auto-set on update
_AUTO_UPDATED: frozenset[str] = frozenset({
    "luggage_orders",
    "luggage_handover_comments",
    "luggage_cash_closings",
    "luggage_rental_daily_sales",
    "luggage_app_settings",
    "user_profiles",
})


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _serialize(data: dict) -> dict:
    """Convert datetime values to ISO 8601 strings for Supabase JSON serialization."""
    out = {}
    for k, v in data.items():
        if isinstance(v, datetime):
            out[k] = v.isoformat()
        else:
            out[k] = v
    return out


def _full_table(name: str) -> str:
    """Return the actual Supabase table name (with luggage_ prefix if needed)."""
    if name in _NO_PREFIX:
        return name
    return f"luggage_{name}"


def _pk_for(full_table: str) -> str:
    return _PK_MAP.get(full_table, "id")


class Row:
    """Dict-like object with attribute access and dirty-field tracking for updates."""
    __slots__ = ("_table", "_full_table", "_pk_col", "_data", "_dirty")

    def __init__(self, table: str, full_table: str, pk_col: str, data: dict) -> None:
        object.__setattr__(self, "_table", table)
        object.__setattr__(self, "_full_table", full_table)
        object.__setattr__(self, "_pk_col", pk_col)
        object.__setattr__(self, "_data", dict(data))
        object.__setattr__(self, "_dirty", set())

    def __getattr__(self, name: str) -> Any:
        data = object.__getattribute__(self, "_data")
        table = object.__getattribute__(self, "_table")
        if name in data:
            return data[name]
        # Compatibility shims for user_profiles (replaces old staff table)
        if table == "user_profiles":
            if name == "staff_id":
                return data.get("id")
            if name == "is_admin":
                return data.get("role") == "admin"
            if name == "name":
                return data.get("username") or data.get("display_name", "")
            if name == "is_active":
                return data.get("is_active", True)
        raise AttributeError(f"Row '{table}' has no column '{name}'")

    def __setattr__(self, name: str, value: Any) -> None:
        data = object.__getattribute__(self, "_data")
        dirty = object.__getattribute__(self, "_dirty")
        data[name] = value
        dirty.add(name)

    def __repr__(self) -> str:
        return f"Row({object.__getattribute__(self, '_table')}, {object.__getattribute__(self, '_data')})"


class SupabaseQuery:
    """Chainable query builder that wraps supabase-py PostgREST API."""

    def __init__(self, db: "SupabaseDB", table: str) -> None:
        self._db = db
        self._table = table
        self._full_table = _full_table(table)
        self._pk_col = _pk_for(self._full_table)
        self._conditions: list = []  # list of (col, op, val) OR [list of (col,op,val)] for OR groups
        self._order_cols: list[str] = []
        self._limit_val: Optional[int] = None

    def filter(self, *conditions: tuple) -> "SupabaseQuery":
        """AND conditions: filter(("col", "=", val), ("col2", "IN", [1,2]))"""
        self._conditions.extend(conditions)
        return self

    def filter_or(self, conditions: list[tuple]) -> "SupabaseQuery":
        """OR group: filter_or([("col", "LIKE", val), ("col2", "LIKE", val)])"""
        self._conditions.append(conditions)  # list = OR group
        return self

    def order_by(self, *cols: str) -> "SupabaseQuery":
        """order_by("created_at DESC", "name ASC")"""
        self._order_cols.extend(cols)
        return self

    def limit(self, n: int) -> "SupabaseQuery":
        self._limit_val = n
        return self

    def _apply(self, q):
        """Apply conditions/order/limit to a supabase-py query object."""
        for cond in self._conditions:
            if isinstance(cond, list):
                # OR group
                or_parts = []
                for col, op, *rest in cond:
                    val = rest[0] if rest else None
                    if op == "=":
                        or_parts.append(f"{col}.eq.{val}")
                    elif op == "!=":
                        or_parts.append(f"{col}.neq.{val}")
                    elif op == "LIKE":
                        or_parts.append(f"{col}.like.{val}")
                    elif op == "ILIKE":
                        or_parts.append(f"{col}.ilike.{val}")
                    elif op == "IN":
                        vals = ",".join(str(v) for v in val)
                        or_parts.append(f"{col}.in.({vals})")
                    elif op == "IS NULL":
                        or_parts.append(f"{col}.is.null")
                    elif op == "IS NOT NULL":
                        or_parts.append(f"{col}.not.is.null")
                if or_parts:
                    q = q.or_(",".join(or_parts))
            else:
                col, op, val = cond
                if op == "=":
                    q = q.eq(col, val)
                elif op == "!=":
                    q = q.neq(col, val)
                elif op == "IN":
                    q = q.in_(col, val)
                elif op == "LIKE":
                    q = q.like(col, val)
                elif op == "ILIKE":
                    q = q.ilike(col, val)
                elif op == ">":
                    q = q.gt(col, val)
                elif op == ">=":
                    q = q.gte(col, val)
                elif op == "<":
                    q = q.lt(col, val)
                elif op == "<=":
                    q = q.lte(col, val)

        for order_str in self._order_cols:
            parts = order_str.strip().split()
            col = parts[0]
            desc = len(parts) > 1 and parts[1].upper() == "DESC"
            q = q.order(col, desc=desc)

        if self._limit_val is not None:
            q = q.limit(self._limit_val)

        return q

    def all(self) -> list[Row]:
        q = self._db.client.table(self._full_table).select("*")
        q = self._apply(q)
        result = q.execute()
        return [Row(self._table, self._full_table, self._pk_col, row) for row in result.data]

    def first(self) -> Optional[Row]:
        q = self._db.client.table(self._full_table).select("*")
        q = self._apply(q)
        q = q.limit(1)
        result = q.execute()
        if not result.data:
            return None
        return Row(self._table, self._full_table, self._pk_col, result.data[0])

    def count(self) -> int:
        q = self._db.client.table(self._full_table).select("*", count="exact").limit(0)
        q = self._apply(q)
        result = q.execute()
        return result.count or 0

    def delete(self) -> None:
        q = self._db.client.table(self._full_table).delete()
        q = self._apply(q)
        q.execute()


class SupabaseDB:
    """
    Drop-in replacement for D1Client. Uses supabase-py with service role key.
    All luggage app tables get the 'luggage_' prefix automatically.
    user_profiles is accessed directly (shared with center-dashboard).
    """

    def __init__(self, url: str, service_role_key: str) -> None:
        self.client = _supabase.create_client(url, service_role_key)

    def get(self, table: str, pk_col: str, pk_val: Any) -> Optional[Row]:
        full = _full_table(table)
        result = self.client.table(full).select("*").eq(pk_col, pk_val).limit(1).execute()
        if not result.data:
            return None
        return Row(table, full, pk_col, result.data[0])

    def query(self, table: str) -> SupabaseQuery:
        return SupabaseQuery(self, table)

    def insert(self, table: str, data: dict) -> Row:
        full = _full_table(table)
        pk_col = _pk_for(full)
        # Remove None pk values so DB generates them; serialize datetime → ISO string
        cleaned = _serialize({k: v for k, v in data.items() if not (k == pk_col and v is None)})
        result = self.client.table(full).insert(cleaned).execute()
        return Row(table, full, pk_col, result.data[0])

    def update(self, row: Row) -> None:
        dirty = object.__getattribute__(row, "_dirty")
        if not dirty:
            return
        table = object.__getattribute__(row, "_table")
        full = object.__getattribute__(row, "_full_table")
        pk_col = object.__getattribute__(row, "_pk_col")
        data = object.__getattribute__(row, "_data")
        pk_val = data[pk_col]

        dirty_data: dict = _serialize({k: data[k] for k in dirty})
        if full in _AUTO_UPDATED:
            dirty_data.setdefault("updated_at", _utc_now())

        self.client.table(full).update(dirty_data).eq(pk_col, pk_val).execute()
        object.__setattr__(row, "_dirty", set())

    def delete_row(self, table: str, pk_col: str, pk_val: Any) -> None:
        full = _full_table(table)
        self.client.table(full).delete().eq(pk_col, pk_val).execute()

    def delete_where(self, table: str, conditions: list[tuple]) -> int:
        full = _full_table(table)
        q = self.client.table(full).delete()
        for col, op, val in conditions:
            if op == "=":
                q = q.eq(col, val)
            elif op == "IN":
                q = q.in_(col, val)
            elif op == "!=":
                q = q.neq(col, val)
        result = q.execute()
        return len(result.data) if result.data else 0

    def execute_sql(self, sql: str, params: list) -> list:
        """Execute raw SQL via Supabase RPC. Returns list of dicts."""
        # Use postgrest RPC for raw queries - wrap in a function call
        # For simple cases, use the table API instead
        # This is a fallback for complex queries
        raise NotImplementedError(
            "execute_sql not supported in SupabaseDB. Use query() instead."
        )

    def close(self) -> None:
        pass  # supabase-py manages its own HTTP client
