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
import{analytics as e}from"../common/analytics.js";import{common as t}from"./common.js";import{communicate as r}from"./communicate.js";import{util as s}from"./util.js";import{Proxy as n}from"./proxy.js";import{SETTINGS as o}from"./settings.js";import{dcLocalStorage as i}from"../common/local-storage.js";var c;c||(c=new function(){this.proxy=n.proxy.bind(this),this.LOG=(...e)=>t.LOG(...e),this.CONVERSION_TIMEOUT=2e5,this.web2pdfCaller={MENU:0,TOOLBAR:1,AUTO:2},this.web2pdfAction={CONVERT:0,APPEND:1},this.web2pdfContext={PAGE:0,LINK:1};var c="ViewResultsPref";this.getViewResultsPreferenceState=function(){return"false"!==i.getItem(c)},this.viewPrefIsDefault=function(){return!i.getItem(c)},this.savePreferences=function(s,n,i){let c=!0;try{if(void 0!==s.analytics_on&&(e.setAnalyticsUsage(s.analytics_on,n.tab.id),1==s.analytics_on&&e.event(e.e.OPTIONS_ENABLED_ANALYTICS)),o.DEBUG_MODE&&s.environment&&(t.reset(s.environment),e.environment=s.environment,e.event(e.e.OPTIONS_SET_ENV)),o.DEBUG_MODE&&s.product)switch(s.product){case"acrobat":r.setVersion(21);break;case"reader":r.setVersion(13);break;case"no-app":r.setVersion(0),o.FILL_N_SIGN_ENABLED=!1}}catch(e){c=!1}i({success:c})},this.fetchPreferences=function(e,n,c){const a=chrome.i18n.getMessage("@@ui_locale");c({environment:t.getEnv(),version:r.version,settings:o,locale:i.getItem("appLocale")||s.getFrictionlessLocale(a)})}},r.registerModule("acro-gstate",c)),r.registerHandlers({"save-preferences":c.proxy(c.savePreferences),"fetch-preferences":c.proxy(c.fetchPreferences)});export const acroGstate=c;