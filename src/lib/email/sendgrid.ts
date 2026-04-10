import type { EmailProvider, EmailConfig, EmailMessage } from './index';

export function createSendGridProvider(config: EmailConfig): EmailProvider {
  return {
    async send(message: EmailMessage) {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: message.to }] }],
          from: parseAddress(message.from ?? config.from_address),
          subject: message.subject,
          content: [
            ...(message.text ? [{ type: 'text/plain', value: message.text }] : []),
            { type: 'text/html', value: message.html },
          ],
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`SendGrid error ${res.status}: ${body}`);
      }

      // SendGrid returns 202 with no body
      return {};
    },
  };
}

/** Parse "Name <email>" into { name, email } for SendGrid */
function parseAddress(addr: string): { name?: string; email: string } {
  const match = addr.match(/^(.+?)\s*<(.+?)>$/);
  if (match) return { name: match[1], email: match[2] };
  return { email: addr };
}
