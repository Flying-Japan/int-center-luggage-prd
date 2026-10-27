import type { Env } from "./types";

// This artifact has no open mode or runtime override. Missing/unknown inputs stay closed.
const MODE = "M0";
const MESSAGE = "Maintenance in progress. Check the result of any earlier request before retrying.";
const HTML = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>서비스 점검 중</title><h1>짐보관 서비스 점검 중입니다</h1><p>이전 요청의 완료 여부를 확인한 뒤 다시 시도해 주세요.</p><p lang="ja">ただいまメンテナンス中です。前の操作の完了状況を確認してから再度お試しください。</p><p lang="en">${MESSAGE}</p></html>`;

const maintenance = {
  fetch(request: Request): Response {
    const path = new URL(request.url).pathname;
    const health = path === "/health" && (request.method === "GET" || request.method === "HEAD");
    const api = /^\/(?:api|internal)(?:\/|$)/.test(path) || /^\/staff\/api(?:\/|$)/.test(path);
    const html = !health && !api && /text\/html/i.test(request.headers.get("Accept") || "");
    const body = health
      ? JSON.stringify({ status: "maintenance", service: "luggage-storage", mode: MODE })
      : html ? HTML : JSON.stringify({ code: "MAINTENANCE", mode: MODE, error: MESSAGE, retryable: false });
    return new Response(request.method === "HEAD" ? null : body, {
      status: health ? 200 : 503,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": html ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        "X-Maintenance-Code": "MAINTENANCE",
      },
    });
  },
  scheduled(event: ScheduledController): void {
    // Skips new invocations only; this cannot cancel or drain older Worker executions.
    console.info("M0 scheduled skipped", { mode: MODE, cron: event.cron });
  },
} satisfies ExportedHandler<Env>;

export default maintenance;
