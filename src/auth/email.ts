import type { Database } from '../db';
import { getEmailProvider } from '../lib/email/index';
import { normalizeLocale } from '../lib/email/i18n';
import type { Role } from './permissions';

// ============================================================
// SIGN-IN EMAIL
// ============================================================
// One email carries the sign-in link and the 6-digit code. The link opens a
// confirmation page in the admin (it does not sign in by itself), so mail
// scanners that pre-open links cannot use it up.

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const ROLE_LABEL: Record<'fr' | 'en', Record<Role, string>> = {
  fr: { owner: 'propriétaire', manager: 'gestionnaire', staff: 'équipe', agency: 'agence' },
  en: { owner: 'owner', manager: 'manager', staff: 'staff', agency: 'agency' },
};

const T = {
  fr: {
    subjectLogin: (s: string) => `Votre lien de connexion · ${s}`,
    subjectInvite: (s: string) => `Vous êtes invité(e) à gérer ${s}`,
    hi: (n: string | null) => (n ? `Bonjour ${n},` : 'Bonjour,'),
    login: 'Voici votre lien pour vous connecter à votre tableau de bord.',
    invite: (s: string, r: string) => `Vous avez été invité(e) à rejoindre le tableau de bord de ${s} (rôle : ${r}).`,
    button: 'Se connecter',
    code: 'Ou saisissez ce code sur la page de connexion :',
    expires: (m: number) => `Ce lien et ce code expirent dans ${m >= 120 ? `${Math.round(m / 60)} heures` : `${m} minutes`} et ne fonctionnent qu’une fois.`,
    ignore: 'Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : personne ne peut se connecter sans ce lien ou ce code.',
  },
  en: {
    subjectLogin: (s: string) => `Your sign-in link · ${s}`,
    subjectInvite: (s: string) => `You're invited to manage ${s}`,
    hi: (n: string | null) => (n ? `Hi ${n},` : 'Hi,'),
    login: 'Here is your link to sign in to your dashboard.',
    invite: (s: string, r: string) => `You've been invited to the ${s} dashboard (role: ${r}).`,
    button: 'Sign in',
    code: 'Or enter this code on the sign-in page:',
    expires: (m: number) => `This link and code expire in ${m >= 120 ? `${Math.round(m / 60)} hours` : `${m} minutes`} and work once.`,
    ignore: "If you didn't request this, you can ignore this email: nobody can sign in without this link or code.",
  },
} as const;

export type LoginEmailInput = {
  to: string;
  name: string | null;
  role: Role;
  storeName: string;
  link: string | null;
  code: string;
  ttlMinutes: number;
  kind: 'login' | 'invite';
  locale?: string | null;
};

export function renderLoginEmail(i: LoginEmailInput): { subject: string; html: string; text: string } {
  const l = normalizeLocale(i.locale ?? undefined);
  const t = T[l];
  const store = i.storeName;
  const intro = i.kind === 'invite' ? t.invite(store, ROLE_LABEL[l][i.role]) : t.login;
  const subject = i.kind === 'invite' ? t.subjectInvite(store) : t.subjectLogin(store);
  const button = i.link
    ? `<p style="margin:24px 0"><a href="${esc(i.link)}" style="background:#0F6B4B;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">${t.button}</a></p>`
    : '';
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#2B2B2B">
<p>${esc(t.hi(i.name))}</p>
<p>${esc(intro)}</p>
${button}
<p style="margin-bottom:6px">${t.code}</p>
<p style="font-size:28px;letter-spacing:6px;font-weight:700;margin:0 0 20px">${esc(i.code)}</p>
<p style="color:#666;font-size:13px">${t.expires(i.ttlMinutes)}</p>
<p style="color:#666;font-size:13px">${t.ignore}</p>
</div>`;
  const text = [t.hi(i.name), '', intro, '', i.link ? `${t.button}: ${i.link}\n` : '', `${t.code} ${i.code}`, '', t.expires(i.ttlMinutes), t.ignore]
    .filter((x) => x !== '')
    .join('\n');
  return { subject, html, text };
}

/** Returns true when the email was handed to the provider, false when no provider is set up or sending failed. */
export async function sendLoginEmail(db: Database, input: LoginEmailInput): Promise<boolean> {
  try {
    const provider = await getEmailProvider(db);
    if (!provider) {
      console.warn('[auth] sign-in email not sent: no email provider configured');
      return false;
    }
    const m = renderLoginEmail(input);
    await provider.send({ to: input.to, subject: m.subject, html: m.html, text: m.text });
    return true;
  } catch (err) {
    console.error('[auth] sign-in email failed', err);
    return false;
  }
}
