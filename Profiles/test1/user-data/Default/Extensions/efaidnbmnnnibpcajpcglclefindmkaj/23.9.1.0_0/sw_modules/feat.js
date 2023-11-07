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
import{communicate as e}from"./communicate.js";import{SETTINGS as t}from"./settings.js";import{googleQueryAnalyzer as o}from"./googleQueryAnalyzer.js";export function feat(a,r,s){if("Automation"!==a.type)return;if("bngnhmnppadfcmpggglniifohlkmddfc"!==r.id)return;let n;t.TEST_MODE=!0;const c="to_html",i="to_append",l="doAcrobat",m="check_toggle_state",u="update_toggle_state",h=0,g=1,d=2,p=5,f=7,b=8,w=9,_=10;switch(a.task){case h:n=c;break;case g:n=i;break;case d:n=l;break;case p:!function(){let e=chrome.i18n.getMessage("@@ui_locale");a.locale&&(e=a.locale);const t=chrome.runtime.getURL("browser/data/"+e+"/searchterms.json");fetch(t).then((e=>{if(e.status>=200&&e.status<=299)return e.json();throw Error(analytics.e.GOOGLE_SEARCHTERM_FETCH_ERROR)})).then((e=>{if(a&&a.data){let t={};for(let r=0;r<a.data.length;++r){const s=o.findAction(e,a.data[r]);t[a.data[r]]=s}const r=JSON.stringify(t),s=new Blob([r],{type:"text/plain;charset=UTF-8"}),n=window.URL.createObjectURL(s);chrome.downloads.download({url:n,filename:"output.json"})}})).catch((e=>{const t=JSON.stringify(e),o=new Blob([t],{type:"text/plain;charset=UTF-8"}),a=window.URL.createObjectURL(o);chrome.downloads.download({url:a,filename:"output.json"})}))}();break;case f:n=m;break;case b:n=u;break;case w:chrome.runtime.openOptionsPage((e=>{chrome.runtime.lastError?s({error:chrome.runtime.lastError,success:!1}):s({success:!0})}));break;case _:chrome.tabs.query({active:!0},(function(e){e.length>0&&e[0].url.startsWith("chrome-extension://")&&chrome.tabs.remove(e[0].id),s({success:!0})}))}n&&chrome.tabs.sendMessage(e.activeTab(),{panel_op:"test",test_extension:n,outputPath:a.path,openPDF:a.openPDF,toggleId:a.toggleId,toggleVal:a.toggleVal},s)}