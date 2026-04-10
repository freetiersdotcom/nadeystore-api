// ============================================================
// EMAIL PROVIDER ABSTRACTION
// ============================================================
//
// Supports: Resend, SendGrid, Mailgun, Postmark
// Active provider is read from the `config` table (key = 'email')
// and can be swapped at runtime via POST /v1/setup/email.
//
// To add a new provider:
//   1. Create src/lib/email/<provider>.ts implementing EmailProvider
//   2. Add a case in createEmailProvider() below
//   3. Add the provider name to the EmailProviderName union type

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  /** Optional plain-text fallback */
  text?: string;
  /** Sender address — falls back to provider default if omitted */
  from?: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<{ id?: string }>;
}

export type EmailProviderName = 'resend' | 'sendgrid' | 'mailgun' | 'postmark';

export interface EmailConfig {
  provider: EmailProviderName;
  api_key: string;
  /** e.g. "Your Store <noreply@yourstore.com>" */
  from_address: string;
  /** Required for Mailgun */
  mailgun_domain?: string;
  /** Required for Mailgun EU */
  mailgun_region?: 'us' | 'eu';
}

// ============================================================
// FACTORY
// ============================================================

export async function createEmailProvider(config: EmailConfig): Promise<EmailProvider> {
  switch (config.provider) {
    case 'resend':
      return (await import('./resend')).createResendProvider(config);
    case 'sendgrid':
      return (await import('./sendgrid')).createSendGridProvider(config);
    case 'mailgun':
      return (await import('./mailgun')).createMailgunProvider(config);
    case 'postmark':
      return (await import('./postmark')).createPostmarkProvider(config);
    default:
      throw new Error(`Unknown email provider: ${(config as any).provider}`);
  }
}

// ============================================================
// HELPER: load config from DB and build a ready-to-use provider
// ============================================================

import type { Database } from '../../db';

export async function getEmailProvider(db: Database): Promise<EmailProvider | null> {
  const [row] = await db.query<{ value: string }>(`SELECT value FROM config WHERE key = 'email' LIMIT 1`);
  if (!row) return null;

  let cfg: EmailConfig;
  try {
    cfg = JSON.parse(row.value) as EmailConfig;
  } catch {
    return null;
  }

  return createEmailProvider(cfg);
}
