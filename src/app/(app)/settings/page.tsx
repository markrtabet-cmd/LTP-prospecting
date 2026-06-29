import { PageHeader } from "@/components/PageHeader";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">{title}</h2>
      {children}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Integrations, scoring rules and compliance — connect real services here later."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Data sources">
          <ul className="space-y-2 text-sm text-slate-600">
            {[
              ["Food Standards Agency API", "Not connected"],
              ["Google Places API", "Not connected"],
              ["Companies House", "Not connected"],
              ["Internal CRM / customer list", "Upload CSV"],
            ].map(([name, status]) => (
              <li key={name} className="flex items-center justify-between border-b border-slate-100 pb-2">
                <span>{name}</span>
                <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{status}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Email provider">
          <p className="text-sm text-slate-600">
            Connect SendGrid, Mailgun or the Gmail API to send approved outreach.
          </p>
          <div className="mt-3 flex items-center justify-between rounded-lg bg-slate-50 p-3">
            <span className="text-sm text-slate-600">Sending mode</span>
            <select className="rounded border border-slate-300 px-2 py-1 text-sm">
              <option>Level 1 — Draft only</option>
              <option>Level 2 — Approved batch sending</option>
              <option>Level 3 — Fully automatic (high-confidence only)</option>
            </select>
          </div>
        </Section>

        <Section title="Lead scoring weights">
          <ul className="space-y-1.5 text-sm text-slate-600">
            {[
              ["Cuisine fit", "0–25"],
              ["Menu fit", "0–25"],
              ["Business type fit", "0–15"],
              ["Location / delivery fit", "0–10"],
              ["Price point fit", "0–10"],
              ["New opening signal", "0–10"],
              ["Contact quality", "0–5"],
            ].map(([k, v]) => (
              <li key={k} className="flex justify-between">
                <span>{k}</span>
                <span className="text-slate-400">{v}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Compliance">
          <ul className="space-y-2 text-sm text-slate-600">
            <li>✓ Prefer generic business emails (info@, hello@, trade@)</li>
            <li>✓ Unsubscribe / opt-out link on every email</li>
            <li>✓ Suppression list — never re-email opted-out contacts</li>
            <li>✓ Store source &amp; date for each contact</li>
            <li>✓ Weekly volume limit per restaurant</li>
          </ul>
        </Section>

        <Section title="Users &amp; permissions">
          <p className="text-sm text-slate-600">
            Roles: Admin · Sales · Viewer. User management connects to your auth provider
            once the private login is wired up.
          </p>
        </Section>
      </div>
    </div>
  );
}
