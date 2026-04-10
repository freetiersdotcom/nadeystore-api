import type { EmailProvider, EmailConfig, EmailMessage } from './index';

export function createMailgunProvider(config: EmailConfig): EmailProvider {
  const domain = config.mailgun_domain;
  if (!domain) throw new Error('mailgun_domain is required for the Mailgun provider');

  const region = config.mailgun_region ?? 'us';
  const baseUrl = region === 'eu'
    ? `https://api.eu.mailgun.net/v3/${domain}`
    : `https://api.mailgun.net/v3/${domain}`;

  return {
    async send(message: EmailMessage) {
      const form = new FormData();
      form.append('from', message.from ?? config.from_address);
      form.append('to', message.to);
      form.append('subject', message.subject);
      form.append('html', message.html);
      if (message.text) form.append('text', message.text);

      const credentials = btoa(`api:${config.api_key}`);

      const res = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: { Authorization: `Basic ${credentials}` },
        body: form,
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Mailgun error ${res.status}: ${body}`);
      }

      const data = await res.json() as { id?: string };
      return { id: data.id };
    },
  };
}
