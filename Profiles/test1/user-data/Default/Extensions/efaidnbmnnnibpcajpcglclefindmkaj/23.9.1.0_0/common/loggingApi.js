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
import{EVAR_KEYS as e,LOGGING_URI as t}from"../sw_modules/constant.js";import{dcLocalStorage as s}from"./local-storage.js";import{SETTINGS as o}from"../sw_modules/settings.js";import{allowedLogs as r}from"../sw_modules/splunkAllowedLogs.js";import{util as n}from"../sw_modules/util.js";const i=new class{constructor(){this.flushInterval=1e4,this.SERVER_PATH="/system/log",this.SERVER_CONTENT_TYPE='application/vnd.adobe.dc+json; profile="/schemas/system_log_parameters_v1.json"',setTimeout((()=>{const e=s.getItem("installSource");this.loggingUri=t[s.getItem("env")],"development"===e&&(this.loggingUri=t.stage,this.enableConsole=!0)}),250)}registerLogInterval(e){e?this.interval||(this.interval=setInterval((()=>{(s.getItem("deferredLogs")||[]).length>0&&this._flushLogs()}),this.flushInterval)):(s.removeItem("deferredLogs"),clearInterval(this.interval))}renameEvars(t){return Object.entries(e).forEach((([e,s])=>{t.hasOwnProperty(e)&&(t[s]=t[e],delete t[e])})),t}_flatten(e){let t={};for(const[s,o]of Object.entries(e))"object"==typeof o?t={...t,...this._flatten(o)}:t[s]=o;return t}_batchHandler(){return s.getItem("deferredLogs").map((e=>(this.renameEvars(e.message),this._flatten(e))))}_flushLogs(){const e={headers:{"Content-Type":this.SERVER_CONTENT_TYPE.replace("/schemas/",`${this.loggingUri}/schemas/`),"x-request-id":n.uuid(),"x-api-app-info":"dc-acrobat-extension","x-api-client-id":`dc-acrobat-extension:${chrome.runtime.id}`}},t=this._batchHandler();this.enableConsole?console.log(t):fetch(this.loggingUri+this.SERVER_PATH,{method:"POST",headers:e.headers,body:JSON.stringify(t)}).catch((e=>console.log(e))),s.setItem("deferredLogs",[])}_logWithoutAuth(e){const t=s.getItem("deferredLogs")||[];t.push(e),s.setItem("deferredLogs",t)}isAllowed(e){const t=s.getItem("allowedLogIndex");return r[e.message]<=t}doLog(e,...t){const o=s.getItem("splunkLoggingEnable");if(!t.length||!t[0]||!1===o||!this.isAllowed(t[0]))return;const r=t[0];r.context||(r.context="logger"),this._logWithoutAuth({message:r,level:e,sessionId:s.getItem("sessionId")})}debug(...e){this.doLog("debug",...e)}info(...e){this.doLog("info",...e)}warn(...e){this.doLog("warn",...e)}error(...e){this.doLog("error",...e)}};export{i as loggingApi};