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
import{communicate as e}from"./communicate.js";import{privateApi as t}from"./private-api.js";import{dcLocalStorage as r}from"../common/local-storage.js";function s(){let e;return r.getItem("pdfViewer")?"true"===r.getItem("pdfViewer")?e="enabled":"false"===r.getItem("pdfViewer")&&(e="disabled"):e="neverEnabled",e}export function externalClients(a,o,c){if(/^https:\/\/([a-zA-Z\d-]+\.){0,}(adobe|acrobat)\.com(:[0-9]*)?$/.test(o.origin))if("WebRequest"===a.type)switch(a.task){case"detect_extension":c({status:"success",result:"true"});break;case"detect_desktop":try{if(0!=e.version&&1!=e.version){c(e.version===SETTINGS.READER_VER||e.version===SETTINGS.ERP_READER_VER?{status:"success",result:"Reader"}:{status:"success",result:"Acrobat"})}else c({status:"success",result:"NoApp"})}catch(e){c({status:"error",code:"error"})}break;case"detect_viewer_enabled":try{c({status:"success",result:s()})}catch(e){c({status:"error",code:"error"})}break;case"enable_viewer":if(!/^https:\/\/((dev|stage)+\.){0,}acrobat\.adobe\.com?$/.test(o.origin)&&!o.origin.includes("local-test.acrobat.com:11010"))return;try{r.setItem("pdfViewer","true"),t.setViewerState("enabled"),c({status:"success"})}catch(e){c({status:"error",code:"error"})}break;case"upsell_redirect_to_pdf":if(!/^https:\/\/((dev|stage)+\.){0,}acrobat\.adobe\.com?$/.test(o.origin)&&!o.origin.includes("local-test.acrobat.com:9019"))return;chrome.tabs.update(o.tab.id,{url:a.pdfUrl});break;default:c({status:"error",code:"invalid_task"})}else c({status:"error",code:"invalid_type"})}