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
import{floodgate as t}from"./floodgate.js";import{communicate as s}from"./communicate.js";import{dcLocalStorage as n,callWithStorage as o}from"../common/local-storage.js";import{common as c}from"./common.js";const i=new function(){this.instances=[t,s,c],this.status={},this.instances.forEach((({constructor:{name:t}})=>this.status[t]=!1)),this.syncInterval=null,this.do=()=>{this.instances.forEach((t=>{const{constructor:{name:s}}=t;this.status[s]||(JSON.parse(n.getItem(s)||"[]").map((([s,n])=>t[s]=n)),this.status[s]=!0)})),this.sync()},this.sync=()=>{this.syncInterval||(this.syncInterval=setInterval((()=>{this.instances.forEach((t=>{n.setItem(t.constructor.name,JSON.stringify(Object.entries(t)))}))}),1e3))}},e=(...t)=>o(i.do,...t);export{e as hydrateWithStorage};