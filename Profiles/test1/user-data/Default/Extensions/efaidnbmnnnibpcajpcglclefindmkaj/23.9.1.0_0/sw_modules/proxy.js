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
import{util as e}from"./util.js";var r=[];function t(){return Math.ceil(1e6*Math.random())}function n(r){var t,n,s=r.split(e.stackDelimiter()),a=[],o=0;for(t=0;t<s.length;t+=1)-1===(n=s[t]).indexOf("run_function")&&o<1e3&&(o+=(n=(n=(n=(n=n.replace(/chrome\-extension:\/\/[a-zA-Z]*\//g,"")).replace(/jar:file:\S*\.xpi!/,"")).replace(/resource:\S+toolkit/,"")).replace(/resource:\S+jetpack/,"")).length,a.push(n));return a.join("\n")}function s(){try{return this.func.apply(this.context,this.args.concat(Array.prototype.slice.call(arguments,0)))}catch(o){if(!o.handled){o.handled=!0;var s={errnum:t(),name:o.name+(o.message?" "+o.message:""),source:"client",details:""},a=2048-(JSON.stringify(s).length+128);s.details=n(o.stack).substr(0,a),e.each(r,(function(e,r){r(s,40,o)})),this.context.LOG(s,40)}throw o}}export const Proxy={proxy:function(e){return s.bind({func:e,context:this,args:Array.prototype.slice.call(arguments,1)})},REST_error:function(n,s,a){var o={errnum:t(),name:n.statusText,status:n.status,details:"HTTP error"};a&&(o=e.extend(o,a)),n.responseJSON&&(o.name=n.responseJSON.error.code,o.details=n.responseJSON.error.message),e.each(r,(function(e,r){r(o,40)})),s.LOG(o,40)},handlers:function(e){r.push(e)}};