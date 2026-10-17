/* Large screenshot drafts use IndexedDB rather than the small localStorage quota. */
(() => {
  let database;
  function open() {return database ||= new Promise((resolve,reject) => {const request=indexedDB.open('math-drafts',1);request.onupgradeneeded=()=>request.result.createObjectStore('drafts');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
  window.mathDrafts = {
    async get(key) {const db=await open();return new Promise((resolve,reject)=>{const req=db.transaction('drafts').objectStore('drafts').get(key);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});},
    async put(key,value) {const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put(value,key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});},
    async remove(key) {const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').delete(key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
  };
})();
