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
function isGoogleQuery(r){if(!r)return!1;try{if(new URL(r).host.startsWith("www.google."))return!0}catch(r){return!1}return!1}function isSupportedBrowserVersion(){const r=navigator.userAgent.match(/Chrome\/([0-9]+)/);return!(r&&r.length>=2)||+r[1]>=SETTINGS.SUPPORTED_VERSION}