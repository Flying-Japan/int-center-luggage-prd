import type { FC } from "hono/jsx";

export const StaffTopbar: FC<{ staff: { display_name: string | null; username: string | null; role: string } }> = ({ staff }) => (
  <header class="topbar">
    <div class="topbar-inner">
      <a class="brand" href="/staff/dashboard">
        <img class="brand-logo-horizontal" src="/static/logo-horizontal.png" alt="Flying Japan" height="32" />
      </a>
      <nav class="pill-nav">
        <a class="pill-link" href="/staff/dashboard">대시보드</a>
        {(staff.role === "admin" || staff.role === "editor") && <a class="pill-link" href="/staff/admin/sales">매출관리</a>}
        <span class="pill-user">{staff.display_name || staff.username}</span>
        <form method="post" action="/staff/logout" style="display:inline">
          <button type="submit" class="pill-link pill-link-btn">로그아웃</button>
        </form>
      </nav>
    </div>
  </header>
);

export const StaffMenu: FC<{ active: string; role: string }> = ({ active, role }) => {
  const links = [
    { href: "/staff/dashboard", label: "대시보드" },
    { href: "/staff/cash-closing", label: "정산마감" },
    { href: "/staff/handover", label: "인수인계" },
    { href: "/staff/lost-found", label: "분실물" },
    { href: "/staff/schedule", label: "스케줄" },
    { href: "/staff/bug-report", label: "버그신고" },
  ];
  const editorLinks = [
    { href: "/staff/admin/sales", label: "매출관리" },
    { href: "/staff/admin/completion-message", label: "완료메시지" },
  ];
  const adminOnlyLinks = [
    { href: "/staff/admin/staff-accounts", label: "계정관리" },
    { href: "/staff/admin/customers", label: "고객목록" },
    { href: "/staff/admin/activity-logs", label: "활동로그" },
  ];
  return (
    <nav class="staff-menu" aria-label="직원 메뉴">
      {links.map(l => <a class={`staff-menu-link${l.href === active ? " is-active" : ""}`} href={l.href}>{l.label}</a>)}
      {(role === "admin" || role === "editor") && editorLinks.map(l => <a class={`staff-menu-link${l.href === active ? " is-active" : ""}`} href={l.href}>{l.label}</a>)}
      {role === "admin" && adminOnlyLinks.map(l => <a class={`staff-menu-link${l.href === active ? " is-active" : ""}`} href={l.href}>{l.label}</a>)}
    </nav>
  );
};
