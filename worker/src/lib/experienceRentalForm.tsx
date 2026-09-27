import { EXPERIENCE_PRODUCT_GROUPS, type ExperienceRental } from "../services/experienceRentals";

function RentalRow({ rental }: { rental?: ExperienceRental }) {
  return <div class="rental-row" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px">
    <label class="field"><span class="field-label">상품</span><select class="control" name="rental_group" required>
      <option value="">선택</option>
      {EXPERIENCE_PRODUCT_GROUPS.map((group) => <option value={group} selected={rental?.product_group === group}>{group}</option>)}
    </select></label>
    <label class="field"><span class="field-label">수량</span><input class="control" name="rental_quantity" type="number" min="1" step="1" value={rental?.quantity || 1} required /></label>
    <label class="field"><span class="field-label">대여 시작일</span><input class="control" name="rental_start" type="date" value={rental?.start_date || ""} required /></label>
    <label class="field"><span class="field-label">반납일</span><input class="control" name="rental_end" type="date" value={rental?.end_date || ""} required /></label>
    <button type="button" class="btn btn-sm" onclick="this.closest('.rental-row').remove()">항목 삭제</button>
  </div>;
}

export function ExperienceRentalForm({ rentals = [] }: { rentals?: ExperienceRental[] }) {
  return <fieldset style="margin:12px 0;padding:12px;border:1px solid #cbd5e1;border-radius:6px">
    <legend>렌탈 재고 반영</legend>
    <p class="muted" style="font-size:12px">입력한 렌탈은 반납일까지 재고를 점유합니다. 취소된 체험단은 제외됩니다. 기존 혜택 내용은 자동 반영되지 않습니다.</p>
    <div class="rental-rows">{rentals.map((rental) => <RentalRow rental={rental} />)}</div>
    <template><RentalRow /></template>
    <button type="button" class="btn btn-secondary" onclick="this.parentElement.querySelector('.rental-rows').appendChild(this.parentElement.querySelector('template').content.cloneNode(true))">렌탈 항목 추가</button>
  </fieldset>;
}

export function ExperienceRentalSummary({ rentals }: { rentals: ExperienceRental[] }) {
  return <div>{rentals.length ? rentals.map((rental) => <div style="white-space:nowrap">
    {rental.product_group} {rental.quantity}개 · {rental.start_date} ~ {rental.end_date}
  </div>) : "-"}</div>;
}
