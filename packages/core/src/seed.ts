import { randomUUID } from 'node:crypto';
import { db, json } from './db';
import { put } from './store';
import { allowDemo } from './config';
import { AppError } from './security';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

export async function createDemo() {
  if(!allowDemo())throw new AppError('DEMO_DISABLED','The sandbox is disabled on this instance.',403);
  const user=await db.user.create({data:{email:`sandbox-${randomUUID()}@orbitdesk.example`,name:'Mike Cooper'}});
  const workspace=await db.workspace.create({data:{ownerId:user.id,name:'Mike’s sandbox',demo:true,settings:json({timezone:'Europe/Amsterdam',workingHours:{start:9,end:17},defaultDurationMinutes:30,defaultView:'today'})}});
  const accounts=[
    ['mike@northstar.example','Northstar','#D49D48'],
    ['mike@cooper.example','Personal','#6E92A8'],
    ['mike@studio.example','Studio','#9284B1'],
    ...Array.from({length:9},(_,i)=>[`mike@client${i+1}.example`,`Client ${i+1}`,['#A47D6D','#78A590','#A6A36F'][i%3]])
  ];
  const conns=[];
  for(const [email,label,color] of accounts) conns.push(await db.connection.create({data:{workspaceId:workspace.id,googleSub:randomUUID(),email,name:'Mike Cooper',label,color,status:'connected',scopes:['sandbox'],lastSyncAt:new Date(),settings:json({isDemo:true,assistantEnabled:true})}}));
  const now=new Date();
  const at=(days:number,hour:number,minute=0)=>{const d=new Date(formatInTimeZone(now,'Europe/Amsterdam','yyyy-MM-dd')+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return fromZonedTime(d.toISOString().slice(0,10)+'T'+String(hour).padStart(2,'0')+':'+String(minute).padStart(2,'0')+':00','Europe/Amsterdam').toISOString();};
  const threads=[
    {account:0,name:'Lena Fischer',email:'lena@northstar.example',subject:'Product review · Thursday?',text:'Hey Mike, could we find 30 minutes on Thursday to walk through the Orbitdesk beta? I can do 10:00 or 14:00 Amsterdam time. We should review account permissions and the first onboarding flow.',age:18,unread:true,starred:true,labels:['INBOX','UNREAD','STARRED'],category:'Needs a reply'},
    {account:2,name:'Noah Williams',email:'noah@studio.example',subject:'The identity explorations are ready',text:'I have uploaded the first three identity directions to the shared folder. My preference is direction two: calm typography, warm paper, and a confident account rail. Would love your thoughts before Friday.',age:43,unread:true,starred:false,labels:['INBOX','UNREAD'],category:'Projects'},
    {account:0,name:'Sarah Chen',email:'sarah@northstar.example',subject:'Beta launch checklist',text:'We need to finish the privacy policy, test reconnect after revoked permissions, and rehearse a database restore. Can you take ownership of the reconnect checks and make sure they are done by Friday?',age:72,unread:true,starred:false,labels:['INBOX','UNREAD'],category:'Needs action'},
    {account:1,name:'Oliver Reed',email:'oliver@friends.example',subject:'Dinner on Saturday',text:'We booked a table at 19:30 on Saturday. There are six of us so far. Are you and Emma joining? I will confirm numbers tomorrow.',age:120,unread:false,starred:false,labels:['INBOX'],category:'Personal'},
    {account:2,name:'Priya Patel',email:'priya@studio.example',subject:'Invoice INV-2026-104',text:'Please find the October invoice attached. The total is €1,250 and the payment due date is October 15. Thanks for another good month of work together.',age:190,unread:false,starred:true,labels:['INBOX','STARRED'],category:'Finance'},
    {account:0,name:'Daniel Brooks',email:'daniel@northstar.example',subject:'Notes from our planning session',text:'Thanks for the discussion. Our agreed priorities are multi-account correctness, a useful agent, and dependable scheduled sends. I added our decisions to the planning document.',age:300,unread:false,starred:false,labels:['INBOX'],category:'Projects'},
    {account:1,name:'Weekly Reading',email:'digest@reading.example',subject:'Your weekend reading list',text:'This week: making time for focused work, the practical limits of AI assistants, and notes on building calm software. Your reading list is ready.',age:520,unread:false,starred:false,labels:['INBOX'],category:'Updates'},
    {account:2,name:'Alex Morgan',email:'alex@client.example',subject:'Following up on the proposal',text:'Hi Mike, just checking whether you had a chance to review our proposal. Happy to answer questions or arrange a short call next week.',age:900,unread:true,starred:false,labels:['INBOX','UNREAD'],category:'Needs a reply'},
  ];
  for(let i=0;i<threads.length;i++){
    const t=threads[i], c=conns[t.account],date=new Date(now.getTime()-t.age*60000).toISOString();
    const message={id:`demo-message-${i}`,providerId:`demo-message-${i}`,from:{name:t.name,email:t.email},to:[{name:'Mike Cooper',email:c.email}],cc:[],bcc:[],subject:t.subject,body:t.text,bodyText:t.text,bodyHtml:'',date,attachments:[],labels:t.labels,messageId:`<demo-${i}@orbitdesk.example>`,references:[]};
    await put(c,'thread',`demo-thread-${i}`,{subject:t.subject,snippet:t.text.slice(0,145),from:message.from,participants:[message.from],lastMessageAt:date,date,unread:t.unread,isUnread:t.unread,starred:t.starred,isStarred:t.starred,labels:t.labels,messageCount:i===0?2:1,category:t.category,messages:i===0?[{...message,id:'demo-message-older',date:new Date(now.getTime()-86400000).toISOString(),body:'Following up on our conversation about reviewing the beta. Let’s find a time this week.',bodyText:'Following up on our conversation about reviewing the beta. Let’s find a time this week.'},message]:[message],isDemo:true});
  }
  const calendars=[];
  for(let i=0;i<8;i++){
    const c=conns[i%conns.length];
    calendars.push(await put(c,'calendar',`demo-calendar-${i}`,{name:i===0?'Northstar':i===1?'Personal':i===2?'Studio':`Client ${i-2}`,summary:i===0?'Northstar':i===1?'Personal':i===2?'Studio':`Client ${i-2}`,color:c.color,timeZone:'Europe/Amsterdam',timezone:'Europe/Amsterdam',accessRole:'owner',selected:true,includeInAvailability:true,primary:i<3,isDemo:true}));
  }
  const evs=[['Weekly planning',0,0,9,0,45],['Design review',2,0,11,30,60],['Gym',1,0,18,0,60],['Product sync',0,1,10,0,30],['Client check-in',3,1,14,0,45],['Focus time',0,2,9,0,120],['Dinner with friends',1,3,19,30,120],['Beta onboarding review',0,4,14,0,60]] as const;
  for(let i=0;i<evs.length;i++){
    const [title,ci,days,hour,minute,duration]=evs[i],cal=calendars[ci],c=conns[ci];const start=at(days,hour,minute),end=new Date(new Date(start).getTime()+duration*60000).toISOString();
    await put(c,'event',`demo-event-${i}`,{title,summary:title,description:i===1?'Review the latest design directions and agree the next steps.':'',calendarId:cal.id,start,end,startAt:start,endAt:end,allDay:false,timeZone:'Europe/Amsterdam',timezone:'Europe/Amsterdam',attendees:i<2?[{email:'lena@northstar.example',name:'Lena Fischer',responseStatus:'accepted'}]:[],location:i===2?'Gym':'',meetLink:i<2?'https://meet.google.com/abc-defg-hij':null,status:'confirmed',isOrganizer:true,isDemo:true},cal.id);
  }
  for(let i=0;i<3;i++){
    const c=conns[i],list=await put(c,'taskList',`demo-task-list-${i}`,{title:i===0?'Work':i===1?'Personal':'Studio',name:i===0?'Work':i===1?'Personal':'Studio',isDemo:true});
    const tasks=i===0?['Test account reconnect','Review beta onboarding','Write the launch announcement']:i===1?['Book a dentist appointment','Plan the weekend']:['Review identity direction two','Send the October invoice'];
    for(let j=0;j<tasks.length;j++)await put(c,'task',`demo-task-${i}-${j}`,{title:tasks[j],notes:j===0&&i===0?'Verify that revoked Google credentials pause scheduled work and show a clear reconnect action.':'',due:formatInTimeZone(at(j===0?0:2,0),'Europe/Amsterdam','yyyy-MM-dd'),dueDate:formatInTimeZone(at(j===0?0:2,0),'Europe/Amsterdam','yyyy-MM-dd'),status:'needsAction',completed:false,listId:list.id,taskListId:list.id,parentId:null,position:String(j).padStart(4,'0'),isDemo:true},list.id);
  }
  const docs=[['Product strategy','application/vnd.google-apps.document'],['Beta launch tracker','application/vnd.google-apps.spreadsheet'],['Orbitdesk introduction','application/vnd.google-apps.presentation']];
  for(let i=0;i<docs.length;i++)await put(conns[0],'file',`demo-file-${i}`,{name:docs[i][0],mimeType:docs[i][1],modifiedTime:new Date(now.getTime()-(i+1)*8*3600000).toISOString(),webViewLink:null,content:i===0?'Orbitdesk brings multiple Google accounts into one calm workspace. The beta prioritizes correct account routing, reliable replies, calendar availability and a useful agent.':i===1?'Task,Owner,Status\nOAuth reconnect,Mike,In progress\nPrivacy policy,Sarah,Review\nRestore test,Daniel,Planned':'Orbitdesk\nEvery account. One clear day.\nAn assistant that understands your inbox, calendar and tasks.',isDemo:true});
  await db.automation.create({data:{workspaceId:workspace.id,name:'Your morning brief',type:'daily_brief',enabled:true,config:json({time:'08:30',timezone:'Europe/Amsterdam',accountIds:conns.map(c=>c.id)}),nextRunAt:new Date(at(1,8,30))}});
  await db.activity.create({data:{workspaceId:workspace.id,actor:user.id,type:'connection.connected',title:'Sandbox ready with 12 accounts and 8 calendars',detail:json({isDemo:true})}});
  return {user,workspace};
}
