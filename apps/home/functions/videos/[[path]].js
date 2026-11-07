// Pages serves its static files whole, even when asked for a part. Safari won't play a video without
// byte ranges and no browser can seek without them, so this answers ranges for /videos/* only.
export async function onRequest({ request, next }) {
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') ?? '');
  if (!range || (!range[1] && !range[2])) {
    const whole = await next();
    const headers = new Headers(whole.headers);
    headers.set('Accept-Ranges', 'bytes');
    return new Response(whole.body, { status: whole.status, headers });
  }

  const asset = await next(new Request(request.url));
  if (!asset.ok) return asset;
  const bytes = await asset.arrayBuffer();
  const size = bytes.byteLength;

  // "bytes=-500" asks for the last 500 bytes.
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  const headers = new Headers(asset.headers);
  headers.set('Accept-Ranges', 'bytes');
  if (start >= size || start > end) {
    headers.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }

  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(request.method === 'HEAD' ? null : bytes.slice(start, end + 1), { status: 206, headers });
}
