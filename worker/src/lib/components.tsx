import type { FC } from "hono/jsx";

export const StaffMenu: FC<{ active: string; role: string }> = ({ active, role }) => {
  const links = [
    { href: "/staff/dashboard", label: "대시보드" },
    { href: "/staff/cash-closing", label: "정산마감" },
    { href: "/staff/handover", label: "인수인계" },
    { href: "/staff/lost-found", label: "분실물" },
    { href: "/staff/schedule", label: "스케줄" },
    { href: "/staff/bug-report", label: "버그신고" },
  ];
  const adminLinks = [
    { href: "/staff/admin/sales", label: "매출관리" },
    { href: "/staff/admin/staff-accounts", label: "계정관리" },
    { href: "/staff/admin/activity-logs", label: "활동로그" },
    { href: "/staff/admin/completion-message", label: "완료메시지" },
  ];
  return (
    <nav class="staff-menu" aria-label="직원 메뉴">
      {links.map(l => <a class={`staff-menu-link${l.href === active ? " is-active" : ""}`} href={l.href}>{l.label}</a>)}
      {role === "admin" && adminLinks.map(l => <a class={`staff-menu-link${l.href === active ? " is-active" : ""}`} href={l.href}>{l.label}</a>)}
    </nav>
  );
};
