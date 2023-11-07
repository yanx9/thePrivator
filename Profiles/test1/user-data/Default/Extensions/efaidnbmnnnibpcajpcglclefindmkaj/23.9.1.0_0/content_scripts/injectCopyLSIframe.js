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
const iframe=document.createElement("iframe");iframe.id="__copyLocalStorage__",iframe.style.display="none",iframe.src=chrome.runtime.getURL("browser/js/lsCopy.html"),document.getElementsByTagName("html")[0].appendChild(iframe),chrome.runtime.onMessage.addListener((({content_op:e})=>{"remove-lsCopy"===e&&iframe.remove()}));