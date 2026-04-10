import type { EmailProvider, EmailConfig, EmailMessage } from './index';

export function createResendProvider(config: EmailConfig): EmailProvider {
  return {
    async send(message: EmailMessage) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: message.from ?? config.from_address,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Resend error ${res.status}: ${body}`);
      }

      const data = await res.json() as { id?: string };
      return { id: data.id };
    },
  };
}
