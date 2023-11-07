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
import{common as e}from"./common.js";import{util as t}from"./util.js";import{SETTINGS as a}from"./settings.js";import{dcLocalStorage as o}from"../common/local-storage.js";import{floodgate as s}from"./floodgate.js";import{loggingApi as l}from"../common/loggingApi.js";let n;n||(n=new function(){this.updateVariables=function(n){try{let i=0!=n&&1!=n&&-1!=n,c=!(!i||n===a.READER_VER||n===a.ERP_READER_VER);o.setItem("locale",t.getFrictionlessLocale(chrome.i18n.getMessage("@@ui_locale"))),o.setItem("cdnUrl",e.getAcrobatViewerUri()),o.setItem("isDeskTop",i),o.setItem("env",e.getEnv()),o.setItem("viewerImsClientId",e.getViewerIMSClientId()),o.setItem("imsContextId",e.getImsContextId()),o.setItem("viewerImsClientIdSocial",e.getViewerIMSClientIdSocial()),o.setItem("imsURL",e.getIMSurl()),o.setItem("imsLibUrl",e.getImsLibUrl()),o.setItem("dcApiUri",e.getDcApiUri()),o.setItem("isAcrobat",c),o.getItem("theme")||o.setItem("theme","auto");let r=[this.checkFeatureEnable({flagName:"dc-cv-read-aloud",storageKey:"isReadAloudEnable"}),this.checkFeatureEnable({flagName:"dc-cv-full-screen-mode",storageKey:"fsm"}),this.checkFeatureEnable({flagName:"dc-cv-show-get-desktop",storageKey:"sgd"}),this.checkFeatureEnable({flagName:"dc-cv-save-location-on-options",storageKey:"isSaveLocationPrefEnabled"}),this.checkFeatureEnable({flagName:"dc-cv-enable-splunk-logging",storageKey:"splunkLoggingEnable"}),this.checkFeatureEnable({flagName:"dc-cv-extension-menu",storageKey:"enableNewExtensionMenu"}),this.checkFeatureEnable({flagName:"dc-cv-enable-embed-viewer",storageKey:"ev"}),this.checkFeatureEnable({flagName:"dc-cv-ext-menu-dark-mode",storageKey:"enableExtMenuDarkMode"}),this.checkFeatureEnable({flagName:"dc-cv-share-link",storageKey:"sl"}),this.checkFeatureEnable({flagName:"dc-cv-alloy-on",storageKey:"ao"}),this.checkFeatureEnable({flagName:"dc-cv-alloy-on-ext-menu",storageKey:"aoem"})];return navigator.onLine&&r.push(this.checkFeatureEnable({flagName:"dc-cv-offline-support-disable",storageKey:"offlineSupportDisable"})),Promise.all(r).then((([e,a,n,i,c,r,m,g,d,u,h])=>{if(!i&&o.getItem("saveLocation")?o.removeItem("saveLocation"):i&&!o.getItem("saveLocation")&&o.setItem("saveLocation","ask"),l.registerLogInterval(c),c){let e=s.getFeatureMeta("dc-cv-enable-splunk-logging")||{};e=JSON.parse(e),o.setItem("allowedLogIndex",e.index)}t.enableNewExtensionMenu(r)}))}catch(e){}},this.checkFeatureEnable=async function(e){const{flagName:t,storageKey:a}=e,l=await s.hasFlag(t);return a&&o.setItem(a,!!l),l}});export const viewerModuleUtils=n;