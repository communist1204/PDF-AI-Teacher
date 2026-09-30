import type {Session} from 'electron';

/** Use Chromium's system network support, without sharing browser cookies or following credential redirects. */
export function createDesktopFetch(networkSession:Pick<Session,'fetch'>):typeof fetch {
  const fetcher:typeof fetch=(input,init)=>networkSession.fetch(input instanceof URL?input.href:input,{...init,credentials:'omit',cache:'no-store',redirect:'error'});
  // The OpenAI SDK uses this to detect FormData support without a data: URL probe.
  return Object.assign(fetcher,{Response});
}
