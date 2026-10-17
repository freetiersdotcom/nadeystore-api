// → src/lib/turnstile.ts
// Server-side check of a Cloudflare Turnstile token.
export async function verifyTurnstile(secret: string, token: string | undefined, ip?: string): Promise<boolean> {
  if (!token) return false;
  try {
    const form = new FormData();
    form.append('secret', secret);
    form.append('response', token);
    if (ip) form.append('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (e) {
    console.error('[turnstile] verification request failed', e);
    return false;
  }
}
