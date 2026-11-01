import type { Database } from '../db';
import { getEmailProvider } from '../lib/email/index';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
type L = 'fr' | 'en';

const T = {
  fr: {
    changeSubject: (s: string) => `Confirmez votre nouvelle adresse e-mail · ${s}`,
    changeIntro: (s: string) => `Vous avez demandé à utiliser cette adresse pour votre compte ${s}. Saisissez ce code dans la page de votre compte :`,
    deleteSubject: (s: string) => `Confirmez la suppression de votre compte · ${s}`,
    deleteIntro: (s: string) => `Vous avez demandé la suppression de votre compte ${s}. Pour confirmer, saisissez ce code dans la page de votre compte :`,
    expires: (m: number) => `Ce code expire dans ${m} minutes et ne fonctionne qu’une fois.`,
    ignore: 'Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : rien ne sera modifié.',
    takenSubject: (s: string) => `Demande d’utilisation de votre adresse · ${s}`,
    takenBody: (s: string) => `Quelqu’un a demandé d’utiliser cette adresse pour un autre compte ${s}. Elle est déjà associée à un compte : aucune action n’est nécessaire et rien n’a été modifié.`,
    changedSubject: (s: string) => `L’adresse e-mail de votre compte a changé · ${s}`,
    changedBody: (s: string, to: string) => `L’adresse e-mail de votre compte ${s} vient d’être remplacée par ${to}. Les autres appareils ont été déconnectés. Si ce n’est pas vous, contactez-nous immédiatement.`,
    erasedSubject: (s: string) => `Votre compte a été supprimé · ${s}`,
    erasedBody: (s: string) => `Votre compte ${s} a été supprimé. Certaines informations de commande peuvent être conservées pour nos obligations comptables. Si ce n’est pas vous, contactez-nous.`,
  },
  en: {
    changeSubject: (s: string) => `Confirm your new email address · ${s}`,
    changeIntro: (s: string) => `You asked to use this address for your ${s} account. Enter this code on your account page:`,
    deleteSubject: (s: string) => `Confirm deleting your account · ${s}`,
    deleteIntro: (s: string) => `You asked to delete your ${s} account. To confirm, enter this code on your account page:`,
    expires: (m: number) => `This code expires in ${m} minutes and works once.`,
    ignore: "If you didn't request this, ignore this email: nothing will change.",
    takenSubject: (s: string) => `Request to use your address · ${s}`,
    takenBody: (s: string) => `Someone asked to use this address for a different ${s} account. It is already linked to an account, so no action is needed and nothing was changed.`,
    changedSubject: (s: string) => `Your account email was changed · ${s}`,
    changedBody: (s: string, to: string) => `The email address of your ${s} account was just changed to ${to}. Other devices were signed out. If this wasn't you, contact us right away.`,
    erasedSubject: (s: string) => `Your account was deleted · ${s}`,
    erasedBody: (s: string) => `Your ${s} account was deleted. Some order information may be kept for our accounting obligations. If this wasn't you, contact us.`,
  },
} as const;

const wrap = (inner: string) => `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#2B2B2B">${inner}</div>`;
const codeBlock = (c: string) => `<p style="font-size:28px;letter-spacing:6px;font-weight:700;margin:12px 0 20px">${esc(c)}</p>`;

export type PrivacyMail =
  | { kind: 'change-code'; to: string; code: string }
  | { kind: 'delete-code'; to: string; code: string }
  | { kind: 'address-taken'; to: string }
  | { kind: 'email-changed'; to: string; newEmail: string }
  | { kind: 'erased'; to: string };

export function renderPrivacyEmail(m: PrivacyMail, store: string, locale: L, ttl: number) {
  const t = T[locale];
  switch (m.kind) {
    case 'change-code':
      return { subject: t.changeSubject(store), text: `${t.changeIntro(store)}\n\n${m.code}\n\n${t.expires(ttl)}\n${t.ignore}`,
        html: wrap(`<p>${esc(t.changeIntro(store))}</p>${codeBlock(m.code)}<p style="color:#666;font-size:13px">${t.expires(ttl)}</p><p style="color:#666;font-size:13px">${t.ignore}</p>`) };
    case 'delete-code':
      return { subject: t.deleteSubject(store), text: `${t.deleteIntro(store)}\n\n${m.code}\n\n${t.expires(ttl)}\n${t.ignore}`,
        html: wrap(`<p>${esc(t.deleteIntro(store))}</p>${codeBlock(m.code)}<p style="color:#666;font-size:13px">${t.expires(ttl)}</p><p style="color:#666;font-size:13px">${t.ignore}</p>`) };
    case 'address-taken':
      return { subject: t.takenSubject(store), text: t.takenBody(store), html: wrap(`<p>${esc(t.takenBody(store))}</p>`) };
    case 'email-changed':
      return { subject: t.changedSubject(store), text: t.changedBody(store, m.newEmail), html: wrap(`<p>${esc(t.changedBody(store, m.newEmail))}</p>`) };
    case 'erased':
      return { subject: t.erasedSubject(store), text: t.erasedBody(store), html: wrap(`<p>${esc(t.erasedBody(store))}</p>`) };
  }
}

/** Send in the background; never throws. */
export async function sendPrivacyEmail(db: Database, m: PrivacyMail, store: string, locale: L, ttl: number): Promise<boolean> {
  try {
    const provider = await getEmailProvider(db);
    if (!provider) return false;
    const r = renderPrivacyEmail(m, store, locale, ttl);
    await provider.send({ to: m.to, subject: r.subject, html: r.html, text: r.text });
    return true;
  } catch (err) {
    console.error('[account] privacy email failed', err);
    return false;
  }
}
