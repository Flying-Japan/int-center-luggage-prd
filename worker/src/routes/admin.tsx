/**
 * Admin routes — Sales analytics, staff accounts, settings, activity logs.
 * US-012: All admin-only routes.
 */
import { Hono } from "hono";
import type { AppType } from "../types";
import { adminAuth, editorAuth, getStaff } from "../middleware/auth";
import { createSupabaseAdmin } from "../lib/supabase";
import { StaffMenu, StaffTopbar } from "../lib/components";
import { loadCompletionMessages, buildCompletionMessagesFromKo } from "../services/completionMessages";

const admin = new Hono<AppType>();
admin.use("/staff/admin/sales/*", editorAuth);
admin.use("/staff/admin/sales", editorAuth);
admin.use("/staff/admin/completion-message*", editorAuth);
admin.use("/staff/admin/staff-accounts*", adminAuth);
admin.use("/staff/admin/activity-logs*", adminAuth);
admin.use("/staff/admin/retention*", adminAuth);
admin.use("/staff/admin/extensions*", adminAuth);

// GET /staff/admin/sales — Sales analytics
admin.get("/staff/admin/sales", async (c) => {
  const startDate = c.req.query("start_date") || "";
  const endDate = c.req.query("end_date") || "";

  // Query from luggage_daily_sales (imported from Google Sheets)
  let whereClause = "";
  const params: string[] = [];
  if (startDate && endDate) {
    whereClause = " WHERE sale_date BETWEEN ? AND ?";
    params.push(startDate, endDate);
  }

  const dailyRows = await c.env.DB.prepare(
    `SELECT sale_date, people, cash, qr, luggage_total, rental_total FROM luggage_daily_sales${whereClause} ORDER BY sale_date DESC`
  ).bind(...params).all<{ sale_date: string; people: number; cash: number; qr: number; luggage_total: number; rental_total: number }>();

  const DOW_JP = ["日", "月", "火", "水", "木", "金", "土"];

  // Japanese public holidays 2026
  const JP_HOLIDAYS: Record<string, string> = {
    "01-01": "元日", "01-13": "成人の日", "02-11": "建国記念の日", "02-23": "天皇誕生日",
    "03-20": "春分の日", "04-29": "昭和の日", "05-03": "憲法記念日", "05-04": "みどりの日",
    "05-05": "こどもの日", "05-06": "振替休日", "07-20": "海の日", "08-11": "山の日",
    "09-21": "敬老の日", "09-23": "秋分の日", "10-12": "体育の日", "11-03": "文化の日",
    "11-23": "勤労感謝の日",
  };

  // Korean public holidays 2025-2026 (MM-DD, with year-specific ones keyed as YYYY-MM-DD)
  const KR_HOLIDAYS: Record<string, string> = {
    "01-01": "신정", "03-01": "삼일절", "05-05": "어린이날", "06-06": "현충일",
    "08-15": "광복절", "10-03": "개천절", "10-09": "한글날", "12-25": "성탄절",
    // 2025 lunar holidays
    "2025-01-28": "설날", "2025-01-29": "설날", "2025-01-30": "설날",
    "2025-05-06": "석가탄신일",
    "2025-10-06": "추석", "2025-10-07": "추석", "2025-10-08": "추석",
    // 2026 lunar holidays
    "2026-02-16": "설날", "2026-02-17": "설날", "2026-02-18": "설날",
    "2026-05-24": "석가탄신일",
    "2026-09-24": "추석", "2026-09-25": "추석", "2026-09-26": "추석",
  };

  function getHolidayFlags(dateStr: string): { isWeekend: boolean; jp: string | null; kr: string | null } {
    const d = new Date(dateStr + "T00:00:00+09:00");
    const dayOfWeek = d.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const mmdd = dateStr.slice(5); // MM-DD
    const jp = JP_HOLIDAYS[mmdd] || null;
    const kr = KR_HOLIDAYS[dateStr] || KR_HOLIDAYS[mmdd] || null;
    return { isWeekend, jp, kr };
  }

  interface MergedRow { date: string; dateJP: string; orders: number; cash: number; qr: number; luggage: number; rental: number; combined: number; isWeekend: boolean; jpHoliday: string | null; krHoliday: string | null; }
  const mergedRows: MergedRow[] = dailyRows.results.map(r => {
    const dow = DOW_JP[new Date(r.sale_date + "T00:00:00+09:00").getDay()];
    const flags = getHolidayFlags(r.sale_date);
    return {
      date: r.sale_date,
      dateJP: `${r.sale_date.replace(/-/g, "/")}/${dow}`,
      orders: r.people,
      cash: r.cash,
      qr: r.qr,
      luggage: r.luggage_total,
      rental: r.rental_total,
      combined: r.luggage_total + r.rental_total,
      isWeekend: flags.isWeekend,
      jpHoliday: flags.jp,
      krHoliday: flags.kr,
    };
  });

  const dayCount = mergedRows.length || 1;
  const totalLuggage = mergedRows.reduce((s, r) => s + r.luggage, 0);
  const totalRental = mergedRows.reduce((s, r) => s + r.rental, 0);
  const totalCombined = totalLuggage + totalRental;
  const totalPeople = mergedRows.reduce((s, r) => s + r.orders, 0);
  const totalCash = mergedRows.reduce((s, r) => s + r.cash, 0);
  const totalQr = mergedRows.reduce((s, r) => s + r.qr, 0);

  // Min / Max stats (only from days with data)
  const activeDays = mergedRows.filter(r => r.combined > 0);
  const minMax = activeDays.length > 0 ? {
    people: { min: Math.min(...activeDays.map(r => r.orders)), max: Math.max(...activeDays.map(r => r.orders)) },
    cash: { min: Math.min(...activeDays.map(r => r.cash)), max: Math.max(...activeDays.map(r => r.cash)) },
    qr: { min: Math.min(...activeDays.map(r => r.qr)), max: Math.max(...activeDays.map(r => r.qr)) },
    luggage: { min: Math.min(...activeDays.map(r => r.luggage)), max: Math.max(...activeDays.map(r => r.luggage)) },
    rental: { min: Math.min(...activeDays.map(r => r.rental)), max: Math.max(...activeDays.map(r => r.rental)) },
    combined: { min: Math.min(...activeDays.map(r => r.combined)), max: Math.max(...activeDays.map(r => r.combined)) },
  } : null;

  const staff = getStaff(c);
  const successMsg = c.req.query("success");
  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script><script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2/dist/chartjs-plugin-datalabels.min.js"></script><title>매출 분석</title></head>
      <body class="staff-site">
        <StaffTopbar staff={staff} />
        <main class="container">
          <StaffMenu active="/staff/admin/sales" role={staff.role} />
        {successMsg && <p class="success-note">{successMsg}</p>}
        <section class="hero"><div><p class="hero-kicker">Admin</p><h2 class="hero-title">매출 분석</h2></div></section>
        {(() => {
          const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
          const today = now.toISOString().slice(0, 10);
          const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
          const presets = [
            { label: "전체", sd: "", ed: "" },
            { label: "이번 달", sd: monthStart, ed: today },
            { label: "최근 7일", sd: new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10), ed: today },
            { label: "최근 14일", sd: new Date(now.getTime() - 14 * 86400000).toISOString().slice(0, 10), ed: today },
            { label: "최근 30일", sd: new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10), ed: today },
          ];
          const activePreset = presets.find(p => p.sd === startDate && p.ed === endDate);
          const isCustom = (startDate || endDate) && !activePreset;
          const displayLabel = activePreset ? activePreset.label : isCustom ? `${startDate} ~ ${endDate}` : "전체";
          return (
            <div class="date-range-wrap" style="position:relative;margin:0 0 12px">
              <button type="button" class="btn btn-sm btn-secondary date-range-trigger" id="dateRangeTrigger" style="display:inline-flex;align-items:center;gap:6px">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
                <span id="dateRangeLabel">{displayLabel}</span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9" /></svg>
              </button>
              <div id="dateRangeDropdown" style="display:none;position:absolute;top:100%;left:0;z-index:50;margin-top:4px;background:#fff;border:1px solid #e5e5e5;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.1);padding:8px 0;min-width:260px">
                <div style="padding:4px 8px">
                  {presets.map(p => {
                    const active = p.sd === startDate && p.ed === endDate;
                    return <a href={p.sd ? `/staff/admin/sales?start_date=${p.sd}&end_date=${p.ed}` : "/staff/admin/sales"} style={`display:block;padding:7px 12px;font-size:12px;border-radius:4px;text-decoration:none;color:${active ? "#2383e2" : "#37352f"};font-weight:${active ? "600" : "400"};background:${active ? "#e8f0fe" : "transparent"}`}>{p.label}</a>;
                  })}
                </div>
                <div style="height:1px;background:#f0f0ee;margin:6px 0" />
                <div style="padding:8px 12px">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                    <button type="button" id="calPrev" style="background:none;border:none;cursor:pointer;padding:2px 6px;font-size:14px;color:#787774">&#x2039;</button>
                    <span id="calTitle" style="font-size:12px;font-weight:600;color:#37352f"></span>
                    <button type="button" id="calNext" style="background:none;border:none;cursor:pointer;padding:2px 6px;font-size:14px;color:#787774">&#x203A;</button>
                  </div>
                  <div id="calGrid" style="display:grid;grid-template-columns:repeat(7,1fr);gap:1px;text-align:center;font-size:11px"></div>
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
                    <span id="calRange" style="font-size:11px;color:#a5a5a3"></span>
                    <button type="button" id="calApply" class="btn btn-sm btn-primary" style="padding:4px 10px;min-height:28px;font-size:11px;display:none">적용</button>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        {(() => {
          const cashPct = totalCombined > 0 ? Math.round(totalCash / (totalCash + totalQr) * 100) : 0;
          const qrPct = 100 - cashPct;
          return (
        <div class="stat-grid">
          <div class="card stat-card">
            <p class="stat-label">짐보관 매출 · 手荷物預かり</p>
            <p class="stat-value">¥{totalLuggage.toLocaleString()}</p>
          </div>
          <div class="card stat-card">
            <p class="stat-label">렌탈 매출 · レンタル</p>
            <p class="stat-value">¥{totalRental.toLocaleString()}</p>
          </div>
          <div class="card stat-card stat-card--highlight">
            <p class="stat-label stat-label--highlight">합계 · 合計</p>
            <p class="stat-value stat-value--highlight">¥{totalCombined.toLocaleString()}</p>
          </div>
          <div class="card stat-card">
            <p class="stat-label">총고객수 · 来客数</p>
            <p class="stat-value">{totalPeople.toLocaleString()}명</p>
          </div>
          <div class="card stat-card">
            <p class="stat-label">일평균 · 日平均</p>
            <p class="stat-value">¥{Math.round(totalCombined / dayCount).toLocaleString()}</p>
          </div>
          <div class="card stat-card">
            <p class="stat-label">현금 · QR</p>
            <p class="stat-value stat-value--sm">¥{totalCash.toLocaleString()} <span class="sales-td--muted">({cashPct}%)</span> / ¥{totalQr.toLocaleString()} <span class="sales-td--muted">({qrPct}%)</span></p>
          </div>
        </div>
          );
        })()}

        <section class="card" style="padding:16px">
          <h3 class="card-title">일별 매출 추이</h3>
          <div style="position:relative;height:320px"><canvas id="trendChart"></canvas></div>
        </section>

        <section class="card" style="padding:16px">
          <h3 class="card-title">일별 방문자 수</h3>
          <div style="position:relative;height:200px"><canvas id="peopleChart"></canvas></div>
        </section>

        <section class="card">
        <h3 class="card-title">일별 매출 상세</h3>
        <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="border-bottom:2px solid var(--line)">
            <th class="sales-th">Date</th>
            <th class="sales-th sales-th--right">People</th>
            <th class="sales-th sales-th--right">Cash</th>
            <th class="sales-th sales-th--right">Pay</th>
            <th class="sales-th sales-th--right sales-td--luggage">Luggage</th>
            <th class="sales-th sales-th--right sales-td--rental">Rental</th>
            <th class="sales-th sales-th--right sales-td--bold">Luggage + Rental Daily</th>
          </tr></thead>
          <tbody>
          {mergedRows.length === 0 && (
            <tr><td colspan={7} style="padding:24px;text-align:center;color:#a5a5a3">데이터가 없습니다</td></tr>
          )}
          {mergedRows.map((r) => {
            const lPct = r.combined > 0 ? Math.round(r.luggage / r.combined * 100) : 0;
            const rPct = r.combined > 0 ? 100 - lPct : 0;
            const isHoliday = r.isWeekend || r.jpHoliday || r.krHoliday;
            const rowBg = isHoliday ? "background:#fef9ee" : "";
            return (
              <tr style={`border-bottom:1px solid var(--line);${rowBg}`}>
                <td class="sales-td" style={`white-space:nowrap;${r.jpHoliday || r.krHoliday ? "color:#dc2626;font-weight:600" : r.isWeekend ? "color:#2383e2;font-weight:600" : ""}`}>{r.dateJP}{r.isWeekend && !r.jpHoliday && !r.krHoliday ? " 🔵" : ""}{r.jpHoliday ? ` 🇯🇵` : ""}{r.krHoliday ? ` 🇰🇷` : ""}</td>
                <td class="sales-td sales-td--right">{r.orders || "-"}</td>
                <td class="sales-td sales-td--right">{r.cash ? `¥${r.cash.toLocaleString()}` : "-"}</td>
                <td class="sales-td sales-td--right">{r.qr ? `¥${r.qr.toLocaleString()}` : "-"}</td>
                <td class="sales-td sales-td--right sales-td--luggage">{r.luggage ? <>{`¥${r.luggage.toLocaleString()}`} <span class="sales-td--muted">({lPct}%)</span></> : "-"}</td>
                <td class="sales-td sales-td--right sales-td--rental">{r.rental ? <>{`¥${r.rental.toLocaleString()}`} <span class="sales-td--muted">({rPct}%)</span></> : "-"}</td>
                <td class="sales-td sales-td--right sales-td--bold">¥{r.combined.toLocaleString()}</td>
              </tr>
            );
          })}
          {mergedRows.length > 0 && (<>
            <tr class="sales-total-row">
              <td class="sales-td">Total</td>
              <td class="sales-td sales-td--right">{totalPeople.toLocaleString()}</td>
              <td class="sales-td sales-td--right">¥{totalCash.toLocaleString()}</td>
              <td class="sales-td sales-td--right">¥{totalQr.toLocaleString()}</td>
              <td class="sales-td sales-td--right sales-td--luggage">¥{totalLuggage.toLocaleString()} <span class="sales-td--muted">({totalCombined > 0 ? Math.round(totalLuggage / totalCombined * 100) : 0}%)</span></td>
              <td class="sales-td sales-td--right sales-td--rental">¥{totalRental.toLocaleString()} <span class="sales-td--muted">({totalCombined > 0 ? Math.round(totalRental / totalCombined * 100) : 0}%)</span></td>
              <td class="sales-td sales-td--right">¥{totalCombined.toLocaleString()}</td>
            </tr>
            <tr class="sales-avg-row">
              <td class="sales-td">Daily Avg</td>
              <td class="sales-td sales-td--right">{Math.round(totalPeople / dayCount)}</td>
              <td class="sales-td sales-td--right">¥{Math.round(totalCash / dayCount).toLocaleString()}</td>
              <td class="sales-td sales-td--right">¥{Math.round(totalQr / dayCount).toLocaleString()}</td>
              <td class="sales-td sales-td--right sales-td--luggage">¥{Math.round(totalLuggage / dayCount).toLocaleString()}</td>
              <td class="sales-td sales-td--right sales-td--rental">¥{Math.round(totalRental / dayCount).toLocaleString()}</td>
              <td class="sales-td sales-td--right">¥{Math.round(totalCombined / dayCount).toLocaleString()}</td>
            </tr>
            {minMax && (<>
            <tr class="sales-max-row">
              <td class="sales-td">Max</td>
              <td class="sales-td sales-td--right">{minMax.people.max}</td>
              <td class="sales-td sales-td--right">¥{minMax.cash.max.toLocaleString()}</td>
              <td class="sales-td sales-td--right">¥{minMax.qr.max.toLocaleString()}</td>
              <td class="sales-td sales-td--right">¥{minMax.luggage.max.toLocaleString()}</td>
              <td class="sales-td sales-td--right">¥{minMax.rental.max.toLocaleString()}</td>
              <td class="sales-td sales-td--right">¥{minMax.combined.max.toLocaleString()}</td>
            </tr>
            <tr class="sales-min-row">
              <td class="sales-td">Min</td>
              <td class="sales-td sales-td--right">{minMax.people.min}</td>
              <td class="sales-td sales-td--right">¥{minMax.cash.min.toLocaleString()}</td>
              <td class="sales-td sales-td--right">¥{minMax.qr.min.toLocaleString()}</td>
              <td class="sales-td sales-td--right">¥{minMax.luggage.min.toLocaleString()}</td>
              <td class="sales-td sales-td--right">¥{minMax.rental.min.toLocaleString()}</td>
              <td class="sales-td sales-td--right">¥{minMax.combined.min.toLocaleString()}</td>
            </tr>
            </>)}
          </>)}
          </tbody>
        </table>
        </div>
        </section>
        <script dangerouslySetInnerHTML={{__html: `(function(){
  var trigger=document.getElementById('dateRangeTrigger');
  var dropdown=document.getElementById('dateRangeDropdown');
  if(trigger&&dropdown){
    trigger.addEventListener('click',function(e){e.stopPropagation();dropdown.style.display=dropdown.style.display==='none'?'block':'none';});
    document.addEventListener('click',function(e){if(!dropdown.contains(e.target)&&e.target!==trigger&&!trigger.contains(e.target))dropdown.style.display='none';});
  }
  // Calendar range picker
  var DOW=['일','월','화','수','목','금','토'];
  var calGrid=document.getElementById('calGrid');
  var calTitle=document.getElementById('calTitle');
  var calRange=document.getElementById('calRange');
  var calApply=document.getElementById('calApply');
  var calY,calM,selStart=null,selEnd=null;
  var initDate=new Date(Date.now()+9*3600000);
  calY=initDate.getUTCFullYear();calM=initDate.getUTCMonth();

  function pad(n){return n<10?'0'+n:''+n;}
  function fmtD(y,m,d){return y+'-'+pad(m+1)+'-'+pad(d);}

  function renderCal(){
    calTitle.textContent=calY+'년 '+pad(calM+1)+'월';
    var html='';
    DOW.forEach(function(d){html+='<div style="color:#a5a5a3;font-weight:600;padding:4px 0;font-size:10px">'+d+'</div>';});
    var first=new Date(calY,calM,1).getDay();
    var days=new Date(calY,calM+1,0).getDate();
    var today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
    for(var i=0;i<first;i++)html+='<div></div>';
    for(var d=1;d<=days;d++){
      var ds=fmtD(calY,calM,d);
      var isToday=ds===today;
      var isSel=ds===selStart||ds===selEnd;
      var inRange=selStart&&selEnd&&ds>selStart&&ds<selEnd;
      var isEdge=isSel;
      var bg=isEdge?'#2383e2':inRange?'#e8f0fe':'transparent';
      var clr=isEdge?'#fff':isToday?'#2383e2':'#37352f';
      var brd=isToday&&!isEdge?'1px solid #2383e2':'1px solid transparent';
      html+='<div data-date="'+ds+'" class="cal-day" style="padding:5px 0;border-radius:4px;cursor:pointer;background:'+bg+';color:'+clr+';border:'+brd+';font-weight:'+(isEdge?'600':'400')+'">'+d+'</div>';
    }
    calGrid.innerHTML=html;
    if(selStart&&selEnd&&selStart!==selEnd){calRange.textContent=selStart+' ~ '+selEnd;calApply.style.display='inline-block';}
    else if(selStart&&selEnd&&selStart===selEnd){calRange.textContent=selStart+' (1일)';calApply.style.display='inline-block';}
    else if(selStart){calRange.textContent=selStart+' ~ 종료일 선택';calApply.style.display='none';}
    else{calRange.textContent='';calApply.style.display='none';}
  }

  if(calGrid){
    calGrid.addEventListener('click',function(e){
      e.stopPropagation();
      var el=e.target;
      var ds=el.getAttribute('data-date');
      if(!ds&&el.parentElement)ds=el.parentElement.getAttribute('data-date');
      if(!ds)return;
      if(!selStart||selEnd){
        selStart=ds;selEnd=null;
      }else{
        if(ds===selStart){selEnd=ds;}
        else if(ds<selStart){selEnd=selStart;selStart=ds;}
        else{selEnd=ds;}
      }
      renderCal();
    });
    document.getElementById('calPrev').addEventListener('click',function(e){e.preventDefault();e.stopPropagation();calM--;if(calM<0){calM=11;calY--;}renderCal();});
    document.getElementById('calNext').addEventListener('click',function(e){e.preventDefault();e.stopPropagation();calM++;if(calM>11){calM=0;calY++;}renderCal();});
    calApply.addEventListener('click',function(e){e.stopPropagation();
      if(selStart&&selEnd)window.location.href='/staff/admin/sales?start_date='+selStart+'&end_date='+(selEnd||selStart);
    });
    renderCal();
  }
  var rows = ${JSON.stringify(mergedRows.slice().reverse().map(r => ({ label: r.dateJP.slice(5), luggage: r.luggage, rental: r.rental, combined: r.combined, people: r.orders })))};

  if(!rows.length){return;}
  var labels = rows.map(function(r){return r.label;});
  var luggageVals = rows.map(function(r){return r.luggage;});
  var rentalVals = rows.map(function(r){return r.rental;});
  var combinedVals = rows.map(function(r){return r.combined;});

  var defaults = Chart.defaults;
  defaults.font.family = "'Pretendard','Noto Sans KR',sans-serif";
  defaults.font.size = 11;
  defaults.color = '#787774';

  function linReg(vals){
    // Only use non-zero points for regression, project across all positions
    var pts=[];
    for(var i=0;i<vals.length;i++){if(vals[i]>0)pts.push({x:i,y:vals[i]});}
    if(pts.length<2)return vals.map(function(){return null;});
    var n=pts.length,sx=0,sy=0,sxy=0,sx2=0;
    for(var j=0;j<n;j++){sx+=pts[j].x;sy+=pts[j].y;sxy+=pts[j].x*pts[j].y;sx2+=pts[j].x*pts[j].x;}
    var denom=n*sx2-sx*sx;if(denom===0)return vals.map(function(){return null;});
    var m=(n*sxy-sx*sy)/denom;
    var b=(sy-m*sx)/n;
    // Only draw trend line between first and last non-zero data points
    var first=pts[0].x,last=pts[pts.length-1].x;
    return vals.map(function(_,i){return i>=first&&i<=last?Math.round(m*i+b):null;});
  }

  // Compute percentages for labels
  var luggagePcts = luggageVals.map(function(_,i){var c=combinedVals[i];return c>0?Math.round(luggageVals[i]/c*100):0;});
  var rentalPcts = rentalVals.map(function(_,i){var c=combinedVals[i];return c>0?Math.round(rentalVals[i]/c*100):0;});

  Chart.register(ChartDataLabels);
  new Chart(document.getElementById('trendChart'),{
    type:'line',
    data:{
      labels: labels,
      datasets:[
        {label:'짐보관 (Luggage)',data:luggageVals,borderColor:'#4285F4',backgroundColor:'rgba(66,133,244,0.08)',pointBackgroundColor:'#4285F4',pointRadius:4,pointHoverRadius:6,borderWidth:2,tension:0.1,fill:false,
          datalabels:{align:'top',color:'#4285F4',font:{size:9,weight:'bold'},formatter:function(_,ctx){return luggagePcts[ctx.dataIndex]+'%';}}},
        {label:'Luggage Trend',data:linReg(luggageVals),borderColor:'rgba(66,133,244,0.35)',borderWidth:1.5,borderDash:[6,4],pointRadius:0,pointHoverRadius:0,fill:false,tension:0,spanGaps:true,datalabels:{display:false}},
        {label:'렌탈 (Rental)',data:rentalVals,borderColor:'#EA4335',backgroundColor:'rgba(234,67,53,0.08)',pointBackgroundColor:'#EA4335',pointRadius:4,pointHoverRadius:6,borderWidth:2,tension:0.1,fill:false,
          datalabels:{align:'bottom',color:'#EA4335',font:{size:9,weight:'bold'},formatter:function(_,ctx){return rentalPcts[ctx.dataIndex]+'%';}}},
        {label:'Rental Trend',data:linReg(rentalVals),borderColor:'rgba(234,67,53,0.35)',borderWidth:1.5,borderDash:[6,4],pointRadius:0,pointHoverRadius:0,fill:false,tension:0,spanGaps:true,datalabels:{display:false}},
        {label:'합계 (Combined)',data:combinedVals,borderColor:'#FBBC05',backgroundColor:'rgba(251,188,5,0.08)',pointBackgroundColor:'#FBBC05',pointRadius:4,pointHoverRadius:6,borderWidth:2,tension:0.1,fill:false,datalabels:{display:false}},
        {label:'Combined Trend',data:linReg(combinedVals),borderColor:'rgba(251,188,5,0.35)',borderWidth:1.5,borderDash:[6,4],pointRadius:0,pointHoverRadius:0,fill:false,tension:0,spanGaps:true,datalabels:{display:false}}
      ]
    },
    options:{
      responsive:true,maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{position:'top',labels:{boxWidth:12,padding:16,usePointStyle:true,pointStyle:'circle',
          filter:function(item){return item.text.indexOf('Trend')===-1;}}},
        tooltip:{filter:function(item){return item.dataset.label.indexOf('Trend')===-1;},
          callbacks:{label:function(c){
            var val='\\u00A5'+c.raw.toLocaleString();
            var idx=c.dataIndex;
            if(c.datasetIndex===0)val+=' ('+luggagePcts[idx]+'%)';
            if(c.datasetIndex===2)val+=' ('+rentalPcts[idx]+'%)';
            return c.dataset.label+': '+val;
          }}}
      },
      scales:{
        x:{grid:{display:false}},
        y:{ticks:{callback:function(v){return '\\u00A5'+v.toLocaleString();}},grid:{color:'#f0f0ee'},beginAtZero:true}
      }
    }
  });

  // People chart
  var peopleVals = rows.map(function(r){return r.people;});
  var avgPeople = Math.round(peopleVals.reduce(function(a,b){return a+b;},0)/peopleVals.length);
  var maxPeople = Math.max.apply(null,peopleVals);
  var minPeople = Math.min.apply(null,peopleVals.filter(function(v){return v>0;}));
  new Chart(document.getElementById('peopleChart'),{
    type:'bar',
    data:{
      labels:labels,
      datasets:[
        {label:'방문자 수 · 来客数',data:peopleVals,backgroundColor:'rgba(35,131,226,0.6)',borderRadius:3,barPercentage:0.65,datalabels:{display:false}},
        {label:'추세 · Trend',data:linReg(peopleVals),type:'line',borderColor:'rgba(234,67,53,0.6)',borderWidth:2,borderDash:[6,4],pointRadius:0,fill:false,datalabels:{display:false},spanGaps:true}
      ]
    },
    options:{
      responsive:true,maintainAspectRatio:false,
      plugins:{
        legend:{position:'top',labels:{boxWidth:12,padding:12,usePointStyle:true,pointStyle:'circle'}},
        tooltip:{callbacks:{label:function(c){return c.dataset.label+': '+c.raw+'명';}}},
        subtitle:{display:true,text:'평균 '+avgPeople+'명 · 최대 '+maxPeople+'명 · 최소 '+minPeople+'명',align:'end',font:{size:11,weight:'normal'},color:'#787774',padding:{bottom:8}}
      },
      scales:{
        x:{grid:{display:false}},
        y:{ticks:{callback:function(v){return v+'명';}},grid:{color:'#f0f0ee'},beginAtZero:true}
      }
    }
  });
})()`}} />
        </main>
      </body>
    </html>
  );
});

// GET /staff/admin/staff-accounts — Staff account management
admin.get("/staff/admin/staff-accounts", async (c) => {
  const supabaseAdmin = createSupabaseAdmin(c.env);
  const { data: accountRows } = await supabaseAdmin
    .from("user_profiles")
    .select("id, display_name, username, email, role, is_active, created_at")
    .order("is_active", { ascending: false })
    .order("created_at", { ascending: false });

  const accounts = { results: accountRows || [] };

  const staff = getStaff(c);
  const focusId = c.req.query("focus");
  const errorMsg = c.req.query("error");
  const successMsg = c.req.query("success");

  const activeAccounts: Record<string, unknown>[] = [];
  const inactiveAccounts: Record<string, unknown>[] = [];
  let adminCount = 0;
  for (const a of accounts.results) {
    if (a.is_active) {
      activeAccounts.push(a);
      if (a.role === "admin") adminCount++;
    } else {
      inactiveAccounts.push(a);
    }
  }

  const AccountRow = ({ a, isOpen }: { a: Record<string, unknown>; isOpen: boolean }) => {
    const name = (a.display_name as string) || (a.username as string) || "?";
    const initial = name[0].toUpperCase();
    const isMe = a.id === staff.id;
    const isActive = a.is_active as boolean;
    const role = a.role as string;
    const created = a.created_at ? new Date(a.created_at as string).toISOString().slice(0, 10) : "-";
    const badgeClass = role === "admin" ? " acct-badge--admin" : "";
    const badgeLabel = role === "admin" ? "관리자" : role === "editor" ? "편집자" : "뷰어";
    const avatarClass = role === "admin" ? " acct-avatar--admin" : "";

    return (<>
      <tr class={`acct-row${!isActive ? " acct-row--dim" : ""}`}>
        <td class="acct-td">
          <div class="acct-name-cell">
            <span class={`acct-avatar${avatarClass}`}>{initial}</span>
            <div>
              <span class="acct-name">{name}{isMe && <span class="acct-me">나</span>}</span>
              <span class="acct-email">{(a.username as string) || (a.email as string) || ""}</span>
            </div>
          </div>
        </td>
        <td class="acct-td"><span class={`acct-badge${badgeClass}`}>{badgeLabel}</span></td>
        <td class="acct-td"><span class={`acct-status${isActive ? " acct-status--on" : " acct-status--off"}`}>{isActive ? "활성" : "잠금"}</span></td>
        <td class="acct-td acct-td--date">{created}</td>
        <td class="acct-td acct-td--actions">
          <div class="acct-menu-wrap">
            <button class="acct-menu-btn" type="button" aria-label="메뉴">&#x22EF;</button>
            <div class="acct-dropdown">
              <button class="acct-dropdown-item acct-edit-toggle" type="button" data-panel={`acct-panel-${a.id}`}>수정</button>
              <form method="post" action={`/staff/admin/staff-accounts/${a.id}/toggle-active`} onsubmit={`return confirm('${isActive ? "이 계정을 잠금 처리할까요?" : "이 계정을 복구할까요?"}')`}>
                <button class={`acct-dropdown-item${!isActive ? " acct-dropdown-item--green" : ""}`} type="submit">{isActive ? "잠금" : "복구"}</button>
              </form>
              {!isMe && (<>
                <div class="acct-dropdown-divider" />
                <form method="post" action={`/staff/admin/staff-accounts/${a.id}/delete`} onsubmit="return confirm('정말 삭제할까요? 되돌릴 수 없습니다.')">
                  <button class="acct-dropdown-item acct-dropdown-item--danger" type="submit">삭제</button>
                </form>
              </>)}
            </div>
          </div>
        </td>
      </tr>
      <tr class="acct-panel-row">
        <td colspan={5} style="padding:0;border:none">
          <div id={`acct-panel-${a.id}`} class={`acct-edit-panel${!isOpen ? " is-collapsed" : ""}`}>
            <form method="post" action={`/staff/admin/staff-accounts/${a.id}/update`} class="acct-edit-form">
              <label class="field"><span class="field-label">표시 이름</span><input class="control" type="text" name="display_name" value={(a.display_name as string) || ""} required /></label>
              <label class="field"><span class="field-label">권한</span>
                <select class="control" name="role">
                  <option value="viewer" selected={(a.role as string) === "viewer"}>뷰어</option>
                  <option value="editor" selected={(a.role as string) === "editor"}>편집자</option>
                  <option value="admin" selected={(a.role as string) === "admin"}>관리자</option>
                </select>
              </label>
              <div class="acct-edit-actions">
                <button class="btn btn-primary btn-sm" type="submit">저장</button>
                <button class="btn btn-sm acct-edit-cancel" type="button">취소</button>
              </div>
            </form>
          </div>
        </td>
      </tr>
    </>);
  };

  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>직원 계정</title>
      </head>
      <body class="staff-site">
        <StaffTopbar staff={staff} />
        <main class="container">
          <StaffMenu active="/staff/admin/staff-accounts" role={staff.role} />
        {successMsg && <p class="success-note">{successMsg}</p>}
        {errorMsg && <p class="error">{decodeURIComponent(errorMsg)}</p>}
        <section class="hero"><div><p class="hero-kicker">Admin</p><h2 class="hero-title">직원 계정</h2></div></section>

        <section class="card">
          <div class="acct-create-section">
            <div class="acct-header">
              <h3 class="card-title" style="margin:0;font-size:14px">새 계정</h3>
            </div>
            <form method="post" action="/staff/admin/staff-accounts" class="acct-create-grid" style="margin-top:8px">
              <label class="field"><span class="field-label">이름</span><input class="control" type="text" id="create-name" name="display_name" placeholder="홍길동" required /></label>
              <label class="field"><span class="field-label">이메일</span>
                <div style="display:flex;align-items:center;gap:0">
                  <input class="control" type="text" id="create-email" name="email" placeholder="이름 입력 시 자동 생성" style="border-radius:6px 0 0 6px;border-right:none" required />
                  <span style="padding:5px 8px;font-size:12px;color:#a5a5a3;background:#f7f7f5;border:1px solid #e5e5e5;border-radius:0 6px 6px 0;white-space:nowrap">@center.local</span>
                </div>
              </label>
              <label class="field"><span class="field-label">비밀번호</span>
                <div style="display:flex;gap:6px">
                  <input class="control" type="text" id="create-pw" name="password" style="flex:1" required />
                  <button class="btn btn-sm btn-secondary" type="button" id="gen-pw-btn" style="white-space:nowrap">생성</button>
                </div>
              </label>
              <label class="field"><span class="field-label">권한</span>
                <select class="control" name="role">
                  <option value="viewer">뷰어</option>
                  <option value="editor" selected>편집자</option>
                  <option value="admin">관리자</option>
                </select>
              </label>
              <button class="btn btn-primary btn-sm" type="submit">계정 생성</button>
            </form>
          </div>
        </section>

        <section class="card">
          <div style="padding:10px 16px 0">
            <div class="acct-header">
              <h3 class="card-title" style="margin:0;font-size:14px">계정 목록</h3>
              <span class="acct-count">{accounts.results.length}명 · 활성 {activeAccounts.length}명 · 관리자 {adminCount}명</span>
            </div>
          </div>
          <div style="overflow-x:auto">
          <table class="acct-tbl">
            <thead>
              <tr>
                <th>이름</th>
                <th>권한</th>
                <th>상태</th>
                <th>생성일</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {activeAccounts.map((a: Record<string, unknown>) => (
                <AccountRow a={a} isOpen={String(a.id) === focusId} />
              ))}
              {inactiveAccounts.length > 0 && (<>
                <tr class="acct-divider-row"><td colspan={5}><span class="acct-divider-label">잠금 계정 ({inactiveAccounts.length})</span></td></tr>
                {inactiveAccounts.map((a: Record<string, unknown>) => (
                  <AccountRow a={a} isOpen={String(a.id) === focusId} />
                ))}
              </>)}
            </tbody>
          </table>
          </div>
        </section>
        </main>
        <script dangerouslySetInnerHTML={{__html: `(function(){
  document.querySelectorAll(".acct-menu-btn").forEach(function(b){
    b.addEventListener("click",function(e){
      e.stopPropagation();
      var w=b.closest(".acct-menu-wrap"),o=w.classList.contains("is-open");
      document.querySelectorAll(".acct-menu-wrap.is-open").forEach(function(x){x.classList.remove("is-open")});
      if(!o)w.classList.add("is-open");
    });
  });
  document.addEventListener("click",function(){document.querySelectorAll(".acct-menu-wrap.is-open").forEach(function(x){x.classList.remove("is-open")})});
  document.querySelectorAll(".acct-edit-toggle").forEach(function(b){
    b.addEventListener("click",function(){
      var p=document.getElementById(b.dataset.panel);if(!p)return;
      p.classList.toggle("is-collapsed");
      var w=b.closest(".acct-menu-wrap");if(w)w.classList.remove("is-open");
    });
  });
  document.querySelectorAll(".acct-edit-cancel").forEach(function(b){
    b.addEventListener("click",function(){
      var p=b.closest(".acct-edit-panel");if(p)p.classList.add("is-collapsed");
    });
  });
  var I=['g','kk','n','d','tt','r','m','b','pp','s','ss','','j','jj','ch','k','t','p','h'];
  var M=['a','ae','ya','yae','eo','e','yeo','ye','o','wa','wae','oe','yo','u','wo','we','wi','yu','eu','ui','i'];
  var F=['','k','k','ks','n','nj','nh','t','l','lk','lm','lp','ls','lt','lp','lh','m','p','ps','t','t','ng','t','t','k','t','p','h'];
  function rom(s){var r='';for(var i=0;i<s.length;i++){var c=s.charCodeAt(i);if(c>=0xAC00&&c<=0xD7A3){var o=c-0xAC00;r+=I[Math.floor(o/588)]+M[Math.floor((o%588)/28)]+F[o%28];}else{r+=s[i];}}return r;}
  var nm=document.getElementById('create-name'),em=document.getElementById('create-email'),edited=false;
  if(em){em.addEventListener('input',function(){edited=true;});}
  if(nm){nm.addEventListener('input',function(){
    if(edited)return;var n=nm.value.trim();if(n.length<2){em.value='';return;}
    em.value=rom(n.slice(1))+'.'+rom(n.charAt(0));
  });}
  var pb=document.getElementById('gen-pw-btn');
  if(pb){pb.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var ch='abcdefghijklmnopqrstuvwxyz0123456789',pw='';
    for(var i=0;i<10;i++){pw+=ch[Math.floor(Math.random()*ch.length)];}
    document.getElementById('create-pw').value=pw;
  });}
})()`}} />
      </body>
    </html>
  );
});

// POST /staff/admin/staff-accounts — Create staff account
admin.post("/staff/admin/staff-accounts", async (c) => {
  const body = await c.req.parseBody();
  const rawEmail = String(body.email || "").trim();
  const email = rawEmail.includes("@") ? rawEmail : `${rawEmail}@center.local`;
  const password = String(body.password || "").trim();
  const displayName = String(body.display_name || "").trim();
  const role = String(body.role || "editor");
  if (!["admin", "editor", "viewer"].includes(role)) {
    return c.redirect("/staff/admin/staff-accounts?error=" + encodeURIComponent("잘못된 역할입니다."));
  }

  if (!rawEmail || !password || !displayName) {
    return c.redirect("/staff/admin/staff-accounts?error=" + encodeURIComponent("모든 항목을 입력해주세요."));
  }
  if (password.length < 6) {
    return c.redirect("/staff/admin/staff-accounts?error=" + encodeURIComponent("비밀번호는 6자리 이상 입력해주세요."));
  }

  // Create user in Supabase Auth
  const supabaseAdmin = createSupabaseAdmin(c.env);
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error || !data.user) {
    return c.redirect(`/staff/admin/staff-accounts?error=${encodeURIComponent(error?.message || "Failed")}`);
  }

  // Create profile in Supabase PG — rollback Supabase user on failure
  const username = email.split("@")[0];
  try {
    const { error: pgError } = await supabaseAdmin.from("user_profiles").upsert({
      id: data.user.id,
      display_name: displayName,
      username,
      email,
      role,
      is_active: true,
    }, { onConflict: "id" });

    if (pgError) throw pgError;
  } catch (e) {
    try {
      await supabaseAdmin.auth.admin.deleteUser(data.user.id);
    } catch { /* rollback best-effort */ }
    return c.redirect(`/staff/admin/staff-accounts?error=${encodeURIComponent("프로필 생성 실패 — 계정이 롤백되었습니다")}`);
  }

  return c.redirect("/staff/admin/staff-accounts?success=계정이 생성되었습니다");
});

// POST /staff/admin/staff-accounts/:id/toggle-active
admin.post("/staff/admin/staff-accounts/:id/toggle-active", async (c) => {
  const targetId = c.req.param("id");
  const staff = getStaff(c);

  if (targetId === staff.id) {
    return c.redirect("/staff/admin/staff-accounts?error=자신의 계정은 비활성화할 수 없습니다");
  }

  const supabaseAdmin = createSupabaseAdmin(c.env);
  const { data: profile } = await supabaseAdmin
    .from("user_profiles")
    .select("is_active")
    .eq("id", targetId)
    .single();

  if (!profile) return c.redirect("/staff/admin/staff-accounts");

  const newActive = !profile.is_active;
  await supabaseAdmin
    .from("user_profiles")
    .update({ is_active: newActive, updated_at: new Date().toISOString() })
    .eq("id", targetId);

  return c.redirect(`/staff/admin/staff-accounts?success=${newActive ? "계정이 복구되었습니다" : "계정이 잠금되었습니다"}`);
});

// POST /staff/admin/staff-accounts/:id/update
admin.post("/staff/admin/staff-accounts/:id/update", async (c) => {
  const targetId = c.req.param("id");
  const body = await c.req.parseBody();

  const updates: Record<string, string> = {};
  if (body.display_name) updates.display_name = String(body.display_name);
  if (body.role) updates.role = String(body.role);

  if (Object.keys(updates).length > 0) {
    const supabaseAdmin = createSupabaseAdmin(c.env);
    await supabaseAdmin
      .from("user_profiles")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("id", targetId);
  }

  return c.redirect("/staff/admin/staff-accounts?success=저장되었습니다");
});

// POST /staff/admin/staff-accounts/:id/delete
admin.post("/staff/admin/staff-accounts/:id/delete", async (c) => {
  const targetId = c.req.param("id");

  // Delete from Supabase Auth + PG
  const supabaseAdmin = createSupabaseAdmin(c.env);
  await supabaseAdmin.auth.admin.deleteUser(targetId);
  await supabaseAdmin.from("user_profiles").delete().eq("id", targetId);
  return c.redirect("/staff/admin/staff-accounts");
});

// Action labels for Korean display
const ACTION_LABELS: Record<string, string> = {
  INLINE_UPDATE: "수정", TOGGLE_PAYMENT: "결제변경", PICKUP: "수령완료",
  UNDO_PICKUP: "수령취소", CANCEL: "취소", TOGGLE_WAREHOUSE: "창고",
  UPDATE_PRICE: "요금변경", MARK_PAID: "결제완료", MARK_PICKED_UP: "수령완료",
  UNDO_PICKED_UP: "수령취소", MANUAL_CREATE: "수기접수", UPDATE: "수정",
  VIEW_ID_IMAGE: "신분증조회", VIEW_LUGGAGE_IMAGE: "짐사진조회",
  VIEW_ID: "신분증조회", VIEW_LUGGAGE: "짐사진조회",
  CREATE_EXTENSION: "연장접수",
  BULK_CANCEL: "일괄취소", BULK_MARK_PAID: "일괄결제",
};

// GET /staff/admin/activity-logs — Audit log viewer
admin.get("/staff/admin/activity-logs", async (c) => {
  const startDate = c.req.query("start_date") || "";
  const endDate = c.req.query("end_date") || "";
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = 50;
  const offset = (page - 1) * limit;

  // Build date filter — default last 7 days
  let dateFilter = "";
  const dateParams: string[] = [];
  if (startDate && endDate) {
    dateFilter = " WHERE date(a.timestamp, '+9 hours') BETWEEN ? AND ?";
    dateParams.push(startDate, endDate);
  } else {
    dateFilter = " WHERE date(a.timestamp, '+9 hours') >= date('now', '-7 days')";
  }


  // Fetch logs from D1 with pagination
  const [logs, countResult] = await Promise.all([
    c.env.DB.prepare(
      `SELECT a.* FROM luggage_audit_logs a${dateFilter}
       ORDER BY a.timestamp DESC LIMIT ? OFFSET ?`
    ).bind(...dateParams, limit, offset).all(),
    c.env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM luggage_audit_logs a${dateFilter}`
    ).bind(...dateParams).first<{ cnt: number }>(),
  ]);

  const totalCount = countResult?.cnt || 0;
  const hasMore = offset + limit < totalCount;

  // Bulk-fetch staff names from Supabase PG
  const staffIds = [...new Set(logs.results.map((l: Record<string, unknown>) => l.staff_id as string).filter(Boolean))];
  const staffNameMap: Record<string, string> = {};
  if (staffIds.length > 0) {
    const supabaseAdmin = createSupabaseAdmin(c.env);
    const { data: profiles } = await supabaseAdmin
      .from("user_profiles")
      .select("id, display_name, username")
      .in("id", staffIds);
    if (profiles) {
      for (const p of profiles) {
        staffNameMap[p.id] = p.display_name || p.username || p.id;
      }
    }
  }

  const staff = getStaff(c);
  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>활동 로그</title></head>
      <body class="staff-site">
        <StaffTopbar staff={staff} />
        <main class="container">
          <StaffMenu active="/staff/admin/activity-logs" role={staff.role} />
        <section class="hero"><div><p class="hero-kicker">Admin</p><h2 class="hero-title">활동 로그</h2><p class="hero-desc">{totalCount.toLocaleString()}건</p></div></section>

        {(() => {
          const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
          const todayStr = now.toISOString().slice(0, 10);
          const presets = [
            { label: "오늘", sd: todayStr, ed: todayStr },
            { label: "최근 3일", sd: new Date(now.getTime() - 3 * 86400000).toISOString().slice(0, 10), ed: todayStr },
            { label: "최근 7일", sd: new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10), ed: todayStr },
            { label: "최근 14일", sd: new Date(now.getTime() - 14 * 86400000).toISOString().slice(0, 10), ed: todayStr },
            { label: "최근 30일", sd: new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10), ed: todayStr },
          ];
          const activePreset = presets.find(p => p.sd === startDate && p.ed === endDate);
          const isDefault = !startDate && !endDate;
          const displayLabel = activePreset ? activePreset.label : isDefault ? "최근 7일" : `${startDate} ~ ${endDate}`;
          return (
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:0 0 12px">
              {presets.map(p => {
                const active = (p.sd === startDate && p.ed === endDate) || (isDefault && p.label === "최근 7일");
                return <a class={`btn btn-sm${active ? " btn-primary" : " btn-secondary"}`} href={`/staff/admin/activity-logs?start_date=${p.sd}&end_date=${p.ed}`}>{p.label}</a>;
              })}
              {!isDefault && !activePreset && <span class="btn btn-sm btn-primary" style="cursor:default">{displayLabel}</span>}
              {!isDefault && <a class="btn btn-sm btn-secondary" href="/staff/admin/activity-logs">초기화</a>}
            </div>
          );
        })()}

        <section class="card">
        <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>시간</th>
              <th>주문</th>
              <th>직원</th>
              <th>행동</th>
              <th>상세</th>
            </tr>
          </thead>
          <tbody>
          {logs.results.length === 0 && (
            <tr><td colspan={5} style="padding:24px;text-align:center;color:#a5a5a3">활동 기록이 없습니다</td></tr>
          )}
          {logs.results.map((l: Record<string, unknown>) => (
            <tr>
              <td style="white-space:nowrap">{l.timestamp ? new Date(l.timestamp as string).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }) : "-"}</td>
              <td><a href={`/staff/orders/${l.order_id as string}`} style="color:var(--primary)">{l.order_id as string}</a></td>
              <td>{staffNameMap[l.staff_id as string] || (l.staff_id as string) || "-"}</td>
              <td><span class="status-pill" style="font-size:10px">{ACTION_LABELS[l.action as string] || (l.action as string)}</span></td>
              <td>{(l.details as string) || "-"}</td>
            </tr>
          ))}
          </tbody>
        </table>
        </div>
        </section>

        <div style="display:flex;gap:8px;justify-content:center;margin:16px 0">
          {page > 1 && (
            <a class="btn btn-secondary btn-sm" href={`/staff/admin/activity-logs?page=${page - 1}${startDate ? `&start_date=${startDate}` : ""}${endDate ? `&end_date=${endDate}` : ""}`}>← 이전</a>
          )}
          <span style="font-size:12px;color:#a5a5a3;padding:6px 0">{totalCount}건 중 {offset + 1}-{Math.min(offset + limit, totalCount)}</span>
          {hasMore && (
            <a class="btn btn-secondary btn-sm" href={`/staff/admin/activity-logs?page=${page + 1}${startDate ? `&start_date=${startDate}` : ""}${endDate ? `&end_date=${endDate}` : ""}`}>다음 →</a>
          )}
        </div>
        </main>
      </body>
    </html>
  );
});

// GET /staff/admin/completion-message — Completion message editor
admin.get("/staff/admin/completion-message", async (c) => {
  const msgs = await loadCompletionMessages(c.env.DB);

  const staff = getStaff(c);
  const successMsg = c.req.query("success");
  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>작성완료 문구 수정</title>
      </head>
      <body class="staff-site">
        <StaffTopbar staff={staff} />
        <main class="container">
          <StaffMenu active="/staff/admin/completion-message" role={staff.role} />
        {successMsg && <p class="success-note">{successMsg}</p>}
        <section class="hero"><div><p class="hero-kicker">Admin</p><h2 class="hero-title">작성완료 문구 수정</h2><p class="hero-desc">한국어로 입력하면 영어/일본어 문구가 자동 생성됩니다.</p></div></section>

        <section class="card" style="padding:16px">
        <form method="post" action="/staff/admin/completion-message">
          <label class="field">
            <span class="field-label">1차 문구 (상단 안내)</span>
            <textarea class="control" name="primary_message_ko" rows={4} style="font-size:13px">{msgs.primary.ko}</textarea>
          </label>
          <label class="field">
            <span class="field-label">2차 문구 (혜택 안내)</span>
            <textarea class="control" name="secondary_message_ko" rows={5} style="font-size:13px">{msgs.secondary.ko}</textarea>
          </label>
          <p style="font-size:12px;color:#787774;margin:8px 0 12px"><code style="background:#f0f0ee;padding:2px 5px;border-radius:3px;font-size:11px">{"{amount}"}</code>를 넣으면 실제 결제금액으로 자동 치환됩니다. (예: ¥4,800)</p>
          <button class="btn btn-primary" type="submit">문구 저장 (자동 번역 포함)</button>
        </form>
        </section>

        <section class="card" style="padding:16px">
          <h3 class="card-title">미리보기</h3>
          <div class="preview-grid">
            <div class="preview-card">
              <h4>KO 한국어</h4>
              <p class="preview-label">1차 문구</p>
              <div class="preview-text">{msgs.primary.ko}</div>
              <p class="preview-label">2차 문구</p>
              <div class="preview-text">{msgs.secondary.ko}</div>
            </div>
            <div class="preview-card">
              <h4>EN English</h4>
              <p class="preview-label">1차 문구</p>
              <div class="preview-text">{msgs.primary.en}</div>
              <p class="preview-label">2차 문구</p>
              <div class="preview-text">{msgs.secondary.en}</div>
            </div>
            <div class="preview-card">
              <h4>JA 日本語</h4>
              <p class="preview-label">1차 문구</p>
              <div class="preview-text">{msgs.primary.ja}</div>
              <p class="preview-label">2차 문구</p>
              <div class="preview-text">{msgs.secondary.ja}</div>
            </div>
          </div>
        </section>
        </main>
      </body>
    </html>
  );
});

// POST /staff/admin/completion-message — Save completion message (auto-translate)
admin.post("/staff/admin/completion-message", async (c) => {
  const body = await c.req.parseBody();
  const staff = getStaff(c);
  const koPrimary = String(body.primary_message_ko || "");
  const koSecondary = String(body.secondary_message_ko || "");

  const msgs = await buildCompletionMessagesFromKo(koPrimary, koSecondary);

  // Upsert all 6 messages
  const entries: [string, string][] = [
    ["customer_success_primary_message_ko", msgs.primary.ko],
    ["customer_success_primary_message_en", msgs.primary.en],
    ["customer_success_primary_message_ja", msgs.primary.ja],
    ["customer_success_secondary_message_ko", msgs.secondary.ko],
    ["customer_success_secondary_message_en", msgs.secondary.en],
    ["customer_success_secondary_message_ja", msgs.secondary.ja],
  ];

  const stmts = entries.map(([key, value]) =>
    c.env.DB.prepare(
      `INSERT INTO luggage_app_settings (setting_key, setting_value, staff_id, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(setting_key) DO UPDATE SET setting_value = ?, staff_id = ?, updated_at = datetime('now')`
    ).bind(key, value, staff.id, value, staff.id)
  );

  await c.env.DB.batch(stmts);

  return c.redirect("/staff/admin/completion-message?success=저장되었습니다 (자동 번역 포함)");
});

// POST /staff/admin/retention/run — Manual retention cleanup
admin.post("/staff/admin/retention/run", async (c) => {
  const { runRetentionCleanup } = await import("../services/retention");
  const result = await runRetentionCleanup(c.env.DB, c.env.IMAGES);
  return c.json({ success: true, ...result });
});

// POST /staff/admin/extensions/run — Manual extension processing
admin.post("/staff/admin/extensions/run", async (c) => {
  const { generateExtensionOrders } = await import("../services/extension");
  const result = await generateExtensionOrders(c.env.DB);
  return c.json({ success: true, ...result });
});

export default admin;
