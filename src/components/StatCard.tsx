interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  accent?: "default" | "green" | "amber" | "blue" | "purple";
}

const accents: Record<NonNullable<StatCardProps["accent"]>, string> = {
  default: "text-slate-900",
  green: "text-green-600",
  amber: "text-amber-600",
  blue: "text-blue-600",
  purple: "text-purple-600",
};

export function StatCard({ label, value, sub, accent = "default" }: StatCardProps) {
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <p className="text-sm text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${accents[accent]}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-400">{sub}</p>}
    </div>
  );
}
