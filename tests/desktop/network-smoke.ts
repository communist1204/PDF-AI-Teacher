import {app,session} from 'electron';
import {createServer} from 'node:http';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import OpenAI,{toFile} from 'openai';
import {createDesktopFetch} from '../../apps/desktop/network';
const profile=join(process.cwd(),'test-results','transport-'+Date.now());mkdirSync(profile,{recursive:true});app.setPath('userData',profile);
void app.whenReady().then(async()=>{
 let redirectHits=0;let cookieSeen=false;let multipart=false;let cancellationObserved=false;
 const server=createServer(async(req,res)=>{
  cookieSeen ||= !!req.headers.cookie;
  if(req.url==='/slow'){req.on('close',()=>{cancellationObserved=true;});return;}
  if(req.url==='/redirect'){res.writeHead(302,{Location:'/redirect-target'}).end();return;}
  if(req.url==='/redirect-target'){redirectHits++;res.end('unexpected');return;}
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
  if(req.url==='/echo'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({method:req.method,body:Buffer.concat(chunks).toString()}));return;}
  assert.equal(req.headers.authorization,'Bearer fake-local-transport-only');
  if(req.url==='/v1/responses'){
   res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({type:'response.output_text.delta',delta:'first'})+'\n\n');
   setTimeout(()=>res.end('data: '+JSON.stringify({type:'response.completed',response:{status:'completed'}})+'\n\n'),10);return;
  }
  if(req.url==='/v1/audio/speech'){res.writeHead(200,{'Content-Type':'audio/mpeg'}).end(Buffer.from([1,2,3,4]));return;}
  if(req.url==='/v1/audio/transcriptions'){multipart=!!req.headers['content-type']?.startsWith('multipart/form-data; boundary=')&&Buffer.concat(chunks).includes(Buffer.from('fixture.wav'));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({text:'模拟转写'}));return;}
  res.writeHead(404).end();
 });
 try{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address==='object');const origin='http://127.0.0.1:'+address.port;
  const isolated=session.fromPartition('provider-smoke',{cache:false});const transport=createDesktopFetch(isolated);
  await isolated.cookies.set({url:origin,name:'must-not-be-forwarded',value:'test-cookie'});
  const echo=await (await transport(new URL(origin+'/echo'),{method:'POST',body:new URLSearchParams({grant_type:'authorization_code',code:'fake-code'}),credentials:'include'})).json();assert.deepEqual(echo,{method:'POST',body:'grant_type=authorization_code&code=fake-code'});
  await assert.rejects(transport(origin+'/redirect',{redirect:'follow'}));assert.equal(redirectHits,0);
  const controller=new AbortController();const delayed=transport(origin+'/slow',{signal:controller.signal});setTimeout(()=>controller.abort(),50);await assert.rejects(delayed);
  const client=new OpenAI({apiKey:'fake-local-transport-only',baseURL:origin+'/v1',fetch:transport,maxRetries:0});
  const stream=await client.responses.create({model:'mock',input:'transport fixture',stream:true});const events=[];for await(const event of stream)events.push(event.type);assert.deepEqual(events,['response.output_text.delta','response.completed']);
  const speech=await client.audio.speech.create({model:'mock',voice:'marin',input:'fixture'});assert.deepEqual(Buffer.from(await speech.arrayBuffer()),Buffer.from([1,2,3,4]));
  const transcript=await client.audio.transcriptions.create({model:'mock',file:await toFile(Buffer.from([1,2,3]),'fixture.wav',{type:'audio/wav'})});assert.equal(transcript.text,'模拟转写');assert(multipart);assert.equal(cookieSeen,false);
  const deadline=Date.now()+1500;while(!cancellationObserved&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));assert(cancellationObserved);
  let discovery:object={status:'skipped; pass --online for public configuration probe'};
  if(process.argv.includes('--online')){const result=await transport('https://auth.openai.com/.well-known/openid-configuration',{signal:AbortSignal.timeout(15000)});assert.equal(result.status,200);const metadata=await result.json();assert.equal(metadata.issuer,'https://auth.openai.com');assert.equal(metadata.authorization_endpoint,'https://auth.openai.com/api/accounts/authorize');discovery={status:result.status,validIssuer:true,validAuthorizationEndpoint:true};}
  const result={date:new Date().toISOString(),transport:'isolated Chromium session.fetch',cookiesOmitted:true,redirectRejected:true,abortClosesRequest:cancellationObserved,formEncodedBody:true,sdkSse:true,sdkAudioBytes:true,sdkMultipart:true,discovery,realAuthorization:false,paidCalls:0};writeFileSync('docs/desktop-network-smoke.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}).then(()=>app.exit(0),error=>{console.error(error instanceof Error?error.message:'Transport verification failed');app.exit(1);});
