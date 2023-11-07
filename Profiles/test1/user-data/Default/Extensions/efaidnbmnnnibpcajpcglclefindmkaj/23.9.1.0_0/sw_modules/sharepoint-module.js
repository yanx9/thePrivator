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
import{SETTINGS as t}from"./settings.js";let n=null;n||(n=new function(){const n=new Set;this.setAllowListedSharePointUrls=function(t){},this.isAllowListedSharePointUrlDomain=function(t){return n.has(t)},this.isAllowListedSharePointURL=function(t){try{const n=new URL(t);return this.isAllowListedSharePointUrlDomain(n.origin)}catch(t){return!1}},this.isFeatureEnabled=function(){return t.SHAREPOINT_ENABLED},this.setFeatureEnabled=function(n){t.SHAREPOINT_ENABLED=!!n},this.handleAllowedListFromNativeHost=function(t){t&&this.isFeatureEnabled()&&t.length>0&&t.length<5e3&&t.split("|").forEach((t=>{if(t.length>0)try{const i=new URL(t);n.add(i.origin)}catch(t){}}))}});export const sharepointModule=n;