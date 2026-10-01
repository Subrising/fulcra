export type WorkMessage={id:string;role:'instruction'|'agent';text:string;truncated:boolean};
export function projectMessages(entries:unknown[]):WorkMessage[];
export function validateMessages(value:unknown,activity?:{id:string;kind:string}[]):WorkMessage[];
