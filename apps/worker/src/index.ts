import { startWorker } from '@orbitdesk/core';
const stop=await startWorker();console.log('Orbitdesk worker is running.');
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await stop();process.exit(0);});
