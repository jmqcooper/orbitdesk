import { createDemo } from './seed';
import { db } from './db';
const {workspace}=await createDemo();
console.log(`Created isolated sandbox workspace ${workspace.id}`);
await db.$disconnect();
