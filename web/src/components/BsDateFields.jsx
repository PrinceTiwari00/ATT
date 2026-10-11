import {
  BS_MONTHS,
  MAX_BS_YEAR,
  MIN_BS_YEAR,
  adToBsParts,
  bsToAdIso,
  daysInBsMonth,
  formatAdDate,
  formatBsDate,
} from '../lib/nepaliDate';

const YEARS = Array.from({ length: MAX_BS_YEAR - MIN_BS_YEAR + 1 }, (_, i) => MAX_BS_YEAR - i);
const TODAY = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Three compact selectors that choose a date in the Nepali Bikram Sambat calendar. */
export function BsDateFields({ value, onChange, disabled = false }) {
  const selected = adToBsParts(value) || adToBsParts(TODAY());
  if (!selected) return null;
  const monthDays = daysInBsMonth(selected.year, selected.month);
  const selectClass = 'input min-w-0 !px-2 !py-2 text-[12px]';

  const update = (patch) => {
    const next = { ...selected, ...patch };
    const maxDay = daysInBsMonth(next.year, next.month);
    next.day = Math.min(next.day, maxDay);
    onChange(bsToAdIso(next.year, next.month, next.day));
  };

  return (
    <div className="min-w-0 space-y-1">
      <div className="grid grid-cols-[1fr_1.35fr_.75fr] gap-1.5">
        <select
          className={selectClass}
          aria-label="Bikram Sambat year"
          value={selected.year}
          disabled={disabled}
          onChange={(event) => update({ year: Number(event.target.value) })}
        >
          {YEARS.map((year) => <option key={year} value={year}>{year}</option>)}
        </select>
        <select
          className={selectClass}
          aria-label="Bikram Sambat month"
          value={selected.month}
          disabled={disabled}
          onChange={(event) => update({ month: Number(event.target.value) })}
        >
          {BS_MONTHS.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}
        </select>
        <select
          className={selectClass}
          aria-label="Bikram Sambat day"
          value={selected.day}
          disabled={disabled}
          onChange={(event) => update({ day: Number(event.target.value) })}
        >
          {Array.from({ length: monthDays }, (_, index) => index + 1)
            .map((day) => <option key={day} value={day}>{day}</option>)}
        </select>
      </div>
      <p className="text-[10.5px] text-slate-400">
        {formatBsDate(value)} BS <span aria-hidden="true">·</span> {formatAdDate(value)} AD
      </p>
    </div>
  );
}

/** Month/year selector for reports; the selected month remains a BS month. */
export function BsMonthFields({ year, month, onChange, disabled = false }) {
  const selectClass = 'input min-w-0 !px-3 !py-2';
  return (
    <div className="grid grid-cols-[1.2fr_1fr] gap-2">
      <select
        className={selectClass}
        aria-label="Bikram Sambat year"
        value={year}
        disabled={disabled}
        onChange={(event) => onChange({ year: Number(event.target.value), month })}
      >
        {YEARS.map((option) => <option key={option} value={option}>{option} BS</option>)}
      </select>
      <select
        className={selectClass}
        aria-label="Bikram Sambat month"
        value={month}
        disabled={disabled}
        onChange={(event) => onChange({ year, month: Number(event.target.value) })}
      >
        {BS_MONTHS.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}
      </select>
    </div>
  );
}
