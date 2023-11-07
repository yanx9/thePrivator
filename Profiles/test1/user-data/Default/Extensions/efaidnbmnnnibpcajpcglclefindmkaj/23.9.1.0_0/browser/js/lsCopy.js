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
chrome.runtime.onMessage.addListener(((e,a,o)=>{if("copy-ls"===e.main_op)return async function(){localStorage&&localStorage.length&&(await chrome.storage.local.set({...localStorage}),localStorage.clear())}().then((()=>o("succeed"))).catch((()=>setTimeout(o,1e4,"failed"))),!0}));