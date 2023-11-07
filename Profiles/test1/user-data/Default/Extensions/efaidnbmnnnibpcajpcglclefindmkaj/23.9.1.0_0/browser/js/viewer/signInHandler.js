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
import{dcTabStorage as e}from"../tab-storage.js";import{signInUtil as n}from"./signInUtils.js";!function(){let t;function o(){const o=e.getItem("csrf"),r=n.parseCSRF(new URL(t));e.removeItem("csrf");!o||!r||r!==o?(n.sendAnalytics("DCBrowserExt:Viewer:User:Error:NonMatchingCsrfToken:FailedToLogin"),n.sign_out(t)):function(){try{let e=t;e&&e.indexOf("#")>-1&&n.signInAnalyticsLogging(e);let o=n.getSearchParamFromURL("mimePdfUrl",t),r=o&&decodeURIComponent(o);chrome.tabs.update({url:r})}catch(e){}}()}const r=()=>{chrome.tabs.query({active:!0,lastFocusedWindow:!0},(function(r){if(r[0]){t=r[0].url;if(!(t.indexOf("access_token")>-1&&e.getItem("signInSource"))){let e=n.getSearchParamFromURL("mimePdfUrl",t),o=e&&decodeURIComponent(e);return void chrome.tabs.update({url:o})}o()}}))};chrome.tabs.query({active:!0,lastFocusedWindow:!0},(o=>{if(o[0])if(t=o[0].url,new URLSearchParams(new URL(t).search).get("socialSignIn")){const o=e.getItem("idp_token");let r=function(e){let n=new URL(window.location.href),t=new URLSearchParams(new URL(window.location.href).search);return t.delete(e),n.search=t,n}("socialSignIn");t=r.href,n.socialSignIn(o,r),e.removeItem("idp_token")}else r()}))}();