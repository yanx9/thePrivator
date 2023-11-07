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
import{dcLocalStorage as t}from"../../common/local-storage.js";import{analytics as e,events as o}from"../../common/analytics.js";import{LOCAL_FILE_PERMISSION_URL as n,TWO_WEEKS_IN_MS as a}from"../../common/constant.js";import{util as c}from"../js/content-util.js";await t.init();const{id:l,url:i}=await chrome.tabs.getCurrent();e.event(o.LOCAL_FTE_DISPLAYED),t.setWithTTL("localFteCooldown",!0,a);const s=(t.getItem("localFteCount")||0)+1;t.setItem("localFteCount",s),$(document).ready((()=>{c.translateElements(".translate"),$("#closeLocalFte").click((()=>{c.sendAnalytics(o.LOCAL_FTE_CROSS_BUTTON_CLICKED),chrome.runtime.sendMessage({main_op:"closeLocalFte"})})),$("#continueLocalFte").click((async()=>{e.event(o.LOCAL_FTE_GO_TO_SETTINGS_CLICKED),t.setItem("pdfViewer","true");const{windowId:a}=await chrome.tabs.create({url:n,active:!0});chrome.windows.update(a,{focused:!0})})),$("#localFteDontShowAgainInput").click((()=>{document.getElementById("localFteDontShowAgainInput").checked?(e.event(o.LOCAL_FTE_DONT_ASK_CHECKED),t.setItem("localFteDontShowAgain",!0)):(e.event(o.LOCAL_FTE_DONT_ASK_UNCHECKED),t.removeItem("localFteDontShowAgain"))})),s>4&&$("#localFteDontShowAgainInput,#localFteDontShowAgainText").removeAttr("hidden"),window.onbeforeunload=()=>{c.sendAnalytics(o.LOCAL_FTE_WINDOW_CLOSED);const t=Date.now();for(;Date.now()-t<60;);},document.addEventListener("keydown",(t=>{"F11"==t.key&&t.preventDefault()}))}));