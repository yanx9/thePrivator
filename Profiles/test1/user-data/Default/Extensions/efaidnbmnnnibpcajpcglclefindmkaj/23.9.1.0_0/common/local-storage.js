/*************************************************************************
* ADOBE CONFIDENTIAL
* ___________________
*
*  Copyright 2015 Adobe Systems Incorporated
*  All Rights Reserved.
*
* NOTICE:  All information contained herein is, and remains
* the property of Adobe Systems Incorporated and its suppliers,
* if any.  The intellectual and technical concepts contained
* herein are proprietary to Adobe Systems Incorporated and its
* suppliers and are protected by all applicable intellectual property laws,
* including trade secret and or copyright laws.
* Dissemination of this information or reproduction of this material
* is strictly forbidden unless prior written permission is obtained
* from Adobe Systems Incorporated.
**************************************************************************/
class t{constructor(t){switch(this.storage=null,this.storagePromise=null,t){case"local":this.storageApi=chrome.storage.local;break;case"session":this.storageApi=chrome.storage.session;break;default:throw new Error("dcStorage type not supported")}}async init(){try{this.storagePromise||(this.storagePromise=this.storageApi.get()),this.storage||(this.storage=await this.storagePromise)}catch(t){}}getAllItems(){return this.storage||{}}length(){return Object.keys(this.getAllItems()).length}getItem(t){return this.storage&&void 0!==this.storage[t]?this.storage[t]:""}setItem(t,e){try{return this.storage[t]=e,this.storageApi.set({[t]:e})}catch(t){}}removeItem(t){try{delete this.storage[t],this.storageApi.remove(t)}catch(t){}}setWithTTL(t,e,s){try{const r=(new Date).getTime()+s;return this.setItem(t,{value:e,expiry:r})}catch(t){}}getWithTTL(t){try{const e=(new Date).getTime(),s=this.getItem(t);if(s){if(e<=s.expiry)return s.value;this.removeItem(t)}}catch(t){}}}const e=new t("local"),s=new t("session"),r=(...t)=>(...r)=>{Promise.all([e.init(),s.init()]).then((()=>t.forEach((t=>t(...r)))))};chrome.storage.onChanged.addListener((async(t,r)=>{let a;switch(r){case"local":a=e;break;case"session":a=s;break;default:return}await a.init(),Object.entries(t).forEach((([t,{newValue:e}])=>{void 0!==e?a.storage[t]=e:delete a.storage[t]}))}));export{e as dcLocalStorage,s as dcSessionStorage,r as callWithStorage};