import { defineContract } from "./rpc-contract";
import {z} from 'zod';
import {activityRpc} from './fleet';
import {validCursor} from './history.mjs';
import {validateMessages,type WorkMessage} from './work-messages.mjs';
export const historyCursor=z.object({scope:z.string(),epoch:z.string(),seq:z.number()}).strict().refine(validCursor);
export type HistoryCursor=z.infer<typeof historyCursor>;
export const messageExcerpts=z.custom<WorkMessage[]>(value=>{try{validateMessages(value);return true;}catch{return false;}});
export const historyRpc=defineContract({name:'organization.activity-history',input:z.object({sessionId:z.string().uuid(),taskId:z.string().uuid(),cursor:historyCursor.nullable(),includeMessages:z.literal(true).optional()}).strict(),output:activityRpc.output.extend({cursor:historyCursor.nullable(),messages:messageExcerpts.optional()})});
