// Research pilot server. Requires a persistent DATA_DIR for remote deployment.
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib');
const nodemailer=require('nodemailer');
const PORT=Number(process.env.PORT||3000),DATA_DIR=path.resolve(process.env.DATA_DIR||'./pilot-data');
const activeGenerations=new Set();
const mailer=process.env.SMTP_HOST&&process.env.SMTP_USER&&process.env.SMTP_PASS?nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:process.env.SMTP_PORT==='465',auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}}):null;
const emailReady=()=>Boolean(mailer&&process.env.RESEARCHER_EMAIL&&process.env.SMTP_FROM);
const validSession=(id,token)=>fs.existsSync(file(id,'.auth'))&&typeof token==='string'&&sha(token)===JSON.parse(fs.readFileSync(file(id,'.auth'),'utf8')).tokenHash;
async function sendCompletionEmail(id){if(!emailReady())throw Error('Email service not configured');const data=fs.readFileSync(file(id,'.json'));const session=JSON.parse(data);const attachment=zlib.gzipSync(data,{level:9});if(attachment.length>18*1024*1024)throw Error('Compressed session exceeds safe email attachment limit; retrieve from researcher dashboard instead');await mailer.sendMail({from:process.env.SMTP_FROM,to:process.env.RESEARCHER_EMAIL,subject:`Co-Ideation ${session.participant} — completed session`,text:`Participant: ${session.participant}\nSession: ${id}\nThe attached .json.gz contains all recorded sketches, generated images, questionnaire answers and event logs. Extract the .gz before importing it into researcher.html.`,attachments:[{filename:`${session.participant}_${id}.json.gz`,content:attachment,contentType:'application/gzip'}]});}

fs.mkdirSync(DATA_DIR,{recursive:true});
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const okId=id=>/^[a-f0-9-]{36}$/.test(id||'');
const file=(id,ext)=>path.join(DATA_DIR,id+ext);
const reply=(res,status,obj)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj))};
const read=async(req)=>{const chunks=[];let size=0;for await(const part of req){size+=part.length;if(size>45*1024*1024)throw Error('Payload too large');chunks.push(part)}return JSON.parse(Buffer.concat(chunks).toString('utf8'))};
const saveJSON=(p,obj)=>{const temp=p+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';fs.writeFileSync(temp,JSON.stringify(obj),{mode:0o600});fs.renameSync(temp,p)};
const serve=(res,name)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});fs.createReadStream(path.join(__dirname,name)).pipe(res)};
http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://localhost'),a=u.pathname.split('/').filter(Boolean);
if(req.method==='GET'&&['/','/participant.html','/researcher.html'].includes(u.pathname))return serve(res,u.pathname==='/researcher.html'?'researcher.html':'participant.html');
if(req.method==='POST'&&u.pathname==='/api/session-start'){const id=crypto.randomUUID(),token=crypto.randomBytes(32).toString('hex');saveJSON(file(id,'.auth'),{tokenHash:sha(token),createdAt:new Date().toISOString()});return reply(res,200,{id,token})}
if(req.method==='POST'&&u.pathname==='/api/generate'){
 const id=req.headers['x-session-id'],token=req.headers['x-session-token'];if(!okId(id)||!validSession(id,token))return reply(res,403,{error:'Session authorization failed'});
 if(!process.env.OPENAI_API_KEY)return reply(res,503,{error:'OPENAI_API_KEY is not configured on the server'});
 if(activeGenerations.has(id))return reply(res,429,{error:'Generation already in progress'});
 const body=await read(req);if(![1,3].includes(body.quantity)||!['low','high'].includes(body.fidelity)||typeof body.sketch!=='string'||!/^data:image\/png;base64,/.test(body.sketch)||body.sketch.length>9e6||typeof body.prompt!=='string'||body.prompt.length>1500)return reply(res,400,{error:'Invalid generation request'});
 const authFile=file(id,'.auth'),state=JSON.parse(fs.readFileSync(authFile,'utf8'));if((state.generations||0)>=40)return reply(res,429,{error:'Pilot generation limit reached'});
 activeGenerations.add(id);try{const sketch=Buffer.from(body.sketch.split(',')[1],'base64');const fidelity=body.fidelity;const base=fidelity==='low'?'Create a rough low-fidelity website wireframe, hand-sketched, ambiguous and exploratory, grayscale strokes on white, no polished rendering, no realistic photos, minimal detail.':'Create a polished high-fidelity website UI mockup with clean typography, realistic visual hierarchy, colors and refined layout.';const instructions=`Use the attached sketch as the primary spatial layout and conceptual reference. Preserve its main organization and proportions. ${base} Create a distinctly different valid interpretation of the sketch from other suggestions. The website task is a campus community volunteer day landing page. ${body.prompt.trim()?'Designer request: '+body.prompt.trim():''}`;
 const generateOne=async(i)=>{const form=new FormData();form.append('model',process.env.OPENAI_IMAGE_MODEL||'gpt-image-1.5');form.append('size','1536x1024');form.append('quality',process.env.OPENAI_IMAGE_QUALITY||'medium');form.append('output_format','png');form.append('image',new Blob([sketch],{type:'image/png'}),'sketch.png');form.append('prompt',instructions+` Variation ${i+1}: make this a unique composition, not a duplicate.`);const response=await fetch('https://api.openai.com/v1/images/edits',{method:'POST',headers:{Authorization:'Bearer '+process.env.OPENAI_API_KEY},body:form,signal:AbortSignal.timeout(180000)});const result=await response.json();if(!response.ok||!result.data?.[0]?.b64_json)throw Error(result.error?.message||'Image API returned no image');return 'data:image/png;base64,'+result.data[0].b64_json};
 const outputs=await Promise.all(Array.from({length:body.quantity},(_,i)=>i).map(generateOne));state.generations=(state.generations||0)+1;saveJSON(authFile,state);return reply(res,200,{outputs,model:process.env.OPENAI_IMAGE_MODEL||'gpt-image-1.5'});
 }catch(e){console.error('Generation error:',e.message);return reply(res,502,{error:'Image generation failed: '+e.message})}finally{activeGenerations.delete(id)}
}
if(req.method==='POST'&&a[0]==='api'&&a[1]==='complete'&&okId(a[2])){const id=a[2];if(!validSession(id,req.headers['x-session-token']))return reply(res,403,{error:'Session authorization failed'});if(!fs.existsSync(file(id,'.json')))return reply(res,409,{error:'Session not yet uploaded'});const data=JSON.parse(fs.readFileSync(file(id,'.json'),'utf8'));if(data.stage!=='complete')return reply(res,409,{error:'Study not yet completed'});if(fs.existsSync(file(id,'.emailed')))return reply(res,200,{emailed:true,alreadySent:true});try{await sendCompletionEmail(id);saveJSON(file(id,'.emailed'),{sentAt:new Date().toISOString()});return reply(res,200,{emailed:true})}catch(e){console.error('Email delivery failed:',e.message);return reply(res,503,{emailed:false,error:e.message})}}
if(req.method==='PUT'&&a[0]==='api'&&a[1]==='session'&&okId(a[2])){
 const id=a[2],token=req.headers['x-session-token'];if(!validSession(id,token))return reply(res,403,{error:'Session authorization failed'});
 const body=await read(req);if(!body||!Array.isArray(body.conditions)||body.conditions.length!==4||!Array.isArray(body.events)||typeof body.participant!=='string')return reply(res,400,{error:'Invalid session format'});
 // Avoid accidental overwrite of one participant's data by another session.
 if(fs.existsSync(file(id,'.json'))){const old=JSON.parse(fs.readFileSync(file(id,'.json')));if(old.id!==body.id||old.participant!==body.participant)return reply(res,409,{error:'Session mismatch'})}
 saveJSON(file(id,'.json'),body);return reply(res,200,{saved:true,updatedAt:new Date().toISOString()})}
// Researcher data is imported locally from the participant email attachment.
return reply(res,404,{error:'Not found'});
}catch(e){console.error(e);return reply(res,e.message==='Payload too large'?413:500,{error:e.message==='Payload too large'?'Payload too large':'Server error'})}
}).listen(PORT,'0.0.0.0',()=>{console.log('Co-Ideation pilot listening on '+PORT);const base=process.env.RENDER_EXTERNAL_URL;if(base){console.log('PARTICIPANT URL: '+base+'/');console.log('RESEARCHER URL: '+base+'/researcher.html');console.log('Assigned participant example: '+base+'/?assignment=T0-C0');}});
