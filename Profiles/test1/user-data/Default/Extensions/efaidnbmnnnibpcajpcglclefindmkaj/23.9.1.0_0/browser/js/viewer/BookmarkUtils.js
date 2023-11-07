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
import{dcLocalStorage as o}from"../../../common/local-storage.js";import{util as e}from"../content-util.js";function r(o,r,s){try{chrome.bookmarks.getTree((t=>{const i=t[0]?.children[0]?.id;i?chrome.bookmarks.create({parentId:i,title:e.getTranslation("dcWebBookmarkTitle"),url:o},(()=>r({success:!0}))):chrome.bookmarks.create({title:e.getTranslation("dcWebBookmarkTitle"),url:o},(()=>r({success:!0}))),s("DCBrowserExt:Viewer:BookmarkCreation:Successful")}))}catch(o){r({error:o})}}export default function s(e,s,t){if(o.getItem("bookmarkedWeb"))s({error:"bookmark already created"});else{o.setItem("bookmarkedWeb","true");try{chrome.permissions.contains({permissions:["bookmarks"],origins:["https://www.google.com/"]},(o=>{o?r(e,s,t):(t("DCBrowserExt:Viewer:Bookmark:PermissionDialog:Shown"),chrome.permissions.request({permissions:["bookmarks"],origins:["https://www.google.com/"]},(o=>{o?(t("DCBrowserExt:Viewer:Bookmark:PermissionDialog:Granted"),r(e,s,t)):(t("DCBrowserExt:Viewer:Bookmark:PermissionDialog:Denied"),s({denied:!0}))})))}))}catch(o){s({error:o})}}}