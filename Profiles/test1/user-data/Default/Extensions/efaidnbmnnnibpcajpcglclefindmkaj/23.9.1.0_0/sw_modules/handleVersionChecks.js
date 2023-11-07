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
import{acroActions as e}from"./acro-actions.js";import{util as t}from"./util.js";import{SETTINGS as o}from"./settings.js";import{dcLocalStorage as n}from"../common/local-storage.js";function r(e){return t&&t.isChromeOnlyMessage(e)&&t.isEdge()&&(e+="Edge"),t&&t.getTranslation?t.getTranslation(e):chrome.i18n.getMessage(e)}export async function versionChecks(){return new Promise(((E,i)=>{e.getVersion((e=>{const i=n.getItem("enableNewExtensionMenu");t.enableNewExtensionMenu(i),e.ver!==o.READER_VER&&e.ver!==o.ERP_READER_VER||(o.IS_READER=!0,o.IS_ACROBAT=!1,e.ver===o.ERP_READER_VER&&(o.IS_ERP_READER=!0),i||(e.ver===o.ERP_READER_VER?chrome.action.setTitle({title:r("web2pdfConvertButtonToolTipERPReader")}):chrome.action.setTitle({title:r("web2pdfOpenButtonText")}))),i||function(e){0!=e&&1!=e&&e!=o.READER_VER&&e!=o.ERP_READER_VER||chrome.action.setTitle({title:""})}(e.ver),E(e)}))}))}