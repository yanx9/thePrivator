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
const e={ca:"Permet l'accés als URL de fitxer",cs:"Umožnit přístup k adresám URL souborů",da:"Tillad adgang til webadresser på filer",de:"Zugriff auf Datei-URLs zulassen",en:"Allow access to file URLs",en_GB:"Allow access to file URLs",es:"Permitir acceso a URL de archivo",eu:"Allow access to file URLs",fi:"Salli tiedostojen URL-osoitteiden käyttö",fr:"Autoriser l'accès aux URL de fichier",hr:"Dozvoli pristup URL-ovima datoteke",hu:"Fájl URL-ekhez való hozzáférés engedélyezése",it:"Consenti l'accesso agli URL dei file",ja:"ファイルの URL へのアクセスを許可する",ko:"파일 URL에 대한 액세스 허용",nb:"Tillat tilgang til filnettadresser",nl:"Toegang tot bestand-URL's toestaan",pl:"Zezwalaj na dostęp do adresów URL plików",pt:"Permitir acesso a URLs de arquivo",pt_BR:"Permitir acesso a URLs de arquivo",ro:"Permite accesul la adresele URL de fișiere",ru:"Разрешить открывать локальные файлы по ссылкам",sk:"Povoliť prístup k webovým adresám súboru",sl:"Dovoli dostop do URL-jev datoteke",sv:"Tillåt åtkomst till webbadresser i filen",tr:"Dosya URL'lerine erişime izin ver",uk:"Надавати доступ до URL-адрес файлу",zh_CN:"允许访问文件网址",zh_TW:"允許存取檔案網址"};export const getLocale=()=>{let e=chrome.i18n.getMessage("@@ui_locale");return["ca","cs","da","de","en","en_GB","es","eu","fi","fr","hr","hu","it","ja","ko","nb","nl","pl","pt","pt_BR","ro","ru","sk","sl","sv","tr","uk","zh_CN","zh_TW"].includes(e)||(e="en"),e};export const getAllowAccessToFileUrl=()=>{const s=getLocale();return encodeURIComponent(e[s]).replace("-","%2D")};