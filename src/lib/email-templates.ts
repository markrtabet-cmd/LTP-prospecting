// Per-rep saved outreach templates (Email centre). A rep keeps ONE template per
// audience — ordinary prospects vs genuine new openings (see isNewOpening) —
// stored server-side in ltp_email_templates keyed "<repId>:<emailType>", with a
// localStorage fallback when Supabase (or the table) isn't set up yet.
// Templates are saved with {{name}} / {{area}} / {{cuisine}} tokens so one
// template personalises per venue at render time.

import type { Restaurant } from "./types";

export const EMAIL_TEMPLATE_TYPES = ["prospect", "new_opening"] as const;
export type EmailTemplateType = (typeof EMAIL_TEMPLATE_TYPES)[number];

export interface EmailTemplate {
  subject: string;
  body: string;
}

/** What each row's `data` jsonb holds in ltp_email_templates. */
export interface EmailTemplateRecord extends EmailTemplate {
  repId: string;
  emailType: EmailTemplateType;
  updatedAt: string;
}

export type EmailTemplateMap = Partial<Record<EmailTemplateType, EmailTemplate>>;

export const EMAIL_TEMPLATE_LABELS: Record<EmailTemplateType, string> = {
  prospect: "prospect",
  new_opening: "new-opening",
};

// Token → the venue field it stands for. {{area}} is the borough on purpose —
// "area" reads better inside an email than "borough".
const TOKEN_VALUES: [token: string, value: (r: Restaurant) => string | undefined][] = [
  ["name", (r) => r.name],
  ["area", (r) => r.borough],
  ["cuisine", (r) => r.cuisineType],
];

/** Substitute {{name}} / {{area}} / {{cuisine}} with this venue's values. */
export function renderTemplate(text: string, r: Restaurant): string {
  let out = text;
  for (const [token, value] of TOKEN_VALUES) {
    const v = value(r)?.trim();
    if (!v) continue;
    out = out.replace(new RegExp(`\\{\\{\\s*${token}\\s*\\}\\}`, "gi"), v);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Best-effort reverse of renderTemplate: swap the current venue's values back
 * into tokens before saving, so the template generalises to other venues.
 * Returns which tokens were substituted so the UI can say what got generalised. */
export function tokenizeTemplate(
  subject: string,
  body: string,
  r: Restaurant
): { subject: string; body: string; tokens: string[] } {
  let outSubject = subject;
  let outBody = body;
  const tokens: string[] = [];
  // Longest value first, so e.g. a venue name containing the cuisine word
  // isn't half-tokenised by the shorter value.
  const pairs = TOKEN_VALUES.map(([token, value]) => ({ token, v: value(r)?.trim() ?? "" }))
    .filter((p) => p.v.length >= 3)
    .sort((a, b) => b.v.length - a.v.length);
  for (const { token, v } of pairs) {
    const re = new RegExp(escapeRegExp(v), "gi");
    const next = { subject: outSubject.replace(re, `{{${token}}}`), body: outBody.replace(re, `{{${token}}}`) };
    if (next.subject !== outSubject || next.body !== outBody) tokens.push(`{{${token}}}`);
    outSubject = next.subject;
    outBody = next.body;
  }
  return { subject: outSubject, body: outBody, tokens };
}

// ---- localStorage fallback (Supabase not configured, or sandbox session) ----

function localKey(repId: string, type: EmailTemplateType): string {
  return `ltp_email_template:${repId}:${type}`;
}

export function loadLocalTemplates(repId: string): EmailTemplateMap {
  const out: EmailTemplateMap = {};
  for (const type of EMAIL_TEMPLATE_TYPES) {
    try {
      const raw = localStorage.getItem(localKey(repId, type));
      if (!raw) continue;
      const parsed = JSON.parse(raw) as EmailTemplate;
      if (typeof parsed?.subject === "string" && typeof parsed?.body === "string") out[type] = parsed;
    } catch {
      // ignore — corrupt/blocked storage just means no saved template
    }
  }
  return out;
}

export function saveLocalTemplate(repId: string, type: EmailTemplateType, tpl: EmailTemplate): void {
  try {
    localStorage.setItem(localKey(repId, type), JSON.stringify(tpl));
  } catch {
    // ignore — storage full/blocked; the in-memory copy still applies this session
  }
}
