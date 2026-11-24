// The platform passes CLAWCHAT_MEDIA_URL as the ClawChat media origin (for example https://app.clawling.com),
// while Connect's mediaUploadUrl is the full upload endpoint. An origin-only value posts attachments to the site root.
export const MEDIA_UPLOAD_PATH='/media/upload';
function originOnly(value){
 if(typeof value!=='string'||!value.trim())return null;
 let url;try{url=new URL(value.trim());}catch{return null;}
 if(url.protocol!=='https:'&&url.protocol!=='http:')return null;
 return url.pathname==='/'&&!url.search&&!url.hash?url:null;
}
/** The upload endpoint for a configured media value: an origin gets /media/upload; anything else is kept as given. */
export function mediaUploadUrlFor(value){
 const origin=originOnly(value);
 return origin?new URL(MEDIA_UPLOAD_PATH,origin).toString():value;
}
/** Rewrites an origin-only mediaUploadUrl in a Connect config object in place; true when it changed. */
export function repairMediaUploadUrl(config){
 if(!config||typeof config!=='object'||!originOnly(config.mediaUploadUrl))return false;
 config.mediaUploadUrl=mediaUploadUrlFor(config.mediaUploadUrl);return true;
}
