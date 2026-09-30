import { CheckCircle2, Clock, LogOut, UserX, TimerReset } from 'lucide-react';
import { humanizeMinutes } from '../api/client';

/**
 * Status badge palette for attendance rows (spec § D.2):
 *  on-time → green · late → red (+mins) · early → purple (Fast Going) ·
 *  late+early → both red & purple · absent → slate
 */
export default function StatusBadges({ status, lateMinutes, earlyMinutes, punchCount }) {
  if (status === 'absent') {
    return (
      <span className="badge bg-slate-200 text-slate-600">
        <UserX size={12} /> ABSENT
      </span>
    );
  }
  const out = [];
  const isLate = status === 'late' || status === 'late_early';
  const isEarly = status === 'early' || status === 'late_early';

  if (!isLate && !isEarly) {
    out.push(
      <span key="on" className="badge bg-emerald-100 text-emerald-700">
        <CheckCircle2 size={12} /> ON TIME
      </span>
    );
  }
  if (isLate) {
    out.push(
      <span key="late" className="badge bg-rose-100 text-rose-700">
        <Clock size={12} /> LATE +{humanizeMinutes(lateMinutes)}
      </span>
    );
  }
  if (isEarly) {
    out.push(
      <span key="early" className="badge bg-purple-100 text-purple-700">
        <LogOut size={12} /> EARLY −{humanizeMinutes(earlyMinutes)}
      </span>
    );
  }
  if (punchCount === 1) {
    out.push(
      <span key="open" className="badge bg-sky-100 text-sky-700" title="Only one punch recorded — no check-out yet">
        <TimerReset size={12} /> OPEN
      </span>
    );
  }
  return <span className="inline-flex flex-wrap items-center gap-1">{out}</span>;
}

/** Row tinting by severity */
export function rowTone(status) {
  switch (status) {
    case 'late':
    case 'late_early':
      return 'bg-rose-50/60 hover:bg-rose-50';
    case 'early':
      return 'bg-purple-50/50 hover:bg-purple-50';
    default:
      return 'hover:bg-slate-50';
  }
}
