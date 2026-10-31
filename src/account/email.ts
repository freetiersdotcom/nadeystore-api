import type { Database } from '../db';
import { getEmailProvider } from '../lib/email/index';

// One email carries the sign-in link and the 6-digit code. The link opens the account page
// (the token is in the URL fragment); it only signs in when the visitor presses the button
// there, so mail scanners that pre-open links cannot use it up.

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const T = {
  fr: {
    subject: (s: string) => `Votre lien de connexion · ${s}`,
    hi: 'Bonjour,',
    intro: (s: string) => `Voici votre lien pour accéder à votre compte ${s} : vos commandes, vos adresses et vos téléchargements.`,
    button: 'Accéder à mon compte',
    code: 'Ou saisissez ce code sur la page de connexion :',
    expires: (m: number) => `Ce lien et ce code expirent dans ${m} minutes et ne fonctionnent qu’une fois.`,
    ignore: 'Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : personne ne peut se connecter sans ce lien ou ce code.',
  },
  en: {
    subject: (s: string) => `Your sign-in link · ${s}`,
    hi: 'Hi,',
    intro: (s: string) => `Here is your link to your ${s} account: your orders, addresses and downloads.`,
    button: 'Open my account',
    code: 'Or enter this code on the sign-in page:',
    expires: (m: number) => `This link and code expire in ${m} minutes and work once.`,
    ignore: "If you didn't request this, you can ignore this email: nobody can sign in without this link or code.",
  },
} as const;

export type CustomerEmailInput = {
  to: string;
  storeName: string;
  link: string | null;
  code: string;
  ttlMinutes: number;
  locale: 'fr' | 'en';
};

export function renderCustomerLoginEmail(i: CustomerEmailInput): { subject: string; html: string; text: string } {
  const t = T[i.locale];
  const button = i.link
    ? `<p style="margin:24px 0"><a href="${esc(i.link)}" style="background:#0F6B4B;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">${t.button}</a></p>`
    : '';
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#2B2B2B">
<p>${t.hi}</p>
<p>${esc(t.intro(i.storeName))}</p>
${button}
<p style="margin-bottom:6px">${t.code}</p>
<p style="font-size:28px;letter-spacing:6px;font-weight:700;margin:0 0 20px">${esc(i.code)}</p>
<p style="color:#666;font-size:13px">${t.expires(i.ttlMinutes)}</p>
<p style="color:#666;font-size:13px">${t.ignore}</p>
</div>`;
  const text = [t.hi, '', t.intro(i.storeName), '', i.link ? `${t.button}: ${i.link}\n` : '', `${t.code} ${i.code}`, '', t.expires(i.ttlMinutes), t.ignore]
    .filter((x) => x !== '')
    .join('\n');
  return { subject: t.subject(i.storeName), html, text };
}

/** Send in the background; never throws. Returns false when no provider is set up or sending failed. */
export async function sendCustomerLoginEmail(db: Database, input: CustomerEmailInput): Promise<boolean> {
  try {
    const provider = await getEmailProvider(db);
    if (!provider) return false;
    const m = renderCustomerLoginEmail(input);
    await provider.send({ to: input.to, subject: m.subject, html: m.html, text: m.text });
    return true;
  } catch (err) {
    console.error('[account] sign-in email failed', err);
    return false;
  }
}
