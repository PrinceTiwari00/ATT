export default function KpiCard({ icon: Icon, label, value, sub, tone = 'indigo' }) {
  const tones = {
    indigo: 'from-indigo-500 to-violet-600 shadow-indigo-500/25',
    emerald: 'from-emerald-500 to-teal-600 shadow-emerald-500/25',
    rose: 'from-rose-500 to-red-600 shadow-rose-500/25',
    amber: 'from-amber-500 to-orange-600 shadow-amber-500/25',
    purple: 'from-purple-500 to-fuchsia-600 shadow-purple-500/25',
    slate: 'from-slate-600 to-slate-800 shadow-slate-500/25',
  };
  return (
    <div className={`relative overflow-hidden rounded-2xl bg-gradient-to-br ${tones[tone]} p-4 text-white shadow-lg`}>
      <div className="absolute -right-4 -top-4 opacity-15">
        <Icon size={92} strokeWidth={1.4} />
      </div>
      <div className="relative">
        <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide opacity-90">
          <Icon size={15} /> {label}
        </div>
        <div className="mt-2 text-3xl font-extrabold tabular-nums leading-none">{value}</div>
        {sub && <div className="mt-1.5 text-[12px] font-medium opacity-85">{sub}</div>}
      </div>
    </div>
  );
}
