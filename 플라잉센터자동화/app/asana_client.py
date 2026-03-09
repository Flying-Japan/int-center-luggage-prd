"""Lightweight Asana API client for creating bug report tasks."""

import logging
from app.config import ASANA_PAT, ASANA_BUG_PROJECT_GID

logger = logging.getLogger(__name__)

ASANA_API = "https://app.asana.com/api/1.0"


async def create_bug_task(
    title: str,
    description: str,
    reporter_name: str,
    priority: str = "medium",
) -> str | None:
    """Create a task in the configured Asana project.

    Returns the task GID on success, None on failure.
    """
    if not ASANA_PAT or not ASANA_BUG_PROJECT_GID:
        logger.warning("Asana not configured: ASANA_PAT or ASANA_BUG_PROJECT_GID missing")
        return None

    import httpx

    body = f"**Reporter:** {reporter_name}\n**Priority:** {priority}\n\n{description}"
    payload = {
        "data": {
            "name": f"[Bug] {title}",
            "notes": body,
            "projects": [ASANA_BUG_PROJECT_GID],
        }
    }

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{ASANA_API}/tasks",
                json=payload,
                headers={
                    "Authorization": f"Bearer {ASANA_PAT}",
                    "Accept": "application/json",
                },
            )
            resp.raise_for_status()
            task_gid = resp.json()["data"]["gid"]
            logger.info("Asana task created: %s", task_gid)
            return task_gid
    except Exception:
        logger.exception("Failed to create Asana task")
        return None
