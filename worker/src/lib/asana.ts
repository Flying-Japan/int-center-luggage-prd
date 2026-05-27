/** Lightweight Asana API client for creating bug report tasks. */

import { captureOperationalError, captureOperationalMessage } from "./observability";

const ASANA_API = "https://app.asana.com/api/1.0";

export async function createBugTask(
  pat: string,
  projectGid: string,
  title: string,
  description: string,
  reporterName: string,
  priority: string
): Promise<string | null> {
  if (!pat || !projectGid) {
    console.warn("Asana not configured: ASANA_PAT or ASANA_BUG_PROJECT_GID missing");
    return null;
  }

  const payload = {
    data: {
      name: title,
      notes: description,
      projects: [projectGid],
      assignee: "1211465522953332",
    },
  };

  try {
    const resp = await fetch(`${ASANA_API}/tasks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      console.error(`Asana API error: ${resp.status} ${resp.statusText}`);
      captureOperationalMessage("Asana API error", {
        level: "warning",
        operation: "external.asana.create_bug_task",
        tags: { external_service: "asana", status: resp.status },
        context: { priority, reporterName },
        fingerprint: ["external.asana.create_bug_task", String(resp.status)],
      });
      return null;
    }

    const json = (await resp.json()) as { data: { gid: string } };
    const taskGid = json.data.gid;
    console.log(`Asana task created: ${taskGid}`);
    return taskGid;
  } catch (err) {
    console.error("Failed to create Asana task", err);
    captureOperationalError(err, {
      level: "warning",
      operation: "external.asana.create_bug_task",
      tags: { external_service: "asana" },
      context: { priority, reporterName },
      fingerprint: ["external.asana.create_bug_task"],
    });
    return null;
  }
}
