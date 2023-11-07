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
import{util as e}from"../content-util.js";import{dcSessionStorage as o}from"../../../common/local-storage.js";import{signInUtil as t}from"./signInUtils.js";import{privateApi as s}from"../content-privateApi.js";function a(){var o,t,s;$("#adobe-yolo-message").text(e.getTranslation("adobeYoloMessage")),o=document.getElementsByClassName("loader-blue-line")[0],t=1,s=setInterval((function(){t>=100?clearInterval(s):(t++,o.style.width=t+"%")}),20)}await o.init(),setTimeout((async function(){const e=o.getItem("adobeYoloTabsInfo");let n;if(t.sendAnalytics("DCBrowserExt:Viewer:Ims:Jump:Page:Launched"),a(),(await chrome.runtime.sendMessage({main_op:"checkUserIsSignedIn"})).signInStatus){if(e&&e.tabsInfo){const t=e.tabsInfo,a=await s.isMimeHandlerAvailable();chrome.tabs.query({},(e=>{e&&e.forEach((e=>{t.includes(e.id)&&(n=e.id,chrome.tabs.reload(e.id),a||setTimeout((()=>{chrome.tabs.sendMessage(n,{main_op:"jumpUrlSuccess"})}),1e3))}))})),a&&setTimeout((()=>{chrome.runtime.sendMessage({main_op:"jumpUrlSuccess",tabInfo:t})}),1e3),o.removeItem("adobeYoloTabsInfo")}}else o.removeItem("adobeYoloTabsInfo"),t.sendAnalytics("DCBrowserExt:Viewer:Ims:Jump:Page:UserNotSignedIn");setTimeout((()=>{const e={active:!0};n&&chrome.tabs.update(n,e),window.close()}),2500)}),200);