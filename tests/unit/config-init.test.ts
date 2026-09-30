import {afterEach,describe,expect,it,vi} from 'vitest';
import {getConfig} from '../../apps/web/src/services/api';
afterEach(()=>vi.unstubAllGlobals());
describe('browser session initialization',()=>{
 it('shares an in-flight request but fetches fresh state on explicit reconnect',async()=>{
  let finish!:(value:Response)=>void;const fetchMock=vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;}));vi.stubGlobal('fetch',fetchMock);
  const first=getConfig(),second=getConfig();expect(first).toBe(second);expect(fetchMock).toHaveBeenCalledTimes(1);
  finish(Response.json({sessionId:'first'}));expect((await first).sessionId).toBe('first');await second;
  const next=getConfig();expect(fetchMock).toHaveBeenCalledTimes(2);finish(Response.json({sessionId:'second'}));expect((await next).sessionId).toBe('second');
 });
 it('allows a user retry after initialization fails',async()=>{
  const fetchMock=vi.fn().mockResolvedValueOnce(new Response(null,{status:429})).mockResolvedValueOnce(Response.json({sessionId:'retry'}));vi.stubGlobal('fetch',fetchMock);
  await expect(getConfig()).rejects.toThrow('无法连接');expect((await getConfig()).sessionId).toBe('retry');expect(fetchMock).toHaveBeenCalledTimes(2);
 });
});
