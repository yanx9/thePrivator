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
import{communicate as t}from"./communicate.js";import{Proxy as e}from"./proxy.js";import{analytics as o}from"../common/analytics.js";import{common as r}from"./common.js";import{util as n}from"./util.js";import{dcLocalStorage as s}from"../common/local-storage.js";var i=null,c=["word-to-pdf","jpg-to-pdf","excel-to-pdf","ppt-to-pdf","pdf-to-word","pdf-to-ppt","pdf-to-excel","pdf-to-image","createpdf","compress-pdf"];i||(i=new function(){this.proxy=e.proxy.bind(this),this.LOG=(...t)=>r.LOG(...t),this.isGoogleQuery=function(t){try{if(new URL(t.url).host.startsWith("www.google."))return!0}catch(t){return!1}return!1},this.getSearchQuery=function(t){try{const e=new URL(t.url).searchParams.get("q");if(e)return decodeURIComponent(e)}catch(t){return o.event(o.e.GOOGLE_URL_DECODE_ERROR),null}return null},this.mapQueryStringToAction=function(e,i){const c=s.getItem("appLocale");let l=chrome.i18n.getMessage("@@ui_locale"),a=c||n.getFrictionlessLocale(l);if(null==a)return;const f=chrome.runtime.getURL("browser/data/"+l+"/searchterms.json");fetch(f).then((t=>{if(t.status>=200&&t.status<=299)return t.json();throw o.event(o.e.GOOGLE_SEARCHTERM_FETCH_ERROR),Error(o.e.GOOGLE_SEARCHTERM_FETCH_ERROR)})).then((async o=>{const n=this.findAction(o,e);n&&(i.pdf_action=n,i.frictionless_uri=await r.getFrictionlessUri(),i.env=r.getEnv(),i.panel_op="load-frictionless",i.frame_visibility="hidden",i.frictionless_workflow="search",i.locale=a,t.sendMessage(i))})).catch((t=>{n.consoleError("googlequeryanalyzer::mapQueryStringToAction",t)}))},this.findAction=function(t,e){const o=e.replace(/\s/g,"").toLowerCase();for(let e=0;e<c.length;++e){const r=c[e];let n=t[r]||[];for(let t=0;t<n.length;t++){const e=n[t];if(o.includes(e))return r}}return null}});export const googleQueryAnalyzer=i;