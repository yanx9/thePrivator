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
$(document).ready((function(e){"use strict";isSupportedBrowserVersion()&&setTimeout((e=>{"application/pdf"===document.contentType?chrome.runtime.sendMessage({main_op:"pdf-menu",is_pdf:!0,url:document.location.href,persist:!0,viewer:"native"}):!1===isGoogleQuery(document.location.href)&&chrome.runtime.sendMessage({main_op:"html-startup",url:document.location.href,startup_time:Date.now()})}),120)}));