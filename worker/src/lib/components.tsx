import type { FC } from "hono/jsx";

export const StaffTopbar: FC<{ staff: { display_name: string | null; username: string | null; role: string }; active?: string }> = ({ staff, active }) => {
  const links = [
    { href: "/staff/dashboard", label: "짐보관 신청" },
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
  const allLinks = [
    ...links,
    ...(staff.role === "admin" || staff.role === "editor" ? editorLinks : []),
    ...(staff.role === "admin" ? adminOnlyLinks : []),
  ];
  return (
    <header class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="/staff/dashboard">
          <img class="brand-logo-horizontal" src="/static/logo-horizontal.png" alt="Flying Japan" height="28" />
        </a>
        <nav class="topbar-menu">
          {allLinks.map(l => <a class={`topbar-menu-link${l.href === active ? " is-active" : ""}`} href={l.href}>{l.label}</a>)}
        </nav>
        <nav class="pill-nav">
          <span class="pill-user">{staff.display_name || staff.username}</span>
          <form method="post" action="/staff/logout" style="display:inline">
            <button type="submit" class="pill-link pill-link-btn">로그아웃</button>
          </form>
        </nav>
      </div>
    </header>
  );
};

export const NewOrderAlert: FC = () => (
  <div>
    <div id="new-order-badge" style="display:none;position:fixed;top:8px;right:16px;background:#dc2626;color:#fff;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700;z-index:9999;cursor:pointer"></div>
    <script dangerouslySetInnerHTML={{__html: "(function(){var lc=new Date().toISOString();var ac=null;try{var AC=window.AudioContext||window.webkitAudioContext;if(AC)ac=new AC()}catch(e){}function beep(){if(!ac)return;try{if(ac.state==='suspended')ac.resume();var o=ac.createOscillator(),g=ac.createGain();o.connect(g);g.connect(ac.destination);o.frequency.value=880;g.gain.value=0.3;o.start();g.gain.exponentialRampToValueAtTime(0.01,ac.currentTime+0.5);o.stop(ac.currentTime+0.5)}catch(e){}}setInterval(function(){fetch('/staff/api/orders/new?since='+encodeURIComponent(lc)).then(function(r){return r.json()}).then(function(d){if(d.count>0){beep();lc=new Date().toISOString();if(location.pathname==='/staff/dashboard'){location.reload()}else{var b=document.getElementById('new-order-badge');if(b){b.style.display='block';b.textContent='\\uc0c8 \\uc811\\uc218 '+d.count+'\\uac74';b.onclick=function(){location.href='/staff/dashboard'}}if(document.title.indexOf('\\ud83d\\udd14')===-1)document.title='\\ud83d\\udd14 '+document.title}}}).catch(function(){})},3000)})()"}} />
  </div>
);

export const StaffMenu: FC<{ active: string; role: string }> = ({ active, role }) => {
  const links = [
    { href: "/staff/dashboard", label: "짐보관 신청" },
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
