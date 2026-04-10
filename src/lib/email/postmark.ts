import type { EmailProvider, EmailConfig, EmailMessage } from './index';

export function createPostmarkProvider(config: EmailConfig): EmailProvider {
  return {
    async send(message: EmailMessage) {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          'X-Postmark-Server-Token': config.api_key,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          From: message.from ?? config.from_address,
          To: message.to,
          Subject: message.subject,
          HtmlBody: message.html,
          TextBody: message.text,
          MessageStream: 'outbound',
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Postmark error ${res.status}: ${body}`);
      }

      const data = await res.json() as { MessageID?: string };
      return { id: data.MessageID };
    },
  };
}
