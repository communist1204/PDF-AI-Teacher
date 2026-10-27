import type {Session} from 'electron';

/** Doubao does not use browser cookies or follow credential redirects. */
export function createDesktopFetch(networkSession:Pick<Session,'fetch'>):typeof fetch {
  const fetcher:typeof fetch=(input,init)=>networkSession.fetch(input instanceof URL?input.href:input,{...init,credentials:'omit',cache:'no-store',redirect:'error'});
  return fetcher;
}

export function allowedBingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['www.bing.com', 'cn.bing.com'].includes(url.hostname)
      && !url.port && !url.username && !url.password && ['/translator', '/tfettts'].includes(url.pathname);
  } catch { return false; }
}

/** Only an isolated non-persistent partition is passed here. The guard runs
 * before EVERY request, including Chromium's regional redirect hops.
 * Electron fetch cancels manual redirects instead of returning a 302 response. */
export function createBingFetch(networkSession: Pick<Session, 'fetch'> & { webRequest: Pick<Session['webRequest'], 'onBeforeRequest'> }): typeof fetch {
  networkSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowedBingUrl(details.url) }));
  return (input, init) => {
    const value = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (!allowedBingUrl(value)) return Promise.reject(Error('拒绝未知微软语音地址。'));
    const url = new URL(value);
    // A translation page GET may redirect regionally. Never forward a synthesis
    // form (text/session parameters) through a redirect.
    const redirect = url.pathname === '/translator' && (!init?.method || init.method === 'GET') ? 'follow' : 'error';
    return networkSession.fetch(url.href, { ...init, credentials: 'include', cache: 'no-store', redirect });
  };
}
