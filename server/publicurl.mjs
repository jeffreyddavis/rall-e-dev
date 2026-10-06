// Only public web addresses: never this server, the cloud metadata service or a private network (source links and
// the links a debugging run follows come from outside).
export function isPublicUrl(value) {
  let u; try { u = new URL(String(value)); } catch { return false; }
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!/^https?:$/.test(u.protocol) || !h.includes('.') && !h.includes(':')) return false;
  if (/^(localhost|0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h)) return false;
  if (/^(::1?|f[cd][0-9a-f]{2}:|fe80:)/.test(h) || /\.(local|internal|localhost)$/.test(h)) return false;
  return true;
}
