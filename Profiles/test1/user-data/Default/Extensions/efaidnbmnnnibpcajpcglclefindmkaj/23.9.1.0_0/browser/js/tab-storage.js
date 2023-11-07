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
const e={getItem:e=>{try{return sessionStorage.getItem(e)}catch(e){return""}},setItem:(e,t)=>{try{return sessionStorage.setItem(e,t)}catch(e){}},removeItem:e=>{try{return sessionStorage.removeItem(e)}catch(e){}}};export{e as dcTabStorage};