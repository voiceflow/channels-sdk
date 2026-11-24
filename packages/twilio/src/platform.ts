// Twilio signs a request over the address it sent it to, and the adapter
// checks that against the request's own address. Behind a tunnel or a proxy
// those differ: the server sees its own host, not the public one Twilio
// called. So the address is put back together here from what the proxy says
// of the request it passed on, or taken from TWILIO_WEBHOOK_URL when set.

/** The address Twilio called, as the request's forwarding headers give it. */
export function publicUrl(request: Request, fixed: string | undefined = process.env.TWILIO_WEBHOOK_URL): string {
  if (fixed) return fixed;
  const url = new URL(request.url);
  const first = (name: string) => request.headers.get(name)?.split(',')[0]?.trim();
  const host = first('x-forwarded-host') ?? request.headers.get('host');
  const proto = first('x-forwarded-proto');
  if (host) url.host = host;
  if (proto === 'https' || proto === 'http') url.protocol = `${proto}:`;
  // A public address has no port of the server's own: one the proxy didn't name isn't part of what Twilio signed.
  if (host && !/:\d+$/.test(host)) url.port = '';
  return url.href;
}

/** Adapter options this channel turns on. The caller's own options win. */
export const adapterDefaults: Record<string, unknown> = { webhookUrl: (request: Request) => publicUrl(request) };
