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
var e=[];export function extend(e={},t={}){for(let r in t)t.hasOwnProperty(r)&&void 0!==t[r]&&(e[r]=t[r]);return e}export function each(e,t){Array.isArray(e)?e.forEach((function(e,r){t.call(e,r,e)})):e&&Object.keys(e).forEach((function(r){t.call(e[r],r,e[r])}))}export function param(e){var t=[];return each(e,(function(e,r){t.push(e+"="+encodeURIComponent(r))})),t.join("&")}export function Deferred(e,t){var r={},n=e||new Promise((function(e,n){r.resolve=function(...t){return r.timer&&clearTimeout(r.timer),e(...t)},r.reject=function(...e){if(r.timer&&clearTimeout(r.timer),n)return n(...e)},t&&(r.timer=setTimeout(dc.wrap((function(){r.time_out=!0,delete r.timer,r.resolve()})),6e4))}));return r.promise=function(){return n},r.clearTimer=function(){r.timer&&clearTimeout(r.timer)},r.then=function(e){return n.then(e)},r.done=function(e){return n.then(e,e)},r}export function ajax(t){var r,n,o,a=t.type||"GET",c=t.data,i=(r=require("chrome"),n=r.Cc,o=r.Ci,n["@mozilla.org/xmlextras/xmlhttprequest;1"].createInstance(o.nsIXMLHttpRequest)),u=Deferred();return i.open(a,t.url,!0),i.onload=function(r){var n=r.currentTarget,o=n.response;try{o=JSON.parse(o)}catch(e){o=n.responseText}n.status<400?u.resolve(o,n.statusText):(u.reject(n,n.statusText,o),each(e,(function(e){e({type:"ajaxError"},n,t,n.statusText)})))},t.contentType&&i.setRequestHeader("Content-Type",t.contentType),each(t.headers,(function(e,t){i.setRequestHeader(e,t)})),t.hasOwnProperty("processData")&&!t.processData||"string"==typeof c||c instanceof String||(c=t.contentType&&-1!==t.contentType.indexOf("application/x-www-form-urlencoded")?param(c):JSON.stringify(c)),i.send(c),u.promise()}export function ajaxError(t){e.push(t)}